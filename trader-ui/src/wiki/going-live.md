# Going Live with Real Money

The **safe path** from paper trading to real capital.

## The short version

1. Run **paper** for a minimum of **2 weeks**. Watch the Dashboard, review the Agents leaderboard, confirm win rate ≥ 45%.
2. Rotate to **live** by setting `ALPACA_BASE_URL=https://api.alpaca.markets` and your live Alpaca keys in `.env`, then restart.
3. **Enable the live ramp**: `PUT /api/runtime-config/LIVE_RAMP_ENABLED {"value": true}`.
4. Set `LIVE_RAMP_TIER=0` — starts at **1%** capital exposure.
5. Let it run for **1 week** before the ramp can advance to 5%.

## Live ramp tiers

The ramp scales capital automatically as gates pass:

| Tier | Capital | Gate to next tier |
|---|---|---|
| 0 | 1% | 20 closed trades + 45% win rate + ≤ 8% drawdown |
| 1 | 5% | 50 closed trades + 50% win rate + ≤ 10% drawdown |
| 2 | 25% | 100 closed trades + 55% win rate + ≤ 12% drawdown |
| 3 | 100% | — max tier |

**Auto-demotion**: if drawdown breaches the current tier's limit, you drop one tier automatically + fire a critical alert.

Check status: `GET /api/live-ramp/status`.

## Pre-flight checklist

- [ ] Paper trading for 2+ weeks
- [ ] Win rate ≥ 45% over last 50 closed trades
- [ ] Max drawdown ≤ 8% in paper
- [ ] No unresolved critical alerts in the last 7 days
- [ ] Slack/Telegram/Discord alert channels tested and receiving
- [ ] Prometheus + Grafana dashboard running
- [ ] Ops runbook bookmarked
- [ ] You have access to the Alpaca dashboard as a manual kill switch
- [ ] Backups are running (Supabase auto or manual pg_dump)
- [ ] `.env` backed up securely

## Kill switches

1. **Pause agency via cost cap**: `PUT /api/runtime-config/LLM_DAILY_COST_CAP_USD {"value": 0}` — LLM unavailable → rule-based fallback only.
2. **Shrink sizing**: `PUT /api/runtime-config/RISK_PCT {"value": 0.0001}` — near-zero position size.
3. **Force back to Tier 0**: `PUT /api/runtime-config/LIVE_RAMP_TIER {"value": 0}` — resets to 1% capital.
4. **Stop the process**: Railway stop / `fly scale count 0` / SIGTERM. Open positions remain — manually close via Alpaca dashboard or `close_all_positions` chat tool.

## Monitoring in production

- **Grafana board** (`docs/grafana-dashboard.json`) — 12 panels on operational metrics
- **Threshold alerts** (via `src/monitoring-alerts.js`) — LLM cost, circuit breaker, scan staleness, daily drawdown, open positions, .env age
- **Daily digest** — end-of-day summary at 16:05 ET to your alerting channels
- **Nightly reconciler** — catches orphan orders at 02:30 ET

## What to watch for in the first week

1. **Agent calibration drift** — some agents will underperform live; their weights will drop automatically
2. **SOR savings** — `smart_order_savings_bps` histogram should average positive
3. **Debate frequency** — high disagreement rate may indicate regime change or signal quality issues
4. **Slippage vs paper** — compare average fill price to expected entry
5. **Trade volume** — if > 20 trades/day, the bot may be over-trading; review MAX_SCAN_SYMBOLS + watchlist size

## If things go wrong

Refer to [docs/OPERATIONS.md](https://github.com/your-repo/blob/main/docs/OPERATIONS.md) for incident response. The 6 most common failure modes are documented with investigate + fix steps.
