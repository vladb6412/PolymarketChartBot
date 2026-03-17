# Polymarket BTC 5m Monitor

Local web tool for recording and replaying Polymarket's rolling `btc-updown-5m-*` markets.

## What it does

- Discovers the active Bitcoin 5-minute Up/Down market from Gamma.
- Connects to Polymarket's market WebSocket for both outcome token IDs.
- Computes the displayed price using midpoint unless spread is wider than `$0.10`, then falls back to last trade.
- Records every displayed-price change to a live `data/runs/<run-id>.jsonl` file.
- Compresses completed runs to `data/runs/<run-id>.jsonl.gz` after rollover without dropping snapshots.
- Serves a local dashboard with:
  - live chart for the active run
  - automatic rollover to the next 5-minute market
  - historical replay for completed runs

## Run it

```bash
npm install
npm start
```

Open `http://127.0.0.1:3000`.

## Useful scripts

```bash
npm test
npm run dev
npm run install-agent
npm run uninstall-agent
```

## Configuration

Optional environment variables:

- `HOST` default `0.0.0.0`
- `PORT` default `3000`
- `DATA_DIR` default `./data`
- `DISCOVERY_INTERVAL_MS` default `15000`
- `DISPLAY_SPREAD_THRESHOLD` default `0.1`
- `POLYMARKET_WS_URL` default `wss://ws-subscriptions-clob.polymarket.com/ws/market`

## 24/7 mode on macOS

To keep the recorder and browser UI running continuously after login:

```bash
npm run install-agent
```

This installs a `launchd` agent that restarts the app automatically and keeps it
available at `http://127.0.0.1:3000`.

Logs are written to:

- `data/logs/stdout.log`
- `data/logs/stderr.log`

To remove it:

```bash
npm run uninstall-agent
```

## Data layout

- Run index: `data/runs-index.json`
- Live snapshot files: `data/runs/<run-id>.jsonl`
- Archived snapshot files: `data/runs/<run-id>.jsonl.gz`

Each JSONL line is a synchronized snapshot for both outcomes, including:

- `recordedAt`
- `elapsedMs`
- `prices.UP`
- `prices.DOWN`
- top-of-book fields
- last trade price
- computed displayed price

Completed runs stay lossless. Compression happens only after a run closes, and
the archived `.jsonl.gz` file contains the same JSONL snapshots as the live raw
file.

## Downloading archived data

The server exposes archived runs directly:

- `GET /api/runs?limit=200&offset=0`
- `GET /api/runs/<run-id>`
- `GET /api/runs/<run-id>/archive`

To sync all archived runs from a deployed instance back into this workspace:

```bash
npm run sync-remote -- https://your-app.up.railway.app
```

That downloads the stored `.jsonl.gz` artifacts into `data/runs/` and refreshes
`data/runs-index.json`, which keeps the data available for later analysis here
or in other programs.

## Railway notes

Set:

- `DATA_DIR=/app/data`

Mount your Railway volume at:

- `/app/data`

## Main files

- `src/monitor.js`: recorder orchestration and market rollover
- `src/polymarket/discovery.js`: active-market selection from Gamma
- `src/polymarket/feed.js`: WebSocket market feed handling
- `src/domain/priceModel.js`: displayed-price calculation
- `src/persistence/runStore.js`: JSONL persistence
- `public/`: browser dashboard
