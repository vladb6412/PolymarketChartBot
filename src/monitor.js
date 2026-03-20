import EventEmitter from "node:events";

import path from "node:path";

import { config } from "./config.js";
import { isoNow } from "./lib/time.js";
import { RunStore } from "./persistence/runStore.js";
import {
  discoverBtcFifteenMinuteMarkets,
  discoverBtcFiveMinuteMarkets
} from "./polymarket/discovery.js";
import { PolymarketFeed } from "./polymarket/feed.js";
import { fetchOfficialOutcomeStats } from "./polymarket/officialOutcomeStats.js";
import { PolyfairTracker } from "./polyfair/tracker.js";

function buildRunId(market) {
  return `${market.slug}-${market.startTimestamp}-${Date.now()}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-");
}

export class MonitorService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.family = options.family || "btc-5m";
    this.datasetLabel = options.datasetLabel || config.datasetLabel;
    this.discoverMarkets = options.discoverMarkets || discoverBtcFiveMinuteMarkets;
    this.officialStatsIntervalMinutes = options.officialStatsIntervalMinutes || 5;
    this.purgeRunIds = [...(options.purgeRunIds || [])];
    this.store = new RunStore({
      dataDir: options.dataDir || config.dataDir
    });
    this.feed = null;
    this.polyfair = new PolyfairTracker({
      intervalMinutes: options.polyfairIntervalMinutes || options.officialStatsIntervalMinutes || 5
    });
    this.onPolyfairAnalysis = (analysis) => {
      this.currentPolyfairSnapshot = analysis;
      this.emitState();
    };
    this.onPolyfairStatus = (status) => {
      this.emit("feed-status", status);
    };
    this.currentMarket = null;
    this.currentRun = null;
    this.currentSnapshot = null;
    this.currentPolyfairSnapshot = null;
    this.nextMarket = null;
    this.phase = "idle";
    this.lastDiscoveryAt = null;
    this.lastError = null;
    this.discoveryTimer = null;
    this.boundaryTimer = null;
    this.discoveryInFlight = false;
    this.skippedMarketIds = new Map();
  }

  async start() {
    await this.store.init();
    await this.purgeConfiguredRuns();
    await this.polyfair.start();
    this.polyfair.on("analysis", this.onPolyfairAnalysis);
    this.polyfair.on("status", this.onPolyfairStatus);
    this.phase = "discovering";
    this.emitState();
    await this.refreshMarket();
    this.discoveryTimer = setInterval(
      () => void this.refreshMarket(),
      config.discoveryIntervalMs
    );
  }

  async stop() {
    clearInterval(this.discoveryTimer);
    clearTimeout(this.boundaryTimer);
    this.discoveryTimer = null;
    this.boundaryTimer = null;

    if (this.feed) {
      this.feed.stop();
      this.feed = null;
    }

    this.polyfair.stop();
    this.polyfair.removeListener("analysis", this.onPolyfairAnalysis);
    this.polyfair.removeListener("status", this.onPolyfairStatus);

    if (this.store.ready) {
      await this.store.flush();
    }
  }

  getState() {
    return {
      phase: this.phase,
      datasetLabel: this.datasetLabel,
      serverTime: isoNow(),
      lastDiscoveryAt: this.lastDiscoveryAt,
      error: this.lastError,
      currentMarket: this.currentMarket,
      currentRun: this.currentRun,
      currentSnapshot: this.currentSnapshot,
      currentPolyfairSnapshot: this.currentPolyfairSnapshot,
      nextMarket: this.nextMarket,
      recentRuns: this.store.getCachedRuns(20)
    };
  }

  async refreshMarket() {
    if (this.discoveryInFlight) {
      return;
    }

    this.discoveryInFlight = true;

    try {
      const now = Date.now();
      this.pruneSkippedMarkets(now);

      const { current, next } = await this.discoverMarkets({ now });
      const selectedCurrent =
        current && !this.skippedMarketIds.has(current.id) ? current : null;
      const selectedNext = next && !this.skippedMarketIds.has(next.id) ? next : null;

      this.lastDiscoveryAt = isoNow();
      this.lastError = null;
      this.nextMarket = selectedNext;

      if (selectedCurrent && selectedCurrent.id !== this.currentMarket?.id) {
        await this.switchToMarket(selectedCurrent);
      } else if (!selectedCurrent && this.currentMarket && now >= this.currentMarket.endTimestamp) {
        await this.finishCurrentRun("expired");
      } else if (!selectedCurrent && !this.currentMarket) {
        this.phase = selectedNext ? "waiting_next" : "discovering";
      }

      this.scheduleBoundaryRefresh(now);
      this.emitState();
    } catch (error) {
      this.lastError = error.message || "Failed to discover market";
      this.phase = this.currentRun ? "live" : "error";
      this.emitState();
    } finally {
      this.discoveryInFlight = false;
    }
  }

  pruneSkippedMarkets(now) {
    for (const [marketId, expiry] of this.skippedMarketIds.entries()) {
      if (now >= expiry) {
        this.skippedMarketIds.delete(marketId);
      }
    }
  }

  scheduleBoundaryRefresh(now) {
    clearTimeout(this.boundaryTimer);

    const candidates = [
      this.currentMarket?.endTimestamp ?? null,
      this.nextMarket?.startTimestamp ?? null
    ].filter((value) => Number.isFinite(value) && value > now);

    if (candidates.length === 0) {
      return;
    }

    const nextTimestamp = Math.min(...candidates);
    const delayMs = Math.max(250, nextTimestamp - now + 250);

    this.boundaryTimer = setTimeout(() => {
      void this.refreshMarket();
    }, delayMs);
  }

  async switchToMarket(market) {
    if (this.currentRun) {
      await this.finishCurrentRun("rolled");
    }

    const resumableRun = await this.store.findResumableRun(market);
    const runSummary =
      resumableRun ||
      (await this.store.startRun({
        id: buildRunId(market),
        datasetLabel: this.datasetLabel,
        status: "live",
        marketId: market.id,
        conditionId: market.conditionId,
        slug: market.slug,
        eventTitle: market.eventTitle,
        question: market.question,
        startedAt: market.startDate,
        recordingStartedAt: isoNow(),
        endsAt: market.endDate,
        outcomes: market.outcomes
      }));

    this.currentMarket = market;
    this.currentRun = runSummary;
    this.currentSnapshot = null;
    this.currentPolyfairSnapshot = null;
    this.phase = "live";

    await this.polyfair.setMarket(market);
    this.attachFeed(market);
    this.emitState();
  }

  attachFeed(market) {
    if (this.feed) {
      this.feed.stop();
      this.feed.removeAllListeners();
    }

    this.feed = new PolymarketFeed();

    this.feed.on("status", (status) => {
      if (status.level === "error") {
        this.lastError = status.message;
      }

      this.emit("feed-status", status);
    });

    this.feed.on("snapshot", async (snapshot) => {
      if (!this.currentRun || this.currentMarket?.id !== market.id) {
        return;
      }

      const enrichedSnapshot = {
        ...snapshot,
        runId: this.currentRun.id,
        marketId: market.id,
        marketSlug: market.slug,
        marketQuestion: market.question,
        marketStartedAt: market.startDate,
        marketEndsAt: market.endDate,
        datasetLabel: this.datasetLabel,
        elapsedMs: Math.max(
          0,
          new Date(snapshot.recordedAt).getTime() - new Date(market.startDate).getTime()
        )
      };
      const polyfairSnapshot = await this.polyfair.captureSnapshot(enrichedSnapshot);
      if (polyfairSnapshot) {
        enrichedSnapshot.polyfair = polyfairSnapshot;
      }

      await this.store.appendSnapshot(this.currentRun.id, enrichedSnapshot);
      this.currentSnapshot = enrichedSnapshot;
      this.currentPolyfairSnapshot = polyfairSnapshot;
      this.emitState();
    });

    this.feed.on("resolved", async (resolution) => {
      if (this.currentMarket?.id !== market.id) {
        return;
      }

      await this.finishCurrentRun("resolved", {
        resolvedAt: resolution.recordedAt,
        winningAssetId: resolution.winningAssetId,
        winningOutcome: resolution.winningOutcome
      });

      this.skippedMarketIds.set(market.id, market.endTimestamp || Date.now() + 60_000);
      await this.refreshMarket();
    });

    this.feed.start(market);
  }

  async finishCurrentRun(status, extra = {}) {
    if (!this.currentRun || !this.currentMarket) {
      return;
    }

    const finishedRun = this.currentRun;
    const finishedMarket = this.currentMarket;

    if (this.feed) {
      this.feed.stop();
      this.feed.removeAllListeners();
      this.feed = null;
    }

    await this.store.finishRun(finishedRun.id, {
      status,
      endedAt: isoNow(),
      ...extra
    });

    this.skippedMarketIds.set(
      finishedMarket.id,
      finishedMarket.endTimestamp || Date.now() + 60_000
    );

    this.currentRun = null;
    this.currentMarket = null;
    this.currentSnapshot = null;
    this.currentPolyfairSnapshot = null;
    this.phase = this.nextMarket ? "waiting_next" : "discovering";
    this.emitState();
  }

  emitState() {
    this.emit("state", this.getState());
  }

  async listRuns(limit = 50, offset = 0) {
    return this.store.listRuns(limit, offset);
  }

  async loadRun(runId) {
    return this.store.loadRun(runId);
  }

  async getRunArtifact(runId) {
    return this.store.getRunArtifact(runId);
  }

  async getLast24HourOutcomeStats() {
    return fetchOfficialOutcomeStats({
      intervalMinutes: this.officialStatsIntervalMinutes
    });
  }

  async purgeConfiguredRuns() {
    if (this.purgeRunIds.length === 0) {
      return;
    }

    for (const runId of this.purgeRunIds) {
      await this.store.removeRun(runId);
    }
  }
}

export function createFiveMinuteMonitorService() {
  return new MonitorService({
    family: "btc-5m",
    discoverMarkets: discoverBtcFiveMinuteMarkets,
    officialStatsIntervalMinutes: 5,
    polyfairIntervalMinutes: 5,
    datasetLabel: config.datasetLabel,
    dataDir: path.join(config.dataDir, config.datasetLabel, "5minutebtc")
  });
}

export function createFifteenMinuteMonitorService() {
  return new MonitorService({
    family: "btc-15m",
    discoverMarkets: discoverBtcFifteenMinuteMarkets,
    dataDir: path.join(config.dataDir, config.datasetLabel, "15minutebtc"),
    officialStatsIntervalMinutes: 15,
    polyfairIntervalMinutes: 15,
    datasetLabel: config.datasetLabel,
    purgeRunIds: ["btc-updown-15m-1773761400-1773761400000-1773762224359"]
  });
}
