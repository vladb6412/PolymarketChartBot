import { buildLast24HourOutcomeStats } from "../domain/outcomeStats.js";
import { fetchJson } from "../lib/http.js";
import { safeJsonParse } from "../lib/json.js";
import { config } from "../config.js";
import {
  normalizeOutcomeLabel,
  normalizeTrackedMarket
} from "./discovery.js";

const DEFAULT_WINDOWS = [24, 24 * 7];
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const FIVE_MINUTES_MS = 5 * 60 * 1_000;
const DEFAULT_SLUG_BATCH_SIZE = 100;
const DEFAULT_FETCH_CONCURRENCY = 4;

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
  const markets = [];
  const seenMarketIds = new Set();
  const slugBatches = buildOfficialOutcomeSlugBatches({
    now,
    hours: longestWindowHours
  });
  const rawMarkets = await fetchOfficialMarketsBySlugBatches(slugBatches);

  for (const rawMarket of rawMarkets) {
    const normalizedMarket = normalizeOfficialClosedOutcomeMarket(rawMarket);
    if (!normalizedMarket || seenMarketIds.has(normalizedMarket.id)) {
      continue;
    }

    seenMarketIds.add(normalizedMarket.id);
    markets.push(normalizedMarket);
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

export function buildOfficialOutcomeSlugBatches({
  now = Date.now(),
  hours = Math.max(...DEFAULT_WINDOWS),
  batchSize = DEFAULT_SLUG_BATCH_SIZE
} = {}) {
  const cutoffTimestamp = now - hours * 60 * 60 * 1_000;
  const earliestStartTimestamp = floorToFiveMinutes(cutoffTimestamp) - FIVE_MINUTES_MS;
  const latestStartTimestamp = floorToFiveMinutes(now) - FIVE_MINUTES_MS;

  if (latestStartTimestamp < earliestStartTimestamp) {
    return [];
  }

  const slugs = [];

  for (
    let startTimestamp = earliestStartTimestamp;
    startTimestamp <= latestStartTimestamp;
    startTimestamp += FIVE_MINUTES_MS
  ) {
    slugs.push(`btc-updown-5m-${Math.floor(startTimestamp / 1_000)}`);
  }

  const batches = [];

  for (let index = 0; index < slugs.length; index += batchSize) {
    batches.push(slugs.slice(index, index + batchSize));
  }

  return batches;
}

export function normalizeOfficialClosedOutcomeMarket(rawMarket) {
  if (!rawMarket?.closed) {
    return null;
  }

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

async function fetchOfficialMarketsBySlugBatches(slugBatches) {
  const pages = [];

  for (let index = 0; index < slugBatches.length; index += DEFAULT_FETCH_CONCURRENCY) {
    const group = slugBatches.slice(index, index + DEFAULT_FETCH_CONCURRENCY);
    const groupPages = await Promise.all(group.map((batch) => fetchOfficialMarketsBySlugs(batch)));
    pages.push(...groupPages);
  }

  return pages.flat();
}

async function fetchOfficialMarketsBySlugs(slugs) {
  if (!Array.isArray(slugs) || slugs.length === 0) {
    return [];
  }

  const params = new URLSearchParams({
    closed: "true",
    limit: `${slugs.length}`,
    order: "endDate",
    ascending: "false"
  });

  for (const slug of slugs) {
    params.append("slug", slug);
  }

  const url = `${config.gammaBaseUrl}/markets?${params.toString()}`;
  const page = await fetchJson(url);

  return Array.isArray(page) ? page : [];
}

function floorToFiveMinutes(timestamp) {
  return Math.floor(timestamp / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
}
