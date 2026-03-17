import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../config.js";
import {
  buildLast24HourOutcomeStats,
  inferOutcomeFromPoints,
  selectRepresentativeCompletedRuns
} from "../domain/outcomeStats.js";
import { ensureDirectory, readJsonFile, writeJsonFile } from "../lib/fs.js";
import { compareIsoStrings, isoNow } from "../lib/time.js";
import {
  COMPRESSED_RUN_STORAGE_FORMAT,
  RAW_RUN_STORAGE_FORMAT,
  buildRunArtifactFileName,
  compressRunArtifact,
  extractRunIdFromFileName,
  getStorageFormatForFileName,
  isRunArtifactFileName,
  readRunArtifactPoints,
  resolveRunArtifactPath
} from "./runArtifacts.js";

const runIndexPath = path.join(config.dataDir, "runs-index.json");
const runsDirectory = path.join(config.dataDir, "runs");

export class RunStore {
  constructor() {
    this.index = [];
    this.ready = false;
    this.indexWriteTimer = null;
    this.pendingCompression = new Map();
    this.last24HourStatsCache = null;
  }

  async init() {
    await ensureDirectory(config.dataDir);
    await ensureDirectory(runsDirectory);
    try {
      const loadedIndex = await readJsonFile(runIndexPath, []);
      this.index = Array.isArray(loadedIndex)
        ? loadedIndex.map((entry) => this.normalizeSummary(entry))
        : [];
    } catch (error) {
      console.warn("Run index could not be read, rebuilding from run files", error.message);
      this.index = await this.rebuildIndexFromFiles();
      await writeJsonFile(runIndexPath, this.index);
    }
    await this.reconcileLiveRuns();
    this.ready = true;
    this.queueArchivedCompressionSweep();
  }

  async rebuildIndexFromFiles() {
    const files = await fs.readdir(runsDirectory);
    const summaries = new Map();
    const sortedFiles = files
      .filter(isRunArtifactFileName)
      .sort((left, right) => {
        const leftPriority = left.endsWith(`.${COMPRESSED_RUN_STORAGE_FORMAT}`) ? 0 : 1;
        const rightPriority = right.endsWith(`.${COMPRESSED_RUN_STORAGE_FORMAT}`) ? 0 : 1;

        return leftPriority - rightPriority || left.localeCompare(right);
      });

    for (const fileName of sortedFiles) {
      const runId = extractRunIdFromFileName(fileName);

      if (!runId || summaries.has(runId)) {
        continue;
      }

      const summary = await this.readRunSummaryFromFile(fileName);
      if (summary) {
        summaries.set(runId, summary);
      }
    }

    return [...summaries.values()].sort((left, right) =>
      compareIsoStrings(right.startedAt, left.startedAt)
    );
  }

  normalizeSummary(summary) {
    const storageFormat =
      summary.storageFormat ||
      getStorageFormatForFileName(summary.fileName || "") ||
      RAW_RUN_STORAGE_FORMAT;
    const fileName =
      summary.fileName || buildRunArtifactFileName(summary.id, storageFormat);
    const archiveStatus =
      summary.archiveStatus ||
      (summary.status === "live"
        ? "live"
        : storageFormat === COMPRESSED_RUN_STORAGE_FORMAT
          ? "ready"
          : "pending");

    return {
      ...summary,
      storageFormat,
      fileName,
      archiveStatus
    };
  }

  async readRunSummaryFromFile(fileName) {
    const runId = extractRunIdFromFileName(fileName);

    if (!runId) {
      return null;
    }

    try {
      const filePath = path.join(runsDirectory, fileName);
      const points = await readRunArtifactPoints(filePath);

      if (points.length === 0) {
        return null;
      }

      const [fileStats, firstPoint, lastPoint] = await Promise.all([
        fs.stat(filePath),
        Promise.resolve(points[0]),
        Promise.resolve(points.at(-1))
      ]);
      const outcomes = Object.values(lastPoint.prices || {})
        .filter((price) => price?.assetId)
        .map((price) => ({
          key: price.key,
          label: price.label,
          assetId: price.assetId
        }));
      const storageFormat = getStorageFormatForFileName(fileName) || RAW_RUN_STORAGE_FORMAT;
      const status =
        new Date(firstPoint.marketEndsAt).getTime() > Date.now() ? "live" : "recorded";

      return this.normalizeSummary({
        id: runId,
        status,
        marketId: firstPoint.marketId,
        slug: firstPoint.marketSlug,
        question: firstPoint.marketQuestion,
        eventTitle: firstPoint.marketQuestion,
        startedAt: firstPoint.marketStartedAt,
        recordingStartedAt: firstPoint.recordedAt,
        endsAt: firstPoint.marketEndsAt,
        outcomes,
        createdAt: firstPoint.recordedAt,
        pointCount: points.length,
        lastRecordedAt: lastPoint.recordedAt,
        endedAt:
          new Date(firstPoint.marketEndsAt).getTime() <= Date.now()
            ? lastPoint.recordedAt
            : null,
        fileName,
        storageFormat,
        storageBytes: fileStats.size,
        rawBytes: storageFormat === RAW_RUN_STORAGE_FORMAT ? fileStats.size : null,
        archiveStatus:
          status === "live"
            ? "live"
            : storageFormat === COMPRESSED_RUN_STORAGE_FORMAT
              ? "ready"
              : "pending"
      });
    } catch (error) {
      console.warn(`Failed to summarize run file ${runId}`, error.message);
      return null;
    }
  }

  async saveRunSummary(summary) {
    const normalizedSummary = this.normalizeSummary(summary);
    const existingIndex = this.index.findIndex((entry) => entry.id === summary.id);
    if (existingIndex >= 0) {
      this.index[existingIndex] = normalizedSummary;
    } else {
      this.index.unshift(normalizedSummary);
    }

    this.index.sort((left, right) => compareIsoStrings(right.startedAt, left.startedAt));
    this.invalidateDerivedCaches();
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

  getRunFilePath(runId, storageFormat = RAW_RUN_STORAGE_FORMAT) {
    return path.join(runsDirectory, buildRunArtifactFileName(runId, storageFormat));
  }

  async resolveRunFilePath(runId, summary = null) {
    return resolveRunArtifactPath(runsDirectory, runId, summary);
  }

  queueArchivedCompressionSweep() {
    for (const summary of this.index) {
      if (summary.status === "live" || summary.storageFormat === COMPRESSED_RUN_STORAGE_FORMAT) {
        continue;
      }

      this.queueRunCompression(summary.id);
    }
  }

  queueRunCompression(runId) {
    if (this.pendingCompression.has(runId)) {
      return this.pendingCompression.get(runId);
    }

    const task = this.compressRun(runId)
      .catch((error) => {
        console.error(`Failed to compress run ${runId}`, error.message);
      })
      .finally(() => {
        this.pendingCompression.delete(runId);
      });

    this.pendingCompression.set(runId, task);
    return task;
  }

  async compressRun(runId) {
    const summary = this.index.find((entry) => entry.id === runId);

    if (!summary || summary.status === "live") {
      return;
    }

    const currentPath = await this.resolveRunFilePath(runId, summary);
    const currentFileName = path.basename(currentPath);
    const currentStorageFormat =
      getStorageFormatForFileName(currentFileName) || RAW_RUN_STORAGE_FORMAT;

    if (currentStorageFormat === COMPRESSED_RUN_STORAGE_FORMAT) {
      if (summary.storageFormat !== COMPRESSED_RUN_STORAGE_FORMAT) {
        await this.saveRunSummary({
          ...summary,
          fileName: currentFileName,
          storageFormat: COMPRESSED_RUN_STORAGE_FORMAT,
          archiveStatus: "ready"
        });
      }
      return;
    }

    await this.saveRunSummary({
      ...summary,
      fileName: currentFileName,
      storageFormat: RAW_RUN_STORAGE_FORMAT,
      archiveStatus: "compressing",
      archiveError: null
    });

    try {
      const { outputPath, inputBytes, outputBytes } = await compressRunArtifact(currentPath);

      try {
        await fs.unlink(currentPath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }

      await this.saveRunSummary({
        ...summary,
        fileName: path.basename(outputPath),
        storageFormat: COMPRESSED_RUN_STORAGE_FORMAT,
        archiveStatus: "ready",
        compressedAt: isoNow(),
        archiveError: null,
        rawBytes: inputBytes,
        storageBytes: outputBytes
      });
    } catch (error) {
      await this.saveRunSummary({
        ...summary,
        fileName: currentFileName,
        storageFormat: RAW_RUN_STORAGE_FORMAT,
        archiveStatus: "failed",
        archiveError: error.message
      });
      throw error;
    }
  }

  async startRun(summary) {
    if (!this.ready) {
      await this.init();
    }

    const runSummary = this.normalizeSummary({
      ...summary,
      createdAt: isoNow(),
      pointCount: 0,
      storageFormat: RAW_RUN_STORAGE_FORMAT,
      fileName: buildRunArtifactFileName(summary.id, RAW_RUN_STORAGE_FORMAT),
      archiveStatus: "live"
    });

    await fs.writeFile(this.getRunFilePath(summary.id, RAW_RUN_STORAGE_FORMAT), "", "utf8");
    await this.saveRunSummary(runSummary);
    return runSummary;
  }

  async appendSnapshot(runId, snapshot) {
    const summary = this.index.find((entry) => entry.id === runId);
    const targetPath =
      summary?.fileName
        ? path.join(runsDirectory, summary.fileName)
        : this.getRunFilePath(runId, RAW_RUN_STORAGE_FORMAT);

    await fs.appendFile(targetPath, `${JSON.stringify(snapshot)}\n`, "utf8");

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

    Object.assign(summary, patch, {
      updatedAt: isoNow(),
      archiveStatus:
        summary.storageFormat === COMPRESSED_RUN_STORAGE_FORMAT ? "ready" : "pending"
    });
    await this.saveRunSummary(summary);

    if (summary.storageFormat !== COMPRESSED_RUN_STORAGE_FORMAT) {
      this.queueRunCompression(runId);
    }
  }

  async listRuns(limit = 50, offset = 0) {
    if (!this.ready) {
      await this.init();
    }

    return this.getCachedRuns(limit, offset);
  }

  getCachedRuns(limit = 50, offset = 0) {
    const start = Math.max(0, Number(offset) || 0);
    return this.index.slice(start, start + limit);
  }

  async reconcileLiveRuns(now = Date.now()) {
    const liveGroups = new Map();

    for (const summary of this.index.filter((entry) => entry.status === "live")) {
      const key = `${summary.marketId || summary.slug}|${summary.startedAt}`;
      const group = liveGroups.get(key) || [];
      group.push(summary);
      liveGroups.set(key, group);
    }

    for (const group of liveGroups.values()) {
      group.sort(compareResumableRuns);

      for (let index = 1; index < group.length; index += 1) {
        await this.retireDuplicateLiveRun(group[index]);
      }

      const primary = group[0];
      if (primary && new Date(primary.endsAt).getTime() <= now) {
        await this.retireExpiredLiveRun(primary);
      }
    }
  }

  async retireDuplicateLiveRun(summary) {
    if ((summary.pointCount || 0) === 0) {
      await this.removeRun(summary.id);
      return;
    }

    await this.finishRun(summary.id, {
      status: "interrupted",
      endedAt: summary.lastRecordedAt || isoNow()
    });
  }

  async retireExpiredLiveRun(summary) {
    if ((summary.pointCount || 0) === 0) {
      await this.removeRun(summary.id);
      return;
    }

    await this.finishRun(summary.id, {
      status: "interrupted",
      endedAt: summary.lastRecordedAt || summary.endsAt || isoNow()
    });
  }

  async removeRun(runId) {
    const summary = this.index.find((entry) => entry.id === runId);

    if (!summary) {
      return;
    }

    try {
      const filePath = await this.resolveRunFilePath(runId, summary);
      await fs.rm(filePath, { force: true });
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    this.index = this.index.filter((entry) => entry.id !== runId);
    this.invalidateDerivedCaches();
    await writeJsonFile(runIndexPath, this.index);
  }

  invalidateDerivedCaches() {
    this.last24HourStatsCache = null;
  }

  async findResumableRun(market) {
    if (!this.ready) {
      await this.init();
    }

    const candidates = this.index
      .filter(
        (entry) =>
          entry.status === "live" &&
          entry.startedAt === market.startDate &&
          (entry.marketId === market.id || entry.slug === market.slug)
      )
      .sort(compareResumableRuns);

    for (const candidate of candidates) {
      try {
        const filePath = await this.resolveRunFilePath(candidate.id, candidate);
        await fs.access(filePath);
        return this.normalizeSummary({
          ...candidate,
          fileName: path.basename(filePath),
          storageFormat:
            getStorageFormatForFileName(path.basename(filePath)) || candidate.storageFormat
        });
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }

    return null;
  }

  async readRunSummaryForRunId(runId) {
    const filePath = await this.resolveRunFilePath(runId);

    try {
      await fs.access(filePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }

      throw error;
    }

    return this.readRunSummaryFromFile(path.basename(filePath));
  }

  async loadRun(runId) {
    if (!this.ready) {
      await this.init();
    }

    const summary =
      this.index.find((entry) => entry.id === runId) || (await this.readRunSummaryForRunId(runId));

    if (!summary) {
      return null;
    }

    const filePath = await this.resolveRunFilePath(runId, summary);
    const points = await readRunArtifactPoints(filePath);
    const resolvedSummary = this.normalizeSummary({
      ...summary,
      fileName: path.basename(filePath),
      storageFormat:
        getStorageFormatForFileName(path.basename(filePath)) || summary.storageFormat
    });

    return {
      run: resolvedSummary,
      points
    };
  }

  async getRunArtifact(runId) {
    if (!this.ready) {
      await this.init();
    }

    const summary =
      this.index.find((entry) => entry.id === runId) || (await this.readRunSummaryForRunId(runId));

    if (!summary) {
      return null;
    }

    const filePath = await this.resolveRunFilePath(runId, summary);
    const fileName = path.basename(filePath);
    const storageFormat =
      getStorageFormatForFileName(fileName) || summary.storageFormat || RAW_RUN_STORAGE_FORMAT;

    return {
      path: filePath,
      fileName,
      storageFormat,
      contentType:
        storageFormat === COMPRESSED_RUN_STORAGE_FORMAT
          ? "application/gzip"
          : "application/x-ndjson; charset=utf-8"
    };
  }

  async getLast24HourOutcomeStats(options = {}) {
    if (!this.ready) {
      await this.init();
    }

    const hours = options.hours || 24;
    const now = options.now ?? Date.now();
    const useCache =
      options.now === undefined &&
      hours === 24 &&
      this.last24HourStatsCache &&
      Date.now() - this.last24HourStatsCache.computedAt < 30_000;

    if (useCache) {
      return this.last24HourStatsCache.payload;
    }

    const cutoff = now - hours * 60 * 60 * 1000;
    const recentCompletedRuns = selectRepresentativeCompletedRuns(
      this.index.filter((entry) => {
        if (entry.status === "live" || entry.status === "interrupted") {
          return false;
        }

        const marketEndTimestamp = timestampOf(entry.endsAt || entry.endedAt);
        return marketEndTimestamp >= cutoff && marketEndTimestamp <= now;
      })
    );

    const concludedRuns = [];

    for (const summary of recentCompletedRuns) {
      const detail = await this.loadRun(summary.id);
      const inferredOutcome = inferOutcomeFromPoints(detail?.run || summary, detail?.points || []);

      if (!inferredOutcome.outcomeKey) {
        continue;
      }

      concludedRuns.push({
        id: summary.id,
        startedAt: summary.startedAt,
        endsAt: summary.endsAt,
        status: summary.status,
        outcomeKey: inferredOutcome.outcomeKey,
        source: inferredOutcome.source
      });
    }

    const payload = buildLast24HourOutcomeStats(concludedRuns, {
      hours,
      now
    });

    if (options.now === undefined && hours === 24) {
      this.last24HourStatsCache = {
        computedAt: Date.now(),
        payload
      };
    }

    return payload;
  }

  async flush() {
    if (this.indexWriteTimer) {
      clearTimeout(this.indexWriteTimer);
      this.indexWriteTimer = null;
    }

    await Promise.allSettled(this.pendingCompression.values());
    await writeJsonFile(runIndexPath, this.index);
  }
}

function compareResumableRuns(left, right) {
  return (
    (right.pointCount || 0) - (left.pointCount || 0) ||
    timestampOf(right.lastRecordedAt) - timestampOf(left.lastRecordedAt) ||
    timestampOf(right.createdAt) - timestampOf(left.createdAt) ||
    timestampOf(right.recordingStartedAt) - timestampOf(left.recordingStartedAt)
  );
}

function timestampOf(value) {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}
