import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tempDataDirectory = await fs.mkdtemp(
  path.join(os.tmpdir(), "polymarket-chart-bot-runstore-")
);

process.env.DATA_DIR = tempDataDirectory;

const { RunStore } = await import("../src/persistence/runStore.js");
const { COMPRESSED_RUN_STORAGE_FORMAT } = await import(
  "../src/persistence/runArtifacts.js"
);

const runsDirectory = path.join(tempDataDirectory, "runs");
const stores = [];

test.after(async () => {
  await Promise.all(stores.map((store) => store.flush()));
  delete process.env.DATA_DIR;
  await fs.rm(tempDataDirectory, { recursive: true, force: true });
});

function buildSnapshot(recordedAt, elapsedMs, upPrice, downPrice) {
  return {
    recordedAt,
    runId: "test-run",
    marketId: "market-1",
    marketSlug: "btc-updown-5m-test",
    marketQuestion: "Bitcoin Up or Down - Test Window",
    marketStartedAt: "2026-03-17T01:00:00.000Z",
    marketEndsAt: "2026-03-17T01:05:00.000Z",
    elapsedMs,
    prices: {
      UP: {
        key: "UP",
        label: "Up",
        assetId: "asset-up",
        displayedPrice: upPrice
      },
      DOWN: {
        key: "DOWN",
        label: "Down",
        assetId: "asset-down",
        displayedPrice: downPrice
      }
    }
  };
}

test("RunStore compresses completed runs and can still reload them", async () => {
  const store = new RunStore();
  stores.push(store);
  await store.init();

  const run = await store.startRun({
    id: "test-run",
    status: "live",
    marketId: "market-1",
    conditionId: "condition-1",
    slug: "btc-updown-5m-test",
    eventTitle: "Bitcoin Up or Down - Test Window",
    question: "Bitcoin Up or Down - Test Window",
    startedAt: "2026-03-17T01:00:00.000Z",
    recordingStartedAt: "2026-03-17T01:00:02.000Z",
    endsAt: "2026-03-17T01:05:00.000Z",
    outcomes: [
      { key: "UP", label: "Up", assetId: "asset-up" },
      { key: "DOWN", label: "Down", assetId: "asset-down" }
    ]
  });

  await store.appendSnapshot(
    run.id,
    buildSnapshot("2026-03-17T01:00:10.000Z", 10_000, 0.54, 0.46)
  );
  await store.appendSnapshot(
    run.id,
    buildSnapshot("2026-03-17T01:04:59.000Z", 299_000, 0.61, 0.39)
  );

  await store.finishRun(run.id, {
    status: "recorded",
    endedAt: "2026-03-17T01:05:00.000Z"
  });
  await store.flush();

  const files = await fs.readdir(runsDirectory);
  assert.deepEqual(files.sort(), [`${run.id}.jsonl.gz`]);

  const loaded = await store.loadRun(run.id);
  assert.equal(loaded.run.storageFormat, COMPRESSED_RUN_STORAGE_FORMAT);
  assert.equal(loaded.run.archiveStatus, "ready");
  assert.equal(loaded.run.pointCount, 2);
  assert.equal(loaded.points.length, 2);
  assert.equal(loaded.points[1].prices.UP.displayedPrice, 0.61);

  const artifact = await store.getRunArtifact(run.id);
  assert.equal(artifact.fileName, `${run.id}.jsonl.gz`);
  assert.equal(artifact.storageFormat, COMPRESSED_RUN_STORAGE_FORMAT);

  const rebuiltStore = new RunStore();
  stores.push(rebuiltStore);
  await rebuiltStore.init();
  const rebuilt = await rebuiltStore.loadRun(run.id);

  assert.equal(rebuilt.run.storageFormat, COMPRESSED_RUN_STORAGE_FORMAT);
  assert.equal(rebuilt.points.length, 2);
  assert.equal(rebuilt.points[0].prices.DOWN.displayedPrice, 0.46);
});

test("RunStore removes empty duplicate live runs and exposes the resumable run", async () => {
  const store = new RunStore();
  stores.push(store);
  await store.init();

  await store.startRun({
    id: "resume-primary",
    status: "live",
    marketId: "market-resume",
    conditionId: "condition-resume",
    slug: "btc-updown-5m-resume",
    eventTitle: "Bitcoin Up or Down - Resume Window",
    question: "Bitcoin Up or Down - Resume Window",
    startedAt: "2026-03-17T02:00:00.000Z",
    recordingStartedAt: "2026-03-17T02:00:01.000Z",
    endsAt: "2099-03-17T02:05:00.000Z",
    outcomes: [
      { key: "UP", label: "Up", assetId: "asset-up" },
      { key: "DOWN", label: "Down", assetId: "asset-down" }
    ]
  });

  await store.appendSnapshot(
    "resume-primary",
    buildSnapshot("2026-03-17T02:00:10.000Z", 10_000, 0.58, 0.42)
  );

  await store.startRun({
    id: "resume-empty-duplicate",
    status: "live",
    marketId: "market-resume",
    conditionId: "condition-resume",
    slug: "btc-updown-5m-resume",
    eventTitle: "Bitcoin Up or Down - Resume Window",
    question: "Bitcoin Up or Down - Resume Window",
    startedAt: "2026-03-17T02:00:00.000Z",
    recordingStartedAt: "2026-03-17T02:00:03.000Z",
    endsAt: "2099-03-17T02:05:00.000Z",
    outcomes: [
      { key: "UP", label: "Up", assetId: "asset-up" },
      { key: "DOWN", label: "Down", assetId: "asset-down" }
    ]
  });

  await store.reconcileLiveRuns();

  const resumable = await store.findResumableRun({
    id: "market-resume",
    slug: "btc-updown-5m-resume",
    startDate: "2026-03-17T02:00:00.000Z"
  });
  const listedRuns = await store.listRuns(10);
  const runFiles = await fs.readdir(runsDirectory);

  assert.equal(resumable.id, "resume-primary");
  assert.equal(listedRuns.total >= 1, true);
  assert.equal(listedRuns.runs.filter((entry) => entry.status === "live").length, 1);
  assert.equal(runFiles.includes("resume-empty-duplicate.jsonl"), false);
  assert.equal(runFiles.includes("resume-primary.jsonl"), true);
});
