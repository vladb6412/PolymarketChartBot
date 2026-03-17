import EventEmitter from "node:events";

import { config } from "./config.js";
import { isoNow } from "./lib/time.js";
import { RunStore } from "./persistence/runStore.js";
import { discoverBtcFiveMinuteMarkets } from "./polymarket/discovery.js";
import { PolymarketFeed } from "./polymarket/feed.js";

function buildRunId(market) {
  return `${market.slug}-${market.startTimestamp}-${Date.now()}`
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-");
}

export class MonitorService extends EventEmitter {
  constructor() {
    super();
    this.store = new RunStore();
    this.feed = null;
    this.currentMarket = null;
    this.currentRun = null;
    this.currentSnapshot = null;
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

    if (this.store.ready) {
      await this.store.flush();
    }
  }

  getState() {
    return {
      phase: this.phase,
      serverTime: isoNow(),
      lastDiscoveryAt: this.lastDiscoveryAt,
      error: this.lastError,
      currentMarket: this.currentMarket,
      currentRun: this.currentRun,
      currentSnapshot: this.currentSnapshot,
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

      const { current, next } = await discoverBtcFiveMinuteMarkets({ now });
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

    const runSummary = await this.store.startRun({
      id: buildRunId(market),
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
    });

    this.currentMarket = market;
    this.currentRun = runSummary;
    this.currentSnapshot = null;
    this.phase = "live";

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
        elapsedMs: Math.max(
          0,
          new Date(snapshot.recordedAt).getTime() - new Date(market.startDate).getTime()
        )
      };

      await this.store.appendSnapshot(this.currentRun.id, enrichedSnapshot);
      this.currentSnapshot = enrichedSnapshot;
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
    this.phase = this.nextMarket ? "waiting_next" : "discovering";
    this.emitState();
  }

  emitState() {
    this.emit("state", this.getState());
  }

  async listRuns(limit = 50) {
    return this.store.listRuns(limit);
  }

  async loadRun(runId) {
    return this.store.loadRun(runId);
  }
}
