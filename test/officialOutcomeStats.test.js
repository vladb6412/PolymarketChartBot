import test from "node:test";
import assert from "node:assert/strict";

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
