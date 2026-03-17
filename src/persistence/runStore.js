import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";
import { ensureDirectory, readJsonFile, writeJsonFile } from "../lib/fs.js";
import { compareIsoStrings, isoNow } from "../lib/time.js";

const runIndexPath = path.join(config.dataDir, "runs-index.json");
const runsDirectory = path.join(config.dataDir, "runs");

export class RunStore {
  constructor() {
    this.index = [];
    this.ready = false;
    this.indexWriteTimer = null;
  }

  async init() {
    await ensureDirectory(config.dataDir);
    await ensureDirectory(runsDirectory);
    try {
      const loadedIndex = await readJsonFile(runIndexPath, []);
      this.index = Array.isArray(loadedIndex) ? loadedIndex : [];
    } catch (error) {
      console.warn("Run index could not be read, rebuilding from run files", error.message);
      this.index = await this.rebuildIndexFromFiles();
      await writeJsonFile(runIndexPath, this.index);
    }
    this.ready = true;
  }

  async rebuildIndexFromFiles() {
    const files = await fs.readdir(runsDirectory);
    const summaries = [];

    for (const fileName of files) {
      if (!fileName.endsWith(".jsonl")) {
        continue;
      }

      const summary = await this.readRunSummaryFromFile(fileName.replace(/\.jsonl$/, ""));
      if (summary) {
        summaries.push(summary);
      }
    }

    summaries.sort((left, right) => compareIsoStrings(right.startedAt, left.startedAt));
    return summaries;
  }

  async readRunSummaryFromFile(runId) {
    try {
      const raw = await fs.readFile(this.getRunFilePath(runId), "utf8");
      const lines = raw.split("\n").filter(Boolean);

      if (lines.length === 0) {
        return null;
      }

      const firstPoint = JSON.parse(lines[0]);
      const lastPoint = JSON.parse(lines.at(-1));
      const outcomes = Object.values(lastPoint.prices || {})
        .filter((price) => price?.assetId)
        .map((price) => ({
          key: price.key,
          label: price.label,
          assetId: price.assetId
        }));

      return {
        id: runId,
        status:
          new Date(firstPoint.marketEndsAt).getTime() > Date.now() ? "live" : "recorded",
        marketId: firstPoint.marketId,
        slug: firstPoint.marketSlug,
        question: firstPoint.marketQuestion,
        eventTitle: firstPoint.marketQuestion,
        startedAt: firstPoint.marketStartedAt,
        recordingStartedAt: firstPoint.recordedAt,
        endsAt: firstPoint.marketEndsAt,
        outcomes,
        createdAt: firstPoint.recordedAt,
        pointCount: lines.length,
        lastRecordedAt: lastPoint.recordedAt,
        endedAt:
          new Date(firstPoint.marketEndsAt).getTime() <= Date.now()
            ? lastPoint.recordedAt
            : null
      };
    } catch (error) {
      console.warn(`Failed to summarize run file ${runId}`, error.message);
      return null;
    }
  }

  async saveRunSummary(summary) {
    const existingIndex = this.index.findIndex((entry) => entry.id === summary.id);
    if (existingIndex >= 0) {
      this.index[existingIndex] = summary;
    } else {
      this.index.unshift(summary);
    }

    this.index.sort((left, right) => compareIsoStrings(right.startedAt, left.startedAt));
    await writeJsonFile(runIndexPath, this.index);
  }

  scheduleIndexWrite() {
    if (this.indexWriteTimer) {
      return;
    }

    this.indexWriteTimer = setTimeout(async () => {
      this.indexWriteTimer = null;
      try {
        await writeJsonFile(runIndexPath, this.index);
      } catch (error) {
        console.error("Failed to flush run index", error);
      }
    }, 1_000);
  }

  getRunFilePath(runId) {
    return path.join(runsDirectory, `${runId}.jsonl`);
  }

  async startRun(summary) {
    if (!this.ready) {
      await this.init();
    }

    const runSummary = {
      ...summary,
      createdAt: isoNow(),
      pointCount: 0
    };

    await fs.writeFile(this.getRunFilePath(summary.id), "", "utf8");
    await this.saveRunSummary(runSummary);
    return runSummary;
  }

  async appendSnapshot(runId, snapshot) {
    await fs.appendFile(this.getRunFilePath(runId), `${JSON.stringify(snapshot)}\n`, "utf8");

    const summary = this.index.find((entry) => entry.id === runId);
    if (summary) {
      summary.pointCount += 1;
      summary.lastRecordedAt = snapshot.recordedAt;
      this.scheduleIndexWrite();
    }
  }

  async finishRun(runId, patch) {
    const summary = this.index.find((entry) => entry.id === runId);
    if (!summary) {
      return;
    }

    Object.assign(summary, patch, { updatedAt: isoNow() });
    await this.saveRunSummary(summary);
  }

  async listRuns(limit = 50) {
    if (!this.ready) {
      await this.init();
    }

    return this.getCachedRuns(limit);
  }

  getCachedRuns(limit = 50) {
    return this.index.slice(0, limit);
  }

  async loadRun(runId) {
    if (!this.ready) {
      await this.init();
    }

    const summary =
      this.index.find((entry) => entry.id === runId) ||
      (await this.readRunSummaryFromFile(runId));

    if (!summary) {
      return null;
    }

    const raw = await fs.readFile(this.getRunFilePath(runId), "utf8");
    const points = raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    return {
      run: summary,
      points
    };
  }

  async flush() {
    if (this.indexWriteTimer) {
      clearTimeout(this.indexWriteTimer);
      this.indexWriteTimer = null;
    }

    await writeJsonFile(runIndexPath, this.index);
  }
}
