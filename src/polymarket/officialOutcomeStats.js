import { buildLast24HourOutcomeStats } from "../domain/outcomeStats.js";
import { fetchJson } from "../lib/http.js";
import { safeJsonParse } from "../lib/json.js";
import { config } from "../config.js";
import {
  isBtcFiveMinuteMarket,
  normalizeOutcomeLabel,
  normalizeTrackedMarket
} from "./discovery.js";

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_MAX_PAGES = 20;

let cachedOfficialStats = null;
let inFlightOfficialStats = null;

export async function fetchOfficialLast24HourOutcomeStats({
  now = Date.now(),
  useCache = true
} = {}) {
  const shouldUseCache =
    useCache &&
    cachedOfficialStats &&
    cachedOfficialStats.windowHours === DEFAULT_WINDOW_HOURS &&
    Date.now() - cachedOfficialStats.cachedAt < DEFAULT_CACHE_TTL_MS;

  if (shouldUseCache) {
    return cachedOfficialStats.payload;
  }

  if (inFlightOfficialStats) {
    return inFlightOfficialStats;
  }

  const task = loadOfficialLast24HourOutcomeStats({ now })
    .then((payload) => {
      cachedOfficialStats = {
        cachedAt: Date.now(),
        requestedNow: now,
        windowHours: DEFAULT_WINDOW_HOURS,
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

async function loadOfficialLast24HourOutcomeStats({ now }) {
  const cutoffIso = new Date(now - DEFAULT_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
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

  return buildLast24HourOutcomeStats(markets, {
    hours: DEFAULT_WINDOW_HOURS,
    now
  });
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
