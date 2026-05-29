# Alpaca Trader v2 Roadmap

## Premise

v1 was a "build the parts" sprint — 29 phases of agents, dashboards, options,
caching, telemetry. **v2 is a measurement + consolidation pass, not a feature
pass.** The default move is to *delete or merge* before adding. Every phase
must justify itself against either (a) higher win rate, (b) lower LLM bill,
or (c) less code to maintain.

The actual v2 journey turned into something the original plan didn't predict:
**most of v2's value so far came from reliability and diagnostic work that
wasn't on the roadmap**. Two weeks of cascading failures (no trades → broken
Quant schema → silent truncation → wrong default → stale runtime overrides)
forced us to build the tools that turn "system is broken" into "system *says*
exactly what's broken." Without those, the rest of v2 can't measure itself.

This document is the **updated** outlook, written 2026-05-28 after Phase 0b
shipped — the original v2 plan revised to match what actually happened and
what's actually next.

---

## Status

| Phase | Status | Notes |
|---|---|---|
| **Phase 0a** (3 agent cuts) | ✅ shipped, partially reverted | Breakout + Mean-Rev defaults flipped back to `true` 2026-05-26 after the 0.70 floor + leaner agency produced zero trades. Screener LLM rerank stays off. Re-evaluation deferred until the retro card has data. |
| **Phase 0b** (news LLM cut) | ✅ shipped 2026-05-28 | `news-keyword-alerts` module + 14 tests; flag `NEWS_PER_CYCLE_LLM_ENABLED` default off. |
| **Phase 0.5** (diagnostic + reliability) | ✅ shipped (unplanned) | The work that consumed weeks 2-4 of v2 — see Phase 0.5 section. |
| **Phase 1** (Trade Retro card) | ✅ shipped, data-starved | Card renders; findings require ≥20 closed trades. Currently under that floor due to the no-trades stretch. |
| **Phase 2** (Coverage v2) | 🚧 next | Reshaped — see Phase 2 section. |
| **Phase 3** (Efficiency v2) | 🟡 partial credit | Tier 1 caching, TA gate, news cut, prompt-cache health probe all shipped. Adaptive throttle + per-agent context-hash gates pending. |
| **Phase 4** (UI delete pass) | ❌ not started | |
| **Phase 5** (hardening, rolling) | ❌ not started | |

---

## The threads

| Thread | Question it answers | Phase |
|---|---|---|
| **Consolidation** | Which agents overlap or don't earn their LLM cost? | 0 |
| **Reliability** | Why is the system silently broken, and what does the dashboard say about it? | 0.5 |
| **Retro** | Which kind of trades keep losing? | 1 |
| **Coverage** | Why didn't we catch today's runners? | 2 |
| **Efficiency v2** | After cuts + retro, what's left to trim? | 3 |
| **Simplicity** | What can be deleted from the UI and the codebase? | 4 |

---

## Phase 0: Agent consolidation ✅

**What landed**

Soft-cuts behind runtime-config flags. All four cuts are reversible from
Settings → Agent Toggles.

- `breakout-agent` (Rupture) — flag `BREAKOUT_AGENT_ENABLED`. Default
  flipped `false → true` on 2026-05-26 after live data showed Quant alone
  at 0.70 floor produced zero trades. Status: **ON**, pending retro
  validation that re-enabling didn't reintroduce noise losses.
- `mean-reversion-agent` (Bounce) — flag `MEAN_REVERSION_AGENT_ENABLED`.
  Same back-flip same day, same reason. Status: **ON**, pending retro.
- `screener-agent` (Scout) LLM rerank — flag `SCREENER_LLM_RERANK_ENABLED`,
  default `false`. The rule-based watchlist construction runs unchanged
  when the LLM is skipped. Status: **OFF** (cut applied).
- `news-agent` (Herald) per-cycle LLM — flag `NEWS_PER_CYCLE_LLM_ENABLED`,
  default `false`. Replaced by `src/agents/news-keyword-alerts.js`, a
  pure-regex scanner over the ~30-min news window producing the same
  `_alerts[]` shape the LLM did. 14 unit tests lock in the regex set.
  Executor's `getCriticalAlert(symbol)` veto path is unchanged. Status:
  **OFF** (cut applied).

**Honest revision** — the cut-then-restore on Breakout and Mean-Reversion
is real evidence that the leaner agency was too thin, *not* a sign that
those agents earn their keep. We're back at the original 5-voice setup
specifically because we couldn't measure anything with 3 voices. Phase 1's
retro card decides their fate next.

---

## Phase 0.5: Diagnostic & reliability infrastructure ✅

**Goal**: turn "system is broken" into "the dashboard says *exactly* what's
broken." Wasn't on the original v2 plan; turned out to be the most valuable
work in the sprint.

**What landed (date order)**

- **Tier 1 prompt caching** (2026-05-07, `b5323df`). Per-agent system
  prompts cached alongside `SHARED_PREAMBLE`. Silent-cache-disable
  detector warns once if no cache activity in first 10 calls. Cache hit
  ratio + DISABLED red flag surfaced on the `LlmCostCard`.
- **MIN_PRICE floor** (2026-05-21, `4c1ce4c`). Blocks new BUYs on
  sub-$3 names. May-blotter postmortem: every large loss was a sub-$1
  stock; slippage at 50K-130K share orders destroyed the edge.
- **Momentum percentage trailing stop** (same commit). Once a momentum
  position is up 10%, trail 6% below the running high. Fixes the
  avg-loss ≥ avg-win asymmetry from the May blotter.
- **Confidence floor revert** (2026-05-21, `31fa399`). `ORCHESTRATOR_MIN_
  CONFIDENCE` 0.55 → 0.70 and `EXECUTION_MIN_CONFIDENCE` 0.5 → 0.6 after
  two windows of data confirmed the lower floor halved the win rate.
- **`verify-trade.js` + `getAccountActivities` API** (2026-05-22,
  `553dac6`). Read-only reconciliation between recorded trades and Alpaca's
  authoritative records. Built to investigate the BMNG +$176K trade;
  confirmed it was real, not a data artifact.
- **TA `_isInteresting` gate loosening + MIN_LLM_BATCH=5 top-up**
  (2026-05-26, `cc94203`). Looser thresholds + safety net so the LLM
  always sees something to grade. Fixed the "Quant HOLD@0.30 across the
  board" symptom.
- **TA maxTokens 4096 → 8192** (2026-05-27, `d019204`). Killed silent
  truncation that was failing 100% of TA calls.
- **`lastError` per-agent surface** (same commit). The single most
  valuable diagnostic addition — `↳ last error:` line on each `LlmCostCard`
  row when retry failures occur. This is what made the schema failure
  visible.
- **News maxTokens 1024 → 4096 + extractJson synthetic-close v2** with 4
  unit tests (2026-05-28, `46fcb75` + `ba77de5`). Salvages partial JSON
  when the LLM truncates mid-object. Tracks commas at all depths (the
  v1 attempt only tracked depth=1, missed TA's depth=2 structure).

**Lesson encoded**

The diagnostic surface (`lastError`, cache probe, extractJson recovery)
made every Phase 0+ change debuggable. Without it, the no-trades stretch
would have stayed mysterious for weeks. **Going forward: any new agent /
LLM call site ships with the lastError surface wired in. Any new rule
ships with tests. Any new defaults ship with a config-side comment naming
the data that justified the value.**

---

## Phase 1: Trade Retro Surface ✅ (data-starved)

**What landed** (2026-05-21, `2b7320a`)

`TradeRetroCard` in the dashboard cockpit. Reads `/api/analytics/
attribution?days={7|30|90}` and emits ranked findings:
- Worst exit-reason / hold-duration / regime / weekday bucket (win rate
  < 35% AND net negative), with an action hint
- Best bucket per slice when strongly positive (validation)
- Weekday clustering (asymmetric avg-P&L)
- Repeat-offender symbols (lost on most of ≥ 4 trades)

Each finding shows severity dot, n-trades, and an expand-to-see-numbers
detail. Findings hide below the 8-trade floor.

**Current state**

The card is shipped and renders, but trade volume since the cuts has been
too low for findings to fire (n < 8 in most slices). The cards reads
"Only N closed trades — need ≥ 8 for reliable findings."

**Acceptance for "complete"**

- 20+ closed trades in any 30d window
- At least one red finding fires that maps to a known pattern
- At least one apply button has been used by the operator

These aren't met yet. **Phase 1 stays open** until the Phase 0 + 0.5 fixes
restore trade flow and the card has enough data to be useful.

---

## Phase 2: Coverage v2 — small-cap quality, not sub-$1 quantity (2-3 days)

**Goal**: catch the right tail of small-cap moves now that MIN_PRICE $3
blocks the sub-$1 lottery tickets that were bleeding us.

**Decision (2026-05-28)**: Option B from the proposal review — *keep* the
MIN_PRICE floor, focus discovery on $3-15 small-caps with strong relative
volume. The May blotter proved sub-$1 names were slippage-destroyed
regardless of how well we picked them; tightening the universe to a price
band where stops actually fill at quoted prices is the higher-EV move.

**What lands**

- `momentum-agent` floor adjustment: `MOMENTUM_MIN_VOLUME` stays at 1M
  shares for default discovery (covers $3-15 names with real liquidity).
  Add `MOMENTUM_MIN_DOLLAR_VOLUME` (new) at $5M as a secondary filter so
  thin $14 names that look interesting on % change but have $300K total
  dollar volume don't sneak in.
- New `momentum-discovery` data source: 5-min cadence scan of Alpaca's
  top % gainers, post-filtered to (price ≥ MIN_PRICE) AND (dollar volume
  in last 15 min ≥ $5M) AND (% change ≥ MOMENTUM_GAP_PCT). Output feeds
  the existing screener candidate pool; no new agent.
- Single flag: `MOMENTUM_DISCOVERY_ENABLED`, default `false` until the
  backtest replay validates against a fixture of recent runners.
- Backtest harness extension: replay against a saved CSV of "movers we
  should have caught last week" to tune floors before flipping live.

**What we explicitly do NOT do**

- No new data provider. No paid Polygon tier.
- No new agent — momentum already exists.
- No lowering MIN_PRICE. The May data is unambiguous on this.
- No "AI-driven discovery." Rule-based filter first; LLM only on the
  filtered candidate set.

**Acceptance**

- Backtest replay against the saved fixture catches at least 70% of
  $3-15 movers at first qualifying bar.
- LLM call count from the screener does NOT increase — new candidates
  flow through the existing budget.
- After 5 live sessions with discovery enabled, the retro card shows the
  momentum strategy's win rate or avg-payoff hasn't degraded vs the
  pre-discovery baseline.

---

## Phase 3: LLM Efficiency v2 — remaining work (2-3 days)

**Goal**: 5-day avg daily LLM spend ≤ $5. The big-ticket items (caching,
news cut, TA gate) are already done in Phase 0 and 0.5. This phase ships
the smaller items still on the table.

**What lands**

- **Adaptive throttle**: at 50% of daily cost cap → debate disabled; at
  70% → Sonnet disabled on orchestrator (Haiku only); at 90% → full
  rule-based fallback. All three breakpoints already have the logic
  hooks; this wires them into the cost tracker.
- **Per-agent context-hash gates**. The orchestrator already has one
  (`_lastInputHash`) — port the same pattern to news, momentum, and risk
  so they skip the LLM when inputs haven't materially changed since the
  last cycle.
- **risk-agent LLM portion review**. If the retro shows its LLM
  commentary never changes the rule-based veto outcome, cut to pure
  rule-based. Hardest of the three; do last.

**What we explicitly do NOT do**

- Don't cut an agent the retro shows IS earning its cost.
- No multi-LLM ensemble. Single Claude tier stays.
- No model fine-tuning.

**Acceptance**

- 5-day avg daily LLM spend ≤ $5 with same or higher win rate vs the
  post-Phase-0 baseline.
- `LlmCostCard` shows each cut explicitly (debate row, Sonnet rate,
  per-agent context-hash skip count).

---

## Phase 4: Interface simplification — delete pass (2-3 days)

**Goal**: cut codebase + cognitive load. v1's UI roadmap added density
and logo coverage; v2 removes what nobody uses.

**What lands**

- **Settings**: collapse 6 sections (Risk · Signal Tuning · Cycle Guard ·
  Options · Momentum · LLM · Data Sources · Watchlist · Agent Toggles)
  into a sticky left-nav with one section visible at a time. Currently
  ~1500-line vertical scroll.
- **Wiki views** (`HelpView`, `AgentsView` wiki tab): delete. Replace
  with inline `?` tooltips on the specific Settings field they document.
  The `GreekTooltip` pattern proves this works.
- **AgentChatView**: move to `/labs` behind a flag, or delete if usage
  data confirms unused.
- **CryptoView**: merge into MarketView (same chart panel works with
  crypto symbols).
- **TimelineView**: delete if Phase 1's retro card supersedes it.
- **Orchestrator prompt cleanup**: strip role descriptions for cut
  agents (only Screener/News currently — Rupture/Bounce stay) from the
  `SHARED_PREAMBLE`. Saves ~30 tokens per cached block and keeps the
  prompt honest.
- Drop the view count from ~15 to ~8.

**Acceptance**

- `trader-ui/src/views/` shrinks by ≥ 30% of LOC.
- No view exceeds 600 lines.
- All deleted features confirmed unused for 14 days.

---

## Phase 5: v2 hardening (rolling, post-4)

Quality-of-life and stability work, no dedicated sprint:

- **TypeScript migration**: one file/week from the deferred list
  (`server.js`, `orchestrator.js`, `execution-agent.js`).
- **Decision audit log**: `/api/decisions/:id/audit` endpoint that joins
  agent_decisions → agent_reports → trades → prompt_versions for full
  reproducibility 3+ months out. The data is all persisted; just needs
  the join.
- **Trade-verification script generalization**: extend `verify-trade.js`
  to optionally reconcile a date range, not just a single symbol. Useful
  for periodic sanity-check runs.

---

## Definition of done

v2 is complete when the operator can answer all four questions on the
dashboard without reading code:

1. **What did I lose money on last 30 days, and what's the rule to apply
   tomorrow?** (Phase 1 retro card.)
2. **Which runners did I miss, and did the coverage fix catch them this
   week?** (Phase 2 discovery + backtest replay metric.)
3. **What's my LLM bill, and which agent is overspending vs its
   contribution?** (Phase 3 per-agent cost vs supporting-agent win rate
   surfaced on the `LlmCostCard`.)
4. **What's silently broken right now?** (Phase 0.5 `lastError` surface,
   cache health probe, breaker root-cause banner.)

If we ship v2 and the answer to any of those four is still "read the
logs" or "open the source", we missed.

---

## What's NOT in v2 (explicit non-goals)

- New asset classes (futures, FX, multi-leg options).
- New brokers (IBKR, Tradier, Schwab).
- Live trading switch from paper. Stays paper until v3 at earliest.
- Mobile-first or native app.
- Multi-account / multi-user.
- Marketplace / strategy sharing / copy-trading.
- Replacing Claude with a different LLM provider.
- Auto-tuning / RL agents that adjust their own knobs.

Each of these is a v3 conversation.

---

## Recommended sequence from here (2026-05-28)

1. **Observation week (today + 5-7 days)**: passive. No new code. Watch
   trade flow, LLM cost, retro card population, and `lastError` lines.
   Goal: confirm the TA + news fixes restored equity signal flow.
2. **Phase 2 (Coverage v2)**: ship after observation week. Small,
   well-scoped, doesn't depend on retro data.
3. **Phase 3 remaining items**: drip-ship in parallel with observation —
   each item is small enough not to need a dedicated sprint.
4. **Phase 1 reactivation**: once trade count clears the 20-closed
   threshold, the retro card starts emitting findings. Apply them.
5. **Phase 4 + 5**: after Phases 1-3 have run for ≥ 14 days. The delete
   pass needs the usage data to know what's safe to cut.
