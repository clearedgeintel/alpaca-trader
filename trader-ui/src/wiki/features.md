# Features Index

Every major feature shipped, grouped by category. Items marked **opt-in** are off by default — flip them on via Settings or `PUT /api/runtime-config/:key`.

## Risk & Sizing

| Feature | Default | Flag |
|---|---|---|
| ATR-based initial stops | on | `ATR_STOP_MULT` |
| Volatility targeting | on | `VOL_TARGET_ENABLED` |
| Kelly / half-Kelly sizing | **opt-in** | `KELLY_ENABLED` |
| Smart position scaling (pyramiding) | **opt-in** | `SCALE_IN_ENABLED` |
| Live-ramp capital tiers | **opt-in** | `LIVE_RAMP_ENABLED` |
| Per-asset risk params (crypto/equity/ETF) | auto | — |
| Max drawdown circuit breaker | on | `MAX_DRAWDOWN_PCT` |
| Earnings event filter | on | `EARNINGS_MODE` |
| Per-symbol day-loss guard | on | — |

## Execution

| Feature | Default | Flag |
|---|---|---|
| Bracket orders (equity) | on | — |
| Smart Order Routing (limit + fallback) | **opt-in** | `SMART_ORDER_ROUTING_ENABLED` |
| Crypto 24/7 trading | **opt-in** | `CRYPTO_WATCHLIST` env |
| Fractional qty (crypto) | auto | — |
| Partial exit at 50% target | on | `PARTIAL_EXIT_PCT` |
| Trailing ATR stops | on | `TRAILING_ATR_MULT` |

## AI Agency

| Feature | Status |
|---|---|
| 7 specialized agents (Scout/Vega/Atlas/Quant/Herald/Rupture/Bounce) | shipped |
| Orchestrator synthesis (Sonnet) | shipped |
| Agent calibration by win rate | shipped |
| Inter-agent debate | shipped — fires when dissenters exist |
| Prompt versioning (DB-backed) | shipped |
| Prompt A/B performance tracking | shipped |
| Prompt A/B shadow mode | **opt-in** — doubles LLM cost |
| ML fallback (TensorFlow) | shipped — activates when LLM over budget |
| ML live accuracy tracking | shipped |

## Data Sources

| Source | Default | Purpose |
|---|---|---|
| Alpaca (bars + news + screeners + trading) | primary | required |
| Polygon.io free tier | **opt-in** (`POLYGON_API_KEY`) | ticker fundamentals, news sentiment, ex-dividends, market status |
| Reddit (Finance subs) | on | social sentiment for news agent |

## Analytics

- **Backtest** — historical replay with slippage + fees
- **Walk-forward** — rolling 60-day windows, robustness check
- **Monte Carlo** — randomized slippage, p05/p50/p95 distribution
- **Attribution** — P&L by regime / exit reason / day-of-week / sector
- **By-strategy** — P&L by pool (breakout / mean_reversion / news / technical / fallback)
- **Replay mode** — sandbox strategy over historical data

## Visualization

- **MarketView** — candles + volume histogram + **VWAP overlay** + **Volume Profile** (right-edge histogram)
- **TradeDrawer** — per-trade agent breakdown with tipping-agent ★, calibration bars, debate transcript, scale-in history
- **Agents page** — Calibration, Kelly recs, Prompt A/B performance, live activity feed

## Observability

- **Prometheus /metrics** — counters + histograms + scrape-time gauges
- **Grafana dashboard JSON** — 12-panel board ready to import
- **Multi-channel alerts** (Slack/Telegram/Discord/webhook) with severity + dedup
- **Daily digest** — end-of-day summary to your alerting channels
- **Threshold monitoring** — cost/breaker/drawdown/position alerts
- **Structured JSON logs** — correlation IDs across agents
- **Nightly reconciler** — catches orphan orders
- **DB archiver** — nightly retention purge

## Infrastructure

- **Docker + docker-compose**
- **GitHub Actions CI** (lint + typecheck + format + coverage)
- **Versioned migrations** (13 total, idempotent)
- **Hot-reload runtime config** (30s cache)
- **TypeScript** (first tranche migrated: indicators, cache, kelly, position-scaling)
- **Persistent strategy assignments** (survive restarts)
