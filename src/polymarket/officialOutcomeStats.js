import { buildLast24HourOutcomeStats } from "../domain/outcomeStats.js";
import { fetchJson } from "../lib/http.js";
import { safeJsonParse } from "../lib/json.js";
import { config } from "../config.js";
import {
  isBtcFiveMinuteMarket,
  normalizeOutcomeLabel,
  normalizeTrackedMarket
} from "./discovery.js";

const DEFAULT_WINDOWS = [24, 24 * 7];
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_MAX_PAGES = 20;

let cachedOfficialStats = null;
let inFlightOfficialStats = null;

export async function fetchOfficialOutcomeStats({
  now = Date.now(),
  useCache = true
} = {}) {
  const shouldUseCache =
    useCache &&
    cachedOfficialStats &&
    Date.now() - cachedOfficialStats.cachedAt < DEFAULT_CACHE_TTL_MS;

  if (shouldUseCache) {
    return cachedOfficialStats.payload;
  }

  if (inFlightOfficialStats) {
    return inFlightOfficialStats;
  }

  const task = loadOfficialOutcomeStats({ now })
    .then((payload) => {
      cachedOfficialStats = {
        cachedAt: Date.now(),
        payload
      };
      return payload;
    })
    .finally(() => {
      inFlightOfficialStats = null;
    });

  inFlightOfficialStats = task;
  return task;
}

async function loadOfficialOutcomeStats({ now }) {
  const longestWindowHours = Math.max(...DEFAULT_WINDOWS);
  const cutoffIso = new Date(now - longestWindowHours * 60 * 60 * 1000).toISOString();
  const nowIso = new Date(now).toISOString();
  const markets = [];
  const seenMarketIds = new Set();

  for (let pageIndex = 0; pageIndex < DEFAULT_MAX_PAGES; pageIndex += 1) {
    const params = new URLSearchParams({
      closed: "true",
      limit: `${DEFAULT_PAGE_SIZE}`,
      offset: `${pageIndex * DEFAULT_PAGE_SIZE}`,
      order: "endDate",
      ascending: "false",
      end_date_min: cutoffIso,
      end_date_max: nowIso
    });

    const url = `${config.gammaBaseUrl}/markets?${params.toString()}`;
    const page = await fetchJson(url);

    if (!Array.isArray(page) || page.length === 0) {
      break;
    }

    for (const rawMarket of page) {
      if (!isBtcFiveMinuteMarket(rawMarket)) {
        continue;
      }

      const normalizedMarket = normalizeOfficialClosedOutcomeMarket(rawMarket);
      if (!normalizedMarket || seenMarketIds.has(normalizedMarket.id)) {
        continue;
      }

      seenMarketIds.add(normalizedMarket.id);
      markets.push(normalizedMarket);
    }

    if (page.length < DEFAULT_PAGE_SIZE) {
      break;
    }
  }

  return {
    asOf: new Date(now).toISOString(),
    source: "polymarket_official",
    windows: {
      last24Hours: buildLast24HourOutcomeStats(markets, {
        hours: 24,
        now
      }),
      last7Days: buildLast24HourOutcomeStats(markets, {
        hours: 24 * 7,
        now
      })
    }
  };
}

export function normalizeOfficialClosedOutcomeMarket(rawMarket) {
  const normalized = normalizeTrackedMarket(rawMarket);

  if (!normalized) {
    return null;
  }

  const outcomes = safeJsonParse(rawMarket.outcomes, []);
  const outcomePrices = safeJsonParse(rawMarket.outcomePrices, []);

  if (!Array.isArray(outcomes) || !Array.isArray(outcomePrices) || outcomes.length !== outcomePrices.length) {
    return null;
  }

  const rankedOutcomes = outcomes
    .map((label, index) => ({
      key: normalizeOutcomeLabel(label, index),
      price: Number(outcomePrices[index])
    }))
    .filter((entry) => Number.isFinite(entry.price))
    .sort((left, right) => right.price - left.price || left.key.localeCompare(right.key));

  if (rankedOutcomes.length === 0) {
    return null;
  }

  if (rankedOutcomes.length > 1 && rankedOutcomes[0].price === rankedOutcomes[1].price) {
    return null;
  }

  return {
    id: normalized.id,
    startedAt: normalized.startDate,
    endsAt: normalized.endDate,
    outcomeKey: rankedOutcomes[0].key,
    source: "polymarket_official"
  };
}
