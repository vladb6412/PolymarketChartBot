import { buildLast24HourOutcomeStats } from "../domain/outcomeStats.js";
import { fetchJson } from "../lib/http.js";
import { safeJsonParse } from "../lib/json.js";
import { config } from "../config.js";
import {
  normalizeOutcomeLabel,
  normalizeTrackedMarket
} from "./discovery.js";

const DEFAULT_WINDOWS = [24, 24 * 3];
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_SLUG_BATCH_SIZE = 100;
const DEFAULT_FETCH_CONCURRENCY = 4;

const cachedOfficialStats = new Map();
const inFlightOfficialStats = new Map();

export async function fetchOfficialOutcomeStats({
  intervalMinutes = 5,
  now = Date.now(),
  useCache = true
} = {}) {
  const cacheKey = `${intervalMinutes}`;
  const cachedEntry = cachedOfficialStats.get(cacheKey) || null;
  const shouldUseCache =
    useCache &&
    cachedEntry &&
    Date.now() - cachedEntry.cachedAt < DEFAULT_CACHE_TTL_MS;

  if (shouldUseCache) {
    return cachedEntry.payload;
  }

  const inFlightTask = inFlightOfficialStats.get(cacheKey) || null;
  if (inFlightTask) {
    return inFlightTask;
  }

  const task = loadOfficialOutcomeStats({ intervalMinutes, now })
    .then((payload) => {
      cachedOfficialStats.set(cacheKey, {
        cachedAt: Date.now(),
        payload
      });
      return payload;
    })
    .finally(() => {
      inFlightOfficialStats.delete(cacheKey);
    });

  inFlightOfficialStats.set(cacheKey, task);
  return task;
}

async function loadOfficialOutcomeStats({ intervalMinutes, now }) {
  const longestWindowHours = Math.max(...DEFAULT_WINDOWS);
  const markets = [];
  const seenMarketIds = new Set();
  const slugBatches = buildOfficialOutcomeSlugBatches({
    intervalMinutes,
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
    intervalMinutes,
    windows: {
      last24Hours: buildLast24HourOutcomeStats(markets, {
        hours: 24,
        now
      }),
      last3Days: buildLast24HourOutcomeStats(markets, {
        hours: 24 * 3,
        now
      })
    }
  };
}

export function buildOfficialOutcomeSlugBatches({
  intervalMinutes = 5,
  now = Date.now(),
  hours = Math.max(...DEFAULT_WINDOWS),
  batchSize = DEFAULT_SLUG_BATCH_SIZE
} = {}) {
  const intervalMs = intervalMinutes * 60 * 1_000;
  const cutoffTimestamp = now - hours * 60 * 60 * 1_000;
  const earliestStartTimestamp = floorToInterval(cutoffTimestamp, intervalMs) - intervalMs;
  const latestStartTimestamp = floorToInterval(now, intervalMs) - intervalMs;

  if (latestStartTimestamp < earliestStartTimestamp) {
    return [];
  }

  const slugs = [];

  for (
    let startTimestamp = earliestStartTimestamp;
    startTimestamp <= latestStartTimestamp;
    startTimestamp += intervalMs
  ) {
    slugs.push(`btc-updown-${intervalMinutes}m-${Math.floor(startTimestamp / 1_000)}`);
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

function floorToInterval(timestamp, intervalMs) {
  return Math.floor(timestamp / intervalMs) * intervalMs;
}
