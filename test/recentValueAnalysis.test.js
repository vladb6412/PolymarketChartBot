import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRecentValueAnalysis,
  getDeltaBucket,
  normalizeComparableSnapshot
} from "../src/domain/recentValueAnalysis.js";

test("normalizeComparableSnapshot infers the missing binary side", () => {
  const normalized = normalizeComparableSnapshot({
    runId: "run-1",
    recordedAt: "2026-03-22T10:00:00.000Z",
    elapsedMs: 75_000,
    prices: {
      UP: { displayedPrice: 0.42 }
    },
    polyfair: {
      spotDeltaUsd: 18
    }
  });

  assert.equal(normalized.runId, "run-1");
  assert.equal(normalized.recordedAt, "2026-03-22T10:00:00.000Z");
  assert.equal(normalized.recordedAtMs, Date.parse("2026-03-22T10:00:00.000Z"));
  assert.equal(normalized.elapsedMs, 75_000);
  assert.equal(normalized.deltaUsd, 18);
  assert.equal(normalized.upPrice, 0.42);
  assert.ok(Math.abs(normalized.downPrice - 0.58) < 1e-9);
});

test("buildRecentValueAnalysis compares only recent matching move and elapsed slices", () => {
  const currentSnapshot = {
    runId: "live-run",
    recordedAt: "2026-03-22T12:00:00.000Z",
    elapsedMs: 140_000,
    prices: {
      UP: { displayedPrice: 0.61 },
      DOWN: { displayedPrice: 0.39 }
    },
    polyfair: {
      spotDeltaUsd: 31
    }
  };
  const historicalSnapshots = [
    {
      runId: "a",
      recordedAtMs: Date.parse("2026-03-22T11:50:00.000Z"),
      elapsedMs: 130_000,
      deltaUsd: 25,
      upPrice: 0.7,
      downPrice: 0.3
    },
    {
      runId: "b",
      recordedAtMs: Date.parse("2026-03-22T11:40:00.000Z"),
      elapsedMs: 150_000,
      deltaUsd: 39,
      upPrice: 0.76,
      downPrice: 0.24
    },
    {
      runId: "c",
      recordedAtMs: Date.parse("2026-03-22T11:20:00.000Z"),
      elapsedMs: 138_000,
      deltaUsd: 28,
      upPrice: 0.74,
      downPrice: 0.26
    },
    {
      runId: "d",
      recordedAtMs: Date.parse("2026-03-22T11:58:00.000Z"),
      elapsedMs: 250_000,
      deltaUsd: 30,
      upPrice: 0.9,
      downPrice: 0.1
    },
    {
      runId: "e",
      recordedAtMs: Date.parse("2026-03-22T11:55:00.000Z"),
      elapsedMs: 140_000,
      deltaUsd: 55,
      upPrice: 0.91,
      downPrice: 0.09
    }
  ];

  const analysis = buildRecentValueAnalysis({
    currentSnapshot,
    historicalSnapshots,
    now: Date.parse("2026-03-22T12:00:00.000Z"),
    timeToleranceMs: 30_000,
    lookbackHours: [3],
    minSampleCount: 1
  });

  assert.deepEqual(getDeltaBucket(31, 20), {
    start: 20,
    end: 40,
    label: "+$20 to +$40"
  });

  assert.equal(analysis.current.deltaBucket.label, "+$20 to +$40");
  assert.equal(analysis.windows["3h"].sampleCount, 3);
  assert.equal(analysis.windows["3h"].runCount, 3);
  assert.equal(analysis.windows["3h"].up.status, "undervalued");
  assert.equal(analysis.windows["3h"].down.status, "overvalued");
  assert.equal(analysis.recommendation.action, "BUY_UP");
});
