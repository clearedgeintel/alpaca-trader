# 🗺️ Roadmap

## Project Vision

Alpaca Auto Trader is evolving from a reliable rule-based momentum bot into a robust, adaptive, AI-augmented trading system. The goal is to combine proven technical strategies with intelligent multi-agent orchestration — all while keeping risk management transparent, capital protection paramount, and paper-trading safety as the default. Every feature ships battle-tested against historical data before touching real capital.

---

## ✅ Current Status (April 14, 2026)

Nine phases shipped. Legacy (rule-based) and Agency (AI-orchestrated) modes both fully operational. The April 13 sprint closed the highest-severity resilience and atomicity gaps; the April 14 sprint completed Phase 1 (testing & code quality) with 97 tests, lint gates, Zod validation, and coverage thresholds enforced in CI.

### What's Mature

| Area | Status | Details |
|------|--------|---------|
| **Core Trading Engine** | ✅ Production | Scanner → Executor → Monitor loop with 5-min cycles, market hours gating |
| **Multi-Agent System** | ✅ Production | 7 agents (Scout/Vega/Atlas/Quant/Herald/Nexus/Striker) with message bus |
| **Risk Management** | ✅ Production | ATR-based initial stops, ATR trailing stops, bracket orders, drawdown breaker, correlation guard, sector limits, per-asset-class params |
| **Dashboard UI** | ✅ Production | 10 pages (Dashboard, Market, Universe, Agents, Positions, Trades, Analytics, Signals, Chat, Settings) with real-time tickers + news feed |
| **API** | ✅ Production | 45+ REST endpoints with Swagger docs, rate limiting, optional auth |
| **Database** | ✅ Production | 7 PostgreSQL tables with versioned migrations; critical write paths wrapped in `db.withTransaction` |
| **Infrastructure** | ✅ Ready | Docker, CI/CD (tests gate build), Railway/Fly.io configs, healthchecks |
| **Analytics** | ✅ Production | Backtesting engine, equity curves, Sharpe ratio, drawdown charts, CSV/tax-lot export |
| **LLM Integration** | ✅ Production | Claude Haiku + Sonnet with cost caps, token caps, circuit breaker, retry-with-backoff, fallback to rules |
| **Real-time Streaming** | ✅ Production | Alpaca market-data WS (SPY/QQQ/IWM/DIA ticks + bars) and trade-update WS with exponential-backoff reconnect |
| **Resilience** | ✅ Production | Retry helper (exp backoff + jitter + Retry-After) on Alpaca REST + Anthropic SDK; WebSocket auto-reconnect with attempt counter reset on auth |
| **Atomicity** | ✅ Production | Signal + trade + decision-link writes wrapped in transactions; explicit "ORPHAN ORDER" logs when Alpaca succeeds but DB rollback |
| **Testing** | ✅ Production | Jest 30 + mock harness (alpaca, DB). 97 tests across 9 suites: indicators, strategy, correlation, asset-classes, orchestrator, risk-agent, message-bus, trade-lifecycle integration, API integration. Per-file coverage floors enforced in CI. |
| **Code Quality** | ✅ Production | ESLint flat-config gates CI (0 errors). Prettier available (`npm run format`). Zod validation on all POST/PUT endpoints via shared `validateBody` middleware. |
| **Agent Calibration** | ✅ Production | Orchestrator weights each agent's confidence by 30-day win rate from `agent_performance`; cold-start guard at 0.5 for sample < 10 |

### Architecture Strengths

- Clean module separation — each file has a single responsibility
- Dual-mode design — legacy rules as fallback when AI is unavailable
- Paper trading by default with clear live-trading safeguards
- Real-time updates via Socket.io alongside polling
- Structured Winston logging with optional Slack/Telegram alerts
- Transactional atomicity wherever multiple DB writes must succeed together
- Retry-with-backoff on every outbound dependency (Alpaca + Anthropic + WS)

---

## 🛣️ Roadmap Phases

### Phase 1: Testing & Code Quality — DONE (excluding TypeScript migration and legacy-executor tests, which are follow-ups)

Shipped April 13–14. 97 tests across 9 suites, 0 lint errors, per-file coverage floors enforced in CI.

| Item | Description | Benefit | Effort | Status |
|------|-------------|---------|--------|--------|
| **Integration test harness** | Mock factories for Alpaca + DB, withTransaction semantics with rollback | Foundation for all further tests | Medium | ✅ Done (Apr 13) |
| **Trade lifecycle tests** | Happy path BUY, retry behavior, transaction rollback | Proves atomicity + retry | Small | ✅ Done (Apr 13) |
| **npm test:coverage script** | `jest --coverage` wired in | Coverage visibility | Small | ✅ Done (Apr 13) |
| **API integration tests** | Supertest on status/account/positions/trades/signals/agents/chat + validation error paths | Catch regressions on every PR | Medium | ✅ Done (Apr 14) |
| **Agent framework tests** | 34 new unit tests: orchestrator fallback + calibration + weighting math; risk-agent sector/heat math; message bus publish/subscribe/history | Prevent silent agent failures | Medium | ✅ Done (Apr 14) |
| **ESLint + Prettier** | Flat config, Node + Jest globals, relaxed unused-var for `req/res/next/err`. Lint gates CI. | Consistent style, catch bugs early | Small | ✅ Done (Apr 14) |
| **Coverage thresholds** | Per-file floors enforced via `jest.config.js` `coverageThreshold` for execution-agent, orchestrator, risk-agent, message-bus, strategy, indicators, middleware/validate | Prevent coverage drift | Small | ✅ Done (Apr 14) |
| **Input validation** | Zod schemas on POST /api/chat, POST /api/backtest, POST /api/watchlist, PUT /api/strategies, PUT /api/runtime-config/:key, POST /api/config/import via shared `validateBody` middleware | Prevent malformed data reaching trading logic | Small | ✅ Done (Apr 14) |
| **Scanner/legacy executor tests** | Mock Alpaca, test legacy signal → order flow | Parity with agency-mode coverage | Medium | Planned (follow-up) |
| **Prettier-format the codebase** | One-time `npm run format` pass; then enable `format:check` in CI | Consistent formatting enforced | Small | Planned (follow-up) |
| **TypeScript migration** | Incremental migration starting with risk math, indicators, LLM schemas | Fewer runtime bugs, better IDE | Large | Planned (follow-up) |

---

### Phase 2: Strategy & Risk Enhancements — PARTIALLY DONE

ATR-scaled initial stops shipped April 13. The remaining items improve entry quality, event handling, and position-management nuance.

| Item | Description | Benefit | Effort | Status |
|------|-------------|---------|--------|--------|
| **ATR-based initial stops** | Stop % = clamp((daily ATR × 2.0)/entry, 2%, 8%). Target = stop × reward_ratio. Fallback: regime → fixed. | Volatile names get wider stops, quiet names tighter — better R:R per symbol | Medium | ✅ Done (Apr 13) |
| **Multi-timeframe confirmation** | Require signal alignment across 5min + 15min + 1hr before entry | Reduce false signals, improve win rate | Medium | Planned |
| **Volume profile analysis** | VWAP anchored zones, volume-at-price for entry timing | More precise entries near support | Medium | Planned |
| **Sector rotation detection** | Track money flow between sectors, bias watchlist toward leaders | Catch sector momentum early | Medium | Planned |
| **Earnings calendar filter** | Skip or reduce sizing for symbols with upcoming earnings | Avoid gap risk on binary events | Small | Planned |
| **Volatility targeting** | Size positions so portfolio realized vol stays near a target (e.g. 15% annualized) | Smoother equity curve | Medium | Planned |
| **Kelly / optimal-f sizing** | Replace fixed 2% risk with Kelly fraction scaled by historical edge | Optimal long-term growth when edge is real | Large | Planned |
| **Intraday P&L limits** | Per-symbol max loss, auto-blacklist after repeated losses on same ticker | Prevent revenge trading | Small | Planned |
| **Smart position scaling** | Scale into winners on confirmation | Better average price on trending moves | Large | Planned |
| **Options-aware risk** | Greeks-based position risk for derivatives | Proper risk measurement if expanding to options | Large | Future |

**Dependencies:** Multi-timeframe confirmation and volatility targeting should land after Phase 1 scanner/executor tests so regressions surface immediately.

---

### Phase 3: AI Agent Evolution — PARTIALLY DONE

Agent calibration shipped April 13. Prompt caching deferred pending prompt-length expansion. Remaining items deepen the system's intelligence and cost-efficiency.

| Item | Description | Benefit | Effort | Status |
|------|-------------|---------|--------|--------|
| **Agent confidence calibration** | 30-day win rate per agent from `agent_performance`, used to scale reported confidence `adjusted = reported × (winRate × 0.7 + 0.3)`. Cold-start floor at 0.5 when sample < 10. Weights injected into user message (not system prompt) so future caching stays compatible. | Better decisions favoring proven agents | Medium | ✅ Done (Apr 13) |
| **Calibration UI panel** | Agent page shows each persona's effective weight bar and sample size | Transparency into orchestrator's trust model | Small | ✅ Done (Apr 13) |
| **Prompt caching** | Pass system prompt as `cache_control: ephemeral` block. **Deferred**: individual prompts sit below the 1024-token cache minimum. Needs a prompt-expansion pass first (shared preamble for tone/format/safety rails). | 30–40% input-token savings on hot paths | Medium | Deferred |
| **Explainability dashboard** | TradeDrawer already shows agent inputs; extend to show pre/post-calibration confidence and which weight tipped the decision | Build trust, aid debugging | Small | Planned |
| **Prompt versioning + A/B testing** | Track prompt templates in DB, run paired prompts on same data, compare decision quality | Systematic prompt improvement | Medium | Planned |
| **Sentiment trend tracking** | Track Reddit/news sentiment over time (not just snapshots) | Catch sentiment shifts before price moves | Medium | Planned |
| **Agent specialization** | Dedicated agents for gap fills, mean reversion, breakouts | Better signal quality per setup type | Large | Planned |
| **ML model improvement** | Expand feature set, walk-forward validation, track live accuracy | Cheaper fallback that improves with data | Large | Planned |
| **Inter-agent debate** | Let agents challenge each other's reasoning before orchestrator decides | More robust decisions via adversarial review | Large | Planned |
| **Prompt length expansion** | Add shared preamble (tone, format, safety) to each agent prompt so they cross the 1024-token caching threshold | Unblocks prompt caching | Small | Planned (prereq for caching) |

**Dependencies:** Calibration grows more reliable as trade history accumulates — expect noticeable orchestrator behavior changes after ~50 closed trades per agent.

---

### Phase 4: Production Readiness & Reliability — PARTIALLY DONE

Retries + atomicity + backoff reconnection shipped April 13. The remaining items close the loop on observability, reconciliation, and scale.

| Item | Description | Benefit | Effort | Status |
|------|-------------|---------|--------|--------|
| **Retry-with-backoff helper** | Shared `retryWithBackoff` with exp + full jitter + Retry-After header parsing. Applied to Alpaca REST (429/5xx/network) and Anthropic SDK (typed errors). Circuit breaker increments only once per user-visible failure, not per retry. | No more silent outages from transient failures | Medium | ✅ Done (Apr 13) |
| **DB transaction wrapping** | `execution-agent` BUY/SELL signal+trade+decision-link writes inside `db.withTransaction`. Alpaca order stays outside — rollback can't un-place an order. Explicit "ORPHAN ORDER" logs for reconciliation when DB fails after Alpaca succeeds. | No more orphaned signals or partial trade records | Medium | ✅ Done (Apr 13) |
| **WebSocket reconnect backoff** | Exponential backoff 1s → 60s with jitter; counter resets on successful auth | Prevents reconnect storms, handles extended outages gracefully | Small | ✅ Done (Apr 13) |
| **LLM throttle banner** | Dashboard shows when agents are throttled with current utilization + cap reason | Prevents silent multi-hour outages like the one on Apr 10 | Small | ✅ Done |
| **Nightly reconciliation job** | Cron job compares Alpaca positions/orders vs DB `trades`; flags orphans from crashes or DB rollbacks; optionally auto-closes or auto-inserts missing records | Catches the rare orphan case automatically instead of requiring human log inspection | Medium | Planned |
| **Partial-fill DB persistence** | Alpaca WS already detects `partial_fill` events; wire into DB updates so qty/entry_price are tracked across fills | Accurate position tracking on partial fills | Small | Planned |
| **Structured JSON logs + correlation IDs** | Replace plain Winston text with JSON lines; include a cycle_id/trade_id across log entries for traceability | Much faster incident forensics | Medium | Planned |
| **Prometheus metrics + Grafana** | Expose cycle latency, LLM cost, agent errors, position count as `/metrics` endpoint | Production-grade observability | Medium | Planned |
| **Graceful shutdown** | Handle SIGTERM — complete in-flight cycles, flush logs, release DB pool before exit | Prevent orphaned positions on deploy | Small | Planned |
| **Health monitoring** | Uptime checks, agent heartbeats, automatic restart on crash, alert on heartbeat stall | Reduce unattended downtime | Medium | Planned |
| **Secrets rotation** | Move from `.env` to Vault or platform-native secrets; document rotation procedure | Security hardening for live trading | Medium | Planned |
| **Database archival** | Auto-archive old signals/messages; retention policies | Prevent unbounded table growth | Small | Planned |

---

### Phase 5: Advanced Features & UX

| Item | Description | Benefit | Effort | Status |
|------|-------------|---------|--------|--------|
| **Backtesting UI** | Visual strategy builder — pick indicators, set params, run + compare backtests | Iterate on strategies without code changes | Large | Planned |
| **Walk-forward optimization** | Split historical data into rolling train/test windows to validate strategy robustness | Detect over-fitting before live | Medium | Planned |
| **Monte Carlo simulation** | Randomize trade order / fill prices / slippage over historical outcomes | Confidence intervals on expected return | Medium | Planned |
| **Slippage + fee modeling** | Add realistic slippage and commission models to backtester | More honest historical P&L | Small | Planned |
| **Replay mode** | Historical replay with fake balance — run live agents against old bars | Safe strategy experimentation | Large | Planned |
| **Alerting channels** | Discord webhook integration, email digests, push notifications | Stay informed without watching the dashboard | Medium | Planned |
| **Multi-strategy support** | Concurrent momentum + mean-reversion + breakout with portfolio-level optimization | Diversify alpha sources | Large | Planned |
| **Performance attribution** | Break down P&L by strategy, agent, regime, time-of-day, sector | Understand what actually makes money | Medium | Planned |
| **Smart Order Routing** | Support limit orders, TWAP/VWAP algos, better fill modeling | Improved execution quality | Large | Planned |
| **Watchlist editor UI** | Add/remove symbols visually, organize into groups, set per-symbol strategies | Faster reaction to themes | Medium | Partial (runtime-config works via chat; needs UI) |

---

### 🔭 Future / Research Directions

| Item | Description | Potential Impact | Feasibility |
|------|-------------|-----------------|-------------|
| **Reinforcement learning** | Train RL agent on backtest envs to learn entry/exit timing | High — could discover non-obvious patterns | Experimental |
| **Portfolio optimization** | Mean-variance, risk-parity, or Black-Litterman across multiple assets/strategies | High — institutional-grade sizing | Moderate |
| **Gradual live deployment** | Ramp 1% → 5% → 25% of capital with automatic pause on anomalies | Critical for real money | High |
| **Cross-exchange arbitrage** | Monitor price discrepancies for low-risk opportunities | Medium — needs fast execution | Moderate |
| **Alternative data** | SEC filings, insider trading reports, satellite imagery, credit-card spending | High — unique alpha | Complex |
| **Ensemble LLMs** | Mix multiple Claude variants + open-source models for cost/resilience | Medium — lower vendor risk | Moderate |
| **Mobile companion app** | Push notifications, position overview, emergency close-all | High usability — traders are mobile | Large |
| **Strategy marketplace** | Share/import community strategies as JSON configs | Community growth | Moderate |
| **Federated backtest** | Run backtests against ensemble of user-submitted data | Bigger sample for robust strategies | Complex |

---

## 🏗️ Completed Phases

<details>
<summary>Click to expand — 65+ items shipped across 10 phases</summary>

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
- Jest test suite (38 tests, 5 suites)
- Railway + Fly.io deployment configs
- Versioned schema migrations ([`src/migrator.js`](src/migrator.js))

### Phase F: UX & Polish ✅
- Socket.io real-time updates ([`src/socket.js`](src/socket.js))
- Settings page with live strategy editing + expandable Agent Decision Logs
- Paper-to-live trading mode indicator
- OpenAPI/Swagger docs at `/api/docs`
- Daily performance upsert fix
- Runtime config hot-reload (RISK_PCT, STOP_PCT, TARGET_PCT, WATCHLIST, etc.)

### Phase G: Expansion ✅
- Reddit sentiment integration ([`src/reddit.js`](src/reddit.js))
- TensorFlow.js ML fallback model ([`src/ml-model.js`](src/ml-model.js))
- Strategy config export/import (community sharing)
- Alpaca MCP server connected for conversational portfolio queries

### Phase H: Agent Agency + Observability ✅
- 7-agent personas (Scout, Vega, Atlas, Quant, Herald, Nexus, Striker) with colored avatars
- Orchestrator synthesis (Sonnet) with rule-based fallback when LLM unavailable
- Live agent activity feed with pause/resume on `/agents` page
- Dashboard market tickers (SPY/QQQ/IWM/DIA) with flash on price changes
- News feed widget with thumbnails, clickable articles
- Market page with TradingView-style candlestick chart ([`src/views/MarketView.jsx`](trader-ui/src/views/MarketView.jsx))
- Universe page showing all discovery sources with counts
- TradeDrawer with decision timeline, sell-reason badges, per-agent input breakdown
- Chat assistant with tool-use loop, 19 tools, session memory, config get/update/reset tools

### Phase J: Testing + Code Quality Sprint (April 14, 2026) ✅
- **Agent framework tests (34 new)**: orchestrator `_fallbackDecisions` filtering + confidence discount, calibration weighting math, `getAgentCalibration` normalization and error paths; risk-agent `_calcSectorExposure` and `_calcPortfolioHeat` math; message bus publish/subscribe/history/wildcard/DB-failure isolation
- **Supertest API integration tests (25)**: GET status/account/positions/trades/signals/agents/market-tickers/calibration; POST /api/chat success + validation failures; PUT strategies/runtime-config with Zod validation; POST watchlist + backtest validation
- **Zod validation middleware** (`src/middleware/validate.js`): shared `validateBody(schema)` factory + pre-built schemas for chat, backtest, watchlist-add, strategy, runtime-config-set, config-import. Returns structured `{ issues: [{path, message, code}] }` on failure. Replaces scattered `if (!field)` checks across 6 endpoints.
- **ESLint flat config** (`eslint.config.js`): Node + Jest globals, relaxed unused-var for `req/res/next/err`, `no-var`/`prefer-const`/`eqeqeq`, 0 errors across src and tests. Wired into CI.
- **Prettier config** (`.prettierrc.json` + `.prettierignore`): 100-col width, single-quotes, ES5 trailing commas. `npm run format` available as a dev tool.
- **Coverage thresholds** (`jest.config.js`): per-file floors enforced in CI for execution-agent (70%), orchestrator (28%), risk-agent (20%), message-bus (90%+), strategy (90%), indicators (70%), middleware/validate (95%). Cannot be lowered without breaking CI.
- **CI upgrades**: `npm run lint` + `npm run test:coverage` now gate every push and PR.
- **Result**: 97 tests across 9 suites (up from 38/5); 0 lint errors.

### Phase I: Resilience + Atomicity Sprint (April 13, 2026) ✅
- Retry-with-backoff helper ([`src/util/retry.js`](src/util/retry.js)) with full jitter and Retry-After parsing
- Alpaca REST retries 429/5xx/network errors up to 4 times
- Anthropic SDK retries typed errors before circuit-breaker increment
- WebSocket reconnect with exponential backoff + attempt reset on auth
- DB transactions wrap signal + trade + decision writes in `execution-agent` BUY/SELL
- Explicit "ORPHAN ORDER" / "ORPHAN SELL" / "ORPHAN CLOSE" logs when Alpaca succeeds but DB rolls back
- ATR-based initial stop sizing with 2–8% clamp (replaces fixed 3%)
- Target % derived from stop × REWARD_RATIO to preserve R:R
- Integration test harness: tests/mocks/alpaca.js, tests/mocks/db.js
- 3 integration tests: happy path BUY, retry recovery, transaction rollback
- Orchestrator weights agent confidences by 30-day win rate from `agent_performance`
- `/api/agents/calibration` endpoint + AgentsView calibration panel
- LLM throttle banner on dashboard when token/cost caps hit or breaker open
- Enriched trade detail view with full decision history

</details>

---

## 🐛 Known Issues

| Issue | Severity | Workaround / Next Step |
|-------|----------|------------------------|
| Monitor race condition with multiple instances | Medium | Run single instance only (enforced by default) |
| Bracket order legs may not cancel on manual close | Medium | Use monitor-based exits; avoid manual closes during active trading |
| Orphaned Alpaca orders possible if DB fails after `placeOrder` | Low | Logged as "ORPHAN ORDER" with `alpaca_order_id`; nightly reconciliation job planned in Phase 4 |
| Prompt caching not yet enabled | Low | Individual prompts under 1024-token cache minimum; blocked on prompt-expansion (Phase 3) |
| `agent_performance` populated by separate aggregator | Low | Until it has ≥10 samples per agent, calibration falls back to 0.5 neutral weight — system still works |

---

## 🤝 How to Contribute

### Good First Issues
- **ESLint + Prettier** — configure linting and auto-formatting
- **API integration tests** — Supertest is installed but endpoints are still uncovered
- **Input validation** — Express middleware for POST/PUT body validation via Zod/Joi
- **Partial-fill DB persistence** — wire the existing Alpaca WS partial-fill event into `trades` updates

### High-Impact Contributions
- **Agent framework tests** — orchestrator synthesis paths, risk veto logic, message bus
- **Nightly reconciliation job** — compare Alpaca positions/orders vs `trades` table, flag orphans
- **Backtesting UI** — visual strategy builder in React dashboard
- **Walk-forward optimization + slippage modeling** — more honest backtest P&L
- **Structured JSON logs + correlation IDs** — production-grade traceability

### Getting Started
1. Fork the repo and clone locally
2. Copy `.env.example` to `.env` and fill in Alpaca paper keys + `ANTHROPIC_API_KEY`
3. `npm install && npm start` and in another terminal `cd trader-ui && npm run dev`
4. Pick an item from the roadmap and open a PR

---

## 📋 Notes

- **Paper trading is the default.** Live trading requires explicit configuration changes and is clearly warned against in the UI.
- **The roadmap is living.** Priorities shift based on market conditions, user feedback, and incident learnings.
- **Effort estimates are rough.** Small = a few hours; Medium = a few days; Large = a week or more.
- **All AI features have fallbacks.** LLM unavailable → rule-based decisions automatically.
- **Recent incidents inform priority.** The April 10 silent token-cap outage motivated the April 13 resilience sprint; the `crypto is not defined` agent error motivated the integration test harness. Real failures keep moving items up this list.

---

*Last updated: April 14, 2026 — after the testing + code-quality sprint that closed Phase 1*
*Maintained alongside active development. Check [commit history](../../commits/main) for latest changes.*
