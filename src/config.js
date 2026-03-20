import path from "node:path";

const workspaceRoot = process.cwd();

function readNumber(value, fallback) {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  host: process.env.HOST || "0.0.0.0",
  port: readNumber(process.env.PORT, 3000),
  dataDir: process.env.DATA_DIR || path.join(workspaceRoot, "data"),
  datasetLabel: process.env.DATASET_LABEL || "iteration-2",
  gammaBaseUrl: process.env.GAMMA_BASE_URL || "https://gamma-api.polymarket.com",
  websocketUrl:
    process.env.POLYMARKET_WS_URL ||
    "wss://ws-subscriptions-clob.polymarket.com/ws/market",
  polyfairSpotWebsocketUrl:
    process.env.POLYFAIR_SPOT_WS_URL ||
    "wss://ws-live-data.polymarket.com",
  discoveryIntervalMs: readNumber(process.env.DISCOVERY_INTERVAL_MS, 15_000),
  gammaPageSize: readNumber(process.env.GAMMA_PAGE_SIZE, 100),
  gammaMaxPages: readNumber(process.env.GAMMA_MAX_PAGES, 10),
  streamHeartbeatMs: readNumber(process.env.STREAM_HEARTBEAT_MS, 15_000),
  reconnectDelayMs: readNumber(process.env.RECONNECT_DELAY_MS, 2_500),
  displaySpreadThreshold: readNumber(process.env.DISPLAY_SPREAD_THRESHOLD, 0.1),
  requestTimeoutMs: readNumber(process.env.REQUEST_TIMEOUT_MS, 10_000)
};
