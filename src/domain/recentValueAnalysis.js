function quantile(sortedValues, q) {
  if (sortedValues.length === 0) {
    return null;
  }

  const index = (sortedValues.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sortedValues[lower];
  }

  const weight = index - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

function normalizeComparablePrice(point) {
  let upPrice = point?.prices?.UP?.displayedPrice;
  let downPrice = point?.prices?.DOWN?.displayedPrice;

  if (!Number.isFinite(upPrice) && Number.isFinite(downPrice)) {
    upPrice = 1 - downPrice;
  }

  if (!Number.isFinite(downPrice) && Number.isFinite(upPrice)) {
    downPrice = 1 - upPrice;
  }

  return {
    upPrice,
    downPrice
  };
}

export function normalizeComparableSnapshot(point) {
  const deltaUsd = point?.polyfair?.spotDeltaUsd;
  const elapsedMs = point?.elapsedMs;
  const recordedAtMs = Date.parse(point?.recordedAt ?? "");
  const prices = normalizeComparablePrice(point);

  if (
    !Number.isFinite(deltaUsd) ||
    !Number.isFinite(elapsedMs) ||
    !Number.isFinite(recordedAtMs) ||
    !Number.isFinite(prices.upPrice) ||
    !Number.isFinite(prices.downPrice)
  ) {
    return null;
  }

  return {
    runId: point?.runId || null,
    recordedAt: point?.recordedAt || null,
    recordedAtMs,
    elapsedMs,
    deltaUsd,
    upPrice: prices.upPrice,
    downPrice: prices.downPrice
  };
}

export function getDeltaBucket(deltaUsd, bucketSizeUsd = 20) {
  if (!Number.isFinite(deltaUsd) || !Number.isFinite(bucketSizeUsd) || bucketSizeUsd <= 0) {
    return null;
  }

  const start = Math.floor(deltaUsd / bucketSizeUsd) * bucketSizeUsd;
  const end = start + bucketSizeUsd;

  return {
    start,
    end,
    label: `${start >= 0 ? "+" : ""}$${start} to ${end >= 0 ? "+" : ""}$${end}`
  };
}

export function classifyValue(
  currentPrice,
  q25,
  q75,
  median,
  sampleCount,
  runCount,
  minSampleCount = 25,
  minRunCount = 3
) {
  if (
    !Number.isFinite(currentPrice) ||
    !Number.isFinite(q25) ||
    !Number.isFinite(q75) ||
    !Number.isFinite(median) ||
    sampleCount < minSampleCount ||
    runCount < minRunCount
  ) {
    return {
      status: "insufficient",
      label: "Insufficient",
      diffVsMedian: Number.isFinite(median) ? currentPrice - median : null
    };
  }

  if (currentPrice < q25) {
    return {
      status: "undervalued",
      label: "Undervalued",
      diffVsMedian: currentPrice - median
    };
  }

  if (currentPrice > q75) {
    return {
      status: "overvalued",
      label: "Overvalued",
      diffVsMedian: currentPrice - median
    };
  }

  return {
    status: "fair",
    label: "Fair",
    diffVsMedian: currentPrice - median
  };
}

function summarizeComparableValues(points, valueKey) {
  const values = points
    .map((point) => point[valueKey])
    .filter(Number.isFinite)
    .sort((left, right) => left - right);

  if (values.length === 0) {
    return null;
  }

  return {
    q25: quantile(values, 0.25),
    median: quantile(values, 0.5),
    q75: quantile(values, 0.75)
  };
}

function overallRecommendation(windows) {
  const ranked = Object.values(windows)
    .flatMap((window) => {
      if (!window) {
        return [];
      }

      return [
        {
          side: "UP",
          hours: window.lookbackHours,
          ...window.up
        },
        {
          side: "DOWN",
          hours: window.lookbackHours,
          ...window.down
        }
      ];
    })
    .filter((entry) => entry.status === "undervalued" && Number.isFinite(entry.diffVsMedian))
    .sort((left, right) => left.diffVsMedian - right.diffVsMedian);

  const best = ranked[0];
  if (!best) {
    return {
      action: "NONE",
      tone: "neutral",
      text: "No clear undervaluation versus the recent history slices."
    };
  }

  const cents = Math.abs(best.diffVsMedian * 100).toFixed(1);
  return {
    action: `BUY_${best.side}`,
    tone: "alert",
    text: `${best.side} is ${cents}c below its ${best.hours}h recent median for this move/time slice.`
  };
}

export function buildRecentValueAnalysis({
  currentSnapshot,
  historicalSnapshots,
  lookbackHours = [3, 6, 12],
  now = Date.now(),
  timeToleranceMs,
  deltaBucketSizeUsd = 20,
  minSampleCount = 25,
  minRunCount = 3
}) {
  const current = normalizeComparableSnapshot(currentSnapshot);

  if (!current) {
    return null;
  }

  const deltaBucket = getDeltaBucket(current.deltaUsd, deltaBucketSizeUsd);
  if (!deltaBucket) {
    return null;
  }

  const windows = {};

  for (const hours of lookbackHours) {
    const cutoff = now - hours * 60 * 60 * 1000;
    const matches = historicalSnapshots.filter(
      (point) =>
        point.recordedAtMs >= cutoff &&
        Math.abs(point.elapsedMs - current.elapsedMs) <= timeToleranceMs &&
        point.deltaUsd >= deltaBucket.start &&
        point.deltaUsd < deltaBucket.end
    );
    const runCount = new Set(matches.map((point) => point.runId).filter(Boolean)).size;
    const upSummary = summarizeComparableValues(matches, "upPrice");
    const downSummary = summarizeComparableValues(matches, "downPrice");

    windows[`${hours}h`] = {
      lookbackHours: hours,
      sampleCount: matches.length,
      runCount,
      up: upSummary
        ? {
            currentPrice: current.upPrice,
            ...upSummary,
            ...classifyValue(
              current.upPrice,
              upSummary.q25,
              upSummary.q75,
              upSummary.median,
              matches.length,
              runCount,
              minSampleCount,
              minRunCount
            )
          }
        : {
            currentPrice: current.upPrice,
            q25: null,
            median: null,
            q75: null,
            ...classifyValue(current.upPrice, null, null, null, 0, 0)
          },
      down: downSummary
        ? {
            currentPrice: current.downPrice,
            ...downSummary,
            ...classifyValue(
              current.downPrice,
              downSummary.q25,
              downSummary.q75,
              downSummary.median,
              matches.length,
              runCount,
              minSampleCount,
              minRunCount
            )
          }
        : {
            currentPrice: current.downPrice,
            q25: null,
            median: null,
            q75: null,
            ...classifyValue(current.downPrice, null, null, null, 0, 0)
          }
    };
  }

  return {
    generatedAt: new Date(now).toISOString(),
    current: {
      recordedAt: current.recordedAt,
      elapsedMs: current.elapsedMs,
      deltaUsd: current.deltaUsd,
      upPrice: current.upPrice,
      downPrice: current.downPrice,
      deltaBucket,
      timeToleranceMs
    },
    windows,
    recommendation: overallRecommendation(windows)
  };
}
