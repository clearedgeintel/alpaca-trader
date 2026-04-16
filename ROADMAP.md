# 🗺️ Roadmap

## Project Vision

Alpaca Auto Trader is evolving from a reliable rule-based momentum bot into a robust, adaptive, AI-augmented trading system. The goal is to combine proven technical strategies with intelligent multi-agent orchestration — all while keeping risk management transparent, capital protection paramount, and paper-trading safety as the default. Every feature ships battle-tested against historical data before touching real capital.

---

## ✅ Current Status (April 15, 2026)

Twenty-eight phases shipped. Legacy (rule-based) and Agency (AI-orchestrated) modes both fully operational. April 13 closed resilience + atomicity gaps; April 14 closed Phases 1 (testing + quality), 4 (operability), 3 (prompt caching + versioning), 2 (strategy edge), 5 (backtesting validation), multi-channel alerting + daily digest, and rule-based replay mode. April 15 was a marathon — shipped hot-reload runtime config, datasource registry + Polygon enrichment, MarketView VWAP + volume profile, TradeDrawer explainability + tipping-agent highlight, sector rotation detection, prompt A/B performance framework, Prometheus /metrics endpoint, sentiment trend tracking with inflection alerts, scanner + executor test suites, a full Prettier format pass (now CI-enforced), Phase 4 ops cleanup (nightly DB archiver + secrets rotation runbook), and strategy-override persistence with bulk import/export polish. Currently: 345 tests across 32 suites, 0 lint errors, 0 format drift, coverage thresholds enforced in CI, live prompt caching confirmed (10x cost reduction).

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

### Phase 1: Testing & Code Quality — DONE (excluding TypeScript migration, which is a dedicated follow-up sprint)

Shipped April 13–15. 247 tests across 24 suites, 0 lint errors, Prettier format:check enforced in CI, per-file coverage floors enforced in CI.

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
| **Scanner/legacy executor tests** | 18 new tests across `tests/scanner.test.js` (9) + `tests/executor.test.js` (9): watchlist merge + dedupe + price-band filter, llm-only skip, insufficient-bars skip, BUY → executor forwarding inside transaction, partial-failure resilience; executor happy path, bracket fallback to market, ATR fetch failure, insufficient funds, risk veto, regime avoid, non-BUY skip, existing-position skip, rejected orders. Extended db-mock to handle executor's 15-col INSERT variant. | Parity with agency-mode coverage | Medium | ✅ Done (Apr 15) |
| **Prettier-format the codebase** | `.prettierrc` added (semi, single-quote, 120 width, trailing commas); one-time format pass across 29 files; `format:check` now a gate in CI alongside lint. | Consistent formatting enforced | Small | ✅ Done (Apr 15) |
| **TypeScript migration** | Incremental migration starting with risk math, indicators, LLM schemas | Fewer runtime bugs, better IDE | Large | Planned (follow-up — dedicated multi-week sprint) |

---

### Phase 2: Strategy & Risk Enhancements — PARTIALLY DONE

ATR-scaled stops, multi-timeframe alignment enforcement, earnings filter, per-symbol P&L guards, and volatility targeting all shipped. Kelly sizing, smart scaling, volume profile, and sector rotation remain as larger follow-ups.

| Item | Description | Benefit | Effort | Status |
|------|-------------|---------|--------|--------|
| **ATR-based initial stops** | Stop % = clamp((daily ATR × 2.0)/entry, 2%, 8%). Target = stop × reward_ratio. Fallback: regime → fixed. | Volatile names get wider stops, quiet names tighter — better R:R per symbol | Medium | ✅ Done (Apr 13) |
| **Multi-timeframe alignment enforcement** | Technical agent now emits explicit `mtfAlignment` (0.0–1.0) = fraction of available timeframes whose EMA trend matches the signal. Confidence is dampened when alignment < 0.5. Orchestrator fallback path hard-filters trades with alignment < 0.5. | Reduce false signals, improve win rate | Medium | ✅ Done (Apr 14) |
| **Earnings calendar filter** | `src/earnings.js` with static calendar + runtime-config overrides + news-keyword fallback heuristic. Mode: block, reduce (50% size, default), or ignore via `EARNINGS_MODE` env. Execution agent gates BUY flow before sizing. | Avoid gap risk on binary events | Small | ✅ Done (Apr 14) |
| **Intraday P&L limits** | `src/symbol-blacklist.js` — per-symbol day-loss cap (1.5% of portfolio, configurable) and consecutive-loss blacklist (3 losers in a row, configurable). Cheap DB read in the BUY hot path; fails open on DB error. | Prevent revenge trading on hostile names | Small | ✅ Done (Apr 14) |
| **Volatility targeting** | Position-size multiplier = clamp(VOL_TARGET_ATR_PCT / (ATR/price), 0.4, 1.5). Sleepy ETFs get up-sized, meme stocks get down-sized so portfolio realized vol stays nearer to a target. Opt-out via `VOL_TARGET_ENABLED=false`. | Smoother equity curve | Medium | ✅ Done (Apr 14) |
| **Volume profile + VWAP overlays** | VWAP line (session-anchored intraday / cumulative daily) + volume-at-price histogram overlay in MarketView. Toggleable via VWAP/VP buttons. | More precise entries near support | Medium | ✅ Done (Apr 15) |
| **Sector rotation detection** | Per-sector N-day returns via Polygon `sic_description` + Alpaca bars; leaders/laggards fed into orchestrator context; Dashboard card + `/api/sectors/rotation`. | Catch sector momentum early | Medium | ✅ Done (Apr 15) |
| **Kelly / optimal-f sizing** | Per-symbol half-Kelly multiplier from closed-trade win-rate + win/loss ratio. Clamped [0.5×, 2.0×] of base RISK_PCT. `KELLY_ENABLED` flag keeps it in "suggestion only" mode until operator flips it on from Agents panel. Cold-start (<20 trades) collapses to 1.0×. | Optimal long-term growth when edge is real | Large | ✅ Done (Apr 15, opt-in) |
| **Smart position scaling** | Add to winning positions when profit exceeds N×ATR. `SCALE_IN_ENABLED` flag (default off), stepwise triggers so each successive add-on requires a higher price, stop moved to breakeven on first scale-in, addQty = 50% of original, capped by MAX_POS_PCT, mutually exclusive with partial-exit. | Better average price on trending moves | Large | ✅ Done (Apr 15, opt-in) |
| **Options-aware risk** | Greeks-based position risk for derivatives | Proper risk measurement if expanding to options | Large | Future |

**Notes:** The earnings calendar is hardcoded; quarterly refresh required. Upgrade path is Finnhub or IEX feeds when we're ready to pay for API access.

---

### Phase 3: AI Agent Evolution — PARTIALLY DONE

Calibration, prompt caching (with preamble expansion to cross Haiku's 4096-token minimum), decision explainability snapshot, and prompt versioning all shipped. Agent specialization, ML improvement, and inter-agent debate remain as larger future sprints.

| Item | Description | Benefit | Effort | Status |
|------|-------------|---------|--------|--------|
| **Agent confidence calibration** | 30-day win rate per agent from `agent_performance`, used to scale reported confidence `adjusted = reported × (winRate × 0.7 + 0.3)`. Cold-start floor at 0.5 when sample < 10. Weights injected into user message (not system prompt) so caching stays compatible. | Better decisions favoring proven agents | Medium | ✅ Done (Apr 13) |
| **Calibration UI panel** | Agent page shows each persona's effective weight bar and sample size | Transparency into orchestrator's trust model | Small | ✅ Done (Apr 13) |
| **Prompt length expansion** | Shared 4343-token preamble (agency architecture, output discipline, vocabulary, indicator glossary, safety rails, regime playbook, reasoning patterns, edge rationale) — crosses Haiku 4.5 minimum (4096) AND Sonnet 4.6 minimum (2048) so caching works on every model tier. | Unblocks prompt caching | Small | ✅ Done (Apr 14) |
| **Prompt caching** | `ask()` auto-prepends the cached preamble as a `cache_control: ephemeral` block when given a plain-string prompt. Cache hit confirmed with live API: 4336 tokens reading at 10% normal input price. Usage tracking now reports `cacheCreationTokens` / `cacheReadTokens` per call and per agent. | ~10x cheaper subsequent calls on the same model within the 5-min TTL | Medium | ✅ Done (Apr 14) |
| **Decision calibration snapshot** | `_persistDecision` now stores both the reported AND calibrated confidence for each agent, plus the full 30d calibration map, inside `agent_decisions.agent_inputs` JSONB. Historical decisions remain reproducible even as `agent_performance` drifts. TradeDrawer can show "which agent's weight tipped the decision". | Build trust, aid debugging | Small | ✅ Done (Apr 14) |
| **Prompt versioning** | New `prompt_versions` table + `promptRegistry` module. Loads active prompt per agent from DB; falls back silently to hardcoded constant when no override. `GET /api/prompts`, `POST /api/prompts/:agent/activate` for runtime switching without a deploy. Foundation for A/B testing — each agent can have multiple versions, exactly one active at a time. | Rollback + iteration without redeploy | Medium | ✅ Done (Apr 14) |
| **Explainability dashboard enhancements** | TradeDrawer per-agent breakdown: dual-tone confidence bar (reported vs calibrated), 30-day win rate + sample size, cold-start label, tipping-agent ★ highlight. | Richer post-mortem visibility | Small | ✅ Done (Apr 15) |
| **Prompt A/B testing framework** | Version-tagged decisions (migration 006) + per-version performance endpoint joining to trades + AgentsView panel with Activate button. **Shadow mode** (migration 010) added Apr 15: designate a candidate version and the orchestrator runs it in parallel on every cycle (~2× LLM cost), persists paired shadow decisions with `shadow_of` linkage, and exposes agreement rate / confidence delta in a live UI card. | Systematic prompt improvement | Medium | ✅ Done (Apr 15, tagging + shadow) |
| **Sentiment trend tracking** | `sentiment_snapshots` table (migration 007) + inflection detector (`getShifts`) + Dashboard card with sparkline per row. | Catch sentiment shifts before price moves | Medium | ✅ Done (Apr 15) |
| **Agent specialization** | Two new specialized agents: **Rupture** (breakout-agent) detects resistance breaks + volume surges + Bollinger expansion; **Bounce** (mean-reversion) detects RSI oversold/overbought + Bollinger reversion + distance from EMA21/VWAP. Both use daily bars + Haiku LLM synthesis and run in parallel with the existing 5 agents. Gap-fill agent deferred (requires intraday bars). | Better signal quality per setup type | Large | ✅ Done (Apr 15, breakout + mean-reversion) |
| **ML model improvement** | Added `ml_predictions` table (migration 013) for per-prediction logging, `logPrediction`/`linkPredictionToTrade`/`scorePendingPredictions`/`getLiveAccuracy`/`validateWalkForward` in `src/ml-model.js`. New endpoints: `GET /api/ml/status`, `GET /api/ml/walk-forward`, `POST /api/ml/score-pending`. | Cheaper fallback that improves with data | Large | ✅ Done (Apr 16) |
| **Inter-agent debate** | 1-round adversarial exchange: dissenters challenge the majority's top supporter, supporter responds. Transcript injected into the orchestrator's user message with explicit instructions to weigh the arguments. Zero LLM cost when all agents agree; capped at 3 rounds when many dissent. Persisted in `agent_inputs.debate` so the TradeDrawer can replay it. | More robust decisions via adversarial review | Large | ✅ Done (Apr 15) |

**Dependencies:** Calibration grows more reliable as trade history accumulates — expect noticeable orchestrator behavior changes after ~50 closed trades per agent.

---

### Phase 4: Production Readiness & Reliability — DONE (operational gaps)

Shipped across April 13–14. Remaining items are nice-to-haves (Prometheus exporter, secrets rotation, DB archival) that unblock production-grade ops but aren't day-to-day blockers.

| Item | Description | Benefit | Effort | Status |
|------|-------------|---------|--------|--------|
| **Retry-with-backoff helper** | Shared `retryWithBackoff` with exp + full jitter + Retry-After header parsing. Applied to Alpaca REST (429/5xx/network) and Anthropic SDK (typed errors). Circuit breaker increments only once per user-visible failure, not per retry. | No more silent outages from transient failures | Medium | ✅ Done (Apr 13) |
| **DB transaction wrapping** | `execution-agent` BUY/SELL signal+trade+decision-link writes inside `db.withTransaction`. Alpaca order stays outside — rollback can't un-place an order. Explicit "ORPHAN ORDER" logs for reconciliation when DB fails after Alpaca succeeds. | No more orphaned signals or partial trade records | Medium | ✅ Done (Apr 13) |
| **WebSocket reconnect backoff** | Exponential backoff 1s → 60s with jitter; counter resets on successful auth | Prevents reconnect storms, handles extended outages gracefully | Small | ✅ Done (Apr 13) |
| **LLM throttle banner** | Dashboard shows when agents are throttled with current utilization + cap reason | Prevents silent multi-hour outages like the one on Apr 10 | Small | ✅ Done (Apr 13) |
| **Structured JSON logs + correlation IDs** | AsyncLocalStorage-based context auto-tags every log line with `cycleId`/`requestId`/`sessionId`/`reconcileId`. `LOG_FORMAT=json` env switch for log aggregators; human-readable default preserved for local dev. | Much faster incident forensics | Medium | ✅ Done (Apr 14) |
| **Graceful shutdown** | SIGTERM/SIGINT handler stops new intervals, closes websockets, closes HTTP server, waits briefly for in-flight work, closes DB pool. 20s hard-exit timer prevents stuck deploys. | Prevents orphaned positions on deploy | Small | ✅ Done (Apr 14) |
| **Health endpoint** | `GET /api/health` pings DB + Alpaca + LLM budget + last-scan age + agent heartbeats. Returns 503 when critical checks fail, 200 healthy/degraded otherwise. Suitable for uptime monitors and liveness probes. | Reduce unattended downtime | Medium | ✅ Done (Apr 14) |
| **Partial-fill DB persistence** | New `persistFillEvent` in `alpaca-stream.js` — Alpaca WS partial_fill/fill events update `trades.qty` + `entry_price` + `order_value` based on live filled data. Idempotent; safe to fire repeatedly. | Accurate position tracking on partial fills | Small | ✅ Done (Apr 14) |
| **Nightly reconciliation job** | `reconciler.js` runs every 24h (also exposed at `GET /api/reconcile?dryRun=true`). Compares Alpaca positions vs DB open trades and auto-resolves three scenarios: orphan Alpaca position (insert trade row), orphan DB trade (close at last-known price with `exit_reason='reconciler_close'`), qty mismatch (sync DB qty to Alpaca). Read-only `computeDiff` available for dry-run/UI. | Catches the rare orphan case automatically instead of requiring human log inspection | Medium | ✅ Done (Apr 14) |
| **Prometheus metrics + Grafana** | `GET /metrics` with counters (llm_calls, trades_opened/closed), histograms (cycle durations), scrape-time gauges (budget, positions_open, polygon status). Mounted outside `/api/` for standard Prom scraping. | Production-grade observability | Medium | ✅ Done (Apr 15) |
| **Secrets rotation** | `docs/SECRETS.md` runbook covering every key, rotation cadence, and 5-step procedure; `/api/health` surfaces `envFile.ageDays` + `envFile.stale` (>90d) as a rotation reminder. Vault / platform-secrets migration stays as a dedicated follow-up sprint. | Security hardening for live trading | Medium | ✅ Done (Apr 15, docs + staleness signal) |
| **Database archival** | `src/archiver.js` + migration 008 (`archive_log`): nightly DELETE with per-table retention for `signals` (90d), `agent_reports` (60d), `agent_metrics` (60d), `sentiment_snapshots` (90d). Fires at 02:30 ET daily. `GET /api/archiver/status` + `POST /api/archiver/run`. Fully env-configurable retention. Failures per table don't halt the run. | Prevent unbounded table growth | Small | ✅ Done (Apr 15) |

---

### Phase 5: Advanced Features & UX — PARTIALLY DONE

Slippage/fees, walk-forward, Monte Carlo, and performance attribution shipped. Backtesting UI gained three new panels. Larger items (visual strategy builder, replay mode, multi-strategy, smart order routing) remain as follow-ups.

| Item | Description | Benefit | Effort | Status |
|------|-------------|---------|--------|--------|
| **Slippage + fee modeling** | `runBacktest` now accepts `slippagePct`, `feePerShare`, `feePerOrder`. Buy fills slip up, sell fills slip down. Entry fees deducted from capital, exit fees from realized P&L. Summary exposes totalFees + totalSlippage + totalCosts per backtest. | More honest historical P&L | Small | ✅ Done (Apr 14) |
| **Walk-forward optimization** | `runWalkForward` + `POST /api/backtest/walk-forward` + Analytics panel. Rolling 60-day windows step by 30 days through history; aggregate reports avgReturn, stdReturn, avgSharpe, positive/negative windows, robustness (fraction positive). Detects strategies that work only on lucky periods. | Catch over-fitting before live | Medium | ✅ Done (Apr 14) |
| **Monte Carlo simulation** | `runMonteCarlo` + `POST /api/backtest/monte-carlo` + panel. N runs with randomized slippage per iteration. Distribution: mean, std, p05/p25/p50/p75/p95, probPositive. Answers "what's the 5th-percentile outcome if fills go against us?". | Confidence intervals on expected return | Medium | ✅ Done (Apr 14) |
| **Performance attribution** | `GET /api/analytics/attribution?days=90` + panel. Breaks closed-trade P&L down by regime (joins historical regime reports), exit reason, day-of-week, hold duration bucket, sector, and top-20 symbols. Every bucket: count / winRate / pnl / avgPnl. | Understand what actually makes money | Medium | ✅ Done (Apr 14) |
| **Backtesting UI enhancements** | AnalyticsView gains three new panels: WalkForwardPanel, MonteCarloPanel, AttributionPanel. Drop-in controls for days/iterations/windowDays. | Iterate on strategies without code changes | Medium | ✅ Done (Apr 14) |
| **Visual strategy builder** | Pick indicators, set params, run + compare side-by-side | Non-developer experimentation | Large | Planned |
| **Replay mode** | `src/replay/sandbox-state.js` + `src/replay/replay-engine.js`: drives rule-based strategy through historical daily bars in a fully in-memory sandbox (never touches Alpaca or the production `trades` table). Tracks slippage + fees + equity curve. Same output shape as live trading so dashboards light up identically. `POST /api/replay` + Analytics panel (equity chart, stat cards, most-recent-trades table). Agency-mode variant (real LLM agent stack) deferred — needs LLM cost gating + Alpaca shim reentrancy work. | Safe strategy experimentation | Large | ✅ Done (Apr 14, rules mode) |
| **Alerting channels** | `src/alerting.js` with Slack/Telegram/Discord/generic-webhook adapters, severity levels (info/warn/critical), per-channel min-severity filter, 5-min dedup window, 100-entry history ring buffer. End-of-day digest at 16:05 ET. Critical alerts wired at orphan order, drawdown breaker, LLM circuit breaker. Settings UI panel with per-channel test-send + recent history. `GET /api/alerts/channels`, `GET /api/alerts/history`, `POST /api/alerts/test`, `POST /api/alerts/digest`. | Stay informed without watching the dashboard | Medium | ✅ Done (Apr 14) |
| **Multi-strategy support** | Migration 012 adds `trades.strategy_pool` and execution-agent tags every open with the winning supporter's pool (breakout / mean_reversion / news / technical / fallback). New `GET /api/analytics/by-strategy?days=N` returns per-pool performance (count, win rate, avg win/loss, total P&L). Full portfolio-level capital allocation deferred as a follow-up — today's shipped work gives the attribution foundation. | Diversify alpha sources | Large | ✅ Done (Apr 16, attribution MVP) |
| **Smart Order Routing** | Mid-price limit orders with market-order fallback on timeout. `SMART_ORDER_ROUTING_ENABLED` runtime flag (default off). Captures 1-5 bps per trade typical; Prometheus histograms `smart_orders_total{strategy}` and `smart_order_savings_bps` for observability. Wired into execution-agent BUY, monitor partial-exit + scale-in. TWAP/VWAP algos deferred as a follow-up. | Improved execution quality | Large | ✅ Done (Apr 15, limit-order tier) |
| **Watchlist editor UI** | Watchlist pills with add/remove already live; per-symbol strategy overrides gained a Clear (×) button per row and migration 009 adds `strategy_config` so overrides + global default now survive restarts. Settings → Data Export gains Export/Import Strategy Config buttons wired to the existing `/api/config/export|import` endpoints. | Faster reaction to themes | Medium | ✅ Done (Apr 15) |

---

### 🔭 Future / Research Directions

| Item | Description | Potential Impact | Feasibility |
|------|-------------|-----------------|-------------|
| **Reinforcement learning** | Train RL agent on backtest envs to learn entry/exit timing | High — could discover non-obvious patterns | Experimental |
| **Portfolio optimization** | Mean-variance, risk-parity, or Black-Litterman across multiple assets/strategies | High — institutional-grade sizing | Moderate |
| **Gradual live deployment** | `src/live-ramp.js` auto-scales capital 1% → 5% → 25% → 100% with gates on closed-trade count, win rate, max drawdown. Drawdown breach auto-demotes one tier + critical alert. `LIVE_RAMP_ENABLED` + `LIVE_RAMP_TIER` runtime-config. Endpoints: `GET /api/live-ramp/status`, `POST /api/live-ramp/check`. | Critical for real money | ✅ Done (Apr 16) |
| **Cross-exchange arbitrage** | Monitor price discrepancies for low-risk opportunities | Medium — needs fast execution | Moderate |
| **Alternative data** | SEC filings, insider trading reports, satellite imagery, credit-card spending | High — unique alpha | Complex |
| **Ensemble LLMs** | Mix multiple Claude variants + open-source models for cost/resilience | Medium — lower vendor risk | Moderate |
| **Mobile companion app** | Push notifications, position overview, emergency close-all | High usability — traders are mobile | Large |
| **Strategy marketplace** | Share/import community strategies as JSON configs | Community growth | Moderate |
| **Federated backtest** | Run backtests against ensemble of user-submitted data | Bigger sample for robust strategies | Complex |

---

## 🏗️ Completed Phases

<details>
<summary>Click to expand — 110+ items shipped across 16 phases</summary>

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

### Phase Z: Inter-Agent Debate (April 15, 2026 — late evening) ✅
Phase 3's last non-ML item closed. When agents disagree, the orchestrator now sees an explicit adversarial exchange before synthesizing — not just raw confidence numbers.
- **src/agents/debate.js**: pure-function `runDebate(agentReports)` identifies the majority signal, finds dissenters, and runs 1-round structured challenges (dissenter challenge → supporter response) via Haiku. Capped at 3 rounds per cycle. Zero LLM cost when all agents agree. Per-round failure is logged and skipped (never blocks live).
- **Orchestrator integration**: debate runs after report collection, before LLM synthesis. Debate transcript is injected into the user message as a structured block with explicit instructions: "Weigh these arguments explicitly in your reasoning. If a dissenter raised a valid risk, acknowledge it and adjust confidence accordingly." Transcript also persisted in `agent_inputs.debate` so every decision is fully replayable.
- **TradeDrawer**: new "Agent Debate" section appears below Orchestrator Decisions when `debate.hasDissent` is true. Each round renders dissenter + supporter badges (signal-colored), challenge text, response text, and any error notes. Collapsible for trade-drawer space.
- **Tests: 309 total / 29 suites** (+6 new: zero-LLM-cost when agreement, debate round with challenge/response, cap at 3 rounds, LLM failure graceful, all-HOLD returns no-dissent, correct majority detection when SELL outnumbers BUY).

### Phase Y: Agent Specialization — Breakout + Mean-Reversion (April 15, 2026 — late evening) ✅
Phase 3's flagship item closed. The agency expands from 5 analysis agents to 7, adding two philosophically opposed lenses that give the orchestrator richer signal diversity.
- **Breakout Agent ("Rupture")** (`src/agents/breakout-agent.js`): detects price breaking above resistance (pivot S/R from `findSupportResistance`), volume surges (≥1.5× avg via `volumeRatio`), Bollinger upper-band expansion, ATR context. Daily bars → LLM synthesis via Haiku. Prompt demands MULTIPLE confirmations (price above resistance + volume spike + trend up) and explicitly flags RSI > 80 exhaustion risk. Processes symbols in parallel batches of 3.
- **Mean-Reversion Agent ("Bounce")** (`src/agents/mean-reversion-agent.js`): detects oversold/overbought conditions — RSI extremes, Bollinger band position (%B), distance from EMA21 and VWAP as reversion targets, volume confirmation. Prompt instructs: don't fade a trend (EMA9 strongly above/below EMA21 → HOLD), and lower confidence when ATR is extreme (gap risk or dead-volume drift). Same batch processing pattern.
- **Registration**: both agents registered with the orchestrator in `src/index.js` and run in `Promise.allSettled` alongside the existing 5 agents in Phase 1 of each cycle. Agent reports flow into the orchestrator's weighted synthesis naturally — calibration weighting (cold-start 0.5) applies from day one.
- **Personas**: `agentPersonas.js` adds Rupture (orange/amber, avatar R) and Bounce (cyan/blue, avatar B). UI auto-renders them in the Agents dashboard card grid, calibration panel, and explainability breakdown.
- **Tests: 303 total / 28 suites** (+7: breakout report shape + indicators, LLM failure graceful degradation, insufficient-bars skip; mean-reversion report shape, LLM failure, buy/sell count derivation; persona file content check).

### Phase X: Smart Position Scaling (April 15, 2026 — late evening) ✅
Phase 2's "Smart position scaling" item closed. Ships opt-in with the same pattern as Kelly — watch the trigger logs before enabling.
- **src/position-scaling.js**: pure `shouldScaleIn(trade, price, atr, portfolioValue)` returns `{scaleIn, addQty, triggerPrice, newBlendedEntry, newStop, newTotalQty, scaleInsCount}` or `{scaleIn: false, reason}`. Stepwise triggers: each successive scale-in requires `entry + (count+1) × SCALE_IN_TRIGGER_ATR × ATR`. Guard against re-firing at the same level via `last_scale_in_price`. Position cap clamped to `MAX_POS_PCT × portfolioValue`.
- **Migration 011**: `trades.scale_ins_count`, `trades.last_scale_in_price`, `trades.original_qty`. Original qty preserved via `COALESCE(original_qty, qty)` on first scale-in update.
- **Monitor integration**: after the partial-exit check (mutual exclusion via `order_type` — `scaled_out` blocks scale-in, `scaled_in` blocks partial-exit). Fetches ATR, calls shouldScaleIn, places buy order, updates trade with blended entry + new stop + scale count. Logs + alerts on trigger. Continues to next trade on failure.
- **Runtime config**: `SCALE_IN_ENABLED` (default false), `SCALE_IN_TRIGGER_ATR` (1.5), `SCALE_IN_SIZE_PCT` (0.5), `SCALE_IN_MAX_COUNT` (2).
- **TradeDrawer**: shows "Scale-ins: 2× (100 → 150)" when `scale_ins_count > 0`.
- **Tests: 296 total / 27 suites** (+15 new position-scaling tests: enabled/disabled flag, basic trigger math, stepwise 2nd-scale-in, max-count guard, scaled_out exclusion, below-last-price guard, ATR null guard, position-cap rejection + clamping, stop-to-breakeven on first + unchanged on subsequent, blended-entry weighted average, enabled() boolean).

### Phase W: Prompt A/B Shadow Mode (April 15, 2026 — late evening) ✅
Closes the Phase 3 "Prompt A/B shadow mode" follow-up to the tagging MVP we shipped earlier today. Now a candidate prompt version can run end-to-end on live context without acting on the output, so we can measure agreement + confidence divergence before promoting.
- **Migration 010**: `prompt_versions` gains `is_shadow BOOLEAN` with a partial unique index (one shadow per agent). `agent_decisions` gains `is_shadow BOOLEAN` + `shadow_of UUID REFERENCES agent_decisions(id) ON DELETE CASCADE` so shadow rows can link to their paired live row.
- **Prompt registry**: shadowCache mirrors activeCache. `getShadow(agent)`, `getShadowMeta(agent)`, `setShadow(agent, version)`, `clearShadow(agent)`. Refresh loads both `is_active=true` and `is_shadow=true` rows in one query.
- **Orchestrator**: live and shadow `askJson` calls fire in `Promise.all` so cycle latency barely budges. Shadow errors are silent (never affect live). After persisting live decisions we capture ids by symbol and write paired shadow rows with `is_shadow=true` + `shadow_of=<live id>`. Shadow decisions never reach the message bus, never hit execution-agent, never get confidence-filtered or BUY-capped.
- **Existing readers**: every `SELECT FROM agent_decisions` that feeds the UI now filters `is_shadow = false` — trade drawer, `/api/decisions`, `/api/decisions/timeline`, prompt performance, agent leaderboard, and the "already decided today" guard in the orchestrator.
- **New endpoints**: `POST /api/prompts/:agent/set-shadow`, `POST /api/prompts/:agent/clear-shadow`, `GET /api/prompts/:agent/shadow-comparison?days=7` (returns paired pairs + agreement rate + avg confidence delta).
- **UI**: PromptPerformancePanel gains a Shadow button next to Activate on every inactive/non-shadow row, a Stop button on the shadow row, a ◆ badge on the shadow version, and a ShadowComparisonCard that appears below the table when a shadow is active — shows agreement %, paired count, shadow-only count, and confidence delta, plus a 1/7/30-day window toggle.
- **Tests: 281 total / 26 suites** (277 → 281; 4 new prompt-registry tests: shadow cache loading, null when absent, setShadow SQL shape, clearShadow SQL shape. Also updated the two existing tests whose mock rows needed `is_active: true` now that refresh filters on it).

### Phase V: Kelly / Half-Kelly Position Sizing (April 15, 2026 — late evening) ✅
Phase 2's flagship "Kelly / optimal-f sizing" item closed. Ships as an opt-in multiplier so operators can watch per-symbol suggestions accumulate for a few days before flipping it live.
- **src/kelly.js**: pure function module computing `f* = p − (1 − p) / b` from closed-trade history (long-only, wins vs losses by dollar P&L, breakevens excluded). Returns `{kellyF, halfKellyF, winRate, avgWin, avgLoss, winLossRatio, multiplier, source}` where `source='kelly'` means the sample qualified and `source='cold_start'` means we fell back to a 1.0× multiplier.
- **Safety math**: full Kelly clamped to an absolute 5% ceiling; half-Kelly is the default; final multiplier clamped to [0.5×, 2.0×] of base RISK_PCT; negative-edge symbols floor at 0.5×.
- **Execution-agent integration**: `kellyMultiplier(symbol)` slots into the existing sizing chain alongside `size_adjustment × earningsSizeFactor × volScale`. Honors the `KELLY_ENABLED` runtime flag (default **false** so flipping on is an explicit choice from the UI after you've reviewed the numbers). Sizing log line now exposes the Kelly scale next to the others.
- **Runtime toggle**: new `KELLY_ENABLED` allowlist entry in `src/runtime-config.js`; toggled from a dedicated Enable / Disable / Reset button in the new Agents panel.
- **Endpoints**: `GET /api/kelly?days=60&minSampleSize=20` (full universe) and `GET /api/kelly/:symbol` (single). Honors watchlist runtime override.
- **UI (AgentsView KellyPanel)**: per-symbol table showing sample (W/L), win rate, avg win, avg loss, Kelly f, half-Kelly, and the final multiplier coloured green/red. Window toggle (30/60/90 days), min-sample toggle (10/20/50), and a status pill showing Active vs "Off (suggest only)". Cold-start rows dim.
- **Tests: 277 total / 26 suites** (262 → 277 with 15 new Kelly tests): qualifying positive-edge produces multiplier > 1, negative-edge floors at 0.5×, base RISK_PCT override reflected in the multiplier, under-min-sample returns cold_start, empty rows, no-losses guard, breakevens excluded, DB error non-fatal, KELLY_ENABLED toggle short-circuits the DB query entirely when off, enabled + cold-start still returns 1.0×, computeForSymbols preserves input order.

### Phase U: Watchlist / Strategy Editor Polish (April 15, 2026 — late evening) ✅
Closed the last "Partial" item on the Phase 5 list. What looked like a UI polish item actually surfaced a latent bug: per-symbol strategy overrides were in-memory only and silently lost on every restart. Fixed the persistence gap, then added the UI affordances the original roadmap called for.
- **Persistence** (migration 009): new `strategy_config` table (`scope` in `('symbol','default')`, `key`, `mode` with `CHECK (mode IN ('rules','llm','hybrid'))`, `updated_at`, composite PK on `(scope, key)`). `src/strategy.js` now write-throughs every `setStrategy` / `setDefaultStrategy` / `clearStrategy` to DB and rebuilds in-memory state from DB on `init()`. Init is non-fatal — missing table / DB-down falls back to built-in defaults.
- **Startup wiring**: `src/index.js` calls `strategy.init()` right after `runtimeConfig.init()` so per-symbol overrides are loaded before the scanner fires.
- **UI — clear button**: Each row in Settings → Symbol Strategy Overrides now has a hover-reveal × button that hits `DELETE /api/strategies/:symbol` with a confirm prompt.
- **UI — bulk import/export**: Settings → Data Export gains Export Strategy Config (downloads JSON via Blob) and Import Strategy Config (file input → POST /api/config/import). Import tolerates both the wrapped `{success, data}` envelope and the raw inner payload.
- **Async migration**: Every `strategy.*` endpoint in `src/server.js` plus the config-import loop were promoted to `async` + `await` since the module's write API is now Promise-returning.
- **Tests: 262 total / 25 suites** (258 → 262 net; strategy suite rewritten around mocked DB — verifies upsert/delete SQL shape, init loads default + per-symbol rows, non-fatal failure, async validation errors).

### Phase T: Phase 4 Cleanup — DB Archival + Secrets Rotation Runbook (April 15, 2026 — late evening) ✅
Phase 4 ops-hygiene follow-ups closed; remaining infrastructure items (Vault migration, full platform-secrets integration) stay on the roadmap as dedicated sprints.
- **DB archival** (`src/archiver.js` + migration 008): nightly job DELETEs from four high-volume tables with per-table, env-overridable retention — `signals` (90d), `agent_reports` (60d), `agent_metrics` (60d), `sentiment_snapshots` (90d). Uses `created_at` for most tables, `captured_at` for sentiment. Every run writes one `archive_log` row per table (cutoff, rows deleted, duration, error) so "did the archiver run last night?" is one query away. Individual table failures don't halt the batch. Fires at 02:30 ET by default (configurable via `ARCHIVER_TIME_ET`). `GET /api/archiver/status` returns the most recent runs + current retention; `POST /api/archiver/run` triggers an on-demand sweep.
- **Secrets rotation runbook** (`docs/SECRETS.md`): single-source inventory of every secret this bot touches — Alpaca key/secret, Anthropic, Polygon, Supabase, API_KEY, Slack/Telegram/Discord/generic webhooks — with recommended rotation cadence and a 5-step procedure that overlaps old + new keys to avoid downtime. `/api/health` now reports `envFile.ageDays` and `envFile.stale` (>90 days) from `.env` mtime so the rotation reminder is observable in the existing health dashboard. A proper Vault / platform-secrets migration remains planned as its own sprint.
- **Tests: 258 across 25 suites** (247 → 258 with 11 new archiver tests covering retention defaults + env overrides, full-run across tables, captured_at vs created_at column selection, individual-table failure resilience, archive_log writes, and shouldFireNow scheduling).

### Phase S: Phase 1 Cleanup (April 15, 2026 — evening) ✅
Closed the two follow-up items Phase 1 had left open (TypeScript migration remains a dedicated multi-week sprint).
- **Scanner + legacy-executor test suites** — 18 new tests cover the full rule-based trade lifecycle. `tests/scanner.test.js` (9): watchlist merge + dedupe + price-band filter, Alpaca screener failure → static fallback, llm-only symbol skip, insufficient-bars skip, BUY path inserts signal + forwards to executor inside a transaction, batch continues after per-symbol failure, getLastScan counts. `tests/executor.test.js` (9): non-BUY and existing-position skip, risk-agent veto, regime avoid, happy path (bracket order → 15-col trade row with correct stop/target), bracket→market fallback, ATR fetch failure → fixed-% stop, insufficient funds skip, rejected order marks signal acted_on=false. Extended `tests/mocks/db.js` to detect executor's 15-col INSERT variant vs execution-agent's 12-col variant.
- **Prettier format pass** — `.prettierrc` added (120-char width, single quotes, trailing commas, LF line endings); `npm run format` across 29 files; `npm run format:check` now a CI gate alongside `lint` and `test:coverage`. Zero format drift going forward.
- **Tests: 247 total across 24 suites** (229 → 247).

### Phase R: Pro-Trader Feature Sprint (April 15, 2026 — afternoon) ✅
Single-day marathon closing seven items from the wishlist + roadmap.
- **MarketView VWAP + volume profile** — session-anchored VWAP line (resets at each ET trading day for intraday timeframes, cumulative for daily/weekly) rendered as a dashed amber LineSeries on the main price scale; volume profile as a right-edge canvas overlay with 50 price buckets and POC highlighted in amber. Toggleable via VWAP / VP buttons in the chart header. Pure frontend, no server changes.
- **TradeDrawer explainability + tipping-agent highlight** — replaces the collapsed Agent Inputs `<details>` with an always-visible per-agent breakdown: dual-tone confidence bar (grey = reported, blue = calibrated), 30-day win rate + sample size, cold-start detection, and a ★ on the supporting agent whose adjusted confidence most influenced the decision. All data was already persisted by `orchestrator._persistDecision`; this is UI plumbing only.
- **Sector rotation detection** — `src/sector-rotation.js` aggregates per-sector N-day returns using Polygon `sic_description` + Alpaca daily bars. Returns ranked sectors with `avgReturn`, `symbolCount`, top contributors, and a z-score momentum score. Wired into the orchestrator context (leaders/laggards surfaced in the LLM user message), exposed at `GET /api/sectors/rotation`, and rendered as a Dashboard card with leader/laggard bars. `sectorBiasMultiplier(symbol, rotation)` → clamped `[0.8, 1.2]` scalar multiplier for any caller needing a single number. Fail-open everywhere; 30-min cache keeps cost ~0.
- **Prompt A/B framework** — lightweight-tagging MVP. Migration 006 adds `agent_decisions.prompt_version_id UUID REFERENCES prompt_versions(id)`. Orchestrator now pulls its active prompt from `prompt-registry` (fallback to hardcoded) and stamps every decision with the source version. `GET /api/prompts/:agent/performance?days=N` joins decisions against trades (via `signal_id`) for per-version closed-trade win rate + P&L. AgentsView gains a Prompt A/B panel with side-by-side comparison, window toggle (7/30/90d), and one-click Activate. Shadow-mode (parallel candidate execution) deferred to keep LLM cost bounded.
- **Prometheus /metrics endpoint** — `src/metrics.js` registers counters (`llm_calls_total`, `llm_tokens_total`, `trades_opened_total`, `trades_closed_total{reason}`), histograms (`agency_cycle_duration_seconds`, `agent_cycle_duration_seconds{agent}`), and scrape-time gauges (`llm_budget_remaining_usd`, `llm_circuit_breaker_open`, `positions_open`, `polygon_calls_total_scraped`, `polygon_rate_limited`) plus Node defaults (heap, event_loop_lag, CPU). Mounted at `GET /metrics` outside `/api/` so Prom can scrape without the API key. Lazy-required hooks in trackUsage, trade open/close, and cycle ends.
- **Sentiment trend tracking** — migration 007 adds `sentiment_snapshots` (symbol, captured_at, sentiment, urgency, article_count, polygon_positive/negative/neutral, reddit_buzz, key_headline). News-agent bulk-inserts one row per symbol per cycle after the existing report persist. `src/sentiment-trends.js` exposes `getTrend(symbol, days)` and `getShifts({hours, threshold})` — the inflection detector that surfaces symbols whose |last−first| sentiment delta in the lookback window exceeds threshold, ranked by magnitude. `GET /api/sentiment/trend/:symbol` and `GET /api/sentiment/shifts`. Dashboard gains a Sentiment Shifts card with tunable window (6h/24h/72h) and threshold (0.3/0.5/0.8) + per-row SVG sparkline from the 3-day trend.
- **Tests added (+39 → 229 across 22 suites)** covering: sector rotation grouping / z-score / bias multiplier / fail-open (11), prompt registry getActiveId (2), Prometheus registry shape + counter + histogram + scrape-time gauges (10), sentiment trends DB round-trips + shift SQL shape + fail-open (7).

### Phase Q: Datasource Registry + Polygon Free Tier (April 15, 2026) ✅
- **Registry** (`src/datasources/`): `index.js` + `alpaca-adapter.js` + `polygon-adapter.js` + `cache.js`. Alpaca remains primary (bars, snapshots, screeners, trading); Polygon is enrichment-only — every Polygon method returns `null` when disabled, so agents never need try/catch or feature flags.
- **Polygon free-tier endpoints**: `getTickerDetails` (fundamentals), `getNewsWithInsights` (sentiment + reasoning), `getDividends` (ex-date warnings), `getMarketStatus`. Deliberately excludes paid endpoints (options, unusual flow, dark-pool) — those slot in cleanly when the subscription upgrades.
- **Safety rails**: token-bucket rate limiter (5/min, matching free tier), TTL + LRU cache (6h for ticker details, 10m for news, 15m for dividends/status — caps Polygon calls to ~1% of naive usage), 3-strike 429 circuit breaker with 60s cooldown, `retryWithBackoff` reused from `src/util/retry.js`.
- **Hot-reload toggle**: `POLYGON_ENABLED` added to `runtime-config` allowlist; user can flip Polygon off from Settings without touching `.env` or restarting.
- **Agent integration**: News Sentinel merges Alpaca + Polygon news by URL (Polygon wins, carries `insights` sentiment). Execution Agent surfaces ex-div-in-2-days warning to the decision log. Orchestrator context now includes per-symbol `marketCap` + `sector` when Polygon is available.
- **UI**: `SettingsView` adds a Data Sources card — live status dot (green/amber/red/grey), call counters, token bucket remaining, last error, and toggle button. Polls `/api/datasources/stats` every 15s.
- **Tests added (+10 → 200 across 19 suites)**: disabled-without-key path, runtime-disabled path, token bucket exhausts on 6th call, response parsing for tickers + news, 429 circuit open after retries, cache hit (no duplicate fetch), TTL expiry, LRU eviction.

### Phase P: Replay Mode Sprint (April 14, 2026) ✅
- **Sandbox state** (`src/replay/sandbox-state.js`): fully in-memory ledger mirroring the Alpaca slice the agency cares about (cash, portfolio_value, buying_power, positions). Slippage + fee accounting, mark-to-market hook, equity curve snapshotting, closed-trade log, signals + decisions logs. `getAccount()` / `getPositions()` / `getPosition()` return the exact same shape as the real Alpaca client so agency code can run against it unchanged.
- **Replay engine** (`src/replay/replay-engine.js`): loads historical daily bars once, builds a timeline, drives a configurable strategy through each date. Current strategy: `rules` (legacy `detectSignal` + ATR-scaled stops, identical math to the live executor). Engine shape designed for a future `agency` strategy that calls the real `technical-agent` / `risk-agent` / `orchestrator` / `execution-agent` against an Alpaca shim — that mode is deferred because each cycle costs LLM budget and needs proper gating.
- **API**: `POST /api/replay` with Zod-validated body. Accepts symbols, days, strategy, starting capital, risk/stop/target params, slippage, and per-share/per-order fees. Returns summary + trades + signals + decisions + equity curve.
- **UI**: `AnalyticsView` gains a `ReplayPanel` (6 stat cards, equity line chart over the replay window, most-recent-trades table with entry/exit/P&L/reason). Lives above WalkForwardPanel so the natural flow is replay → walk-forward → Monte Carlo → attribution.
- **Smoke-tested** against a 10-symbol / 90-day run: 3 trades, 66.7% win rate, +1.08% return, 0.84% max drawdown.
- **Tests added (+10 total → 190 across 18 suites)**: sandbox slippage direction (buys up, sells down) + fee accounting + duplicate-open rejection + insufficient-cash rejection + summary winRate/maxDD math; engine timeline construction, equity curve emission, no-bars-loaded graceful exit, slippage/fee pass-through to trades.

### Phase O: Alerting Channels Sprint (April 14, 2026) ✅
- **Multi-channel alerter** (`src/alerting.js`): Slack, Telegram, Discord, and generic-webhook adapters. Each channel is opt-in via env vars (`SLACK_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID`, `DISCORD_WEBHOOK_URL`, `WEBHOOK_URL`). Per-channel minimum severity (`SLACK_ALERT_MIN`, etc.) so noisy channels can be info-level while paging channels stay critical-only.
- **Severity levels**: info / warn / critical with shorthand helpers `info()`, `warn()`, `critical()`.
- **Dedup window** (5 min): identical (severity, title) repeats are suppressed but still recorded in history with `suppressed: true` so the dashboard sees the storm.
- **History ring buffer** (100 entries): in-memory list of recent alerts, surfaced via `GET /api/alerts/history`.
- **Backwards-compat**: `logger.alert(message)` shim now delegates to `alerting.alert({ severity: 'warn', ... })` so existing call sites keep working.
- **Critical-severity emissions wired at**:
  - Orphan ALPACA ORDER on BUY (execution-agent BUY transaction rollback)
  - Orphan SELL on close (execution-agent _executeSell rollback)
  - Drawdown circuit breaker tripped (risk-agent)
  - LLM circuit breaker open (llm.js after retries exhausted)
- **Warn-severity emissions wired at**: large P&L swing on close (>=$1k absolute), LLM daily cost at 80% of cap.
- **Daily digest** (`src/daily-digest.js`): scheduler fires once per trading day at configurable ET time (default 16:05). Pulls today's realized P&L, win rate, open positions with unrealized P&L, LLM cost, and cache hit %. Composes a single info-severity alert. Idempotent — won't double-fire on the same day.
- **API**: `GET /api/alerts/channels`, `GET /api/alerts/history?limit=N`, `POST /api/alerts/test {channel}`, `POST /api/alerts/digest`.
- **UI**: Settings page gains a Notifications panel with per-channel state, "Test" buttons, "Test all", "Send digest now", and a recent-alerts list with severity color-coding.
- **Tests added (+24 total → 180 across 17 suites)**: alerting (channel registration via env, severity filtering, dedup, history, test-send, failure isolation when one channel throws), daily-digest (content shape, fallback to closed-trades aggregate, position truncation, getPositions error survival, scheduling logic with ET timezone + weekday gate + env override).

### Phase N: Backtesting Validation Sprint (April 14, 2026) ✅
- **Slippage + fees in backtest** (`src/backtest.js`): new params `slippagePct` (default 5bps), `feePerShare`, `feePerOrder`. Buy fills slip up, sell fills slip down. Entry fees deducted from capital, exit fees from realized P&L. Each trade row carries `cleanEntry`/`cleanExitPrice`/`fees`/`slippageCost` for transparency. Summary exposes `totalFees`, `totalSlippage`, `totalCosts`.
- **Walk-forward runner** (`runWalkForward`): rolling 60-day windows stepping 30 days through the history. Preloads bars once, passes slices into the runner per window via a `getDailyBars` interceptor so we don't re-fetch. Aggregates avgReturn, stdReturn, avgSharpe, robustness (fraction of positive windows). Throws if `days < windowDays`.
- **Monte Carlo runner** (`runMonteCarlo`): N iterations with `slippageRandomize=true` so each run sees uniform-random slippage in [0.5x, 1.5x] of the base rate. Returns per-iteration runs plus a distribution block: mean, std, p05/p25/p50/p75/p95, min/max, probPositive.
- **Performance attribution endpoint** (`GET /api/analytics/attribution?days=90`): closed trades broken down by regime (joined to historical regime reports), exit reason, day-of-week, hold duration bucket (intraday/swing_1-2d/swing_3-7d/position_7d+), sector, top-20 symbols. Each bucket: count / winRate / pnl / avgPnl / wins / losses.
- **API surface**: `POST /api/backtest/walk-forward` and `POST /api/backtest/monte-carlo` with Zod-validated schemas.
- **UI**: `AnalyticsView` gains `WalkForwardPanel` (windows table + 6 stat cards), `MonteCarloPanel` (6 stat cards including P5/P50/probPositive), `AttributionPanel` (five-dimension grid showing count/win rate/pnl per bucket).
- **Tests added (+7 total → 156 across 15 suites)**: backtest slippage/fee application, walk-forward window generation + robustness math, Monte Carlo distribution validity (non-decreasing percentiles, probPositive ∈ [0,1], finite numbers), randomized slippage producing variance across iterations.

### Phase M: Strategy Edge Sprint (April 14, 2026) ✅
- **Earnings calendar filter** (`src/earnings.js`): static calendar + runtime-config overrides + news-keyword fallback (regexes for "earnings", "Q[1-4] report", "beats/misses EPS", etc.). Mode switch via `EARNINGS_MODE` (block/reduce/ignore). Execution agent gates BUY flow before sizing when a symbol is within the 2-trading-day window.
- **Intraday P&L + consecutive-loss guards** (`src/symbol-blacklist.js`): `checkSymbolGuards(symbol, portfolioValue)` does two cheap DB reads — today's realized P&L on the symbol (blocks if loss exceeds 1.5% of portfolio) and most-recent closed trades (blocks if 3 consecutive losers). Fails open on DB error so a DB outage doesn't halt all trading.
- **Multi-timeframe alignment score** (`src/agents/technical-agent.js`): computes `mtfAlignment` = fraction of available timeframes whose EMA trend matches the final signal. Confidence is algorithmically dampened when alignment < 0.5 so the LLM can't emit high-confidence single-timeframe setups. Exposed on the report object so the orchestrator + TradeDrawer can see it.
- **Orchestrator MTF gate** (`src/agents/orchestrator.js`): fallback decision path hard-filters trades with `mtfAlignment < 0.5`. LLM path sees the alignment score in context and weights accordingly.
- **Volatility targeting** (`src/agents/execution-agent.js` + `src/config.js`): new multiplier `volScale = clamp(VOL_TARGET_ATR_PCT / (ATR/price), VOL_TARGET_MIN_SCALE, VOL_TARGET_MAX_SCALE)`. Default target 2.5% ATR/price, clamps 0.4–1.5. Stacks multiplicatively with orchestrator confidence scaling and earnings dampener. Sizing log line now shows all three factors for traceability.
- **Tests added (+23 total → 149 across 14 suites)**: earnings (12: calendar, news signal, mode env), symbol-blacklist (11: day cap, streak, fail-open).

### Phase L: AI Prompt Caching + Versioning Sprint (April 14, 2026) ✅
- **Shared preamble** (`src/agents/prompts/shared-preamble.js`): 4343-token agency-wide system prompt covering agency architecture, output-format discipline, shared vocabulary, indicator glossary, safety rails, regime playbook, reasoning patterns, and the edge rationale. Sized to clear Haiku 4.5's 4096-token cache minimum (and Sonnet 4.6's 2048).
- **LLM.ask auto-prepend + cache plumbing** (`src/agents/llm.js`): plain-string prompts are auto-wrapped as `[preamble-block-with-cache_control, agent-suffix]`. Array form still accepted for fine control. `normalizeSystemPrompt` handles both. Anthropic SDK now includes `cache_creation_input_tokens` and `cache_read_input_tokens` in usage tracking; per-agent cost accounting uses the correct cached-input price (Haiku $0.08/M reads, Sonnet $0.30/M reads).
- **Cache verified live**: 4336 cached tokens read at ~10% of normal input cost on every subsequent agent call within the 5-minute TTL. Expected 30-40% cost reduction across the hot path (technical-analysis runs per symbol per cycle).
- **Decision explainability snapshot** (`src/agents/orchestrator.js`): `_persistDecision` now stores both `reportedConfidence` and `adjustedConfidence` for each contributing agent, plus the full calibration map at decision time (win rate + sample size per agent), inside `agent_decisions.agent_inputs` JSONB. Historical decisions remain reproducible as `agent_performance` drifts. Unblocks future TradeDrawer UI showing "which agent's weight tipped this decision".
- **Prompt versioning** (`db/migrations/005_prompt_versions.sql` + `src/agents/prompt-registry.js`): new `prompt_versions` table with unique active row per agent. `getActive(agent, fallback)` falls back silently to hardcoded prompts when no override exists or DB is unreachable. `activate(agent, version, prompt, notes)` upserts and switches active atomically. 5-minute cache refresh.
- **Runtime prompt management API**: `GET /api/prompts[?agent=x]` lists versions; `POST /api/prompts/:agent/activate` switches active version. Zod-validated body. Enables runtime rollback without code deploy.
- **Tests added (+9 total → 126 across 12 suites)**: prompt-registry fallback + activation + list + DB-failure resilience.

### Phase K: Production Operability Sprint (April 14, 2026) ✅
- **Structured logs + correlation IDs** (`src/logger.js`): AsyncLocalStorage-backed context so every log line, including downstream DB/Alpaca/LLM calls, auto-gets `cycleId` (agent cycles), `requestId` (Express), `sessionId` (chat), `reconcileId`. `LOG_FORMAT=json` env flag produces one-line JSON for log aggregators; human-readable stays the default for local dev.
- **Graceful shutdown** (`src/index.js`): SIGTERM/SIGINT → clear intervals → close WS streams → close HTTP → wait briefly → close DB pool. 20s hard-exit timer prevents stuck deploys. `db.close()` exported.
- **Rich health endpoint** (`GET /api/health`): DB ping, Alpaca ping, LLM budget/availability, last-scan age (stale if >3× interval while market open), per-agent heartbeats (stalled if no run in 30 min). Returns 503 on critical failure, 200 healthy/degraded otherwise. Suitable for k8s liveness probe or uptime monitor.
- **Partial-fill persistence** (`persistFillEvent` in `src/alpaca-stream.js`): wired into the trade_updates WS handler, updates `trades.qty` + `entry_price` + `order_value` idempotently on every `fill`/`partial_fill` event. Logged with a correlation id.
- **Nightly reconciler** (`src/reconciler.js` + `GET /api/reconcile`): runs daily via `setInterval` (also `immediate=true` available). Three auto-resolve paths: (1) Alpaca has position, DB missing → INSERT trade row; (2) DB open, Alpaca flat → close at last-known price with `exit_reason='reconciler_close'`; (3) qty mismatch → sync DB to Alpaca. `dryRun=true` returns the diff without writing. Never touches Alpaca (only DB).
- **Tests added (+20 total → 117 across 11 suites)**: alpaca-stream (7: partial-fill scenarios), reconciler (10: diff logic + all three auto-resolves + short-circuit), api-health (3: 200/503 paths).

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

*Last updated: April 14, 2026 — after the replay-mode sprint (rule-based strategy in a sandbox account, agency-mode replay deferred)*
*Maintained alongside active development. Check [commit history](../../commits/main) for latest changes.*
