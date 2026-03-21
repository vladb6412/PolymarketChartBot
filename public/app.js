const monitorConfig = window.MONITOR_CONFIG || {};
const RUN_PAGE_SIZE = 500;

const state = {
  axisMode: "elapsed",
  followLive: true,
  liveState: null,
  runCatalog: [],
  runCatalogTotal: 0,
  selectedRunId: null,
  selectedRun: null,
  loadVersion: 0,
  loadingRunId: null,
  loadingMoreRuns: false
};

const elements = {
  axisToggleButton: document.querySelector("#axis-toggle-button"),
  followLiveButton: document.querySelector("#follow-live-button"),
  previousRunButton: document.querySelector("#previous-run-button"),
  nextRunButton: document.querySelector("#next-run-button"),
  selectedRunPosition: document.querySelector("#selected-run-position"),
  chartTitle: document.querySelector("#chart-title"),
  phaseBadge: document.querySelector("#phase-badge"),
  selectionBadge: document.querySelector("#selection-badge"),
  chartWindow: document.querySelector("#chart-window"),
  chartUpdated: document.querySelector("#chart-updated"),
  chartEmpty: document.querySelector("#chart-empty"),
  marketStatus: document.querySelector("#market-status"),
  viewMode: document.querySelector("#view-mode"),
  marketWindow: document.querySelector("#market-window"),
  marketRecording: document.querySelector("#market-recording"),
  marketPoints: document.querySelector("#market-points"),
  nextMarketWindow: document.querySelector("#next-market-window"),
  datasetLabel: document.querySelector("#dataset-label"),
  savedRuns: document.querySelector("#saved-runs"),
  selectedRunIdLabel: document.querySelector("#selected-run-id"),
  dataPath: document.querySelector("#data-path"),
  upPrice: document.querySelector("#up-price"),
  upDetail: document.querySelector("#up-detail"),
  downPrice: document.querySelector("#down-price"),
  downDetail: document.querySelector("#down-detail"),
  polyfairSource: document.querySelector("#polyfair-source"),
  polyfairStrategy: document.querySelector("#polyfair-strategy"),
  polyfairSpot: document.querySelector("#polyfair-spot"),
  polyfairStrike: document.querySelector("#polyfair-strike"),
  polyfairMove: document.querySelector("#polyfair-move"),
  polyfairVol: document.querySelector("#polyfair-vol"),
  polyfairSeconds: document.querySelector("#polyfair-seconds"),
  polyfairUpFair: document.querySelector("#polyfair-up-fair"),
  polyfairUpDetail: document.querySelector("#polyfair-up-detail"),
  polyfairUpLabel: document.querySelector("#polyfair-up-label"),
  polyfairDownFair: document.querySelector("#polyfair-down-fair"),
  polyfairDownDetail: document.querySelector("#polyfair-down-detail"),
  polyfairDownLabel: document.querySelector("#polyfair-down-label"),
  polyfairRecommendation: document.querySelector("#polyfair-recommendation"),
  chartCanvas: document.querySelector("#chart-canvas")
};

const chartContext = elements.chartCanvas.getContext("2d");
const apiBasePath = `${monitorConfig.apiBasePath || "/api"}`.replace(/\/+$/, "");
const defaultDurationMinutes = Number(monitorConfig.defaultDurationMinutes) || 5;
const storagePathLabel =
  monitorConfig.storagePathLabel || "data/runs/*.jsonl.gz + live .jsonl";
const datasetLabel = monitorConfig.datasetLabel || "iteration-2";
const waitingChartTitle = monitorConfig.waitingChartTitle || "Waiting for market data";
const failedChartTitle = monitorConfig.failedChartTitle || "Failed to load monitor";

function apiPath(suffix) {
  return `${apiBasePath}${suffix}`;
}

function compareRuns(left, right) {
  return new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime();
}

function formatTimestamp(value) {
  if (!value) {
    return "-";
  }

  return new Intl.DateTimeFormat([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(value));
}

function formatWindow(startValue, endValue) {
  if (!startValue || !endValue) {
    return "-";
  }

  const formatter = new Intl.DateTimeFormat([], {
    hour: "2-digit",
    minute: "2-digit"
  });

  return `${formatter.format(new Date(startValue))} - ${formatter.format(new Date(endValue))}`;
}

function formatProbability(value) {
  if (value === null || value === undefined) {
    return "-";
  }

  return `${(value * 100).toFixed(1)}%`;
}

function formatUsd(value) {
  if (value === null || value === undefined) {
    return "-";
  }

  return `$${Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function formatUsdDelta(value, direction) {
  if (value === null || value === undefined) {
    return "-";
  }

  const absoluteValue = Math.abs(Number(value));
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  const locationLabel =
    direction === "up"
      ? "above strike"
      : direction === "down"
        ? "below strike"
        : "at strike";

  return `${sign}${formatUsd(absoluteValue)} ${locationLabel}`;
}

function formatSpread(value) {
  if (value === null || value === undefined) {
    return "spread -";
  }

  return `spread ${(value * 100).toFixed(1)}c`;
}

function formatPolyfairDiff(value) {
  if (value === null || value === undefined) {
    return "diff -";
  }

  const cents = (value * 100).toFixed(1);
  return `diff ${value >= 0 ? "+" : ""}${cents}c`;
}

function formatVolatility(value) {
  if (value === null || value === undefined) {
    return "-";
  }

  return `${(value * 100).toFixed(3)}%`;
}

function formatCountdownSeconds(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  const minutes = Math.floor(value / 60);
  const seconds = value % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function strategyLabel(value) {
  if (value === "LN_EWMA") {
    return "Classic";
  }

  if (value === "LN_GARCH") {
    return "Adaptive";
  }

  if (value === "T_EWMA") {
    return "Fat Tails";
  }

  return value || "-";
}

function formatAxisMinutes(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  return Number.isInteger(value) ? `${value}` : value.toFixed(1);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json();
}

function getRunDurationMinutes(run) {
  const startValue = run?.startedAt || run?.startDate || run?.marketStartedAt || null;
  const endValue = run?.endsAt || run?.endDate || run?.marketEndsAt || null;

  if (startValue && endValue) {
    const durationMinutes =
      (new Date(endValue).getTime() - new Date(startValue).getTime()) / 60_000;

    if (Number.isFinite(durationMinutes) && durationMinutes > 0) {
      return durationMinutes;
    }
  }

  return defaultDurationMinutes;
}

function getCurrentRunFromLiveState() {
  return state.liveState?.currentRun || null;
}

function mergeRunCatalog(runs) {
  const merged = new Map(state.runCatalog.map((run) => [run.id, run]));

  for (const run of runs || []) {
    merged.set(run.id, {
      ...(merged.get(run.id) || {}),
      ...run
    });
  }

  state.runCatalog = [...merged.values()].sort(compareRuns);
}

async function refreshRunCatalog(limit = RUN_PAGE_SIZE, offset = 0) {
  const payload = await fetchJson(apiPath(`/runs?limit=${limit}&offset=${offset}`));
  mergeRunCatalog(payload.runs);
  state.runCatalogTotal = Math.max(
    state.runCatalogTotal,
    Number(payload.total) || state.runCatalog.length
  );
}

async function loadMoreRuns() {
  if (state.loadingMoreRuns || state.runCatalog.length >= state.runCatalogTotal) {
    return;
  }

  state.loadingMoreRuns = true;

  try {
    await refreshRunCatalog(RUN_PAGE_SIZE, state.runCatalog.length);
  } finally {
    state.loadingMoreRuns = false;
  }
}

async function ensureRunCatalogLoadedThrough(targetIndex) {
  while (targetIndex >= state.runCatalog.length && state.runCatalog.length < state.runCatalogTotal) {
    const previousLength = state.runCatalog.length;
    await loadMoreRuns();

    if (state.runCatalog.length === previousLength) {
      break;
    }
  }
}

function getSelectedRunIndex() {
  return state.runCatalog.findIndex((run) => run.id === state.selectedRunId);
}

async function loadRun(runId) {
  state.loadingRunId = runId;
  const version = state.loadVersion + 1;
  state.loadVersion = version;

  const payload = await fetchJson(apiPath(`/runs/${encodeURIComponent(runId)}`));

  if (version !== state.loadVersion) {
    return;
  }

  state.selectedRunId = runId;
  state.selectedRun = payload;
  state.loadingRunId = null;
  render();
}

function selectRun(runId, { followLive = false } = {}) {
  state.followLive = followLive;

  if (
    state.selectedRunId === runId &&
    (state.selectedRun || state.loadingRunId === runId)
  ) {
    render();
    return;
  }

  state.selectedRunId = runId;
  state.selectedRun = null;
  render();
  loadRun(runId).catch((error) => {
    state.loadingRunId = null;
    console.error(error);
  });
}

function ensureSelectedRun() {
  const currentRun = getCurrentRunFromLiveState();

  if (state.followLive && currentRun) {
    if (state.selectedRunId !== currentRun.id || !state.selectedRun) {
      selectRun(currentRun.id, { followLive: true });
    }
    return;
  }

  if (!state.selectedRunId) {
    const fallbackRun = state.runCatalog[0] || currentRun;
    if (fallbackRun) {
      selectRun(fallbackRun.id, { followLive: false });
    }
  }
}

function syncSelectedRunSummary() {
  if (!state.selectedRun) {
    return;
  }

  const catalogSummary = state.runCatalog.find((run) => run.id === state.selectedRunId);
  if (catalogSummary) {
    state.selectedRun.run = {
      ...state.selectedRun.run,
      ...catalogSummary
    };
  }

  const currentRun = getCurrentRunFromLiveState();
  if (currentRun?.id === state.selectedRunId) {
    state.selectedRun.run = {
      ...state.selectedRun.run,
      ...currentRun
    };
  }
}

function appendLiveSnapshotIfNeeded() {
  const currentRun = getCurrentRunFromLiveState();
  const currentSnapshot = state.liveState?.currentSnapshot;

  if (!currentRun || !currentSnapshot || state.selectedRunId !== currentRun.id) {
    return;
  }

  if (!state.selectedRun) {
    state.selectedRun = {
      run: currentRun,
      points: []
    };
  }

  const lastPoint = state.selectedRun.points.at(-1);
  if (lastPoint?.recordedAt === currentSnapshot.recordedAt) {
    return;
  }

  state.selectedRun.run = currentRun;
  state.selectedRun.points.push(currentSnapshot);
}

function buildLiveRunDetail() {
  const currentRun = getCurrentRunFromLiveState();

  if (!currentRun) {
    return null;
  }

  return {
    run: currentRun,
    points: state.selectedRun?.run?.id === currentRun.id ? state.selectedRun.points : []
  };
}

function getDisplayedRunDetail() {
  if (state.followLive) {
    const liveDetail = buildLiveRunDetail();
    if (liveDetail) {
      return liveDetail;
    }
  }

  return state.selectedRun;
}

function lineColorForKey(key, fallbackIndex) {
  if (/up|yes/i.test(key)) {
    return "#157f53";
  }

  if (/down|no/i.test(key)) {
    return "#c03a2b";
  }

  return fallbackIndex === 0 ? "#157f53" : "#c03a2b";
}

function extractSeries(runDetail) {
  if (!runDetail?.run?.outcomes || runDetail.run.outcomes.length === 0) {
    return [];
  }

  const durationMinutes = getRunDurationMinutes(runDetail.run);

  return runDetail.run.outcomes.map((outcome, index) => ({
    ...outcome,
    color: lineColorForKey(outcome.key, index),
    points: (runDetail.points || [])
      .map((point) => ({
        x:
          state.axisMode === "elapsed"
            ? point.elapsedMs / 60_000
            : Math.max(
                0,
                (new Date(point.marketEndsAt).getTime() - new Date(point.recordedAt).getTime()) /
                  60_000
              ),
        y: point.prices?.[outcome.key]?.displayedPrice ?? null
      }))
      .filter((point) => point.y !== null && point.x <= durationMinutes)
  }));
}

function drawChart(runDetail) {
  const rect = elements.chartCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  elements.chartCanvas.width = Math.floor(rect.width * dpr);
  elements.chartCanvas.height = Math.floor(rect.height * dpr);
  chartContext.setTransform(dpr, 0, 0, dpr, 0, 0);

  const width = rect.width;
  const height = rect.height;
  chartContext.clearRect(0, 0, width, height);

  const padding = { top: 28, right: 24, bottom: 46, left: 54 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const durationMinutes = getRunDurationMinutes(runDetail?.run);

  chartContext.fillStyle = "#fffaf1";
  chartContext.fillRect(0, 0, width, height);

  chartContext.strokeStyle = "rgba(28, 35, 32, 0.12)";
  chartContext.lineWidth = 1;

  for (let step = 0; step <= 5; step += 1) {
    const y = padding.top + (plotHeight / 5) * step;
    chartContext.beginPath();
    chartContext.moveTo(padding.left, y);
    chartContext.lineTo(width - padding.right, y);
    chartContext.stroke();
  }

  for (let step = 0; step <= 5; step += 1) {
    const x = padding.left + (plotWidth / 5) * step;
    chartContext.beginPath();
    chartContext.moveTo(x, padding.top);
    chartContext.lineTo(x, height - padding.bottom);
    chartContext.stroke();
  }

  chartContext.strokeStyle = "#1c2320";
  chartContext.lineWidth = 1.5;
  chartContext.beginPath();
  chartContext.moveTo(padding.left, padding.top);
  chartContext.lineTo(padding.left, height - padding.bottom);
  chartContext.lineTo(width - padding.right, height - padding.bottom);
  chartContext.stroke();

  chartContext.fillStyle = "#38443f";
  chartContext.font = '12px "IBM Plex Mono", "SFMono-Regular", monospace';
  chartContext.textAlign = "right";

  for (let step = 0; step <= 5; step += 1) {
    const yValue = 1 - step / 5;
    const y = padding.top + (plotHeight / 5) * step + 4;
    chartContext.fillText(`${Math.round(yValue * 100)}%`, padding.left - 10, y);
  }

  chartContext.textAlign = "center";
  for (let step = 0; step <= 5; step += 1) {
    const xValue =
      state.axisMode === "elapsed"
        ? (durationMinutes / 5) * step
        : durationMinutes - (durationMinutes / 5) * step;
    const x = padding.left + (plotWidth / 5) * step;
    chartContext.fillText(`${formatAxisMinutes(xValue)}m`, x, height - padding.bottom + 24);
  }

  const series = extractSeries(runDetail);
  const hasData = series.some((entry) => entry.points.length > 0);
  elements.chartEmpty.hidden = hasData;

  if (!hasData) {
    return;
  }

  for (const entry of series) {
    chartContext.strokeStyle = entry.color;
    chartContext.lineWidth = 3;
    chartContext.beginPath();

    entry.points.forEach((point, pointIndex) => {
      const x = padding.left + (point.x / durationMinutes) * plotWidth;
      const y = padding.top + (1 - point.y) * plotHeight;

      if (pointIndex === 0) {
        chartContext.moveTo(x, y);
      } else {
        chartContext.lineTo(x, y);
      }
    });

    chartContext.stroke();

    const latest = entry.points.at(-1);
    if (latest) {
      const x = padding.left + (latest.x / durationMinutes) * plotWidth;
      const y = padding.top + (1 - latest.y) * plotHeight;
      chartContext.fillStyle = entry.color;
      chartContext.beginPath();
      chartContext.arc(x, y, 4.5, 0, Math.PI * 2);
      chartContext.fill();
    }
  }
}

function renderCurrentPriceCard(outcome, valueElement, detailElement) {
  if (!outcome) {
    valueElement.textContent = "-";
    detailElement.textContent = "No quote";
    return;
  }

  valueElement.textContent = formatProbability(outcome.displayedPrice);
  detailElement.textContent = `${formatSpread(outcome.spread)} | last ${formatProbability(
    outcome.lastTradePrice
  )}`;
}

function renderPolyfairLabel(element, value) {
  element.textContent = value || "-";
  element.className = "polyfair-label";

  if (value === "UNDERVALUED") {
    element.classList.add("polyfair-label-undervalued");
  } else if (value === "OVERPRICED") {
    element.classList.add("polyfair-label-overpriced");
  } else {
    element.classList.add("polyfair-label-neutral");
  }
}

function renderPolyfairPanel(polyfairSnapshot) {
  if (!polyfairSnapshot) {
    elements.polyfairSource.textContent = "-";
    elements.polyfairStrategy.textContent = "-";
    elements.polyfairSpot.textContent = "-";
    elements.polyfairStrike.textContent = "-";
    elements.polyfairMove.textContent = "-";
    elements.polyfairVol.textContent = "-";
    elements.polyfairSeconds.textContent = "-";
    elements.polyfairUpFair.textContent = "-";
    elements.polyfairUpDetail.textContent = "No model yet";
    renderPolyfairLabel(elements.polyfairUpLabel, null);
    elements.polyfairDownFair.textContent = "-";
    elements.polyfairDownDetail.textContent = "No model yet";
    renderPolyfairLabel(elements.polyfairDownLabel, null);
    elements.polyfairRecommendation.textContent = "Waiting for Polyfair-aligned data.";
    elements.polyfairRecommendation.className = "panel-note polyfair-recommendation-neutral";
    return;
  }

  const selectedStrategy =
    polyfairSnapshot.strategies?.[polyfairSnapshot.defaultStrategy] || null;
  const recommendation = polyfairSnapshot.recommendation || {
    tone: "neutral",
    text: "Fair value - no edge"
  };

  elements.polyfairSource.textContent = polyfairSnapshot.source || "-";
  elements.polyfairStrategy.textContent = strategyLabel(polyfairSnapshot.defaultStrategy);
  elements.polyfairSpot.textContent = formatUsd(polyfairSnapshot.spotPrice);
  elements.polyfairStrike.textContent = formatUsd(polyfairSnapshot.strikePrice);
  elements.polyfairMove.textContent = formatUsdDelta(
    polyfairSnapshot.spotDeltaUsd,
    polyfairSnapshot.spotDeltaDirection
  );
  elements.polyfairVol.textContent = formatVolatility(polyfairSnapshot.volatility);
  elements.polyfairSeconds.textContent = formatCountdownSeconds(polyfairSnapshot.secondsRemaining);
  elements.polyfairUpFair.textContent = formatProbability(selectedStrategy?.fairUp);
  elements.polyfairUpDetail.textContent = `${formatProbability(
    selectedStrategy?.marketUp
  )} market | ${formatPolyfairDiff(selectedStrategy?.diffUp)}`;
  renderPolyfairLabel(elements.polyfairUpLabel, selectedStrategy?.labelUp);
  elements.polyfairDownFair.textContent = formatProbability(selectedStrategy?.fairDown);
  elements.polyfairDownDetail.textContent = `${formatProbability(
    selectedStrategy?.marketDown
  )} market | ${formatPolyfairDiff(selectedStrategy?.diffDown)}`;
  renderPolyfairLabel(elements.polyfairDownLabel, selectedStrategy?.labelDown);
  elements.polyfairRecommendation.textContent = recommendation.text;
  elements.polyfairRecommendation.className = `panel-note polyfair-recommendation-${recommendation.tone}`;
}

function renderNavigation() {
  const selectedIndex = getSelectedRunIndex();
  const count = Math.max(state.runCatalogTotal, state.runCatalog.length);

  if (selectedIndex === -1) {
    elements.selectedRunPosition.textContent = count
      ? `${count} saved runs available`
      : "No run selected";
  } else {
    elements.selectedRunPosition.textContent = `Run ${selectedIndex + 1} of ${count} (newest first)`;
  }

  elements.previousRunButton.disabled = selectedIndex === -1 || selectedIndex >= count - 1;
  elements.nextRunButton.disabled = selectedIndex <= 0;
}

function render() {
  syncSelectedRunSummary();

  const runDetail = getDisplayedRunDetail();
  const run = runDetail?.run || null;
  const latestPoint = runDetail?.points?.at(-1) || null;
  const prices =
    latestPoint?.prices ||
    (state.followLive ? state.liveState?.currentSnapshot?.prices : null) ||
    {};
  const polyfairSnapshot =
    latestPoint?.polyfair ||
    (state.followLive ? state.liveState?.currentPolyfairSnapshot : null) ||
    null;
  const outcomes = run?.outcomes || [];
  const nextMarket = state.liveState?.nextMarket || null;

  elements.phaseBadge.textContent = state.liveState?.phase || "idle";
  elements.selectionBadge.textContent = state.followLive ? "live" : "history";
  elements.chartTitle.textContent = run?.question || waitingChartTitle;
  elements.chartWindow.textContent = run
    ? `${formatWindow(run.startedAt, run.endsAt)} · ${run.status || "recording"}`
    : "Waiting for market window";
  elements.chartUpdated.textContent = `Last update: ${formatTimestamp(
    latestPoint?.recordedAt || state.liveState?.currentSnapshot?.recordedAt
  )}`;

  elements.marketStatus.textContent = state.liveState?.error
    ? `error: ${state.liveState.error}`
    : run?.status || state.liveState?.phase || "-";
  elements.viewMode.textContent = state.followLive ? "Auto-follow live" : "Manual review";
  elements.marketWindow.textContent = run ? formatWindow(run.startedAt, run.endsAt) : "-";
  elements.marketRecording.textContent = run?.recordingStartedAt
    ? formatTimestamp(run.recordingStartedAt)
    : "-";
  elements.marketPoints.textContent = `${run?.pointCount ?? runDetail?.points?.length ?? 0}`;
  elements.nextMarketWindow.textContent = nextMarket
    ? `${formatWindow(nextMarket.startDate, nextMarket.endDate)}`
    : "-";
  elements.datasetLabel.textContent = state.liveState?.datasetLabel || run?.datasetLabel || datasetLabel;
  elements.savedRuns.textContent = `${Math.max(state.runCatalogTotal, state.runCatalog.length)}`;
  elements.selectedRunIdLabel.textContent = state.selectedRunId || "-";
  elements.dataPath.textContent = storagePathLabel;

  renderCurrentPriceCard(prices[outcomes[0]?.key], elements.upPrice, elements.upDetail);
  renderCurrentPriceCard(prices[outcomes[1]?.key], elements.downPrice, elements.downDetail);
  renderPolyfairPanel(polyfairSnapshot);
  renderNavigation();
  drawChart(runDetail);
}

async function navigateRun(offset) {
  const selectedIndex = getSelectedRunIndex();
  if (selectedIndex === -1) {
    return;
  }

  const targetIndex = selectedIndex + offset;
  const totalCount = Math.max(state.runCatalogTotal, state.runCatalog.length);

  if (targetIndex < 0 || targetIndex >= totalCount) {
    return;
  }

  await ensureRunCatalogLoadedThrough(targetIndex);

  const target = state.runCatalog[targetIndex];
  if (!target) {
    return;
  }

  selectRun(target.id, { followLive: false });
}

async function initialize() {
  const [liveState, catalog] = await Promise.all([
    fetchJson(apiPath("/status")),
    fetchJson(apiPath(`/runs?limit=${RUN_PAGE_SIZE}`))
  ]);

  state.liveState = liveState;
  state.runCatalogTotal = Number(catalog.total) || 0;
  mergeRunCatalog(catalog.runs);
  mergeRunCatalog(liveState.recentRuns || []);
  ensureSelectedRun();
  render();

  const stream = new EventSource(apiPath("/stream"));
  stream.addEventListener("state", (event) => {
    state.liveState = JSON.parse(event.data);
    mergeRunCatalog(state.liveState.recentRuns || []);
    appendLiveSnapshotIfNeeded();
    ensureSelectedRun();
    render();
  });

  setInterval(() => {
    refreshRunCatalog(RUN_PAGE_SIZE)
      .then(() => render())
      .catch(console.error);
  }, 60_000);
}

elements.axisToggleButton.addEventListener("click", () => {
  state.axisMode = state.axisMode === "elapsed" ? "remaining" : "elapsed";
  elements.axisToggleButton.textContent = `X-axis: ${state.axisMode}`;
  render();
});

elements.followLiveButton.addEventListener("click", () => {
  state.followLive = true;
  ensureSelectedRun();
  render();
});

elements.previousRunButton.addEventListener("click", () => {
  void navigateRun(1);
});

elements.nextRunButton.addEventListener("click", () => {
  void navigateRun(-1);
});

window.addEventListener("keydown", (event) => {
  if (event.key === "ArrowLeft") {
    void navigateRun(1);
  }

  if (event.key === "ArrowRight") {
    void navigateRun(-1);
  }
});

window.addEventListener("resize", () => render());

initialize().catch((error) => {
  console.error(error);
  elements.chartTitle.textContent = failedChartTitle;
});
