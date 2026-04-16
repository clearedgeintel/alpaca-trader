# Getting Started

Welcome to Alpaca Auto Trader — an AI-powered stock + crypto trading bot.

## What it does

- Scans a configurable watchlist every 5 minutes during market hours
- Runs **7 specialized AI agents** (technical, news, regime, risk, screener, breakout, mean-reversion) whose reports are synthesized by an **orchestrator** into BUY/SELL decisions
- Places orders on Alpaca (paper or live), tracks positions, manages stops/targets
- Learns: calibrates each agent's weight by real win rate, supports prompt A/B testing, and runs a live-ramp to scale capital only after proving the edge

## 3 modes

| Mode | What it uses | Cost |
|---|---|---|
| **Rules** | Pure EMA crossover + RSI + volume | $0 LLM |
| **Hybrid** | Rules generate candidates, LLM confirms | ~$2-5/day LLM |
| **LLM** | Full agency pipeline — 7 agents + orchestrator | ~$5-15/day LLM |

Change per-symbol or globally in **Settings → Trading Mode**.

## First-time setup

1. **Paper trade first.** Default `ALPACA_BASE_URL` points to paper. Do not change to live until you've run for weeks and reviewed results.
2. Open the **Dashboard** — confirm Alpaca connection is green, LLM budget banner shows budget remaining, agents are reporting.
3. Watch the **Agents page** — each agent has a persona (Scout, Vega, Atlas, Quant, Herald, Rupture, Bounce, Nexus). Green dot = healthy heartbeat.
4. **Market view** lets you inspect any symbol with VWAP and volume profile overlays.
5. **Trades page** shows every trade with the full agent-decision chain in the drawer.

## Core concepts

- **Agency mode** — 7 AI agents debate, orchestrator synthesizes, execution-agent places orders
- **Calibration** — each agent's reported confidence is scaled by its 30-day win rate
- **Live ramp** — capital auto-scales 1% → 5% → 25% → 100% as gates pass
- **Kelly sizing** — position size optimized from historical edge (opt-in)
- **Smart Order Routing** — limit orders with market fallback to capture spread
- **Shadow mode** — test new prompts in parallel without trading their output
- **Debate** — dissenting agents challenge the majority before synthesis

## Next steps

- **[Dashboard](#/help/dashboard)** — explain every panel
- **[Agents Overview](#/help/agents-overview)** — meet the 7 agents
- **[Going Live](#/help/going-live)** — the safe path from paper to real money
