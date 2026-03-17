import { config } from "../config.js";
import { fetchJson } from "../lib/http.js";
import { safeJsonParse } from "../lib/json.js";
import { parseDate } from "../lib/time.js";

const BTC_MARKET_PATTERN = /\bbitcoin up or down\b/i;
const BTC_SLUG_PATTERN = /^btc-updown-5m-(\d+)$/i;
const DEFAULT_LOOKBACK_MS = 10 * 60 * 1000;
const DEFAULT_LOOKAHEAD_MS = 60 * 60 * 1000;

function marketText(rawMarket) {
  return [
    rawMarket.slug,
    rawMarket.question,
    rawMarket.description,
    rawMarket.events?.[0]?.slug,
    rawMarket.events?.[0]?.title,
    rawMarket.events?.[0]?.description
  ]
    .filter(Boolean)
    .join(" ");
}

export function normalizeOutcomeLabel(label, fallbackIndex) {
  const rawLabel = `${label || ""}`.trim();

  if (/^up$/i.test(rawLabel)) {
    return "UP";
  }

  if (/^down$/i.test(rawLabel)) {
    return "DOWN";
  }

  if (/^yes$/i.test(rawLabel)) {
    return fallbackIndex === 0 ? "YES" : "NO";
  }

  if (/^no$/i.test(rawLabel)) {
    return fallbackIndex === 0 ? "NO" : "YES";
  }

  return rawLabel.toUpperCase() || `OUTCOME_${fallbackIndex + 1}`;
}

export function normalizeTrackedMarket(rawMarket) {
  const event = rawMarket.events?.[0] || null;
  const slug = rawMarket.slug || event?.slug || `${rawMarket.id}`;
  const slugMatch = slug.match(BTC_SLUG_PATTERN);
  const outcomes = safeJsonParse(rawMarket.outcomes, []);
  const assetIds = safeJsonParse(rawMarket.clobTokenIds, []);

  if (!Array.isArray(outcomes) || !Array.isArray(assetIds) || outcomes.length !== assetIds.length) {
    return null;
  }

  const derivedStartTimestamp = slugMatch ? Number(slugMatch[1]) * 1_000 : null;
  const derivedEndTimestamp = derivedStartTimestamp !== null ? derivedStartTimestamp + 5 * 60 * 1_000 : null;
  const startDate =
    derivedStartTimestamp !== null
      ? new Date(derivedStartTimestamp).toISOString()
      : rawMarket.startDate || event?.startDate || null;
  const endDate =
    derivedEndTimestamp !== null
      ? new Date(derivedEndTimestamp).toISOString()
      : rawMarket.endDate || event?.endDate || null;

  const outcomeDefinitions = outcomes.map((outcome, index) => ({
    key: normalizeOutcomeLabel(outcome, index),
    label: `${outcome || `Outcome ${index + 1}`}`.trim() || `Outcome ${index + 1}`,
    assetId: `${assetIds[index]}`
  }));

  return {
    id: `${rawMarket.id}`,
    question: rawMarket.question || event?.title || "Untitled market",
    slug,
    conditionId: rawMarket.conditionId || null,
    eventId: event?.id ? `${event.id}` : null,
    eventTitle: event?.title || rawMarket.question || "Untitled event",
    eventSlug: event?.slug || slug,
    createdAt: rawMarket.startDate || event?.startDate || null,
    startDate,
    endDate,
    startTimestamp:
      derivedStartTimestamp ?? parseDate(startDate)?.getTime() ?? null,
    endTimestamp: derivedEndTimestamp ?? parseDate(endDate)?.getTime() ?? null,
    acceptingOrders: Boolean(rawMarket.acceptingOrders),
    active: Boolean(rawMarket.active),
    closed: Boolean(rawMarket.closed),
    outcomes: outcomeDefinitions
  };
}

export function isBtcFiveMinuteMarket(rawMarket) {
  const text = marketText(rawMarket);
  const slug = rawMarket.slug || rawMarket.events?.[0]?.slug || "";
  const normalized = normalizeTrackedMarket(rawMarket);

  if (!normalized) {
    return false;
  }

  if (slug) {
    return BTC_SLUG_PATTERN.test(slug);
  }

  return BTC_MARKET_PATTERN.test(text);
}

export function selectRelevantMarket(candidates, now = Date.now()) {
  const sorted = [...candidates].sort((left, right) => left.startTimestamp - right.startTimestamp);
  const current = sorted
    .filter((candidate) => candidate.startTimestamp <= now && candidate.endTimestamp > now)
    .at(-1);

  if (current) {
    return { current, next: sorted.find((candidate) => candidate.startTimestamp > now) || null };
  }

  return {
    current: null,
    next: sorted.find((candidate) => candidate.startTimestamp > now) || null
  };
}

export async function fetchCandidateMarkets({ signal, now = Date.now() } = {}) {
  const endMin = new Date(now - DEFAULT_LOOKBACK_MS).toISOString();
  const endMax = new Date(now + DEFAULT_LOOKAHEAD_MS).toISOString();
  const candidates = [];

  for (let pageIndex = 0; pageIndex < config.gammaMaxPages; pageIndex += 1) {
    const params = new URLSearchParams({
      limit: `${config.gammaPageSize}`,
      offset: `${pageIndex * config.gammaPageSize}`,
      closed: "false",
      order: "endDate",
      ascending: "true",
      end_date_min: endMin,
      end_date_max: endMax
    });

    const url = `${config.gammaBaseUrl}/markets?${params.toString()}`;
    const page = await fetchJson(url, { signal });

    if (!Array.isArray(page) || page.length === 0) {
      break;
    }

    for (const market of page) {
      if (!isBtcFiveMinuteMarket(market)) {
        continue;
      }

      const normalized = normalizeTrackedMarket(market);
      if (normalized) {
        candidates.push(normalized);
      }
    }

    if (page.length < config.gammaPageSize) {
      break;
    }
  }

  const deduped = [];
  const seenIds = new Set();

  for (const candidate of candidates) {
    if (seenIds.has(candidate.id)) {
      continue;
    }

    seenIds.add(candidate.id);
    deduped.push(candidate);
  }

  return deduped;
}

export async function discoverBtcFiveMinuteMarkets({ signal, now = Date.now() } = {}) {
  const candidates = await fetchCandidateMarkets({ signal, now });
  return selectRelevantMarket(candidates, now);
}
