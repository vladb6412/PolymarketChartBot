function formatProbability(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  return `${(value * 100).toFixed(1)}%`;
}

function formatSignedUsd(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  const absolute = Math.abs(Number(value)).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}$${absolute}`;
}

function formatElapsedSeconds(value) {
  if (!Number.isFinite(value)) {
    return "-";
  }

  const totalSeconds = Math.max(0, Math.round(value / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatDiffCents(value) {
  if (!Number.isFinite(value)) {
    return "median -";
  }

  const cents = (value * 100).toFixed(1);
  return `${value >= 0 ? "+" : ""}${cents}c vs median`;
}

function buildValueStatusBadge(entry) {
  const label = entry?.label || "Unknown";
  const status = entry?.status || "neutral";

  return `<span class="value-badge value-badge-${status}">${label}</span>`;
}

function buildValueSideMarkup(sideLabel, entry) {
  if (!entry) {
    return `
      <div class="value-side value-side-${sideLabel.toLowerCase()}">
        <p class="price-label">${sideLabel}</p>
        <p class="value-line">No recent comparison</p>
      </div>
    `;
  }

  return `
    <div class="value-side value-side-${sideLabel.toLowerCase()}">
      <div class="value-side-header">
        <p class="price-label">${sideLabel}</p>
        ${buildValueStatusBadge(entry)}
      </div>
      <p class="value-line">Now ${formatProbability(entry.currentPrice)}</p>
      <p class="value-line">Median ${formatProbability(entry.median)}</p>
      <p class="value-line">Range ${formatProbability(entry.q25)}-${formatProbability(entry.q75)}</p>
      <p class="price-detail">${formatDiffCents(entry.diffVsMedian)}</p>
    </div>
  `;
}

function renderValueSection(elements, payload, titleFallback) {
  const state = payload?.status;
  const analysis = payload?.analysis;

  elements.phase.textContent = state?.phase || "-";
  elements.title.textContent = state?.currentRun?.question || titleFallback;

  if (!analysis?.current) {
    elements.summary.innerHTML = "Waiting for live value comparison.";
    elements.recommendation.textContent = "No live recommendation yet.";
    elements.recommendation.className = "panel-note value-recommendation-neutral";
    elements.windows.innerHTML = "";
    return;
  }

  const current = analysis.current;
  const toleranceSeconds = Math.round((current.timeToleranceMs || 0) / 1000);

  elements.summary.innerHTML = `
    <div class="value-summary-grid">
      <div>
        <p class="price-label">BTC move</p>
        <p class="value-summary-value">${formatSignedUsd(current.deltaUsd)}</p>
      </div>
      <div>
        <p class="price-label">Move bucket</p>
        <p class="value-summary-value">${current.deltaBucket?.label || "-"}</p>
      </div>
      <div>
        <p class="price-label">Elapsed</p>
        <p class="value-summary-value">${formatElapsedSeconds(current.elapsedMs)}</p>
      </div>
      <div>
        <p class="price-label">Comparator</p>
        <p class="value-summary-value">same move bucket, ±${toleranceSeconds}s</p>
      </div>
    </div>
  `;

  elements.recommendation.textContent =
    analysis.recommendation?.text || "No live recommendation yet.";
  elements.recommendation.className = `panel-note value-recommendation-${
    analysis.recommendation?.tone || "neutral"
  }`;

  const windowOrder = ["3h", "6h", "12h"];
  elements.windows.innerHTML = windowOrder
    .map((key) => {
      const entry = analysis.windows?.[key];

      if (!entry) {
        return "";
      }

      return `
        <article class="value-window-card">
          <div class="value-window-header">
            <div>
              <p class="price-label">${key}</p>
              <p class="price-detail">${entry.sampleCount} points across ${entry.runCount} runs</p>
            </div>
          </div>
          <div class="value-window-sides">
            ${buildValueSideMarkup("UP", entry.up)}
            ${buildValueSideMarkup("DOWN", entry.down)}
          </div>
        </article>
      `;
    })
    .join("");
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json();
}

const sections = {
  five: {
    title: document.querySelector("#five-title"),
    phase: document.querySelector("#five-phase"),
    summary: document.querySelector("#five-summary"),
    recommendation: document.querySelector("#five-recommendation"),
    windows: document.querySelector("#five-windows"),
    statusUrl: "/api/status",
    analysisUrl: "/api/value-analysis",
    titleFallback: "Waiting for 5m data"
  },
  fifteen: {
    title: document.querySelector("#fifteen-title"),
    phase: document.querySelector("#fifteen-phase"),
    summary: document.querySelector("#fifteen-summary"),
    recommendation: document.querySelector("#fifteen-recommendation"),
    windows: document.querySelector("#fifteen-windows"),
    statusUrl: "/api/15minutebtc/status",
    analysisUrl: "/api/15minutebtc/value-analysis",
    titleFallback: "Waiting for 15m data"
  }
};

async function refreshSection(section) {
  const [status, analysis] = await Promise.all([
    fetchJson(section.statusUrl),
    fetchJson(section.analysisUrl).catch(() => null)
  ]);

  renderValueSection(section, { status, analysis }, section.titleFallback);
}

async function refreshAll() {
  await Promise.all(Object.values(sections).map((section) => refreshSection(section)));
}

refreshAll().catch(console.error);
setInterval(() => {
  void refreshAll();
}, 30_000);
