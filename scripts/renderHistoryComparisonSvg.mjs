import fs from "node:fs/promises";
import path from "node:path";

import { readRunArtifactPoints, resolveRunArtifactPath } from "../src/persistence/runArtifacts.js";

const root = process.cwd();
const previewsDir = path.join(root, "data", "previews");
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

async function loadRunFromFile(runId) {
  const runPath = await resolveRunArtifactPath(runsDirectory, runId);
  const points = await readRunArtifactPoints(runPath);

  if (points.length === 0) {
    throw new Error(`Run file has no snapshots: ${runId}`);
  }

  const firstPoint = points[0];
  const firstCompletePoint = points.find((point) =>
    Object.values(point.prices || {}).every((price) => price?.assetId)
  );
  const prices = firstCompletePoint?.prices || firstPoint.prices || {};
  const outcomes = Object.values(prices).map((price, index) => ({
    key: price.key,
    label: price.label,
    assetId: price.assetId,
    color: colorForKey(price.key, index)
  }));

  return {
    run: {
      id: runId,
      question: firstPoint.marketQuestion,
      startedAt: firstPoint.marketStartedAt,
      endsAt: firstPoint.marketEndsAt,
      status: "recorded",
      outcomes
    },
    points
  };
}

async function fetchHistory(assetId, startTs, endTs) {
  const params = new URLSearchParams({
    market: assetId,
    startTs: `${startTs}`,
    endTs: `${endTs}`,
    fidelity: "1"
  });

  const response = await fetch(`https://clob.polymarket.com/prices-history?${params.toString()}`, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`History request failed for asset ${assetId}: ${response.status}`);
  }

  const payload = await response.json();
  return Array.isArray(payload.history) ? payload.history : [];
}

function toSvgPath(points, plot) {
  if (points.length === 0) {
    return "";
  }

  return points
    .map((point, index) => {
      const x = plot.x + (point.elapsedMs / plot.maxElapsedMs) * plot.width;
      const y = plot.y + (1 - point.value) * plot.height;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function markerCircles(points, plot, color) {
  return points
    .map((point) => {
      const x = plot.x + (point.elapsedMs / plot.maxElapsedMs) * plot.width;
      const y = plot.y + (1 - point.value) * plot.height;
      return `<circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="5.5" fill="${color}" stroke="#fffaf1" stroke-width="2" />`;
    })
    .join("");
}

function buildComparisonSvg(run, recordedSeries, apiSeries) {
  const width = 1600;
  const height = 920;
  const plot = {
    x: 130,
    y: 220,
    width: 1320,
    height: 520,
    maxElapsedMs: Math.max(5 * 60 * 1000, new Date(run.endsAt).getTime() - new Date(run.startedAt).getTime())
  };

  const gridLines = Array.from({ length: 6 }, (_, step) => {
    const y = plot.y + (plot.height / 5) * step;
    return `<line x1="${plot.x}" y1="${y}" x2="${plot.x + plot.width}" y2="${y}" stroke="rgba(28,35,32,0.12)" stroke-width="1" />`;
  }).join("");

  const verticalGridLines = Array.from({ length: 6 }, (_, step) => {
    const x = plot.x + (plot.width / 5) * step;
    return `<line x1="${x}" y1="${plot.y}" x2="${x}" y2="${plot.y + plot.height}" stroke="rgba(28,35,32,0.10)" stroke-width="1" />`;
  }).join("");

  const yLabels = Array.from({ length: 6 }, (_, step) => {
    const y = plot.y + (plot.height / 5) * step + 6;
    const value = 100 - step * 20;
    return `<text x="${plot.x - 18}" y="${y}" text-anchor="end" font-family="'IBM Plex Mono', monospace" font-size="18" fill="#5d675f">${value}%</text>`;
  }).join("");

  const xLabels = Array.from({ length: 6 }, (_, step) => {
    const x = plot.x + (plot.width / 5) * step;
    return `<text x="${x}" y="${plot.y + plot.height + 38}" text-anchor="middle" font-family="'IBM Plex Mono', monospace" font-size="18" fill="#5d675f">${step}m</text>`;
  }).join("");

  const legend = run.outcomes
    .map((outcome, index) => {
      const y = 150 + index * 42;
      return `
        <line x1="980" y1="${y}" x2="1035" y2="${y}" stroke="${outcome.color}" stroke-width="4" />
        <text x="1048" y="${y + 6}" font-family="'IBM Plex Mono', monospace" font-size="18" fill="#1c2320">${escapeXml(outcome.label.toUpperCase())} recorded (${recordedSeries[outcome.key].length})</text>
        <line x1="1280" y1="${y}" x2="1335" y2="${y}" stroke="${outcome.color}" stroke-width="4" stroke-dasharray="14 10" />
        <text x="1348" y="${y + 6}" font-family="'IBM Plex Mono', monospace" font-size="18" fill="#1c2320">${escapeXml(outcome.label.toUpperCase())} API (${apiSeries[outcome.key].length})</text>
      `;
    })
    .join("");

  const recordedPaths = run.outcomes
    .map((outcome) => {
      const pathValue = toSvgPath(recordedSeries[outcome.key], plot);
      return pathValue
        ? `<path d="${pathValue}" fill="none" stroke="${outcome.color}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round" />`
        : "";
    })
    .join("");

  const apiPaths = run.outcomes
    .map((outcome) => {
      const pathValue = toSvgPath(apiSeries[outcome.key], plot);
      if (!pathValue) {
        return "";
      }

      return `
        <path d="${pathValue}" fill="none" stroke="${outcome.color}" stroke-width="4" stroke-dasharray="14 10" stroke-linejoin="round" stroke-linecap="round" opacity="0.95" />
        ${markerCircles(apiSeries[outcome.key], plot, outcome.color)}
      `;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="${width}" height="${height}" fill="#f3e8d8"/>
  <rect x="30" y="30" width="${width - 60}" height="${height - 60}" rx="30" fill="#fffaf1" stroke="rgba(28,35,32,0.12)"/>
  <text x="80" y="95" font-family="'IBM Plex Mono', monospace" font-size="22" letter-spacing="3" fill="#5d675f">RECORDED VS /PRICES-HISTORY</text>
  <text x="80" y="138" font-family="'Iowan Old Style', Georgia, serif" font-size="38" fill="#1c2320">${escapeXml(run.question)}</text>
  <text x="80" y="168" font-family="'IBM Plex Mono', monospace" font-size="18" fill="#5d675f">${escapeXml(formatTimeWindow(run.startedAt, run.endsAt))} · solid = recorded displayed price · dashed = API history (fidelity=1m)</text>
  ${legend}
  ${gridLines}
  ${verticalGridLines}
  <rect x="${plot.x}" y="${plot.y}" width="${plot.width}" height="${plot.height}" fill="none" stroke="#1c2320" stroke-width="2"/>
  ${yLabels}
  ${xLabels}
  ${recordedPaths}
  ${apiPaths}
  <text x="${plot.x}" y="${plot.y + plot.height + 82}" font-family="'IBM Plex Mono', monospace" font-size="18" fill="#5d675f">Elapsed through market</text>
  <text x="${plot.x}" y="${plot.y + plot.height + 112}" font-family="'IBM Plex Mono', monospace" font-size="16" fill="#5d675f">Observed result for this run: the API series is much sparser and does not exactly match the recorded displayed-price line.</text>
</svg>`;
}

async function main() {
  const runId = process.argv[2] || "btc-updown-5m-1773702300-1773702300000-1773702308635";
  const outputPath =
    process.argv[3] || path.join(previewsDir, `${runId}-comparison.svg`);

  const { run, points } = await loadRunFromFile(runId);
  const startTs = Math.floor(new Date(run.startedAt).getTime() / 1000);
  const endTs = Math.floor(new Date(run.endsAt).getTime() / 1000);

  const recordedSeries = {};
  for (const outcome of run.outcomes) {
    recordedSeries[outcome.key] = points
      .map((point) => ({
        elapsedMs: point.elapsedMs,
        value: point.prices?.[outcome.key]?.displayedPrice
      }))
      .filter((point) => point.value !== null && point.value !== undefined);
  }

  const apiSeries = {};
  for (const outcome of run.outcomes) {
    const history = await fetchHistory(outcome.assetId, startTs, endTs);
    apiSeries[outcome.key] = history.map((point) => ({
      elapsedMs: point.t * 1000 - new Date(run.startedAt).getTime(),
      value: point.p
    }));
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buildComparisonSvg(run, recordedSeries, apiSeries), "utf8");
  console.log(outputPath);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
