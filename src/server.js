import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";

import { config } from "./config.js";
import { MonitorService } from "./monitor.js";

const publicDirectory = path.join(process.cwd(), "public");
const monitor = new MonitorService();
const sseClients = new Set();

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

function broadcast(event, payload) {
  for (const response of sseClients) {
    sendSseEvent(response, event, payload);
  }
}

async function serveStatic(requestPath, response) {
  let safePath = requestPath;

  if (requestPath === "/") {
    safePath = "/index.html";
  } else if (requestPath === "/previousstats") {
    safePath = "/previousstats.html";
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

function routeApi(request, response, url) {
  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" });
    return true;
  }

  if (url.pathname === "/api/status") {
    sendJson(response, 200, monitor.getState());
    return true;
  }

  if (url.pathname === "/api/runs") {
    const limit = Number(url.searchParams.get("limit") || 50);
    const offset = Number(url.searchParams.get("offset") || 0);
    monitor
      .listRuns(limit, offset)
      .then((runs) => sendJson(response, 200, { runs }))
      .catch((error) => sendJson(response, 500, { error: error.message }));
    return true;
  }

  if (url.pathname === "/api/stats/last-24h") {
    monitor
      .getLast24HourOutcomeStats()
      .then((stats) => sendJson(response, 200, stats))
      .catch((error) => sendJson(response, 500, { error: error.message }));
    return true;
  }

  if (url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/archive")) {
    const runId = decodeURIComponent(
      url.pathname.replace("/api/runs/", "").replace(/\/archive$/, "")
    );

    monitor
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

  if (url.pathname.startsWith("/api/runs/")) {
    const runId = decodeURIComponent(url.pathname.replace("/api/runs/", ""));
    monitor
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

  if (url.pathname === "/api/stream") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive"
    });

    response.write("\n");
    sseClients.add(response);
    sendSseEvent(response, "state", monitor.getState());

    const heartbeat = setInterval(() => {
      response.write(": keep-alive\n\n");
    }, config.streamHeartbeatMs);

    request.on("close", () => {
      clearInterval(heartbeat);
      sseClients.delete(response);
    });

    return true;
  }

  return false;
}

monitor.on("state", (state) => {
  broadcast("state", state);
});

monitor.on("feed-status", (status) => {
  broadcast("feed-status", status);
});

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    const handled = routeApi(request, response, url);
    if (!handled) {
      sendJson(response, 404, { error: "Not found" });
    }
    return;
  }

  await serveStatic(url.pathname, response);
});

async function shutdown() {
  await monitor.stop();
  server.closeAllConnections?.();
  server.close();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await monitor.start();

server.listen(config.port, config.host, () => {
  console.log(`Polymarket chart bot listening on http://${config.host}:${config.port}`);
});
