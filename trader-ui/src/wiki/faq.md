# FAQ

## Is this safe for real money?

Only if you've:
1. Paper traded for at least 2 weeks
2. Reviewed Agents calibration — all agents have ≥ 10 closed trades
3. Enabled `LIVE_RAMP_ENABLED=true` with tier 0 (1% capital) for the first week
4. Confirmed alert channels are receiving messages
5. Read `docs/OPERATIONS.md`

See [Going Live](#/help/going-live) for the full checklist.

## How much does the LLM cost per day?

**Typical paper/small live: $1-5/day.** Depends on:
- Watchlist size (more symbols = more technical/news calls)
- Cycle interval (5 min default)
- Whether shadow mode is on (doubles orchestrator cost)
- Whether Agency mode is enabled (without it, $0)

Cost caps prevent overruns: `LLM_DAILY_COST_CAP_USD` (default $5, editable in Settings).

## What happens when the LLM budget is exhausted?

Agency flips to **rule-based fallback** — the technical agent's signals drive a conservative BUY decision path with 0.8× size adjustment. Monitor continues normally. Budget resets at midnight UTC.

## Can I run it without the LLM?

Yes — set `USE_AGENCY=false` in `.env`. The bot reverts to legacy scanner mode: rule-based EMA/RSI/volume signals only, no LLM calls. Coverage is narrower but costs $0.

## Why 7 agents? Isn't that overkill?

Each agent adds a **specific lens**:
- **Quant** catches multi-timeframe alignment that single-timeframe rules miss
- **Herald** blocks trades on bearish news (Alpaca + Polygon + Reddit)
- **Vega** vetoes when portfolio heat is too high
- **Atlas** prevents longs in bear regimes
- **Rupture** catches breakouts rules-only scanners miss
- **Bounce** identifies oversold reversions
- **Scout** finds symbols that aren't in your static watchlist

The orchestrator synthesizes and the calibration layer down-weights agents that don't pay off. Over time, your bot auto-tunes to what works.

## Can I trade options?

Not yet — marked as "Future" in the roadmap. Needs paid Polygon tier for options chains + Greeks. The architecture supports it via the asset-class system; we just haven't wired the options-aware risk layer.

## Can I trade crypto?

**Yes.** Set `CRYPTO_WATCHLIST=BTC/USD,ETH/USD,SOL/USD` in `.env` and restart. Crypto runs 24/7 (bypasses market-hours gate), uses fractional quantities automatically, and has wider stops (5% vs 3% equity default).

## How are prompts versioned?

Prompts live in the `prompt_versions` table. The orchestrator reads its active version via `promptRegistry` on every cycle (5-min cache). Create a new version via `POST /api/prompts/orchestrator/activate`, run it in shadow first to compare agreement/confidence, then activate when satisfied.

## What's "shadow mode"?

A candidate prompt runs in parallel with the active one on every cycle. The candidate's decisions are persisted (`is_shadow=true`) but never executed. The Shadow Comparison card on the Agents page shows agreement rate + confidence delta between the two versions. Doubles LLM cost while active.

## Kelly sizing scared me a little

Half-Kelly is the default (not full Kelly) + clamped to [0.5×, 2.0×] of base RISK_PCT. That means even if Kelly says "risk 10%", the bot caps at 2× your base risk. Negative-edge symbols floor at 0.5× (not zero — still trades them, just smaller). Most cold-start symbols get 1.0× (no change from pre-Kelly behavior).

## Why do I see "scaled_in" trades?

Smart position scaling adds to winners when profit exceeds N×ATR. Stop moves to breakeven on first scale-in. Mutually exclusive with partial-exit (a scaled-in trade won't partial-exit). Opt-in via `SCALE_IN_ENABLED`.

## How do I back out of a feature I enabled?

Every opt-in feature has a runtime flag. Flip it off via Settings → runtime-config, no restart needed. Takes ≤30s to propagate (the runtime-config cache TTL).

## Where's the multi-tenant admin app?

It's a separate project. See `docs/ADMIN-APP-SPEC.md` — drop that as `CLAUDE.md` in a new Next.js repo and an LLM agent can bootstrap it. It wraps this bot as a black box and handles onboarding, billing, provisioning.
