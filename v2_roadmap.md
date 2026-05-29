# Alpaca Trader v2 Roadmap — Personal Pro-Grade (path to live)

## Premise

v1 was 29 phases of LLM-orchestration scaffolding. v2 turns it into something
that can responsibly trade real capital on a personal account. The brutal-review
checklist defines "professional":

- Stops survive halts and gap-opens
- Backtest predicts live within 10-15% over 200+ trades per regime
- Deterministic where possible; LLM only where it demonstrably earns its keep
- Post-trade attribution with MAE/MFE per setup
- Sample size discipline before any edge claim
- Risk discipline that survives a black-swan open

Personal use means complexity can stay *if* it pays. SaaS pressure is off.
Regulatory concerns are off. The remaining bar is brutal: **does it make money
on real capital without blowing up?**

The prior v2 outline (Phases 0a/0b/1/2/...) is superseded by this document.
What shipped is logged in "Already in flight" below; nothing is wasted, but the
order of work changes significantly.

---

## Path-to-live order (committed)

Sequential, not parallel. Each phase has explicit no-go criteria — failures
stop the progression and force rethink, not "ship anyway."

### Phase 1 — Safety prereqs (4-5 days) [BLOCKS live capital]

Without these, live trading is irresponsible regardless of edge.

- **Halt detection.** Subscribe to Alpaca's halt status feed. Pause any
  position in a halted symbol. Never enter a name currently halted. Test
  with a recently-halted symbol fixture.
- **Gap risk handling.** Before market open, check premarket %change for
  every open position. If gap > 1.5× the configured stop distance, log a
  GAP-RISK alert and exit at open (no waiting for the 5-min cycle to
  notice). Configurable: `GAP_EXIT_THRESHOLD_MULT` default 1.5.
- **Broker outage handling.** Detect Alpaca API down (3 consecutive
  fetch failures > 30s apart). Stop entering new positions. Open
  positions: log + alert, do not panic-exit. Resume when API recovers
  + 60s grace period.
- **Risk-rule audit.** Trace through actual production behavior: portfolio
  heat cap, sector concentration, correlation guard, max-pos-pct. Confirm
  each one *actually fires* via integration tests against contrived
  fixtures. (The code is there, but I don't know it's correct in all
  paths.)

**No-go criteria.** If any safety prereq can't be cleanly tested + verified,
do not advance to live. These aren't optional.

### Phase 2 — Measurement prereqs (3-5 days)

Without these, every subsequent phase is measuring noise.

- **Backtest fidelity audit.** Run our backtest against the last 30 days
  of actual paper fills. Compare predicted P&L per trade vs actual. If
  median absolute error > 15%, fix the slippage + cost + partial-fill
  model until it isn't. The honest test: blind-run the backtest on a
  symbol/window where we know live fill prices, never letting the
  backtest see them, then compare.
- **MAE/MFE attribution.** Extend `TradeRetroCard` with max-adverse-
  excursion (worst paper-loss during trade) + max-favorable-excursion
  (best paper-gain during trade) per setup. This is what pros use to
  know if stops are at the right place. Storage: extend `trades` table
  with `mae_pct`, `mfe_pct` columns; monitor populates them on each
  cycle.
- **Trade attribution dimensions.** Add to the retro card: time-of-day
  bucket (first hour / midday / last hour), regime-at-entry, sector,
  hold-duration. Most exist; consolidate.

**No-go criteria.** If backtest error > 25% and we can't get it under 15%,
the backtest is useless for sizing and we don't have a viable
path-to-live until it is. Stop, fix, then resume.

### Phase 3 — Strip to rules-only baseline (3-4 days, then 7-10 days observation)

Bold but rigorous. Disable every LLM call site. Run paper for 7-10 days.
Measure trade count, EV/trade, win rate, max drawdown, max-single-loss.

- All Phase 0 toggles → ON for "cut applied" (Breakout OFF, Mean-Rev OFF,
  Screener-LLM OFF, News-LLM OFF)
- New flag: `ORCHESTRATOR_LLM_ENABLED` default `false` — when off, the
  orchestrator runs rule-based fallback synthesis only
- New flag: `TECHNICAL_LLM_ENABLED` default `false` — when off, Quant
  publishes only the rule-based `detectSignal` output
- Risk-agent LLM portion: already mostly rule-based, leave for now
- Regime + Momentum: keep (cheap, rule-heavy already)

**This is the key test.** If rules-only is profitable, the LLMs are
*possibly* adding value and Phase 4 measures it. If rules-only is *not*
profitable, the LLMs were masking a fundamental absence of rule-based
edge — STOP. Don't go live. The strategy doesn't have a real foundation.

**No-go criteria.**
- 7-10 day paper EV/trade < 0 with > 20 closed trades → strategy lacks
  base edge. Stop and re-evaluate the setups themselves.
- < 5 closed trades in 10 days → rules are too restrictive. Loosen rule
  thresholds before Phase 4 or accept that the strategy never trades.

### Phase 4 — Add agents back, one at a time (15-21 days)

Scientific ablation in reverse. Each addition is a 3-4 day block. After
each block, compare EV/trade + win-rate against the rolling baseline.

| Block | Add this back | Measure |
|---|---|---|
| 4a | Technical-analysis LLM | Δ EV/trade vs rules-only baseline |
| 4b | Orchestrator (Haiku only, no debate, no Sonnet) | Δ EV/trade vs 4a |
| 4c | Momentum-agent's LLM portion | Δ EV/trade vs 4b |
| 4d | Orchestrator Sonnet on dissent | Δ EV/trade vs 4c |
| 4e | News-LLM (only if 4d showed positive Δ) | Δ EV/trade vs 4d |
| 4f | Breakout / Mean-Reversion (per Phase 0 retro hypothesis) | Δ EV/trade vs 4e |

**Decision rule.** Keep an addition only if Δ EV/trade ≥ that addition's
LLM cost per trade × 2 (margin for the small-sample noise floor). Below
that, the addition is paying for itself but with no headroom — cut it.

**No-go criteria.**
- 4a regresses by > 10% — Quant's LLM is actively harmful. Cut.
- Any block adds > $1/day cost with EV/trade unchanged — that agent
  is noise.

### Phase 5 — Two-setup focus (7-10 days)

After Phase 4, we know which agents pay. Now reduce setup count.

- Identify the 2 setups (rule + LLM combination) with the highest
  *expected value × trade frequency* product
- Drop everything else into a "watch but don't trade" mode (signals
  generated and logged, but `execution-agent` filters them)
- Pour all remaining measurement effort into the chosen 2

**No-go criteria.** If no setup combo has positive EV × frequency after
Phase 4, the system doesn't have edge. Stop. The path-to-live ends here
and we re-evaluate the entire strategy thesis.

### Phase 6 — 200-trade discipline (calendar gate, ~4-8 weeks)

No code work. Run the Phase 5 system on paper. Accumulate 200+ closed
trades per regime label that the regime agent classifies (trending_bull,
trending_bear, range_bound at minimum).

Until this gate is cleared, **everything claimed about live edge is
hypothesis**. Resist the urge to ship more code during this phase.

**Acceptance for advancing to Phase 7.**
- 200+ trades per regime
- Sharpe ratio (annualized, net of fees) > 1.0
- Max drawdown < 15%
- Per-setup MAE shows stops are above the 90th-percentile loss point
  (otherwise stops are getting picked off by noise)

### Phase 7 — Paper-to-live transition (3-4 weeks)

This is the most-dangerous phase and gets the most discipline.

- Start with **5-10% of intended live capital** (e.g., $5K if intended
  $50K)
- Track real-money slippage vs paper slippage per trade
- After **first 25 live trades**: compare live P&L vs paper P&L for the
  same trades. Acceptable divergence: ≤ 25%
- After **first 50 live trades**: backtest-vs-live error vs Phase 2 audit
  threshold. Should still be ≤ 15%
- Cap any single trade at 1% of live capital regardless of strategy size
  until 100 trades are in
- Ramp capital in 25% increments only after each milestone is cleared

**No-go criteria.**
- Live slippage > 2× paper slippage → recalibrate before ramping
- First live week ends with > 8% drawdown → pause, post-mortem, do not
  ramp capital
- ANY broker-side error not handled cleanly → stop, fix, re-test

### Phase 8 — Delete pass + code consolidation (3-5 days)

After Phase 7's first 100 live trades complete cleanly. NOW we know
what's keeping its weight.

- Delete agents/setups that didn't survive Phase 4
- Settings UI: collapse into single sticky left-nav (the long-promised
  cleanup)
- Wiki views: delete, replace with inline `?` tooltips
- CryptoView / AgentChatView / TimelineView: delete if unused
- Orchestrator prompt: strip dead-agent role descriptions
- Goal: `trader-ui/src/views/` shrinks 30%+ of LOC

---

## Already in flight (preserved across the reframe)

Work shipped in the prior v2 attempt that survives this reframe — none of
it gets thrown away, but it gets re-prioritized under the new phases:

| Work | Phase it belongs to | Status |
|---|---|---|
| Phase 0a (breakout/mean-rev/screener LLM gates) | Phase 4 (used for ablation control) | ✅ shipped |
| Phase 0b (news LLM cut + keyword detector) | Phase 4 cell 4e | ✅ shipped |
| TradeRetroCard (current form) | Phase 2 (extended with MAE/MFE) | ✅ shipped, needs extension |
| MIN_PRICE floor + momentum trailing stop | Phase 1 (safety baseline) | ✅ shipped |
| Confidence floor revert (0.70 / 0.60) | Phase 3 baseline | ✅ shipped |
| `lastError` surface + cache health probe | Phase 2 (observability infrastructure) | ✅ shipped |
| extractJson synthetic-close + tests | Cross-cutting reliability | ✅ shipped |
| `verify-trade.js` + `getAccountActivities` | Phase 2 (fidelity audit tooling) | ✅ shipped |
| Per-agent prompt caching | Cross-cutting cost | ✅ shipped |
| TA gate loosening + MIN_LLM_BATCH | Phase 4 (will be re-enabled then ablated) | ✅ shipped |
| TA + news maxTokens bumps | Phase 4 prereq | ✅ shipped |

---

## Acceptance for "v2 done"

Operator can truthfully answer all of these without code-reading:

1. **What's my live Sharpe over 200+ real trades?** (Phase 6 + 7 result)
2. **What's my max drawdown in the worst month live?** (Phase 7 ongoing tracking)
3. **Backtest predicts live within how much error?** (Phase 2 → Phase 7 ongoing)
4. **What % of edge comes from rules vs LLM, with ablation data?** (Phase 4)
5. **What's silently broken right now?** (Phase 0.5 reliability surface already shipped)

If we ship v2 and the answer to any of those is "I don't know" or "depends
who you ask," we missed.

---

## What's explicitly NOT in v2

- SaaS / multi-tenant / pricing / billing
- New asset classes (futures, FX, multi-leg options)
- New brokers (IBKR, Tradier, Schwab)
- Mobile-first or native app
- Replacing Claude with a different LLM provider
- Auto-tuning / RL agents
- Discretionary intervention during Phase 6 — leave the system alone, take
  notes
- More than 2 setups after Phase 5 — adding setups dilutes measurement
- Going to live capital before Phase 7's no-go criteria are clear

Each is a v3 conversation.

---

## Why this order

I want to name the discipline since it'll be tested by future "ship X"
requests:

1. **Safety before performance.** A halted-name stop bypass kills a real
   account; backtest fidelity is annoying. Order reflects severity.
2. **Measurement before ablation.** Without honest backtest + MAE/MFE, the
   ablation tells us about backtest noise, not real edge.
3. **Strip-then-add, not selective-cut.** Builds confidence that the
   rule-based foundation actually exists. The cuts are reversible runtime
   flags; the risk of stripping is bounded.
4. **Calendar gate is calendar gate.** 200 trades is 200 trades. Resist the
   urge to ship code during Phase 6 — it's the most-tempting and most-
   damaging phase to over-engineer.
5. **Live transition gets the most paranoid criteria** because real money.
6. **Delete pass last** — only after we know what's worth keeping.

The temptation when something feels stuck will be to ship more code. The
right move at those moments is to look at the no-go criteria for the
current phase and answer them honestly first.
