# Agents Overview

The agency has **7 specialized analysis agents** plus an **orchestrator** and **executor**. Each has a persona with an avatar + accent color.

## The 7 analysis agents

| Avatar | Name | Role | Primary inputs |
|---|---|---|---|
| S | **Scout** (Market Screener) | Discovers dynamic watchlist symbols every cycle | Alpaca most-actives + top movers |
| V | **Vega** (Risk Manager) | Portfolio heat, sector exposure, daily P&L, **veto power** | Current positions + sector allocations |
| A | **Atlas** (Market Regime) | Bull/bear/range/high-vol classification | SPY + VIX correlation + breadth |
| Q | **Quant** (Technical) | Multi-timeframe EMA/RSI/volume/MTF alignment | 5m/15m/1H/1D bars per symbol |
| H | **Herald** (News Sentinel) | News sentiment + Reddit buzz + Polygon insights | Alpaca news + Reddit + Polygon enrichment |
| R | **Rupture** (Breakout) | Resistance break + volume surge + BB expansion | Daily bars + pivot S/R |
| B | **Bounce** (Mean-Reversion) | RSI extremes + BB reversion + VWAP distance | Daily bars + VWAP |

## How they work together

1. **Phase 0** — Scout builds the watchlist; Atlas classifies the market regime
2. **Phase 1** — Vega, Quant, Herald, Rupture, Bounce all analyze the watchlist **in parallel**
3. **Phase 1.5 (debate)** — if agents disagree, dissenters get one Haiku call to challenge the majority's top supporter, who responds. Transcript flows into the orchestrator prompt.
4. **Phase 2** — Orchestrator (Nexus) synthesizes all reports + debate + calibration + regime + sector rotation into final BUY/SELL decisions
5. **Phase 3** — Execution agent (Striker) sizes + places orders

## Calibration

Each agent's **reported confidence** is scaled by its **30-day win rate** before the orchestrator weighs it. Cold-start (fewer than 10 closed trades) defaults to 0.5. The calibration panel on the Agents page shows each agent's effective weight.

**Tipping agent**: the supporter whose calibrated confidence most influenced a decision. Marked with ★ in the TradeDrawer.

## Agent specialization mantras

- **Rupture** — chases momentum, needs MULTIPLE confirmations
- **Bounce** — fades stretched moves, never fights a trend
- **Quant** — grounds the decision in multi-timeframe alignment
- **Herald** — kills trades on critical bearish news (final safety gate)
- **Vega** — absolute veto: if risk says no, the decision is no

## LLM cost per cycle

With 7 agents + orchestrator, each cycle costs roughly:
- 5 agent LLM calls (Haiku) × $0.001 each
- 1 orchestrator call (Sonnet) × $0.01
- 2-4 debate calls (Haiku) when agents disagree × $0.001 each

Typical: **~$0.02 per cycle**. At 5-min intervals during 6.5h market hours, **~$1.50/day**. Shadow mode roughly doubles this when active.
