# Alpaca Trader v2 Roadmap

## Premise

v1 was a "build the parts" sprint — 29 phases of agents, dashboards, options,
caching, telemetry. The bot now does too many things, and the symptom is that
**too many veto sources have stopped it from trading at all**. The retro can't
measure agent contribution if no trades exist to retro against.

**v2 is a measurement + consolidation pass, not a feature pass.** The default
move is to *delete or merge* before adding. Every phase must justify itself
against either: (a) higher win rate, (b) lower LLM bill, or (c) less code to
maintain.

---

## Status

- **Phase 0a** (3 of 4 agent cuts): ✅ shipped — Breakout + Mean-Reversion
  + Screener-LLM-rerank soft-disabled behind runtime-config flags, default
  OFF. Settings → Agent Toggles flips each back on. Agent code retained
  for 14 days; deletion in Phase 4 if metrics agree.
- **Phase 0b** (news-per-cycle LLM cut): pending — requires a keyword-based
  critical-alert detector first so we don't lose the news-veto path.
- **Risk fixes** (out-of-band, 2026-05-21): ✅ MIN_PRICE floor ($3 default)
  + momentum percentage trailing stop. Triggered by the May 18-21 blotter
  showing −$7,450 net, every large loss a sub-$1 penny stock, and momentum
  avg-loss ≥ avg-win.
- **Phase 1** (trade retro card): ✅ shipped — TradeRetroCard reads
  /api/analytics/attribution and emits ranked findings (worst regime /
  exit-reason / hold-duration / weekday / repeat-offender symbols) plus
  green validation findings. 7/30/90d windows, ≥8-trade floor.
- **Phase 2-4**: planned.

---

## Ordering rationale

The original plan put the trade-retro card first ("measure before optimize").
Right call in principle, wrong call given current state: **we have no recent
trades to retro against**, and the most likely cause is *too many agents
voting HOLD by default*. So the prerequisite to a useful retro is to cut the
agents we already know are redundant, get trading flowing, *then* measure.

The cuts in Phase 0 are surgical and grounded in clear overlap with Quant —
not blind. The retro in Phase 1 then validates that the cuts didn't lose
alpha and decides whether to cut further.

---

## The threads

| Thread | Question it answers | Phase |
|---|---|---|
| **Consolidation** | Which agents overlap or don't earn their LLM cost? | 0 |
| **Retro** | Which kind of trades keep losing? | 1 |
| **Coverage** | Why didn't we catch today's runners? | 2 |
| **Efficiency v2** | After cuts + retro, what's left to trim? | 3 |
| **Simplicity** | What can be deleted from the UI and the codebase? | 4 |

---

## Phase 0: Agent consolidation (1-2 days)

**Goal**: cut LLM call sites from ~10/cycle to ~4 without touching the agents
that produce distinct signal. Unblocks trades by removing redundant veto
sources. Drops daily LLM bill toward the $5 target without depending on
caching to do all the work.

### What lands

**Kill outright (redundant with Quant's MTF analysis):**
- `breakout-agent` (Rupture). Its breakout detection is what Quant already
  does on the 5min/15min timeframes via EMA crossover + volume confirmation.
  Two LLM calls voting the same way isn't dissent, it's duplication.
- `mean-reversion-agent` (Bounce). Same story — Quant's BB position +
  RSI extreme reads on multi-timeframe already cover this. Bounce was
  voting BUY when Quant said HOLD on the same bar, then losing in the
  next cycle. Net negative signal.

**Downgrade to rule-based (keep the agent shell, cut the LLM call):**
- `screener-agent` (Scout) — **shipped in Phase 0a**. LLM rerank gated
  behind `SCREENER_LLM_RERANK_ENABLED` (default off). The agent's
  existing rule-based watchlist construction runs unchanged when the LLM
  is skipped. Future Phase 2 work can replace the simple score with the
  composite (volume_ratio × |gap%| × volatility × distance-from-52wh).
- `news-agent` (Herald) — **deferred to Phase 0b**. The per-cycle LLM
  call is what currently produces the `_alerts` list that the executor
  reads via `newsAgent.getCriticalAlert(symbol)`. Cutting that today
  removes the news veto path. Phase 0b adds a keyword-based critical
  detector first, then cuts the LLM call.

**Keep unchanged:**
- `regime-agent` (Atlas) — runs every 3rd cycle already, cheap, broad
  context useful for every other agent.
- `technical-agent` (Quant) — core signal source, already rule-gated.
- `risk-agent` (Vega) — already mostly rule-based; the LLM portion is
  a small assessment that adds nuance to portfolio veto.
- `momentum-agent` — sees runners Quant can't (parabolic moves Quant
  reads as overbought).
- `orchestrator` (Nexus) — synthesizes. Already Haiku-on-consensus,
  Sonnet-on-dissent. Now sees fewer agents, so dissent is rarer; the
  context-hash cache should hit more often.
- `execution-agent` (Striker) — rule-based, zero LLM.

### What we explicitly do NOT do

- Don't keep Rupture/Bounce "just in case." If the retro in Phase 1 says
  we lost edge by cutting them, we resurrect with data. Until then, dead.
- Don't replace the news LLM with another LLM tier. Cut to event-only.
- Don't refactor the orchestrator's prompt to reflect the smaller agency.
  Stale role descriptions for cut agents still parse fine; redundant prose
  costs ~50 tokens per cached system block. Schedule for Phase 4.

### Acceptance

- LLM call volume drops from ~10 sites/cycle to 4 (Atlas-every-3rd +
  Quant-gated + Nexus + Momentum). Verify via the existing per-agent
  cost breakdown on the dashboard `LlmCostCard`.
- At least 1 trade clears synthesis per session-day within 48 hours of
  deploy. If zero trades persist, the bottleneck is somewhere else
  (cycle guard / breaker / runtime config override) and we investigate
  before Phase 1.
- 5-day avg daily LLM spend ≤ $7 (interim — full $5 target after Phase 3).

---

## Phase 1: Trade Retro Surface (2-3 days)

**Goal**: turn the existing `/api/analytics/attribution` slice data into a
single dashboard card that emits 3-5 concrete findings the operator can act
on tomorrow morning. Validates that Phase 0 cuts didn't lose alpha.

### What lands

- New `TradeRetroCard` component on the dashboard cockpit (right column,
  below Quick Trade / Option Activity).
- Reads `/api/analytics/attribution?days=30`.
- Computes a small ruleset over the existing slices and emits findings as
  ranked cards:
    - "Wed losses 3.2× Mon losses (n=12) — consider Wed gate"
    - "trending_bear wins 12% vs trending_bull 58% — disable agency BUYs
      in trending_bear"
    - "manual_close loses 60% vs stop_loss closes 30% — let stops do
      their job"
    - "hold_duration intraday wins 22% vs swing_3-7d wins 51% — defer
      same-day exits unless target hit"
    - "AAPL has lost on 7/10 trades — drop from watchlist or stop trading
      it during current regime"
- Plus one Phase 0 validation finding: **"Trades since agent cuts: N wins
  / M losses. Win rate vs prior 30d: X% vs Y%."** If win rate dropped
  meaningfully, surface "consider restoring breakout/mean-rev agents."
- Each finding includes: severity (red/amber/green), n-trades it's based
  on (hides when n < 10), and a one-click "apply" button where applicable.

### What we explicitly do NOT do

- No new analytics endpoints. Reuse what exists.
- No ML / clustering / "AI insights" — this is a ruleset over slices.
- No backtest validation of findings. The findings are *hypotheses* for
  the operator to act on; the next 30 days will validate them.

### Acceptance

- After 1 cycle, the card emits at least 1 finding for any account with
  ≥ 20 closed trades.
- Each finding renders the underlying slice (clickable expand → table of
  the trades it counts).
- Apply buttons for regime / sector / symbol findings actually flip the
  relevant runtime-config key and the next agency cycle respects it.

---

## Phase 2: Coverage — catch the runners we're missing (2-3 days)

**Goal**: close the gap that TDIC, QUCY, AIIO exposed. These are
small-share-count parabolic movers with real dollar volume that Alpaca's
standard most-active screener misses because share count is small.

### What lands

- `momentum-agent` floor change: `MOMENTUM_MIN_VOLUME` from 1M shares
  → 100K shares. Add `MOMENTUM_MIN_DOLLAR_VOLUME` (new) at $10M. Catches
  the right tail without picking up dollar-store pennies.
- New `momentum-discovery` source that pulls a real-time mover scan
  during regular hours (5-min cadence): top % gainers above $1 with
  $10M+ dollar volume in last 15 min. Free via Alpaca's
  `most_active_stocks` with an extended set + post-filter on dollar
  volume.
- The discovery output feeds the existing screener candidate pool; no
  new agent. One config knob: `MOMENTUM_DISCOVERY_ENABLED` (default off
  until Phase 1 retro tells us small-cap parabolic is worth chasing).
- Backtest harness gets a small extension to replay a saved CSV of
  "movers we should have caught" against the new screener config, so we
  can tune the floors before flipping discovery on.

### What we explicitly do NOT do

- No new data provider. No paid Polygon tier. No tradier/IBKR integration.
- No new agent — momentum already exists.
- No "AI-driven discovery" — the LLM doesn't see this universe until
  after rule-based filtering picks the candidates worth analyzing.

### Acceptance

- Replay against last week's movers (TDIC + 2-3 others to be saved as a
  fixture) catches at least 70% of them at first qualifying bar.
- LLM call count from the screener does NOT increase — the new candidates
  are fed through the existing budget, not added on top.

---

## Phase 3: LLM Efficiency v2 — what's left after Phase 0 (3-5 days)

**Goal**: from ~$7/day post-Phase-0 to ≤ $5/day. The Phase 1 retro tells
us which of the *remaining* agents matter; this phase acts on it.

### What lands (contingent on retro findings)

After Phase 0, the surviving LLM call sites are:
- regime-agent (every 3rd cycle)
- technical-agent (gated on rule-based "interesting" filter — already shipped)
- risk-agent
- momentum-agent
- orchestrator (Haiku on consensus, Sonnet on dissent)

For each, the retro card will show contribution-to-wins via the
`supporting_agents` field. If any of these doesn't move win rate over
baseline:

- **risk-agent LLM portion**: if its LLM commentary never changes the
  rule-based veto outcome, cut to pure rule-based. Most likely candidate.
- **debate**: contingent on retro — if dissent rarely changes the
  orchestrator outcome (compare decision.action with vs without debate
  block from prompt-registry data we already log), disable by default.
- Adaptive throttle: at 50% daily cap → debate off; at 70% → Sonnet off
  (Haiku only on orchestrator); at 90% → full rule-based fallback.
- Per-agent context-hash gates (the orchestrator already has one). Port
  to risk + momentum so they skip the LLM when inputs haven't materially
  changed.

### What we explicitly do NOT do

- Do NOT cut an agent that the retro shows IS earning its cost.
- No multi-LLM ensemble. Single Claude tier (Haiku) with Sonnet only on
  dissent stays.
- No fine-tuned model. Not worth the operational cost at this scale.

### Acceptance

- 5-day average daily LLM spend ≤ $5 with same or higher win rate vs
  the post-Phase-0 baseline.
- Per-agent cost on the dashboard's LlmCostCard shows the cut explicitly.

---

## Phase 4: Interface simplification — delete pass (2-3 days)

**Goal**: cut codebase + cognitive load. The v1 UI roadmap added density
and logo coverage. v2 removes what nobody uses.

### What lands

- **Settings**: collapse 6 sections (Risk · Signal Tuning · Cycle Guard ·
  Options · Momentum · LLM · Data Sources · Watchlist) into a single
  sticky left-nav with one section visible at a time. Currently a
  ~1200-line vertical scroll.
- **Wiki views** (`HelpView`, `AgentsView` wiki pages): delete. Replace
  with inline `?` tooltips on the specific Settings field they document.
  The existing `GreekTooltip` pattern proves this works.
- **AgentChatView**: low-use, high-maintenance. Move to a `/labs` route
  hidden behind a flag, or delete if usage data confirms.
- **CryptoView**: low-use. Merge into MarketView (same chart panel works
  with crypto symbols).
- **TimelineView**: if Phase 1's retro card supersedes it, delete.
- **Orchestrator prompt cleanup**: strip the role descriptions for cut
  agents (Rupture, Bounce) from the SHARED_PREAMBLE. Saves ~50 tokens
  per cached block, also keeps the prompt honest.
- Goal: drop the view count from ~15 to ~8.

### What we explicitly do NOT do

- No theme system. No light mode. No customization knobs nobody asked for.
- No drag-and-drop dashboard layout. The cockpit shape from Phase 3 is
  fine.
- No mobile-specific app or PWA install flow.

### Acceptance

- `trader-ui/src/views/` shrinks by ≥ 30% of LOC.
- No view exceeds 600 lines.
- All deleted features confirmed unused for 14 days.

---

## Phase 5: v2 hardening (rolling, post-4)

Pure quality-of-life and stability work that doesn't need its own sprint:

- TypeScript migration continues: one file/week from the deferred list
  (`server.js`, `orchestrator.js`, `execution-agent.js`).
- Decision audit log: every orchestrator decision should be
  re-explainable 3 months later via a single endpoint that joins
  agent_decisions → agent_reports → trades → prompt_versions. Mostly
  exists; just needs a `/api/decisions/:id/audit` endpoint that returns
  it.

---

## Definition of done

v2 is complete when the operator can answer all four questions on the
dashboard without reading code:

1. **What did I lose money on last 30 days, and what's the rule to apply
   tomorrow?** (Phase 1 retro card.)
2. **Which runners did I miss, and did the coverage fix catch them this
   week?** (Phase 2 discovery + replay metric.)
3. **What's my LLM bill, and which agent is overspending vs its
   contribution?** (Phase 3 per-agent cost vs supporting-agent win rate.)
4. **What setting should I change right now to fix the biggest hole?**
   (All three phases above feed this — the retro card emits actions,
   the cost card emits agent-cut recommendations, and Settings became
   small enough to find the right knob in <10 seconds.)

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
