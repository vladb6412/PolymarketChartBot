import { config } from "../config.js";

function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function calculateDisplayedPrice(state, spreadThreshold = config.displaySpreadThreshold) {
  const bestBid = toNumber(state.bestBid);
  const bestAsk = toNumber(state.bestAsk);
  const lastTradePrice = toNumber(state.lastTradePrice);

  if (bestBid !== null && bestAsk !== null) {
    const spread = bestAsk - bestBid;
    const midpoint = (bestBid + bestAsk) / 2;

    if (spread <= spreadThreshold) {
      return midpoint;
    }

    if (lastTradePrice !== null) {
      return lastTradePrice;
    }

    return midpoint;
  }

  if (lastTradePrice !== null) {
    return lastTradePrice;
  }

  if (bestBid !== null) {
    return bestBid;
  }

  if (bestAsk !== null) {
    return bestAsk;
  }

  return null;
}

export function normalizeBookState(partialState, spreadThreshold = config.displaySpreadThreshold) {
  const bestBid = toNumber(partialState.bestBid);
  const bestAsk = toNumber(partialState.bestAsk);
  const lastTradePrice = toNumber(partialState.lastTradePrice);
  const spread =
    bestBid !== null && bestAsk !== null ? Number((bestAsk - bestBid).toFixed(6)) : null;
  const displayedPrice = calculateDisplayedPrice(
    { bestBid, bestAsk, lastTradePrice },
    spreadThreshold
  );

  return {
    bestBid,
    bestAsk,
    lastTradePrice,
    spread,
    displayedPrice
  };
}
