import test from "node:test";
import assert from "node:assert/strict";

import { calculateDisplayedPrice, normalizeBookState } from "../src/domain/priceModel.js";

test("calculateDisplayedPrice uses midpoint when spread is within threshold", () => {
  const price = calculateDisplayedPrice({
    bestBid: 0.41,
    bestAsk: 0.45,
    lastTradePrice: 0.35
  });

  assert.equal(price, 0.43);
});

test("calculateDisplayedPrice falls back to last trade when spread is wide", () => {
  const price = calculateDisplayedPrice({
    bestBid: 0.1,
    bestAsk: 0.25,
    lastTradePrice: 0.19
  });

  assert.equal(price, 0.19);
});

test("normalizeBookState returns spread and displayed price", () => {
  const state = normalizeBookState({
    bestBid: "0.32",
    bestAsk: "0.36",
    lastTradePrice: "0.34"
  });

  assert.deepEqual(state, {
    bestBid: 0.32,
    bestAsk: 0.36,
    lastTradePrice: 0.34,
    spread: 0.04,
    displayedPrice: 0.33999999999999997
  });
});
