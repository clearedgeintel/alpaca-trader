# Troubleshooting

Common issues and fast fixes.

## Bot isn't placing trades

**Checklist:**
1. `/api/health` — DB + Alpaca + LLM all green?
2. Agency mode enabled? `USE_AGENCY=true` in `.env`
3. Watchlist non-empty? `/api/config` → `watchlist` array
4. Market open? Dashboard top banner tells you. Crypto runs 24/7 if `CRYPTO_WATCHLIST` is set.
5. Daily P&L below drawdown circuit breaker? `MAX_DRAWDOWN_PCT` default 10%
6. LLM budget exhausted? Check the banner — if maxed, agency is in rule-based fallback
7. Risk agent vetoing everything? `/api/agents/risk/report` shows reasoning

## "No open positions to monitor" but I placed a trade

The trade is on Alpaca but didn't make it into the DB (orphan order). The **nightly reconciler at 02:30 ET** will detect + fix. Manual: `curl -X POST /api/reconcile`.

## LLM is over budget 3x in a row

- Increase cap: `PUT /api/runtime-config/LLM_DAILY_COST_CAP_USD {"value": 25}`
- Reduce cycle rate: `PUT /api/runtime-config/SCAN_INTERVAL_MS {"value": 600000}` (10 min)
- Disable shadow mode if on: `POST /api/prompts/orchestrator/clear-shadow`
- Trim watchlist — fewer symbols = fewer technical/news calls

## Win rate dropped sharply

1. Check **Calibration panel** — which agent is misfiring?
2. Review recent **agent_decisions** via Decisions page — are supporters making sense?
3. Is the **regime agent** wrong? (e.g. calling "trending" in a choppy market)
4. Consider activating **Shadow mode** to test a revised prompt without affecting trading
5. Temporarily demote live-ramp: `PUT /api/runtime-config/LIVE_RAMP_TIER {"value": 0}`

## Polygon says "rate limited"

Free tier is 5 calls/min. Token bucket + circuit breaker handle this automatically — calls return `null` during the cooldown. To check: `GET /api/datasources/stats`. Upgrade to paid Polygon if you need intraday data or options.

## Crypto orders rejected

- Alpaca requires `time_in_force: 'gtc'` for crypto (handled automatically via `isCrypto` check)
- Use `SYMBOL/USD` format (not `SYMBOL`)
- Bracket orders aren't supported for crypto — the bot automatically falls back to market + monitor-managed stops

## Graphs are empty

- Dashboard → Portfolio chart needs `daily_performance` rows — 1 trade has to close for today's row to exist
- Sentiment shifts card needs ≥ 2 snapshots per symbol — requires Polygon enabled + active news flow
- Sector rotation needs ≥ 2 distinct sectors in the universe — requires Polygon

## Tests failing after pulling main

- Run migrations: restart the app, `db.initSchema()` applies new migrations idempotently
- Regenerate lockfile if deps changed: `npm ci`
- Clear Jest cache: `npx jest --clearCache`

## Deploy is stuck

- Check Railway/Fly logs for crash loop
- Common cause: a migration referencing a removed column
- Rollback: `git revert <commit>` + push

## See also

- [docs/OPERATIONS.md](https://github.com/your-repo/blob/main/docs/OPERATIONS.md) — full incident runbook
- [docs/SECRETS.md](https://github.com/your-repo/blob/main/docs/SECRETS.md) — key rotation procedure
