# Dashboard

The Dashboard gives you a single view of the bot's current state.

## Top banner — LLM status

Green: LLM available, budget healthy. Amber: approaching daily cap. Red: circuit breaker open or cap reached — agency in rule-based fallback. The banner shows live cost spend vs daily cap and token usage.

## Stat cards

- **Today's P&L** — realized P&L from closed trades today
- **Win Rate** — all-time closed trades; 7-day comparison below
- **Open Positions** — current count (see Positions view for detail)
- **Total Trades** — lifetime count + weekly activity

## Portfolio chart

Equity curve over the last 30 days. Daily aggregation from `daily_performance`. Hover for daily P&L + portfolio value.

## Mini chat

Quick access to the chat agent — ask natural-language questions about your positions, recent signals, or market state. Uses tool-use to read from DB/Alpaca. Full chat interface is at `/chat`.

## News feed

Recent articles from Alpaca's news endpoint, filtered to your watchlist. When **Polygon enrichment** is enabled (Settings → Data Sources), articles also carry `insights[]` sentiment scoring.

## Sector rotation

N-day momentum by sector (Polygon `sic_description`). Top 3 leaders in green, laggards in red. When a symbol is in a leading sector, the orchestrator gets a positive bias signal.

## Sentiment shifts

Symbols whose sentiment inflected over the lookback window (6h/24h/72h). The card shows symbols where |last − first| sentiment exceeds the threshold. Each row has a 3-day sparkline.

Requires at least 2 sentiment snapshots per symbol — Polygon must be enabled for this to populate.

## Activity feed

Live stream of agent events: cycles completed, decisions published, orders placed/filled/closed. Socket.io push from the backend.
