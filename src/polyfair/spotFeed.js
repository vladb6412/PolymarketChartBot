import EventEmitter from "node:events";

import WebSocket from "ws";

import { config } from "../config.js";
import { isoNow } from "../lib/time.js";

const BTC_CHAINLINK_SYMBOL = "btc/usd";

function parseSpotPayload(raw) {
  try {
    const parsed = JSON.parse(`${raw}`);
    if (parsed?.topic !== "crypto_prices_chainlink" || !parsed.payload) {
      return null;
    }

    if (`${parsed.payload.symbol || ""}`.toLowerCase() !== BTC_CHAINLINK_SYMBOL) {
      return null;
    }

    const spotPrice = Number(parsed.payload.value);
    if (!Number.isFinite(spotPrice)) {
      return null;
    }

    return {
      symbol: BTC_CHAINLINK_SYMBOL,
      source: "chainlink_live",
      spotPrice,
      recordedAt: isoNow()
    };
  } catch {
    return null;
  }
}

export class PolyfairSpotFeed extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.latestSpot = null;
    this.stopped = true;
  }

  start() {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }
  }

  getLatestSpot() {
    return this.latestSpot;
  }

  connect() {
    if (this.stopped) {
      return;
    }

    const socket = new WebSocket(config.polyfairSpotWebsocketUrl);
    this.socket = socket;

    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          action: "subscribe",
          subscriptions: [
            {
              topic: "crypto_prices_chainlink",
              type: "*",
              filters: JSON.stringify({
                symbol: BTC_CHAINLINK_SYMBOL
              })
            }
          ]
        })
      );

      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ action: "ping" }));
        }
      }, 5_000);

      this.emit("status", {
        level: "info",
        message: "Connected to Polyfair-compatible BTC spot feed"
      });
    });

    socket.on("message", (raw) => {
      const payload = parseSpotPayload(raw);
      if (!payload) {
        return;
      }

      this.latestSpot = payload;
      this.emit("spot", payload);
    });

    socket.on("error", (error) => {
      this.emit("status", {
        level: "warn",
        message: error.message || "Polyfair spot WebSocket error"
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
        message: "Polyfair spot WebSocket closed; retrying"
      });
      this.reconnectTimer = setTimeout(() => this.connect(), config.reconnectDelayMs);
    });
  }
}
