# Secrets Rotation Runbook

Every secret this bot touches lives in `.env` today. This doc is the single
source of truth for **which secrets exist, when to rotate them, and the
exact steps**. Works today; a dedicated Vault / platform-secrets sprint is
on the roadmap as a follow-up.

## Secrets inventory

| Key                      | Purpose                                  | Where it's used                              | Rotation cadence                    |
| ------------------------ | ---------------------------------------- | -------------------------------------------- | ----------------------------------- |
| `ALPACA_API_KEY`         | Alpaca REST + WebSocket auth             | `src/alpaca.js`, `src/alpaca-stream.js`      | **90 days** (or on suspicion)       |
| `ALPACA_API_SECRET`      | Alpaca REST + WebSocket auth             | `src/alpaca.js`, `src/alpaca-stream.js`      | **90 days** (rotate with the key)   |
| `ANTHROPIC_API_KEY`      | LLM agent calls                          | `src/agents/llm.js`                          | **90 days** (or on leakage)         |
| `POLYGON_API_KEY`        | Polygon enrichment (free tier, optional) | `src/datasources/polygon-adapter.js`         | **180 days** (lower blast radius)   |
| `DATABASE_URL`           | Supabase Postgres                        | `src/db.js`                                  | On Supabase-side credential change  |
| `API_KEY`                | Our own `/api/*` auth header             | `src/middleware/auth.js`                     | **180 days**, or immediately on any suspected leak |
| `SLACK_WEBHOOK_URL`      | Slack alerts (optional)                  | `src/alerting.js`                            | On team/channel change              |
| `TELEGRAM_BOT_TOKEN`     | Telegram alerts (optional)               | `src/alerting.js`                            | On team change                      |
| `TELEGRAM_CHAT_ID`       | Telegram alerts (optional)               | `src/alerting.js`                            | Rarely (tied to chat)               |
| `DISCORD_WEBHOOK_URL`    | Discord alerts (optional)                | `src/alerting.js`                            | On channel change                   |
| `WEBHOOK_URL`            | Generic alerts (optional)                | `src/alerting.js`                            | On destination change               |

> **Rotate on suspicion.** Don't wait for the cadence if a laptop walked away,
> a key was pasted into a chat, or a dependency changed hands.

## Rotation procedure

Follow the same 5-step flow for every secret. All steps are reversible
until the old secret is revoked.

1. **Mint the new secret** in the provider's console (Alpaca, Anthropic,
   Polygon, Supabase, etc.). Keep the old secret active — we'll overlap
   to avoid downtime.
2. **Update `.env`** locally (and any secrets manager the deploy uses —
   Railway env vars, Fly.io secrets, etc.) with the NEW value. Keep a
   backup of the old value in a password manager until step 5.
3. **Restart the app.** For live trading, do this during a scheduled
   merge freeze or off-hours. The bot will pick up the new key on the
   next cycle. The `/api/health` endpoint reports a boot time — confirm
   it's fresh.
4. **Verify end-to-end.** Hit `/api/health` — all checks should be green
   (DB, Alpaca, LLM budget). Place a trivial paper trade through chat or
   let one cycle run; confirm the trade appears in Alpaca dashboard and
   the local DB.
5. **Revoke the old secret** in the provider's console. This is the
   irreversible step. Only do it once step 4 is green.

### Alpaca-specific notes

- Alpaca has separate paper and live keys. Rotating one doesn't affect
  the other. The bot's active mode is set by `ALPACA_BASE_URL`.
- If you rotate the key mid-session, open WebSocket streams will keep
  running on the old auth until disconnect. A restart is clean.

### Anthropic-specific notes

- Prompt cache entries are tied to a workspace, not a specific API key.
  Rotating your key will NOT invalidate the shared-preamble cache.
- Circuit breaker stays "closed" across a key rotation; the new key
  starts with zero failures.

## Staleness monitor

`/api/health` now reports an `envFileAgeDays` field derived from the
mtime of `.env`. If it hasn't changed in >90 days, the field is present
with a non-null value — use that as an ops dashboard signal or wire
it into an alert if you want to enforce rotation cadence.

> This only measures when `.env` was last touched, not when individual
> keys were last rotated. If you change just one key, make a comment
> edit somewhere in the file to update its mtime so the signal stays
> honest.

## Follow-up (out of scope for today)

Moving off `.env` to a proper secrets manager:

- **Vault / AWS Secrets Manager / GCP Secret Manager** — dedicated
  sprint. Wraps secret reads behind a small `getSecret(key)` helper;
  per-environment, auditable, rotatable without a restart.
- **Platform-native secrets** (Railway, Fly.io) — lower effort, no
  local-dev change. Already works today via the deploy provider's
  env-var UI; document specific provider flow when we pick one.
- **Short-lived tokens** — replace long-lived API keys with
  short-lived tokens plus a refresh flow. Not available for Alpaca
  at the time of writing; worth checking when we upgrade.
