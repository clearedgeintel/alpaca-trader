# Operations Runbook

Single source of truth for running this bot in production.

## Quick health check

```bash
curl https://$HOST/api/health | jq .
curl https://$HOST/metrics | head -40
curl https://$HOST/api/status | jq .
```

Healthy: HTTP 200, `checks.db.ok` + `checks.alpaca.ok` true, `checks.lastScan.stale` false when market open, no stalled agents, `envFile.stale` false.

## Incident response

### Circuit breaker OPEN
LLM failed 3+ times in a row. Auto-fallback to rule-based for 5 min.
- `curl /api/health` → check `llm.unavailableReason`
- Common fixes: rotate `ANTHROPIC_API_KEY`, raise `LLM_DAILY_COST_CAP_USD`, or wait for Anthropic recovery.

### Daily cost cap reached
- Raise cap: `PUT /api/runtime-config/LLM_DAILY_COST_CAP_USD {"value": 25}`
- Slow cycles: `PUT /api/runtime-config/SCAN_INTERVAL_MS {"value": 600000}`
- Disable shadow mode: `POST /api/prompts/orchestrator/clear-shadow` (it doubles LLM cost)

### Orphan Alpaca order
Position placed on Alpaca but DB rolled back. Nightly reconciler auto-fixes at 02:30 ET. Manual trigger: `curl -X POST /api/reconcile`.

### Live ramp demoted
Max drawdown exceeded tier limit — expected auto-behavior, capital reduced one tier. Review `GET /api/live-ramp/status` + recent trades.

### Agent stalled
No cycle in >30min during market hours. Check `/api/health` for which agent, inspect logs, restart app if deadlocked.

### DB connection lost
Supabase paused (free tier) or credentials rotated. Resume project in Supabase dashboard or update `DATABASE_URL` + restart.

## Deployment

Pre-deploy: `npm test` + `npm run lint` + `npm run format:check` + `npm run typecheck` all green, migrations idempotent.

Deploy: push to main → auto-deploy → verify `/api/health` → watch first cycle.

Rollback: `git revert` + push, or Railway/Fly one-click rollback.

## Backup

```bash
# Daily — Supabase auto-backs up. Manual snapshot:
pg_dump $DATABASE_URL > backups/$(date +%F).sql

# Critical tables only:
pg_dump $DATABASE_URL -t trades -t agent_decisions -t daily_performance -t prompt_versions > backups/critical-$(date +%F).sql
```

Restore: `psql $DATABASE_URL < backups/YYYY-MM-DD.sql` then restart.

**Keep forever:** trades, daily_performance, agent_decisions, prompt_versions, runtime_config.
**Regenerable:** signals, agent_reports, agent_metrics, sentiment_snapshots (archiver purges these).

## Maintenance

**Weekly:** review `smart_order_savings_bps`, live-ramp tier, ML walk-forward.
**Monthly:** rotate keys if >90d (`docs/SECRETS.md`), check DB size, roadmap cleanup.
**Quarterly:** retrain ML fallback, audit Grafana alert noise.

## Gotchas

- Alpaca paper + live keys are separate. `ALPACA_BASE_URL` picks mode.
- Crypto uses `time_in_force='gtc'`, equities `'day'` — handled auto.
- Bracket orders don't support crypto or limit entries. SOR uses plain limits; monitor manages stops.
- Prompt cache needs ≥4096 tokens (Haiku) or ≥2048 (Sonnet). Don't strip the shared preamble.
- Runtime-config cache TTL is 30s.
- Reconciler runs at 02:30 ET. Orphan orders linger until then unless triggered manually.

## Emergency stop

```bash
# Halt agency without restart
PUT /api/runtime-config/LLM_DAILY_COST_CAP_USD {"value": 0}    # LLM offline → rule-based fallback only
PUT /api/runtime-config/RISK_PCT {"value": 0.0001}              # near-zero sizing
```

True zero-trading: stop the Node process. Open positions are NOT closed automatically — use the chat agent's `close_all_positions` tool or Alpaca dashboard first.
