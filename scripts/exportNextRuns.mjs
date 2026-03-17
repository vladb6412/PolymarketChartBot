import fs from "node:fs/promises";
import path from "node:path";

import { indexPath, previewsDir, writeRunSvg } from "./renderRunSvg.mjs";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestampOf(value) {
  return new Date(value).getTime();
}

function selectBaselineRun(index) {
  return index.find((entry) => entry.status === "live") || index[0] || null;
}

async function loadIndex() {
  const raw = await fs.readFile(indexPath, "utf8");
  return JSON.parse(raw);
}

async function main() {
  const requestedCount = Number(process.argv[2] || 3);
  const pollMs = Number(process.argv[3] || 15_000);
  const index = await loadIndex();
  const baselineRun = selectBaselineRun(index);

  if (!baselineRun) {
    throw new Error("No runs available to use as a baseline.");
  }

  const baselineStart = timestampOf(baselineRun.startedAt);
  console.log(
    `Waiting for ${requestedCount} completed runs starting at or after ${baselineRun.startedAt}`
  );

  while (true) {
    const nextIndex = await loadIndex();
    const completedRuns = nextIndex
      .filter((entry) => timestampOf(entry.startedAt) >= baselineStart && entry.status !== "live")
      .sort((left, right) => timestampOf(left.startedAt) - timestampOf(right.startedAt))
      .slice(0, requestedCount);

    console.log(
      `[${new Date().toISOString()}] completed ${completedRuns.length}/${requestedCount}`
    );

    if (completedRuns.length >= requestedCount) {
      await fs.mkdir(previewsDir, { recursive: true });

      const outputs = [];
      for (let index = 0; index < completedRuns.length; index += 1) {
        const run = completedRuns[index];
        const outputPath = path.join(previewsDir, `next-3-run-${index + 1}.svg`);
        const result = await writeRunSvg(run.id, outputPath);
        outputs.push({
          order: index + 1,
          runId: run.id,
          question: run.question,
          outputPath: result.outputPath
        });
      }

      console.log(JSON.stringify(outputs, null, 2));
      return;
    }

    await sleep(pollMs);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
