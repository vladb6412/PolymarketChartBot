import test from "node:test";
import assert from "node:assert/strict";

import {
  POLYFAIR_STRATEGIES,
  buildPolyfairRecommendation,
  buildPolyfairStrategySnapshot,
  calculatePolyfairFairPrices,
  classifyPolyfairMispricing,
  createPolyfairVolatilityState,
  getPolyfairDisplayedVolatility,
  updatePolyfairVolatilityState
} from "../src/polyfair/model.js";

test("classifyPolyfairMispricing uses Polyfair thresholds", () => {
  assert.equal(classifyPolyfairMispricing(0.02), "NEUTRAL");
  assert.equal(classifyPolyfairMispricing(0.031), "UNDERVALUED");
  assert.equal(classifyPolyfairMispricing(-0.031), "OVERPRICED");
});

test("buildPolyfairRecommendation maps alert labels to actionable text", () => {
  const verdict = buildPolyfairRecommendation({
    labelUp: "UNDERVALUED",
    labelDown: "OVERPRICED",
    diffUp: 0.06,
    diffDown: -0.06
  });

  assert.deepEqual(verdict, {
    action: "BUY_UP",
    tone: "alert",
    text: "UP is undervalued - buy UP"
  });
});

test("Polyfair volatility state updates from spot ticks", () => {
  const state = createPolyfairVolatilityState();

  updatePolyfairVolatilityState(state, 100_000);
  updatePolyfairVolatilityState(state, 100_050);
  updatePolyfairVolatilityState(state, 100_120);

  assert.equal(state.prevSpot, 100_120);
  assert.equal(state.sigma2Delta !== null, true);
  assert.equal(getPolyfairDisplayedVolatility(state, "5m") > 0, true);
});

test("calculatePolyfairFairPrices favors UP when spot is above strike", () => {
  const state = createPolyfairVolatilityState();

  for (const price of [100_000, 100_040, 100_110, 100_180]) {
    updatePolyfairVolatilityState(state, price);
  }

  const result = calculatePolyfairFairPrices({
    strategy: POLYFAIR_STRATEGIES.LN_EWMA,
    spotPrice: 100_180,
    strikePrice: 100_000,
    secondsRemaining: 120,
    state
  });

  assert.equal(result.fairUp > result.fairDown, true);
});

test("buildPolyfairStrategySnapshot includes labels and diffs", () => {
  const state = createPolyfairVolatilityState();

  for (const price of [100_000, 100_060, 100_100, 100_140]) {
    updatePolyfairVolatilityState(state, price);
  }

  const snapshot = buildPolyfairStrategySnapshot({
    strategy: POLYFAIR_STRATEGIES.LN_EWMA,
    spotPrice: 100_140,
    strikePrice: 100_000,
    secondsRemaining: 180,
    marketUpPrice: 0.45,
    marketDownPrice: 0.55,
    state
  });

  assert.equal(snapshot.fairUp > 0.45, true);
  assert.equal(snapshot.labelUp, "UNDERVALUED");
  assert.equal(snapshot.labelDown, "OVERPRICED");
});

