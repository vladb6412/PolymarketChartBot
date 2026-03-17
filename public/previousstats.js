const elements = {
  refreshButton: document.querySelector("#refresh-stats-button"),
  stats24hUpCount: document.querySelector("#stats-24h-up-count"),
  stats24hDownCount: document.querySelector("#stats-24h-down-count"),
  stats24hMaxUpStreak: document.querySelector("#stats-24h-max-up-streak"),
  stats24hMaxDownStreak: document.querySelector("#stats-24h-max-down-streak"),
  stats7dUpCount: document.querySelector("#stats-7d-up-count"),
  stats7dDownCount: document.querySelector("#stats-7d-down-count"),
  stats7dMaxUpStreak: document.querySelector("#stats-7d-max-up-streak"),
  stats7dMaxDownStreak: document.querySelector("#stats-7d-max-down-streak"),
  statsSummaryNote: document.querySelector("#stats-summary-note")
};

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

function renderStats(stats) {
  const stats24h = stats?.windows?.last24Hours || null;
  const stats7d = stats?.windows?.last7Days || null;

  elements.stats24hUpCount.textContent = `${stats24h?.upCount ?? "-"}`;
  elements.stats24hDownCount.textContent = `${stats24h?.downCount ?? "-"}`;
  elements.stats24hMaxUpStreak.textContent = `${stats24h?.maxConsecutiveUp ?? "-"}`;
  elements.stats24hMaxDownStreak.textContent = `${stats24h?.maxConsecutiveDown ?? "-"}`;
  elements.stats7dUpCount.textContent = `${stats7d?.upCount ?? "-"}`;
  elements.stats7dDownCount.textContent = `${stats7d?.downCount ?? "-"}`;
  elements.stats7dMaxUpStreak.textContent = `${stats7d?.maxConsecutiveUp ?? "-"}`;
  elements.stats7dMaxDownStreak.textContent = `${stats7d?.maxConsecutiveDown ?? "-"}`;

  if (!stats) {
    elements.statsSummaryNote.textContent = "Loading official Polymarket outcome summaries.";
    return;
  }

  elements.statsSummaryNote.textContent = `Official Polymarket closed outcomes. Counted runs: ${
    stats24h?.concludedRuns ?? "-"
  } in the last 24 hours, ${stats7d?.concludedRuns ?? "-"} in the last 7 days.`;
}

async function refreshStats() {
  elements.refreshButton.disabled = true;
  elements.statsSummaryNote.textContent = "Refreshing official Polymarket outcome summaries.";

  try {
    const stats = await fetchJson("/api/stats/last-24h");
    renderStats(stats);
  } catch (error) {
    console.error(error);
    elements.statsSummaryNote.textContent = `Failed to load official Polymarket outcomes: ${error.message}`;
  } finally {
    elements.refreshButton.disabled = false;
  }
}

elements.refreshButton.addEventListener("click", () => {
  refreshStats().catch(console.error);
});

refreshStats().catch(console.error);
