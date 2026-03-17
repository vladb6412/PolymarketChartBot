const STATUS_PRIORITY = new Map([
  ["resolved", 0],
  ["rolled", 1],
  ["recorded", 1],
  ["expired", 2],
  ["interrupted", 3],
  ["live", 4]
]);

export function buildMarketWindowKey(summary) {
  return `${summary.marketId || summary.slug || summary.question || summary.id}|${
    summary.startedAt || ""
  }`;
}

export function compareCompletedRunPreference(left, right) {
  return (
    statusPriority(left.status) - statusPriority(right.status) ||
    (right.pointCount || 0) - (left.pointCount || 0) ||
    timestampOf(right.lastRecordedAt) - timestampOf(left.lastRecordedAt) ||
    timestampOf(right.createdAt) - timestampOf(left.createdAt) ||
    timestampOf(right.recordingStartedAt) - timestampOf(left.recordingStartedAt)
  );
}

export function selectRepresentativeCompletedRuns(runs) {
  const grouped = new Map();

  for (const run of runs) {
    const key = buildMarketWindowKey(run);
    const group = grouped.get(key) || [];
    group.push(run);
    grouped.set(key, group);
  }

  return [...grouped.values()]
    .map((group) => [...group].sort(compareCompletedRunPreference)[0])
    .sort(
      (left, right) =>
        timestampOf(left.endsAt || left.endedAt) - timestampOf(right.endsAt || right.endedAt) ||
        timestampOf(left.startedAt) - timestampOf(right.startedAt)
    );
}

export function resolveStoredOutcome(summary) {
  if (summary.winningAssetId && Array.isArray(summary.outcomes)) {
    const matchedOutcome = summary.outcomes.find(
      (outcome) => outcome.assetId === summary.winningAssetId
    );

    if (matchedOutcome?.key) {
      return matchedOutcome.key;
    }
  }

  if (!summary.winningOutcome) {
    return null;
  }

  const normalizedWinningOutcome = `${summary.winningOutcome}`.trim().toUpperCase();
  const matchedOutcome = (summary.outcomes || []).find(
    (outcome) =>
      outcome.key?.toUpperCase() === normalizedWinningOutcome ||
      outcome.label?.toUpperCase() === normalizedWinningOutcome
  );

  return matchedOutcome?.key || normalizedWinningOutcome;
}

export function inferOutcomeFromPoints(summary, points) {
  const storedOutcome = resolveStoredOutcome(summary);

  if (storedOutcome) {
    return {
      outcomeKey: storedOutcome,
      source: "resolved"
    };
  }

  const latestPoint = [...(points || [])]
    .reverse()
    .find((point) =>
      (summary.outcomes || []).some(
        (outcome) => point.prices?.[outcome.key]?.displayedPrice !== null
      )
    );

  if (!latestPoint) {
    return {
      outcomeKey: null,
      source: "unknown"
    };
  }

  const rankedOutcomes = (summary.outcomes || [])
    .map((outcome) => ({
      key: outcome.key,
      displayedPrice: latestPoint.prices?.[outcome.key]?.displayedPrice
    }))
    .filter((outcome) => outcome.displayedPrice !== null && outcome.displayedPrice !== undefined)
    .sort(
      (left, right) =>
        right.displayedPrice - left.displayedPrice || left.key.localeCompare(right.key)
    );

  if (rankedOutcomes.length === 0) {
    return {
      outcomeKey: null,
      source: "unknown"
    };
  }

  if (rankedOutcomes.length > 1 && rankedOutcomes[0].displayedPrice === rankedOutcomes[1].displayedPrice) {
    return {
      outcomeKey: null,
      source: "unknown"
    };
  }

  return {
    outcomeKey: rankedOutcomes[0].key,
    source: "last_observation_carried_forward",
    recordedAt: latestPoint.recordedAt,
    elapsedMs: latestPoint.elapsedMs
  };
}

export function buildLast24HourOutcomeStats(resolvedRuns, options = {}) {
  const hours = options.hours || 24;
  const now = options.now ?? Date.now();
  const cutoff = now - hours * 60 * 60 * 1000;

  const recentRuns = (resolvedRuns || [])
    .filter((run) => {
      const endedTimestamp = timestampOf(run.endsAt || run.endedAt);
      return endedTimestamp >= cutoff && endedTimestamp <= now && run.outcomeKey;
    })
    .sort(
      (left, right) =>
        timestampOf(left.endsAt || left.endedAt) - timestampOf(right.endsAt || right.endedAt) ||
        timestampOf(left.startedAt) - timestampOf(right.startedAt)
    );

  let upCount = 0;
  let downCount = 0;
  let currentUpStreak = 0;
  let currentDownStreak = 0;
  let maxConsecutiveUp = 0;
  let maxConsecutiveDown = 0;
  let inferredCount = 0;
  let resolvedCount = 0;

  for (const run of recentRuns) {
    if (run.source === "resolved") {
      resolvedCount += 1;
    } else if (run.source === "last_observation_carried_forward") {
      inferredCount += 1;
    }

    if (run.outcomeKey === "UP") {
      upCount += 1;
      currentUpStreak += 1;
      currentDownStreak = 0;
      maxConsecutiveUp = Math.max(maxConsecutiveUp, currentUpStreak);
      continue;
    }

    if (run.outcomeKey === "DOWN") {
      downCount += 1;
      currentDownStreak += 1;
      currentUpStreak = 0;
      maxConsecutiveDown = Math.max(maxConsecutiveDown, currentDownStreak);
      continue;
    }

    currentUpStreak = 0;
    currentDownStreak = 0;
  }

  return {
    asOf: new Date(now).toISOString(),
    windowHours: hours,
    concludedRuns: recentRuns.length,
    upCount,
    downCount,
    maxConsecutiveUp,
    maxConsecutiveDown,
    inferredCount,
    resolvedCount
  };
}

function statusPriority(status) {
  return STATUS_PRIORITY.get(status) ?? 9;
}

function timestampOf(value) {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}
