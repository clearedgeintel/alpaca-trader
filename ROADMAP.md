# 🗺️ Roadmap

## Project Vision

Alpaca Auto Trader is evolving from a reliable rule-based momentum bot into a robust, adaptive, AI-augmented trading system. The goal is to combine proven technical strategies with intelligent multi-agent orchestration — all while keeping risk management transparent, capital protection paramount, and paper-trading safety as the default. Every feature ships battle-tested against historical data before touching real capital.

---

## ✅ Current Status (April 2026)

The project has completed seven phases of development and is fully operational in both **Legacy** (rule-based) and **Agency** (AI-orchestrated) modes.

### What's Mature

| Area | Status | Details |
|------|--------|---------|
| **Core Trading Engine** | ✅ Production | Scanner → Executor → Monitor loop with 5-min cycles, market hours gating |
| **Multi-Agent System** | ✅ Production | 7 agents (Screener, Technical, Risk, Regime, News, Orchestrator, Execution) with message bus |
| **Risk Management** | ✅ Production | Position sizing, ATR trailing stops, bracket orders, drawdown breaker, correlation guard, sector limits |
| **Dashboard UI** | ✅ Production | 9-page React terminal (Dashboard, Agents, Decisions, Analytics, Timeline, Positions, Trades, Signals, Settings) |
| **API** | ✅ Production | 35+ REST endpoints with Swagger docs, rate limiting, optional auth |
| **Database** | ✅ Production | 6 PostgreSQL tables with versioned migrations, transaction support |
| **Infrastructure** | ✅ Ready | Docker, CI/CD, Railway/Fly.io configs, healthchecks |
| **Analytics** | ✅ Production | Backtesting engine, equity curves, Sharpe ratio, drawdown charts, CSV/tax-lot export |
| **LLM Integration** | ✅ Production | Claude Haiku + Sonnet with cost caps, circuit breaker, fallback to rules |

### Architecture Strengths

- Clean module separation — each file has a single responsibility
- Dual-mode design — legacy rules as fallback when AI is unavailable
- Paper trading by default with clear live-trading safeguards
- Real-time updates via Socket.io alongside polling
- Structured Winston logging with optional Slack/Telegram alerts

---

## 🛣️ Roadmap Phases

### Phase 1: Testing & Code Quality (Next 2–4 weeks)

The codebase is functional but has only 35 unit tests covering pure utility functions. Zero integration tests exist for the trading core, API endpoints, agent framework, or database operations.

| Item | Description | Benefit | Effort | Status |
|------|-------------|---------|--------|--------|
| **API integration tests** | Supertest tests for all 35+ endpoints (already installed, unused) | Catch regressions on every PR | Medium | Planned |
| **Agent framework tests** | Unit tests for orchestrator decisions, risk veto logic, message bus | Prevent silent agent failures | Medium | Planned |
| **Scanner/executor tests** | Mock Alpaca API, test signal → order → trade flow end-to-end | Protect the money path | Large | Planned |
| **ESLint + Prettier** | Add linting config, fix existing issues, add to CI | Consistent code style, catch bugs early | Small | Planned |
| **Jest configuration** | Proper `jest.config.js` with coverage thresholds, test groups | Track coverage gaps | Small | Planned |
| **Database operation tests** | Test transactions, migration runner, upsert edge cases | Prevent data corruption | Medium | Planned |
| **Input validation** | Add request validation middleware on POST/PUT endpoints | Prevent malformed data from reaching trading logic | Small | Planned |

**Target:** 70%+ code coverage on critical paths ([`src/executor.js`](src/executor.js), [`src/monitor.js`](src/monitor.js), [`src/agents/risk-agent.js`](src/agents/risk-agent.js), [`src/agents/orchestrator.js`](src/agents/orchestrator.js)).

---

### Phase 2: Strategy & Risk Enhancements (1–2 months)

Improve trade quality and adapt to more market conditions.

| Item | Description | Benefit | Effort | Status |
|------|-------------|---------|--------|--------|
| **Multi-timeframe confirmation** | Require signal alignment across 5min + 15min + 1hr before entry | Reduce false signals, improve win rate | Medium | Planned |
| **Volume profile analysis** | Add VWAP anchored zones, volume-at-price for better entry timing | More precise entries near support | Medium | Planned |
| **Sector rotation detection** | Track money flow between sectors, bias watchlist toward leading sectors | Catch sector momentum early | Medium | Planned |
| **Earnings calendar filter** | Skip or reduce sizing for symbols with upcoming earnings (via Alpaca calendar API) | Avoid gap risk on binary events | Small | Planned |
| **Intraday P&L limits** | Per-symbol max loss, auto-blacklist after repeated losses on same ticker | Prevent revenge trading on hostile names | Small | Planned |
| **Smart position scaling** | Scale into winners (add on confirmation) instead of all-in entries | Better average price on trending moves | Large | Planned |
| **Options-aware risk** | If multi-asset expands to options, calculate Greeks-based position risk | Proper risk measurement for derivatives | Large | Planned |

**Dependencies:** Phase 1 testing should cover the executor and monitor before modifying entry/exit logic.

---

### Phase 3: AI Agent Evolution (2–4 months)

Deepen the multi-agent system's intelligence and cost-efficiency.

| Item | Description | Benefit | Effort | Status |
|------|-------------|---------|--------|--------|
| **Agent confidence calibration** | Track each agent's historical accuracy, weight orchestrator votes accordingly | Better decisions from proven agents | Medium | Planned |
| **Prompt optimization** | A/B test agent prompts, measure decision quality vs cost | Reduce LLM spend by 30-50% without quality loss | Medium | Planned |
| **Prompt caching** | Cache repeated analysis prompts (same symbol, same timeframe within cycle) | Lower latency and cost | Small | Planned |
| **Explainability dashboard** | Show why each trade was taken/rejected with full agent vote breakdown | Build trust, aid debugging | Medium | Planned |
| **Sentiment trend tracking** | Track Reddit/news sentiment over time (not just snapshots) for momentum signals | Catch sentiment shifts before price moves | Medium | Planned |
| **Agent specialization** | Add dedicated agents for specific patterns (gap fills, mean reversion, breakouts) | Better signal quality per setup type | Large | Planned |
| **ML model improvement** | Expand feature set, add walk-forward validation, track live accuracy | Cheaper fallback that improves with data | Large | Planned |
| **Inter-agent debate** | Let agents challenge each other's reasoning before orchestrator decides | More robust decisions through adversarial review | Large | Planned |

**Dependencies:** Agent confidence calibration requires sufficient trade history (50+ closed trades recommended).

---

### Phase 4: Advanced Features & Production Readiness (3–6 months)

Bigger features for daily usability and operational confidence.

| Item | Description | Benefit | Effort | Status |
|------|-------------|---------|--------|--------|
| **Backtesting UI** | Visual strategy builder in dashboard — pick indicators, set params, run + compare backtests | Iterate on strategies without code changes | Large | Planned |
| **Watchlist manager** | Add/remove symbols from the UI, organize into groups, set per-symbol strategies | Faster reaction to market themes | Medium | Planned |
| **Alerting channels** | Discord webhook integration, email digests, push notifications | Stay informed without watching the dashboard | Medium | Planned |
| **Simulation mode** | Paper-trade with fake balance + historical replay for training | Safe experimentation with new strategies | Large | Planned |
| **Multi-strategy support** | Run multiple strategies concurrently (momentum + mean reversion + breakout) | Diversify alpha sources | Large | Planned |
| **Performance attribution** | Break down P&L by strategy, agent, time-of-day, day-of-week | Understand what actually makes money | Medium | Planned |
| **Database archival** | Auto-archive old signals/messages, add data retention policies | Prevent unbounded table growth | Small | Planned |
| **Graceful shutdown** | Handle SIGTERM properly — close positions or save state before exit | Prevent orphaned positions on deploy | Small | Planned |
| **Health monitoring** | Uptime checks, agent heartbeats, automatic restart on crash | Reduce unattended downtime | Medium | Planned |

**Dependencies:** Multi-strategy support depends on the hybrid strategy engine ([`src/strategy.js`](src/strategy.js)) already in place.

---

### 🔭 Future / Research Directions (Long-term)

Ambitious ideas for when the core is rock-solid and generating consistent returns.

| Item | Description | Potential Impact | Feasibility |
|------|-------------|-----------------|-------------|
| **Reinforcement learning** | Train an RL agent on backtest environments to learn optimal entry/exit timing | High — could discover non-obvious patterns | Experimental |
| **Live trading safeguards** | Gradual capital deployment (1% → 5% → 25%), automatic pause on anomalies | Critical for real money | High |
| **Cross-exchange arbitrage** | Monitor price discrepancies across exchanges for low-risk opportunities | Medium — needs fast execution | Moderate |
| **Alternative data sources** | SEC filings, insider trading reports, satellite data, credit card spending | High — unique alpha | Complex |
| **Mobile companion app** | Push notifications, quick position overview, emergency close-all button | High usability — traders are mobile | Large |
| **Strategy marketplace** | Share/import community strategies as JSON configs (foundation exists) | Community growth | Moderate |
| **TypeScript migration** | Gradual migration for type safety across the codebase | Fewer runtime bugs, better IDE support | Large |

---

## 🏗️ Completed Phases (v1.0 → v2.0)

<details>
<summary>Click to expand — 46 items shipped across 7 phases</summary>

### Phase A: Hardening & Reliability ✅
- API key authentication middleware
- PostgreSQL transaction safety (`db.withTransaction()`)
- LLM guardrails (cost cap, token cap, circuit breaker)
- Winston structured logging + Slack/Telegram alerts
- Express rate limiting (60 req/min)

### Phase B: Trading Improvements ✅
- Parallel scanner (batched `Promise.allSettled`)
- Dynamic watchlist from Alpaca screeners
- ATR-based trailing stops
- Bracket orders with market-order fallback
- Partial fill and rejection handling
- Alpaca WebSocket trade update stream

### Phase C: Analytics & Backtesting ✅
- Historical backtesting engine ([`src/backtest.js`](src/backtest.js))
- Portfolio analytics dashboard with equity curve, drawdown, Sharpe
- Agent decision timeline visualization
- CSV trade export and FIFO tax-lot reporting

### Phase D: Advanced Risk & Multi-Asset ✅
- Pearson correlation matrix ([`src/correlation.js`](src/correlation.js))
- Max drawdown circuit breaker (10% threshold)
- Multi-asset support — crypto, ETF, equity ([`src/asset-classes.js`](src/asset-classes.js))
- Hybrid strategy engine — rules/llm/hybrid per symbol ([`src/strategy.js`](src/strategy.js))

### Phase E: Infrastructure & Deployment ✅
- Docker + docker-compose (Node 18 Alpine + Postgres 16)
- GitHub Actions CI/CD (test → build → Docker)
- Jest test suite (35 tests)
- Railway + Fly.io deployment configs
- Versioned schema migrations ([`src/migrator.js`](src/migrator.js))

### Phase F: UX & Polish ✅
- Socket.io real-time updates ([`src/socket.js`](src/socket.js))
- Settings page with live strategy editing
- Paper-to-live trading mode indicator
- OpenAPI/Swagger docs at `/api/docs`
- Daily performance upsert fix

### Phase G: Expansion ✅
- Reddit sentiment integration ([`src/reddit.js`](src/reddit.js))
- TensorFlow.js ML fallback model ([`src/ml-model.js`](src/ml-model.js))
- Strategy config export/import (community sharing)
- Volume ratio calculation consistency fix

</details>

---

## 🐛 Known Issues

| Issue | Severity | Workaround |
|-------|----------|------------|
| `executeSignal` imports risk/regime agents in legacy mode | Low | Harmless tight coupling; no functional impact |
| Monitor race condition with multiple instances | Medium | Run single instance only (enforced by default) |
| Bracket order legs may not cancel on manual close | Medium | Use monitor-based exits; avoid manual closes during active trading |

---

## 🤝 How to Contribute

We welcome contributions! Here are the areas that need the most help:

### Good First Issues
- **Add ESLint + Prettier** — Configure linting and auto-formatting
- **Write API integration tests** — Supertest is installed but unused
- **Add input validation** — Express middleware for POST/PUT body validation
- **Improve error messages** — Make Alpaca API errors more user-friendly in the UI

### High-Impact Contributions
- **Agent framework tests** — Help test the orchestrator decision pipeline
- **Backtesting UI** — Build a visual strategy builder in the React dashboard
- **Mobile alerts** — Add push notification support via web push or Telegram

### Getting Started
1. Fork the repo and clone locally
2. Copy `.env.example` to `.env` and fill in your Alpaca paper-trading keys
3. Run `npm install && npm start`
4. Check the [README.md](README.md) for full setup instructions
5. Pick an item from the roadmap and open a PR!

---

## 📋 Notes

- **Paper trading is the default.** Live trading requires explicit configuration changes and is clearly warned against in the UI. Treat this as a learning and research tool first.
- **The roadmap is living.** Priorities shift based on market conditions, user feedback, and what we learn from running the system. Items may be reordered, split, or removed.
- **Effort estimates are rough.** "Small" = a few hours, "Medium" = a few days, "Large" = a week or more.
- **All AI features have fallbacks.** If the LLM is down, over budget, or slow, the system falls back to rule-based decisions automatically.

---

*Last updated: April 9, 2026*
*This roadmap is maintained alongside active development. Check the [commit history](../../commits/main) for the latest changes.*
