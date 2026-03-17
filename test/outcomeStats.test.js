import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLast24HourOutcomeStats,
  inferOutcomeFromPoints,
  resolveStoredOutcome,
  selectRepresentativeCompletedRuns
} from "../src/domain/outcomeStats.js";

const baseSummary = {
  marketId: "market-1",
  slug: "btc-updown-5m-1",
  question: "Bitcoin Up or Down - Test",
  startedAt: "2026-03-17T00:00:00.000Z",
  endsAt: "2026-03-17T00:05:00.000Z",
  outcomes: [
    { key: "UP", label: "Up", assetId: "asset-up" },
    { key: "DOWN", label: "Down", assetId: "asset-down" }
  ]
};

test("resolveStoredOutcome prefers winning asset id and normalizes winning outcome labels", () => {
  assert.equal(
    resolveStoredOutcome({
      ...baseSummary,
      winningAssetId: "asset-down"
    }),
    "DOWN"
  );

  assert.equal(
    resolveStoredOutcome({
      ...baseSummary,
      winningOutcome: "Up"
    }),
    "UP"
  );
});

test("inferOutcomeFromPoints carries the last observed lead forward", () => {
  const inferred = inferOutcomeFromPoints(baseSummary, [
    {
      recordedAt: "2026-03-17T00:04:22.245Z",
      elapsedMs: 262245,
      prices: {
        UP: { displayedPrice: 0.995 },
        DOWN: { displayedPrice: 0.005 }
      }
    }
  ]);

  assert.deepEqual(inferred, {
    outcomeKey: "UP",
    source: "last_observation_carried_forward",
    recordedAt: "2026-03-17T00:04:22.245Z",
    elapsedMs: 262245
  });
});

test("selectRepresentativeCompletedRuns prefers the non-interrupted run with more data", () => {
  const representatives = selectRepresentativeCompletedRuns([
    {
      ...baseSummary,
      id: "rolled",
      status: "rolled",
      pointCount: 4000,
      createdAt: "2026-03-17T00:00:01.000Z",
      lastRecordedAt: "2026-03-17T00:04:50.000Z"
    },
    {
      ...baseSummary,
      id: "interrupted",
      status: "interrupted",
      pointCount: 1200,
      createdAt: "2026-03-17T00:00:02.000Z",
      lastRecordedAt: "2026-03-17T00:01:30.000Z"
    }
  ]);

  assert.equal(representatives.length, 1);
  assert.equal(representatives[0].id, "rolled");
});

test("buildLast24HourOutcomeStats counts winners and streaks in chronological order", () => {
  const stats = buildLast24HourOutcomeStats(
    [
      {
        id: "r1",
        startedAt: "2026-03-16T05:00:00.000Z",
        endsAt: "2026-03-16T05:05:00.000Z",
        outcomeKey: "UP",
        source: "last_observation_carried_forward"
      },
      {
        id: "r2",
        startedAt: "2026-03-16T05:05:00.000Z",
        endsAt: "2026-03-16T05:10:00.000Z",
        outcomeKey: "UP",
        source: "resolved"
      },
      {
        id: "r3",
        startedAt: "2026-03-16T05:10:00.000Z",
        endsAt: "2026-03-16T05:15:00.000Z",
        outcomeKey: "DOWN",
        source: "resolved"
      },
      {
        id: "r4",
        startedAt: "2026-03-16T05:15:00.000Z",
        endsAt: "2026-03-16T05:20:00.000Z",
        outcomeKey: "DOWN",
        source: "last_observation_carried_forward"
      },
      {
        id: "r5",
        startedAt: "2026-03-15T04:55:00.000Z",
        endsAt: "2026-03-15T05:00:00.000Z",
        outcomeKey: "UP",
        source: "resolved"
      }
    ],
    {
      now: new Date("2026-03-17T05:00:00.000Z").getTime()
    }
  );

  assert.deepEqual(stats, {
    asOf: "2026-03-17T05:00:00.000Z",
    windowHours: 24,
    concludedRuns: 4,
    upCount: 2,
    downCount: 2,
    maxConsecutiveUp: 2,
    maxConsecutiveDown: 2,
    inferredCount: 2,
    resolvedCount: 2
  });
});
