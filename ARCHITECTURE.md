# Architecture

## System Overview

Alpaca Auto Trader runs in one of two modes, selected by `USE_AGENCY` in `.env`:

```
                        ┌──────────────┐
                        │   index.js   │
                        │  (entry pt)  │
                        └──────┬───────┘
                               │
                    ┌──────────┴──────────┐
                    │                     │
              USE_AGENCY=false       USE_AGENCY=true
                    │                     │
            ┌───────▼───────┐    ┌────────▼────────┐
            │  Legacy Mode  │    │  Agency Mode     │
            │  (rule-based) │    │  (AI-orchestrated)│
            └───────────────┘    └──────────────────┘
```

Both modes share: database, API server, Socket.io, Alpaca WebSocket stream, and the monitor.

---

## Legacy Mode

Simple sequential loop every 5 minutes during market hours:

```
Scanner (buildWatchlist → fetchBars → detectSignal)
    │
    ├── Signal = NONE → skip
    │
    └── Signal = BUY/SELL → [Transaction]
            │
            ├── INSERT into signals table
            └── Executor
                    ├── Risk agent evaluate() → VETO?
                    ├── Regime agent getParams() → adjust sizing
                    ├── Asset class → per-class risk params
                    ├── Place bracket order (or market fallback)
                    ├── Poll order status (partial fills, rejects)
                    └── INSERT into trades table

Monitor (every 5 min)
    │
    ├── Check trailing stop (ATR-based, only moves up)
    ├── Partial exit at 50% target → sell half, stop to breakeven
    ├── Full exit at stop/target → close position
    └── Update daily_performance
```

---

## Agency Mode

Phased multi-agent cycle every 5 minutes:

```
Phase 0 ─── Parallel ──────────────────────────────────
│                                                       │
│   Screener Agent                  Regime Agent        │
│   ├── Alpaca most-active (40)     ├── SPY/QQQ daily   │
│   ├── Top gainers/losers (30)     ├── EMA 20/50/200   │
│   ├── Filter by price/vol/%       ├── RSI, VIX proxy  │
│   ├── LLM ranks candidates        ├── Breadth calc    │
│   └── Output: 15-25 symbols      ├── Intraday bounce  │
│                                   └── Output: regime   │
─────────────────────────────────────────────────────────

Phase 1 ─── Parallel (using screener's watchlist) ──────
│                                                       │
│   Technical Agent    Risk Agent       News Agent      │
│   ├── Multi-TF bars  ├── Open trades  ├── Alpaca news │
│   ├── EMA/RSI/MACD   ├── Daily P&L    ├── Reddit buzz │
│   ├── Bollinger/VWAP  ├── Sector exp   ├── LLM scores │
│   ├── Support/Resist  ├── Portfolio    ├── Alerts      │
│   ├── LLM interprets  │   heat         └── Sentiment  │
│   └── Per-symbol sig  ├── Correlation                 │
│                       └── Drawdown check              │
─────────────────────────────────────────────────────────

Phase 2 ─── Orchestrator ──────────────────────────────
│                                                       │
│   Collects all agent reports                          │
│   ├── Claude Sonnet synthesizes decisions             │
│   ├── Rules: risk veto absolute, news overrides TA   │
│   ├── Confidence > 0.7 required                      │
│   ├── Max 3 BUY per cycle                            │
│   ├── Dedup: one decision per symbol per day          │
│   └── Output: BUY/SELL decisions                      │
─────────────────────────────────────────────────────────

Phase 3 ─── Execution Agent ───────────────────────────
│                                                       │
│   For each decision:                                  │
│   ├── News critical alert check → BLOCK               │
│   ├── Risk agent evaluate() → VETO gate               │
│   ├── Regime bias check → BLOCK if avoid              │
│   ├── Asset-class risk params → sizing                │
│   ├── Place order → Alpaca                            │
│   ├── INSERT signal + trade (linked)                  │
│   └── Link decision → signal for timeline             │
─────────────────────────────────────────────────────────

Phase 4 ─── Monitor (same as legacy) ─────────────────
```

---

## Agent Message Bus

Agents communicate via a pub/sub message bus (`src/agents/message-bus.js`):

```
Message Types:
  SIGNAL   ── Agent detected a trading signal
  ALERT    ── Critical event (breaking news, earnings)
  VETO     ── Risk agent blocks a trade
  REPORT   ── Periodic analysis report
  DECISION ── Orchestrator final decision

Flow:
  Agent.run() → analyze() → messageBus.publish(type, agentName, payload)
                                    │
                          ┌─────────┴─────────┐
                          │                   │
                    In-memory buffer     DB persist
                    (500 messages)    (agent_messages)
                          │
                    Subscribers notified
```

### Agent Hierarchy

```
                    ┌─────────────────┐
                    │  Orchestrator   │  (Claude Sonnet)
                    │  Final arbiter  │
                    └────────┬────────┘
                             │ collects reports from
           ┌─────────┬──────┴──────┬──────────┐
           │         │             │           │
      ┌────▼───┐ ┌───▼────┐ ┌─────▼────┐ ┌────▼────┐
      │Technical│ │  Risk  │ │  News    │ │ Regime  │
      │  Agent  │ │ Agent  │ │ Sentinel │ │ Agent   │
      │(Haiku) │ │(Haiku) │ │(Haiku)  │ │(Haiku) │
      └────────┘ └───┬────┘ └──────────┘ └─────────┘
                     │
               ABSOLUTE VETO
              (cannot be overridden)
```

---

## Database Schema

```
signals ◄──── trades (signal_id FK)
                 │
                 └──── agent_decisions (signal_id FK, trade_id FK)

agent_messages   (message bus history)
agent_reports    (per-agent periodic reports)
daily_performance (daily P&L aggregates)
runtime_config   (hot-reloadable settings)
schema_migrations (migration version tracking)
```

See `db/schema.sql` for full DDL. Migrations in `db/migrations/`.

---

## LLM Integration

```
src/agents/llm.js
│
├── Two model tiers:
│   ├── Haiku  (fast)     — per-symbol analysis, screener, regime, news
│   └── Sonnet (standard) — orchestrator synthesis only
│
├── Guardrails:
│   ├── Daily cost cap ($5 default)
│   ├── Daily token cap (500k default)
│   ├── Circuit breaker (3 failures → 5min cooldown)
│   └── isAvailable() check before every call
│
├── Fallback:
│   └── Orchestrator uses rule-based signal passthrough when LLM unavailable
│
└── Debug log:
    └── Last 50 calls stored with prompt/response (GET /api/agents/debug)
```

---

## Risk Controls (Defense in Depth)

```
Layer 1: Risk Agent evaluate()
    ├── Daily loss cap (4%)
    ├── Portfolio heat cap (20%)
    ├── Sector concentration (40% / 2 positions)
    ├── Correlation guard (0.85 threshold)
    └── Dynamic sizing (scale with win rate)

Layer 2: Drawdown Circuit Breaker
    └── 10% from peak → pause all trading until next day

Layer 3: Regime Bias
    ├── trending_bear → short_only (0.3x scale)
    ├── bear_bounce → selective_long (0.4x scale)
    ├── high_vol_selloff → defensive (0.3x scale)
    └── Intraday bounce override when SPY +0.5%

Layer 4: Execution Gates
    ├── News critical alert → BLOCK
    ├── Regime bias → BLOCK if avoid
    └── Funds check (95% of buying power)

Layer 5: Position Management
    ├── Bracket orders (stop + target on entry)
    ├── ATR trailing stop (only moves up)
    ├── Partial exit at 50% of target
    └── Monitor polls every 5 min + WebSocket real-time
```

---

## Frontend Architecture

```
trader-ui/
├── src/
│   ├── App.jsx              ← Router (9 routes)
│   ├── api/client.js        ← Fetch wrapper for all API calls
│   ├── hooks/
│   │   ├── useQueries.js    ← React Query hooks (auto-polling)
│   │   └── useSocket.js     ← Socket.io → cache invalidation
│   ├── views/               ← 9 page components
│   └── components/
│       ├── layout/          ← Sidebar, TopBar
│       ├── dashboard/       ← PortfolioChart, ActivityFeed
│       ├── shared/          ← Badge, StatCard, PnlCell, etc.
│       └── (tables)         ← Positions, Trades, Signals tables

Data flow:
  Socket.io event → useSocket invalidates query → React Query refetches → UI updates
  (fallback: React Query polls on interval if socket disconnects)
```

---

## Configuration Layers

```
Priority (highest to lowest):
  1. Runtime config (DB: runtime_config table, hot-reloaded every 30s)
  2. Environment variables (.env)
  3. Static defaults (src/config.js, frozen object)

Configurable at runtime via API:
  RISK_PCT, STOP_PCT, TARGET_PCT, MAX_POS_PCT, TRAILING_ATR_MULT,
  PARTIAL_EXIT_PCT, PARTIAL_EXIT_TRIGGER, MAX_DRAWDOWN_PCT,
  CORRELATION_THRESHOLD, SCAN_INTERVAL_MS, WATCHLIST
```

---

## Key File Map

| File | LOC | Role |
|------|-----|------|
| `src/index.js` | 200 | Entry point, mode dispatch, scheduling |
| `src/server.js` | 770 | Express API (35+ endpoints) + Socket.io |
| `src/scanner.js` | 160 | Dynamic watchlist + parallel signal detection |
| `src/executor.js` | 140 | Position sizing, bracket orders, fill verification |
| `src/monitor.js` | 150 | Trailing stops, partial exits, stop/target exits |
| `src/indicators.js` | 290 | EMA, RSI, ATR, MACD, Bollinger, VWAP, S/R |
| `src/agents/orchestrator.js` | 240 | LLM synthesis of all agent reports |
| `src/agents/risk-agent.js` | 360 | Portfolio guardian, veto power |
| `src/agents/llm.js` | 220 | Claude SDK wrapper, cost/token tracking |
| `src/backtest.js` | 200 | Historical simulation engine |

---

*Last updated: April 2026*
