# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm start            # Run the app (node src/index.js)
npm run dev          # Run with nodemon auto-reload
```

No test suite or linter is configured.

## Architecture

This is a Node.js auto-trading bot with three recurring workflows orchestrated by `setInterval` in `src/index.js`:

1. **Scanner** (`scanner.js`) — Every 5 min during market hours, fetches 5-min bars from Alpaca for each watchlist symbol, computes EMA9/EMA21/RSI14/volume indicators, and saves BUY/SELL signals to the `signals` table.

2. **Executor** (`executor.js`) — Called immediately when a BUY signal is detected. Sizes the position (2% portfolio risk, 3% stop, 6% target), places a market order via Alpaca, and records the trade in the `trades` table. Only one open position per symbol is allowed.

3. **Monitor** (`monitor.js`) — Every 5 min, checks all open trades against current Alpaca prices. Closes positions that hit stop-loss or take-profit, updates `daily_performance`.

### Key module roles

- `config.js` — Frozen config object with all thresholds, intervals, and risk params. Loaded from constants (not env vars except for the server port).
- `db.js` — `pg` Pool wrapper. `initSchema()` runs `db/schema.sql` on startup to create tables idempotently.
- `alpaca.js` — Thin fetch wrapper over Alpaca REST API. Handles 429 retry (10s backoff, one retry). All methods are async.
- `indicators.js` — Pure functions: `emaArray`, `calcRsi`, `volumeRatio`, `detectSignal`. No I/O. `detectSignal` is the master function that takes raw bars and returns `{ signal: 'BUY'|'SELL'|'NONE', reason, ...metrics }`.
- `server.js` — Read-only Express API on port 3001 under `/api/*` for a future dashboard frontend.
- `logger.js` — Timestamped `log()` and `error()` functions wrapping `console.log/error`.

### Data flow

```
Alpaca bars → indicators.detectSignal() → signal row in DB
                                        → executor sizes + places order → trade row in DB
Alpaca positions → monitor checks stop/target → closes position → updates trade + daily_performance
```

### Database

Three Supabase PostgreSQL tables defined in `db/schema.sql`: `signals`, `trades`, `daily_performance`. Schema auto-runs on startup. The `trades.signal_id` FK links trades back to their originating signal.

### Market hours gate

`isMarketOpen()` in `index.js` uses `luxon` to check ET timezone: Mon–Fri, 9:35 AM – 3:50 PM. All scheduled work is skipped outside this window.
