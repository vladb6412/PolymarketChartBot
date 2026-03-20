import EventEmitter from "node:events";

import { config } from "../config.js";
import { fetchJson } from "../lib/http.js";
import {
  POLYFAIR_DEFAULT_STRATEGY,
  POLYFAIR_STRATEGIES,
  buildPolyfairRecommendation,
  buildPolyfairStrategySnapshot,
  createPolyfairVolatilityState,
  getPolyfairDisplayedVolatility,
  updatePolyfairVolatilityState
} from "./model.js";
import { PolyfairSpotFeed } from "./spotFeed.js";

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timeframeKey(intervalMinutes) {
  return intervalMinutes === 15 ? "15m" : "5m";
}

function secondsRemainingFor(market, recordedAt) {
  const endTime = new Date(market.endDate || market.endsAt).getTime();
  const snapshotTime = new Date(recordedAt).getTime();

  if (!Number.isFinite(endTime) || !Number.isFinite(snapshotTime)) {
    return 0;
  }

  return Math.max(0, Math.round((endTime - snapshotTime) / 1_000));
}

async function fetchStrikePriceForMarket(slug) {
  if (!slug) {
    return null;
  }

  const url = `${config.gammaBaseUrl}/events?slug=${encodeURIComponent(slug)}`;
  const payload = await fetchJson(url);
  const event = Array.isArray(payload) ? payload[0] : null;

  return (
    toFiniteNumber(event?.eventMetadata?.priceToBeat) ??
    toFiniteNumber(event?.markets?.[0]?.priceToBeat) ??
    null
  );
}

export class PolyfairTracker extends EventEmitter {
  constructor(options = {}) {
    super();
    this.intervalMinutes = options.intervalMinutes || 5;
    this.defaultStrategy = options.defaultStrategy || POLYFAIR_DEFAULT_STRATEGY;
    this.market = null;
    this.strikePrice = null;
    this.latestMarketPrices = null;
    this.latestSpot = null;
    this.currentAnalysis = null;
    this.volatilityState = createPolyfairVolatilityState();
    this.spotFeed = new PolyfairSpotFeed();
    this.started = false;
    this.onSpot = (spot) => this.handleSpot(spot);
    this.onStatus = (status) => this.emit("status", status);
  }

  async start() {
    if (this.started) {
      return;
    }

    this.started = true;
    this.spotFeed.on("spot", this.onSpot);
    this.spotFeed.on("status", this.onStatus);
    this.spotFeed.start();
    this.latestSpot = this.spotFeed.getLatestSpot();

    if (this.latestSpot) {
      updatePolyfairVolatilityState(this.volatilityState, this.latestSpot.spotPrice);
    }
  }

  stop() {
    this.started = false;
    this.spotFeed.removeListener("spot", this.onSpot);
    this.spotFeed.removeListener("status", this.onStatus);
    this.spotFeed.stop();
  }

  async setMarket(market) {
    this.market = market || null;
    this.latestMarketPrices = null;
    this.currentAnalysis = null;
    this.strikePrice =
      toFiniteNumber(market?.priceToBeat) ??
      toFiniteNumber(market?.eventMetadata?.priceToBeat) ??
      null;

    if (!this.strikePrice && market?.slug) {
      try {
        this.strikePrice = await fetchStrikePriceForMarket(market.slug);
      } catch (error) {
        this.emit("status", {
          level: "warn",
          message: `Polyfair strike lookup failed for ${market.slug}: ${error.message}`
        });
      }
    }

    this.emit("analysis", this.currentAnalysis);
  }

  getCurrentAnalysis() {
    return this.currentAnalysis;
  }

  captureSnapshot(snapshot) {
    this.latestMarketPrices = snapshot?.prices || null;
    this.currentAnalysis = this.buildAnalysis(snapshot?.recordedAt);
    this.emit("analysis", this.currentAnalysis);
    return this.currentAnalysis;
  }

  handleSpot(spot) {
    this.latestSpot = spot;
    updatePolyfairVolatilityState(this.volatilityState, spot.spotPrice);

    if (!this.market || !this.latestMarketPrices) {
      return;
    }

    this.currentAnalysis = this.buildAnalysis(spot.recordedAt);
    this.emit("analysis", this.currentAnalysis);
  }

  buildAnalysis(recordedAt) {
    if (!this.market || !this.latestMarketPrices || !this.latestSpot || !this.strikePrice) {
      return null;
    }

    const marketUpPrice = this.latestMarketPrices?.UP?.displayedPrice ?? null;
    const marketDownPrice = this.latestMarketPrices?.DOWN?.displayedPrice ?? null;
    const secondsRemaining = secondsRemainingFor(this.market, recordedAt || this.latestSpot.recordedAt);
    const strategySnapshots = {};

    for (const strategy of Object.values(POLYFAIR_STRATEGIES)) {
      strategySnapshots[strategy] = buildPolyfairStrategySnapshot({
        strategy,
        spotPrice: this.latestSpot.spotPrice,
        strikePrice: this.strikePrice,
        secondsRemaining,
        marketUpPrice,
        marketDownPrice,
        state: this.volatilityState
      });
    }

    const selectedStrategy =
      strategySnapshots[this.defaultStrategy] || strategySnapshots[POLYFAIR_DEFAULT_STRATEGY];
    const recommendation = buildPolyfairRecommendation(selectedStrategy);

    return {
      source: "polyfair-aligned-v1",
      recordedAt: recordedAt || this.latestSpot.recordedAt,
      spotPrice: this.latestSpot.spotPrice,
      strikePrice: this.strikePrice,
      secondsRemaining,
      timeframe: timeframeKey(this.intervalMinutes),
      volatility: getPolyfairDisplayedVolatility(
        this.volatilityState,
        timeframeKey(this.intervalMinutes)
      ),
      defaultStrategy: this.defaultStrategy,
      strategies: strategySnapshots,
      recommendation
    };
  }
}

