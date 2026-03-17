import fs from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outputDirectory = path.join(root, "data", "runs");
const indexPath = path.join(root, "data", "runs-index.json");

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createBaseUrl(value) {
  if (!value) {
    throw new Error(
      "Remote base URL is required. Pass it as the first argument or set REMOTE_BASE_URL."
    );
  }

  return new URL(value.endsWith("/") ? value : `${value}/`);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }

  return response.json();
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function fetchAllRuns(baseUrl, pageSize) {
  const runs = [];
  let offset = 0;

  while (true) {
    const url = new URL("/api/runs", baseUrl);
    url.searchParams.set("limit", `${pageSize}`);
    url.searchParams.set("offset", `${offset}`);

    const payload = await fetchJson(url);
    const page = Array.isArray(payload.runs) ? payload.runs : [];

    if (page.length === 0) {
      break;
    }

    runs.push(...page);
    offset += page.length;

    if (page.length < pageSize) {
      break;
    }
  }

  return runs;
}

async function downloadRunArtifact(baseUrl, run) {
  const fileName =
    run.fileName || `${run.id}.${run.storageFormat || (run.status === "live" ? "jsonl" : "jsonl.gz")}`;
  const targetPath = path.join(outputDirectory, fileName);

  if (await fileExists(targetPath)) {
    return { runId: run.id, fileName, downloaded: false };
  }

  const url = new URL(`/api/runs/${encodeURIComponent(run.id)}/archive`, baseUrl);
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Archive download failed (${response.status}) for ${run.id}`);
  }

  const body = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(targetPath, body);

  return { runId: run.id, fileName, downloaded: true, bytes: body.length };
}

async function main() {
  const baseUrl = createBaseUrl(process.argv[2] || process.env.REMOTE_BASE_URL);
  const pageSize = parseNumber(process.argv[3], 200);

  await fs.mkdir(outputDirectory, { recursive: true });

  const runs = await fetchAllRuns(baseUrl, pageSize);
  const results = [];

  for (const run of runs) {
    results.push(await downloadRunArtifact(baseUrl, run));
  }

  await fs.writeFile(indexPath, JSON.stringify(runs, null, 2), "utf8");

  const downloadedCount = results.filter((entry) => entry.downloaded).length;
  const downloadedBytes = results.reduce(
    (total, entry) => total + (entry.bytes || 0),
    0
  );

  console.log(
    JSON.stringify(
      {
        remote: baseUrl.origin,
        runCount: runs.length,
        downloadedCount,
        downloadedBytes
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
