# Alpaca Auto Trader

Automated paper trading bot with two operating modes:

- **Legacy Mode** — rule-based momentum strategy (EMA crossover + RSI + volume confirmation)
- **Agency Mode** — multi-agent AI system powered by Claude that discovers opportunities, analyzes technicals across timeframes, monitors news sentiment, classifies market regimes, and synthesizes decisions through an orchestrator

Built on the Alpaca API with Supabase PostgreSQL for persistence.

## Prerequisites

- **Node.js 18+** (uses native `fetch`)
- **Alpaca paper trading account** — sign up at [alpaca.markets](https://alpaca.markets)
- **Supabase project** — create at [supabase.com](https://supabase.com) (free tier works)
- **Anthropic API key** — required for agency mode ([console.anthropic.com](https://console.anthropic.com))

## Setup

1. Clone the repo and install dependencies:
   ```bash
   cd alpaca-trader
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your credentials:
   ```bash
   cp .env.example .env
   ```

   Required variables:
   | Variable | Description |
   |----------|-------------|
   | `ALPACA_API_KEY` | From your Alpaca paper trading dashboard |
   | `ALPACA_API_SECRET` | From your Alpaca paper trading dashboard |
   | `ALPACA_BASE_URL` | `https://paper-api.alpaca.markets` for paper trading |
   | `ALPACA_DATA_URL` | `https://data.alpaca.markets` |
   | `DATABASE_URL` | Supabase direct connection string |
   | `ANTHROPIC_API_KEY` | Required for agency mode |
   | `USE_AGENCY` | `true` to enable agency mode, `false` for legacy (default) |

3. Start the app:
   ```bash
   npm start
   ```

   For development with auto-reload:
   ```bash
   npm run dev
   ```

## How It Works

### Legacy Mode (`USE_AGENCY=false`)

Three recurring workflows run on 5-minute intervals during market hours:

1. **Scanner** — fetches 5-min bars for watchlist symbols, computes EMA9/EMA21/RSI14/volume indicators, saves BUY/SELL signals to the database
2. **Executor** — fires on BUY signals, sizes positions (2% portfolio risk, 3% stop, 6% target), places market orders via Alpaca
3. **Monitor** — checks open positions against current prices, closes at stop-loss or take-profit, updates daily performance

### Agency Mode (`USE_AGENCY=true`)

A phased multi-agent cycle runs every 5 minutes during market hours:

```
Phase 0: Screener + Regime (parallel)
   ├── Screener: discovers dynamic watchlist from market movers
   └── Regime: classifies market as bull/bear/range/selloff/recovery

Phase 1: Analysis Agents (parallel)
   ├── Technical: multi-timeframe TA (5min, 15min, 1hr, daily)
   ├── Risk: portfolio heat, sector exposure, win rate assessment
   └── News: sentiment analysis + critical event detection

Phase 2: Orchestrator
   └── Claude synthesizes all reports into BUY/SELL/HOLD decisions

Phase 3: Execution Agent
   └── Final safety checks (risk veto, news alerts, regime bias) → place orders

Phase 4: Monitor
   └── Check open positions for stop/target exits
```

#### Agent Roles

| Agent | Model | Role |
|-------|-------|------|
| **Screener** | Haiku | Discovers tradeable symbols from most-active, gainers/losers; ranks by opportunity score |
| **Technical** | Haiku | Multi-timeframe pattern recognition (EMA, RSI, MACD, Bollinger, VWAP, support/resistance) |
| **Risk Manager** | Haiku | Portfolio guardian with **absolute veto power**; enforces daily loss cap, sector limits, portfolio heat |
| **Market Regime** | Haiku | Classifies market environment; adjusts stop/target/position sizing per regime |
| **News Sentinel** | Haiku | Monitors news sentiment; flags critical events that can block trades |
| **Orchestrator** | Sonnet | Synthesizes all agent reports into final decisions via Claude |
| **Execution** | None | Executes decisions after final risk/news/regime gate checks |

#### Decision Rules

- Risk Manager veto is absolute — overrides everything
- News critical alerts override technical signals
- Confidence must exceed 0.7 for action
- Max 3 BUY decisions per cycle
- Regime bias of "avoid" blocks all BUY signals

#### Inter-Agent Communication

Agents communicate via a message bus supporting SIGNAL, ALERT, VETO, REPORT, and DECISION message types. Messages are stored in-memory (circular buffer) and persisted to the database.

## Trading Rules

| Rule | Value |
|------|-------|
| Portfolio risk per trade | 2% (dynamically adjusted by risk agent) |
| Stop loss | 3% (regime-adjusted) |
| Take profit | 6% (regime-adjusted, 2:1 R:R) |
| Max single position | 10% of portfolio |
| Max portfolio heat | 20% capital at risk |
| Max per sector | 40% exposure, 2 positions |
| Daily loss cap | 4% triggers trading pause |
| Market hours | 9:35 AM - 3:50 PM ET |

## API Endpoints

### Status & Account

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/status` | App health, market open flag, last scan time |
| GET | `/api/account` | Live Alpaca account data |
| GET | `/api/positions` | Live open positions from Alpaca |

### Trades & Signals

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/trades` | All trades (`?status=open` supported) |
| GET | `/api/trades/:id` | Single trade detail |
| GET | `/api/signals` | Recent signals (`?limit=N`, default 50) |
| GET | `/api/performance` | Daily performance rows |

### Agent Status (Agency Mode)

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/agents` | All agents' status + LLM usage stats |
| GET | `/api/agents/risk/report` | Risk manager's latest report |
| GET | `/api/agents/risk/evaluate` | Test risk evaluation (`?symbol=AAPL&price=150`) |
| GET | `/api/agents/regime/report` | Regime classification + adjusted params |
| GET | `/api/agents/technical/report` | TA results for all symbols (`?symbol=AAPL` for one) |
| GET | `/api/agents/news/report` | News sentiment summary + critical alerts |
| GET | `/api/agents/news/sentiment/:symbol` | Sentiment for a specific symbol |
| GET | `/api/agents/screener/report` | Dynamic watchlist + candidates |
| GET | `/api/agents/orchestrator/report` | Latest orchestrator decisions |
| GET | `/api/agents/execution/fills` | Recent trade fills (`?limit=N`) |
| GET | `/api/agents/:name/reports` | Historical reports for a specific agent |

### Decisions

| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/decisions` | Recent decisions (`?limit=N`) |
| GET | `/api/decisions/:id` | Decision detail with full agent inputs |

## Database

Six PostgreSQL tables defined in `db/schema.sql` (auto-created on startup):

- **signals** — BUY/SELL signals from scanner
- **trades** — order executions with entry/exit, stop/target, P&L
- **daily_performance** — daily aggregate stats
- **agent_messages** — message bus history (agency mode)
- **agent_reports** — periodic reports from each agent (agency mode)
- **agent_decisions** — orchestrator decisions with reasoning (agency mode)

## Verifying It Works

1. **Logs** — on startup you should see:
   ```
   Database ready
   API server running on port 3001
   Alpaca Auto Trader running
   ```
   In agency mode, you'll also see each agent initializing and running its cycle.

2. **API health check**:
   ```bash
   curl http://localhost:3001/api/status
   ```

3. **Agent status** (agency mode):
   ```bash
   curl http://localhost:3001/api/agents
   ```

4. **Supabase** — check the `signals` table (legacy) or `agent_decisions` table (agency) after the first scan during market hours

5. **Alpaca dashboard** — paper orders appear at [app.alpaca.markets/paper/dashboard](https://app.alpaca.markets/paper/dashboard/overview)

## Switching to Live Trading

> **Warning:** Live trading uses real money. Thoroughly test with paper trading first.

1. Get live API keys from Alpaca
2. Update `.env`:
   ```
   ALPACA_API_KEY=live_key
   ALPACA_API_SECRET=live_secret
   ALPACA_BASE_URL=https://api.alpaca.markets
   ```
3. Restart the app

## LLM Cost Estimates (Agency Mode)

The system uses two Claude model tiers to balance cost and capability:

| Model | Used By | Approx Cost (per 1M tokens) |
|-------|---------|------------------------------|
| Claude Haiku | All analysis agents | $0.80 input / $4.00 output |
| Claude Sonnet | Orchestrator only | $3.00 input / $15.00 output |

Token usage is tracked per-agent and viewable at `/api/agents`.
