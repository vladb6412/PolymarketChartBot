import EventEmitter from "node:events";

import WebSocket from "ws";

import { config } from "../config.js";
import { normalizeBookState } from "../domain/priceModel.js";
import { isoNow } from "../lib/time.js";

function parseTimestamp(value) {
  if (value === undefined || value === null || value === "") {
    return isoNow();
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const epochMs = numeric > 1_000_000_000_000 ? numeric : numeric * 1_000;
    return new Date(epochMs).toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? isoNow() : parsed.toISOString();
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractBestBid(bids) {
  if (!Array.isArray(bids) || bids.length === 0) {
    return null;
  }

  return bids.reduce((best, level) => {
    const price = toNumber(level.price);
    return price !== null && (best === null || price > best) ? price : best;
  }, null);
}

function extractBestAsk(asks) {
  if (!Array.isArray(asks) || asks.length === 0) {
    return null;
  }

  return asks.reduce((best, level) => {
    const price = toNumber(level.price);
    return price !== null && (best === null || price < best) ? price : best;
  }, null);
}

export class PolymarketFeed extends EventEmitter {
  constructor() {
    super();
    this.market = null;
    this.socket = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.assetState = new Map();
    this.lastSnapshotSignature = null;
    this.stopped = true;
  }

  start(market) {
    this.stop();
    this.market = market;
    this.stopped = false;
    this.assetState = new Map(
      market.outcomes.map((outcome) => [
        outcome.assetId,
        {
          key: outcome.key,
          label: outcome.label,
          assetId: outcome.assetId,
          bestBid: null,
          bestAsk: null,
          lastTradePrice: null,
          spread: null,
          displayedPrice: null
        }
      ])
    );
    this.lastSnapshotSignature = null;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.reconnectTimer);

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }
  }

  connect() {
    if (this.stopped || !this.market) {
      return;
    }

    this.emit("status", {
      level: "info",
      message: `Connecting to market feed for ${this.market.question}`
    });

    const socket = new WebSocket(config.websocketUrl);
    this.socket = socket;

    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "market",
          assets_ids: this.market.outcomes.map((outcome) => outcome.assetId),
          custom_feature_enabled: true
        })
      );

      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send("PING");
        }
      }, 10_000);

      this.emit("status", {
        level: "info",
        message: `Subscribed to ${this.market.outcomes.length} Polymarket assets`
      });
    });

    socket.on("message", (raw) => {
      const messages = this.parsePayload(raw);
      for (const message of messages) {
        this.handleEvent(message);
      }
    });

    socket.on("error", (error) => {
      this.emit("status", {
        level: "error",
        message: error.message || "Market WebSocket error"
      });
    });

    socket.on("close", () => {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      this.socket = null;

      if (this.stopped) {
        return;
      }

      this.emit("status", {
        level: "warn",
        message: "Market WebSocket closed; retrying"
      });

      this.reconnectTimer = setTimeout(() => this.connect(), config.reconnectDelayMs);
    });
  }

  parsePayload(raw) {
    const text = `${raw}`;

    if (text === "PONG" || text === "PING") {
      return [];
    }

    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }

  handleEvent(message) {
    if (!message?.event_type) {
      return;
    }

    switch (message.event_type) {
      case "book":
        this.applyAssetUpdate(
          message.asset_id,
          {
            bestBid: extractBestBid(message.bids),
            bestAsk: extractBestAsk(message.asks)
          },
          message.timestamp,
          "book"
        );
        break;
      case "price_change": {
        const changes = Array.isArray(message.price_changes) ? message.price_changes : [];
        const lastChange = changes.at(-1) || {};
        this.applyAssetUpdate(
          message.asset_id || lastChange.asset_id,
          {
            bestBid: lastChange.best_bid ?? message.best_bid,
            bestAsk: lastChange.best_ask ?? message.best_ask
          },
          message.timestamp,
          "price_change"
        );
        break;
      }
      case "best_bid_ask":
        this.applyAssetUpdate(
          message.asset_id,
          {
            bestBid: message.best_bid,
            bestAsk: message.best_ask
          },
          message.timestamp,
          "best_bid_ask"
        );
        break;
      case "last_trade_price":
        this.applyAssetUpdate(
          message.asset_id,
          {
            lastTradePrice: message.price
          },
          message.timestamp,
          "last_trade_price"
        );
        break;
      case "market_resolved":
        this.emit("resolved", {
          recordedAt: parseTimestamp(message.timestamp),
          winningAssetId: message.winning_asset_id || null,
          winningOutcome: message.winning_outcome || null
        });
        break;
      default:
        break;
    }
  }

  applyAssetUpdate(assetId, patch, timestamp, sourceEventType) {
    if (!assetId || !this.assetState.has(assetId)) {
      return;
    }

    const current = this.assetState.get(assetId);
    const normalized = normalizeBookState(
      {
        bestBid: patch.bestBid ?? current.bestBid,
        bestAsk: patch.bestAsk ?? current.bestAsk,
        lastTradePrice: patch.lastTradePrice ?? current.lastTradePrice
      },
      config.displaySpreadThreshold
    );

    const next = {
      ...current,
      ...normalized
    };

    this.assetState.set(assetId, next);
    this.emitSnapshot(parseTimestamp(timestamp), sourceEventType);
  }

  emitSnapshot(recordedAt, sourceEventType) {
    const prices = {};

    for (const outcome of this.market.outcomes) {
      const state = this.assetState.get(outcome.assetId);
      prices[outcome.key] = {
        key: outcome.key,
        label: outcome.label,
        assetId: outcome.assetId,
        bestBid: state.bestBid,
        bestAsk: state.bestAsk,
        spread: state.spread,
        lastTradePrice: state.lastTradePrice,
        displayedPrice: state.displayedPrice
      };
    }

    const signature = JSON.stringify(prices);
    if (signature === this.lastSnapshotSignature) {
      return;
    }

    this.lastSnapshotSignature = signature;
    this.emit("snapshot", {
      recordedAt,
      sourceEventType,
      prices
    });
  }
}
