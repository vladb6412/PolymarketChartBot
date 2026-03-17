const statsViews = [
  {
    label: "BTC 5-minute",
    endpoint: "/api/stats/last-24h",
    elements: {
      summaryNote: document.querySelector("#stats-5m-summary-note"),
      stats24hUpCount: document.querySelector("#stats-5m-24h-up-count"),
      stats24hDownCount: document.querySelector("#stats-5m-24h-down-count"),
      stats24hMaxUpStreak: document.querySelector("#stats-5m-24h-max-up-streak"),
      stats24hMaxDownStreak: document.querySelector("#stats-5m-24h-max-down-streak"),
      stats3dUpCount: document.querySelector("#stats-5m-3d-up-count"),
      stats3dDownCount: document.querySelector("#stats-5m-3d-down-count"),
      stats3dMaxUpStreak: document.querySelector("#stats-5m-3d-max-up-streak"),
      stats3dMaxDownStreak: document.querySelector("#stats-5m-3d-max-down-streak")
    }
  },
  {
    label: "BTC 15-minute",
    endpoint: "/api/15minutebtc/stats/last-24h",
    elements: {
      summaryNote: document.querySelector("#stats-15m-summary-note"),
      stats24hUpCount: document.querySelector("#stats-15m-24h-up-count"),
      stats24hDownCount: document.querySelector("#stats-15m-24h-down-count"),
      stats24hMaxUpStreak: document.querySelector("#stats-15m-24h-max-up-streak"),
      stats24hMaxDownStreak: document.querySelector("#stats-15m-24h-max-down-streak"),
      stats3dUpCount: document.querySelector("#stats-15m-3d-up-count"),
      stats3dDownCount: document.querySelector("#stats-15m-3d-down-count"),
      stats3dMaxUpStreak: document.querySelector("#stats-15m-3d-max-up-streak"),
      stats3dMaxDownStreak: document.querySelector("#stats-15m-3d-max-down-streak")
    }
  }
];

const refreshButton = document.querySelector("#refresh-stats-button");

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

function renderStats(view, stats) {
  const stats24h = stats?.windows?.last24Hours || null;
  const stats3d = stats?.windows?.last3Days || null;
  const { elements } = view;

  elements.stats24hUpCount.textContent = `${stats24h?.upCount ?? "-"}`;
  elements.stats24hDownCount.textContent = `${stats24h?.downCount ?? "-"}`;
  elements.stats24hMaxUpStreak.textContent = `${stats24h?.maxConsecutiveUp ?? "-"}`;
  elements.stats24hMaxDownStreak.textContent = `${stats24h?.maxConsecutiveDown ?? "-"}`;
  elements.stats3dUpCount.textContent = `${stats3d?.upCount ?? "-"}`;
  elements.stats3dDownCount.textContent = `${stats3d?.downCount ?? "-"}`;
  elements.stats3dMaxUpStreak.textContent = `${stats3d?.maxConsecutiveUp ?? "-"}`;
  elements.stats3dMaxDownStreak.textContent = `${stats3d?.maxConsecutiveDown ?? "-"}`;

  if (!stats) {
    elements.summaryNote.textContent = `Loading ${view.label} official outcome summaries.`;
    return;
  }

  elements.summaryNote.textContent = `${view.label} official Polymarket closed outcomes. Counted runs: ${
    stats24h?.concludedRuns ?? "-"
  } in the last 24 hours, ${stats3d?.concludedRuns ?? "-"} in the last 3 days.`;
}

async function refreshStats() {
  refreshButton.disabled = true;

  for (const view of statsViews) {
    view.elements.summaryNote.textContent = `Refreshing ${view.label} official outcome summaries.`;
  }

  const results = await Promise.allSettled(
    statsViews.map((view) => fetchJson(view.endpoint))
  );

  results.forEach((result, index) => {
    const view = statsViews[index];

    if (result.status === "fulfilled") {
      renderStats(view, result.value);
      return;
    }

    console.error(result.reason);
    view.elements.summaryNote.textContent = `Failed to load ${view.label} official outcomes: ${
      result.reason?.message || "Unknown error"
    }`;
  });

  refreshButton.disabled = false;
}

refreshButton.addEventListener("click", () => {
  refreshStats().catch(console.error);
});

refreshStats().catch(console.error);
