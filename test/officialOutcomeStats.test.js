import test from "node:test";
import assert from "node:assert/strict";

import { buildLast24HourOutcomeStats } from "../src/domain/outcomeStats.js";
import {
  buildOfficialOutcomeSlugBatches,
  normalizeOfficialClosedOutcomeMarket
} from "../src/polymarket/officialOutcomeStats.js";

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

test("normalizeOfficialClosedOutcomeMarket ignores markets that are not officially closed yet", () => {
  assert.equal(
    normalizeOfficialClosedOutcomeMarket({
      ...rawClosedMarket,
      closed: false
    }),
    null
  );
});

test("buildOfficialOutcomeSlugBatches covers the full 7 day window in exact five minute increments", () => {
  const batches = buildOfficialOutcomeSlugBatches({
    now: new Date("2026-03-17T05:12:00.000Z").getTime(),
    hours: 24 * 7,
    batchSize: 100
  });
  const slugs = batches.flat();

  assert.equal(batches.length, 21);
  assert.equal(slugs.length, 2017);
  assert.equal(slugs[0], "btc-updown-5m-1773119100");
  assert.equal(slugs.at(-1), "btc-updown-5m-1773723900");
  assert.ok(batches.every((batch) => batch.length <= 100));
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
