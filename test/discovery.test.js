import test from "node:test";
import assert from "node:assert/strict";

import {
  isBtcFiveMinuteMarket,
  normalizeTrackedMarket,
  selectRelevantMarket
} from "../src/polymarket/discovery.js";

const exampleMarket = {
  id: "123",
  slug: "btc-updown-5m-1773663600",
  question: "Bitcoin Up or Down - Mar 16, 12:20PM-12:25PM UTC",
  startDate: "2026-03-16T12:20:00.000Z",
  endDate: "2026-03-16T12:25:00.000Z",
  outcomes: "[\"Up\",\"Down\"]",
  clobTokenIds: "[\"asset-up\",\"asset-down\"]",
  active: true,
  closed: false,
  acceptingOrders: true,
  events: [
    {
      id: "evt-1",
      slug: "btc-updown-5m-1773663600",
      title: "Bitcoin Up or Down - Mar 16, 12:20PM-12:25PM UTC"
    }
  ]
};

test("isBtcFiveMinuteMarket recognizes the BTC 5-minute up/down slug family", () => {
  assert.equal(isBtcFiveMinuteMarket(exampleMarket), true);
});

test("normalizeTrackedMarket maps outcomes to asset ids", () => {
  const normalized = normalizeTrackedMarket(exampleMarket);

  assert.deepEqual(normalized.outcomes, [
    { key: "UP", label: "Up", assetId: "asset-up" },
    { key: "DOWN", label: "Down", assetId: "asset-down" }
  ]);
});

test("isBtcFiveMinuteMarket excludes the 15-minute slug family", () => {
  assert.equal(
    isBtcFiveMinuteMarket({
      ...exampleMarket,
      slug: "btc-updown-15m-1773663600"
    }),
    false
  );
});

test("selectRelevantMarket returns the current market and the next queued market", () => {
  const current = normalizeTrackedMarket(exampleMarket);
  const next = normalizeTrackedMarket({
    ...exampleMarket,
    id: "124",
    slug: "btc-updown-5m-1773663900",
    question: "Bitcoin Up or Down - Mar 16, 12:25PM-12:30PM UTC",
    startDate: "2026-03-16T12:25:00.000Z",
    endDate: "2026-03-16T12:30:00.000Z"
  });

  const selected = selectRelevantMarket([current, next], new Date("2026-03-16T12:22:00.000Z").getTime());

  assert.equal(selected.current.id, "123");
  assert.equal(selected.next.id, "124");
});
