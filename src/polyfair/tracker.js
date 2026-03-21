import EventEmitter from "node:events";

import { config } from "../config.js";
import { fetchJson } from "../lib/http.js";
import {
  POLYFAIR_DEFAULT_STRATEGY,
  POLYFAIR_STRATEGIES,
  buildPolyfairSpotDeltaSnapshot,
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

async function fetchBinanceMinuteOpen(startTimestamp) {
  if (!Number.isFinite(startTimestamp)) {
    return null;
  }

  const params = new URLSearchParams({
    symbol: "BTCUSDT",
    interval: "1m",
    startTime: `${startTimestamp}`,
    limit: "1"
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch(`https://api.binance.com/api/v3/klines?${params.toString()}`, {
      signal: controller.signal,
      headers: {
        accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Binance strike lookup failed with status ${response.status}`);
    }

    const payload = await response.json();
    const openPrice = Array.isArray(payload) && payload[0] ? toFiniteNumber(payload[0][1]) : null;
    return openPrice;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBinanceSpotPrice() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const response = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", {
      signal: controller.signal,
      headers: {
        accept: "application/json"
      }
    });

    if (!response.ok) {
      throw new Error(`Binance spot lookup failed with status ${response.status}`);
    }

    const payload = await response.json();
    return toFiniteNumber(payload?.price);
  } finally {
    clearTimeout(timeout);
  }
}

export class PolyfairTracker extends EventEmitter {
  constructor(options = {}) {
    super();
    this.intervalMinutes = options.intervalMinutes || 5;
    this.defaultStrategy = options.defaultStrategy || POLYFAIR_DEFAULT_STRATEGY;
    this.market = null;
    this.strikePrice = null;
    this.strikeSource = null;
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
    this.strikeSource = null;
    this.strikePrice =
      toFiniteNumber(market?.priceToBeat) ??
      toFiniteNumber(market?.eventMetadata?.priceToBeat) ??
      null;
    if (this.strikePrice) {
      this.strikeSource = "gamma";
    }

    if (!this.strikePrice && market?.slug) {
      try {
        this.strikePrice = await fetchStrikePriceForMarket(market.slug);
        if (this.strikePrice) {
          this.strikeSource = "gamma";
        }
      } catch (error) {
        this.emit("status", {
          level: "warn",
          message: `Polyfair strike lookup failed for ${market.slug}: ${error.message}`
        });
      }
    }

    if (!this.strikePrice) {
      try {
        const startTimestamp =
          market?.startTimestamp ??
          (market?.startDate ? new Date(market.startDate).getTime() : null);
        this.strikePrice = await fetchBinanceMinuteOpen(startTimestamp);
        if (this.strikePrice) {
          this.strikeSource = "binance_open";
        }
      } catch (error) {
        this.emit("status", {
          level: "warn",
          message: `Polyfair Binance strike fallback failed for ${market?.slug}: ${error.message}`
        });
      }
    }

    if (!this.strikePrice && this.latestSpot?.spotPrice) {
      this.strikePrice = this.latestSpot.spotPrice;
      this.strikeSource = "spot_fallback";
    }

    this.emit("analysis", this.currentAnalysis);
  }

  getCurrentAnalysis() {
    return this.currentAnalysis;
  }

  async captureSnapshot(snapshot) {
    this.latestMarketPrices = snapshot?.prices || null;
    await this.ensureSpotPrice(snapshot?.recordedAt);

    if (!this.strikePrice && this.latestSpot?.spotPrice) {
      this.strikePrice = this.latestSpot.spotPrice;
      this.strikeSource = "spot_fallback";
    }

    this.currentAnalysis = this.buildAnalysis(snapshot?.recordedAt);
    this.emit("analysis", this.currentAnalysis);
    return this.currentAnalysis;
  }

  handleSpot(spot) {
    this.latestSpot = spot;
    updatePolyfairVolatilityState(this.volatilityState, spot.spotPrice);

    if (!this.strikePrice) {
      this.strikePrice = spot.spotPrice;
      this.strikeSource = "spot_fallback";
    }

    if (!this.market || !this.latestMarketPrices) {
      return;
    }

    this.currentAnalysis = this.buildAnalysis(spot.recordedAt);
    this.emit("analysis", this.currentAnalysis);
  }

  async ensureSpotPrice(recordedAt) {
    if (this.latestSpot?.spotPrice) {
      return this.latestSpot;
    }

    try {
      const spotPrice = await fetchBinanceSpotPrice();
      if (!spotPrice) {
        return null;
      }

      this.latestSpot = {
        symbol: "btc/usd",
        source: "binance_ticker",
        spotPrice,
        recordedAt: recordedAt || new Date().toISOString()
      };
      updatePolyfairVolatilityState(this.volatilityState, spotPrice);
      return this.latestSpot;
    } catch (error) {
      this.emit("status", {
        level: "warn",
        message: `Polyfair Binance spot fallback failed: ${error.message}`
      });
      return null;
    }
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
    const spotDeltaSnapshot = buildPolyfairSpotDeltaSnapshot({
      spotPrice: this.latestSpot.spotPrice,
      strikePrice: this.strikePrice
    });

    return {
      source: "polyfair-aligned-v1",
      recordedAt: recordedAt || this.latestSpot.recordedAt,
      spotPrice: this.latestSpot.spotPrice,
      spotSource: this.latestSpot.source || "chainlink_live",
      strikePrice: this.strikePrice,
      strikeSource: this.strikeSource,
      ...spotDeltaSnapshot,
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
