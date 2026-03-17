import test from "node:test";
import assert from "node:assert/strict";

import { buildLast24HourOutcomeStats } from "../src/domain/outcomeStats.js";
import { normalizeOfficialClosedOutcomeMarket } from "../src/polymarket/officialOutcomeStats.js";

const rawClosedMarket = {
  id: "1603800",
  question: "Bitcoin Up or Down - March 17, 12:20AM-12:25AM ET",
  slug: "btc-updown-5m-1773721200",
  endDate: "2026-03-17T04:25:00Z",
  outcomes: "[\"Up\", \"Down\"]",
  outcomePrices: "[\"0\", \"1\"]",
  clobTokenIds: "[\"asset-up\", \"asset-down\"]",
  closed: true,
  active: true,
  events: [
    {
      id: "274903",
      slug: "btc-updown-5m-1773721200",
      title: "Bitcoin Up or Down - March 17, 12:20AM-12:25AM ET"
    }
  ]
};

test("normalizeOfficialClosedOutcomeMarket maps official Gamma outcomes to a winning side", () => {
  assert.deepEqual(normalizeOfficialClosedOutcomeMarket(rawClosedMarket), {
    id: "1603800",
    startedAt: "2026-03-17T04:20:00.000Z",
    endsAt: "2026-03-17T04:25:00.000Z",
    outcomeKey: "DOWN",
    source: "polymarket_official"
  });
});

test("normalizeOfficialClosedOutcomeMarket ignores tied official outcomes", () => {
  assert.equal(
    normalizeOfficialClosedOutcomeMarket({
      ...rawClosedMarket,
      outcomePrices: "[\"0.5\", \"0.5\"]"
    }),
    null
  );
});

test("official stats payload can support 24 hour and 7 day windows from the same market list", () => {
  const markets = [
    {
      id: "m1",
      startedAt: "2026-03-16T12:00:00.000Z",
      endsAt: "2026-03-16T12:05:00.000Z",
      outcomeKey: "UP",
      source: "polymarket_official"
    },
    {
      id: "m2",
      startedAt: "2026-03-16T12:05:00.000Z",
      endsAt: "2026-03-16T12:10:00.000Z",
      outcomeKey: "DOWN",
      source: "polymarket_official"
    },
    {
      id: "m3",
      startedAt: "2026-03-11T00:00:00.000Z",
      endsAt: "2026-03-11T00:05:00.000Z",
      outcomeKey: "DOWN",
      source: "polymarket_official"
    }
  ];

  const last24Hours = buildLast24HourOutcomeStats(markets, {
    hours: 24,
    now: new Date("2026-03-17T00:10:00.000Z").getTime()
  });
  const last7Days = buildLast24HourOutcomeStats(markets, {
    hours: 24 * 7,
    now: new Date("2026-03-17T00:10:00.000Z").getTime()
  });

  assert.equal(last24Hours.concludedRuns, 2);
  assert.equal(last24Hours.upCount, 1);
  assert.equal(last24Hours.downCount, 1);
  assert.equal(last7Days.concludedRuns, 3);
  assert.equal(last7Days.downCount, 2);
});
