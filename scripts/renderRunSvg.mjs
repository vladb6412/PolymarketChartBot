import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  RAW_RUN_STORAGE_FORMAT,
  buildRunArtifactFileName,
  readRunArtifactPoints,
  resolveRunArtifactPath
} from "../src/persistence/runArtifacts.js";

export const root = process.cwd();
export const indexPath = path.join(root, "data", "runs-index.json");
export const previewsDir = path.join(root, "data", "previews");
const runsDirectory = path.join(root, "data", "runs");

function escapeXml(value) {
  return `${value}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function colorForKey(key, index) {
  if (/up|yes/i.test(key)) {
    return "#157f53";
  }

  if (/down|no/i.test(key)) {
    return "#c03a2b";
  }

  return index === 0 ? "#157f53" : "#c03a2b";
}

function formatProbability(value) {
  if (value === null || value === undefined) {
    return "-";
  }

  return `${(value * 100).toFixed(1)}%`;
}

function formatTimeWindow(startValue, endValue) {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC"
  });

  return `${formatter.format(new Date(startValue))} - ${formatter.format(new Date(endValue))} UTC`;
}

export async function loadRun(runId) {
  const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
  const run =
    index.find((entry) => entry.id === runId) ||
    index.find((entry) => entry.status !== "live") ||
    index[0];

  if (!run) {
    throw new Error("No recorded runs found.");
  }

  const pointsPath = await resolveRunArtifactPath(runsDirectory, run.id, {
    ...run,
    storageFormat: run.storageFormat || RAW_RUN_STORAGE_FORMAT,
    fileName:
      run.fileName ||
      buildRunArtifactFileName(run.id, run.storageFormat || RAW_RUN_STORAGE_FORMAT)
  });
  const points = await readRunArtifactPoints(pointsPath);

  return { run, points };
}

function toPath(points, plot) {
  if (points.length === 0) {
    return "";
  }

  return points
    .map((point, index) => {
      const x = plot.x + (point.elapsedMs / plot.maxElapsedMs) * plot.width;
      const y = plot.y + (1 - point.displayedPrice) * plot.height;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

export function buildSvg(run, points) {
  const width = 1400;
  const height = 820;
  const plot = {
    x: 120,
    y: 180,
    width: 1160,
    height: 500,
    maxElapsedMs: Math.max(
      5 * 60 * 1000,
      points.at(-1)?.elapsedMs ?? new Date(run.endsAt).getTime() - new Date(run.startedAt).getTime()
    )
  };

  const series = run.outcomes.map((outcome, index) => ({
    ...outcome,
    color: colorForKey(outcome.key, index),
    samples: points
      .map((point) => ({
        elapsedMs: point.elapsedMs,
        displayedPrice: point.prices?.[outcome.key]?.displayedPrice
      }))
      .filter((point) => point.displayedPrice !== null && point.displayedPrice !== undefined)
  }));

  const gridLines = Array.from({ length: 6 }, (_, step) => {
    const y = plot.y + (plot.height / 5) * step;
    return `<line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.width}" y2="${y}" stroke="rgba(28,35,32,0.12)" stroke-width="1" />`;
  }).join("");

  const verticalGridLines = Array.from({ length: 6 }, (_, step) => {
    const x = plot.x + (plot.width / 5) * step;
    return `<line x1="${x}" y1="${plot.y}" x2="${x}" y2="${plot.y + plot.height}" stroke="rgba(28,35,32,0.10)" stroke-width="1" />`;
  }).join("");

  const yLabels = Array.from({ length: 6 }, (_, step) => {
    const y = plot.y + (plot.height / 5) * step + 4;
    const value = 100 - step * 20;
    return `<text x="${plot.x - 20}" y="${y}" text-anchor="end" font-family="'IBM Plex Mono', monospace" font-size="18" fill="#5d675f">${value}%</text>`;
  }).join("");

  const xLabels = Array.from({ length: 6 }, (_, step) => {
    const x = plot.x + (plot.width / 5) * step;
    return `<text x="${x}" y="${plot.y + plot.height + 38}" text-anchor="middle" font-family="'IBM Plex Mono', monospace" font-size="18" fill="#5d675f">${step}m</text>`;
  }).join("");

  const paths = series
    .map((entry) => {
      const pathValue = toPath(entry.samples, plot);
      if (!pathValue) {
        return "";
      }

      const latest = entry.samples.at(-1);
      return `
        <path d="${pathValue}" fill="none" stroke="${entry.color}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round" />
        <text x="${plot.x + plot.width - 10}" y="${plot.y - 54 + (entry.key === run.outcomes[0].key ? 0 : 34)}" text-anchor="end" font-family="'IBM Plex Mono', monospace" font-size="20" fill="${entry.color}">${escapeXml(entry.label.toUpperCase())}: ${formatProbability(latest.displayedPrice)}</text>
      `;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="#f3e8d8"/>
  <rect x="30" y="30" width="${width - 60}" height="${height - 60}" rx="30" fill="#fffaf1" stroke="rgba(28,35,32,0.12)"/>
  <text x="80" y="95" font-family="'IBM Plex Mono', monospace" font-size="22" letter-spacing="3" fill="#5d675f">POLYMARKET BTC 5M RUN</text>
  <text x="80" y="138" font-family="'Iowan Old Style', Georgia, serif" font-size="38" fill="#1c2320">${escapeXml(run.question)}</text>
  <text x="80" y="168" font-family="'IBM Plex Mono', monospace" font-size="18" fill="#5d675f">${escapeXml(formatTimeWindow(run.startedAt, run.endsAt))} · ${points.length} snapshots · ${escapeXml(run.status.toUpperCase())}</text>
  ${gridLines}
  ${verticalGridLines}
  <rect x="${plot.x}" y="${plot.y}" width="${plot.width}" height="${plot.height}" fill="none" stroke="#1c2320" stroke-width="2"/>
  ${yLabels}
  ${xLabels}
  ${paths}
  <text x="${plot.x}" y="${plot.y + plot.height + 80}" font-family="'IBM Plex Mono', monospace" font-size="18" fill="#5d675f">Elapsed through market</text>
</svg>`;
}

export async function writeRunSvg(runId, outputPath) {
  const resolvedOutputPath =
    outputPath ||
    path.join(previewsDir, `${runId || "latest"}.svg`);
  const { run, points } = await loadRun(runId);
  await fs.mkdir(path.dirname(resolvedOutputPath), { recursive: true });
  await fs.writeFile(resolvedOutputPath, buildSvg(run, points), "utf8");

  return {
    run,
    points,
    outputPath: resolvedOutputPath
  };
}

async function main() {
  const requestedRunId = process.argv[2];
  const outputPath = process.argv[3];
  const result = await writeRunSvg(requestedRunId, outputPath);
  console.log(result.outputPath);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
