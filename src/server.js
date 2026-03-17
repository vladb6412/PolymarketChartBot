import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";

import { config } from "./config.js";
import {
  createFifteenMinuteMonitorService,
  createFiveMinuteMonitorService
} from "./monitor.js";

const publicDirectory = path.join(process.cwd(), "public");
const fiveMinuteContext = {
  apiBasePath: "/api",
  monitor: createFiveMinuteMonitorService(),
  sseClients: new Set(),
  includeOfficialStats: true
};
const fifteenMinuteContext = {
  apiBasePath: "/api/15minutebtc",
  monitor: createFifteenMinuteMonitorService(),
  sseClients: new Set(),
  includeOfficialStats: false
};
const monitorContexts = [fifteenMinuteContext, fiveMinuteContext];

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"]
]);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function sendSseEvent(response, event, payload) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(clients, event, payload) {
  for (const response of clients) {
    sendSseEvent(response, event, payload);
  }
}

async function serveStatic(requestPath, response) {
  let safePath = requestPath;

  if (requestPath === "/") {
    safePath = "/index.html";
  } else if (requestPath === "/previousstats") {
    safePath = "/previousstats.html";
  } else if (requestPath === "/15minutebtc") {
    safePath = "/15minutebtc.html";
  }

  const targetPath = path.join(publicDirectory, safePath);
  const normalizedPublic = `${publicDirectory}${path.sep}`;
  const normalizedTarget = path.normalize(targetPath);

  if (!normalizedTarget.startsWith(normalizedPublic)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const body = await fs.readFile(normalizedTarget);
    const extension = path.extname(normalizedTarget);
    response.writeHead(200, {
      "content-type": contentTypes.get(extension) || "application/octet-stream",
      "cache-control": "no-store"
    });
    response.end(body);
  } catch (error) {
    if (error.code === "ENOENT") {
      sendJson(response, 404, { error: "Not found" });
      return;
    }

    sendJson(response, 500, { error: error.message });
  }
}

function routeMonitorApi(request, response, url, context) {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return true;
  }

  if (url.pathname === `${context.apiBasePath}/status`) {
    sendJson(response, 200, context.monitor.getState());
    return true;
  }

  if (url.pathname === `${context.apiBasePath}/runs`) {
    const limit = Number(url.searchParams.get("limit") || 50);
    const offset = Number(url.searchParams.get("offset") || 0);
    context.monitor
      .listRuns(limit, offset)
      .then((runs) => sendJson(response, 200, { runs }))
      .catch((error) => sendJson(response, 500, { error: error.message }));
    return true;
  }

  if (context.includeOfficialStats && url.pathname === `${context.apiBasePath}/stats/last-24h`) {
    context.monitor
      .getLast24HourOutcomeStats()
      .then((stats) => sendJson(response, 200, stats))
      .catch((error) => sendJson(response, 500, { error: error.message }));
    return true;
  }

  if (
    url.pathname.startsWith(`${context.apiBasePath}/runs/`) &&
    url.pathname.endsWith("/archive")
  ) {
    const runId = decodeURIComponent(
      url.pathname.replace(`${context.apiBasePath}/runs/`, "").replace(/\/archive$/, "")
    );

    context.monitor
      .getRunArtifact(runId)
      .then(async (artifact) => {
        if (!artifact) {
          sendJson(response, 404, { error: "Run not found" });
          return;
        }

        const body = await fs.readFile(artifact.path);
        response.writeHead(200, {
          "content-type": artifact.contentType,
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="${artifact.fileName}"`
        });
        response.end(body);
      })
      .catch((error) => sendJson(response, 500, { error: error.message }));
    return true;
  }

  if (url.pathname.startsWith(`${context.apiBasePath}/runs/`)) {
    const runId = decodeURIComponent(url.pathname.replace(`${context.apiBasePath}/runs/`, ""));
    context.monitor
      .loadRun(runId)
      .then((run) => {
        if (!run) {
          sendJson(response, 404, { error: "Run not found" });
          return;
        }

        sendJson(response, 200, run);
      })
      .catch((error) => sendJson(response, 500, { error: error.message }));
    return true;
  }

  if (url.pathname === `${context.apiBasePath}/stream`) {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    });

    response.write("\n");
    context.sseClients.add(response);
    sendSseEvent(response, "state", context.monitor.getState());

    const heartbeat = setInterval(() => {
      response.write(": keep-alive\n\n");
    }, config.streamHeartbeatMs);

    request.on("close", () => {
      clearInterval(heartbeat);
      context.sseClients.delete(response);
    });

    return true;
  }

  return false;
}

for (const context of monitorContexts) {
  context.monitor.on("state", (state) => {
    broadcast(context.sseClients, "state", state);
  });

  context.monitor.on("feed-status", (status) => {
    broadcast(context.sseClients, "feed-status", status);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    for (const context of monitorContexts) {
      const handled = routeMonitorApi(request, response, url, context);
      if (handled) {
        return;
      }
    }

    sendJson(response, 404, { error: "Not found" });
    return;
  }

  await serveStatic(url.pathname, response);
});

async function shutdown() {
  await Promise.all(monitorContexts.map((context) => context.monitor.stop()));
  server.closeAllConnections?.();
  server.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await Promise.all(monitorContexts.map((context) => context.monitor.start()));

server.listen(config.port, config.host, () => {
  console.log(`Polymarket chart bot listening on http://${config.host}:${config.port}`);
});
