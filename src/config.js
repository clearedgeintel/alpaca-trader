require('dotenv').config();

const config = Object.freeze({
  // Watchlist — these are the symbols scanned every cycle
  WATCHLIST: ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'META', 'GOOGL', 'AMZN'],

  // Crypto watchlist — these trade 24/7 and bypass market-hours gating.
  // Set CRYPTO_WATCHLIST in .env as comma-separated: BTC/USD,ETH/USD,SOL/USD
  CRYPTO_WATCHLIST: (process.env.CRYPTO_WATCHLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Scheduler
  SCAN_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes
  MONITOR_INTERVAL_MS: 5 * 60 * 1000, // 5 minutes

  // Market hours (ET)
  MARKET_OPEN_HOUR: 9,
  MARKET_OPEN_MIN: 35, // 9:35 AM — skip open volatility
  MARKET_CLOSE_HOUR: 15,
  MARKET_CLOSE_MIN: 50, // 3:50 PM — stop before close

  // Alpaca bars
  BAR_TIMEFRAME: '5Min',
  BAR_LIMIT: 55,

  // Technical indicator periods
  EMA_FAST: 9,
  EMA_SLOW: 21,
  RSI_PERIOD: 14,
  VOLUME_LOOKBACK: 20,

  // Signal thresholds
  RSI_BUY_MIN: 45,
  RSI_BUY_MAX: 75,
  RSI_SELL_MAX: 60,
  VOLUME_SPIKE_RATIO: parseFloat(process.env.VOLUME_SPIKE_RATIO) || 1.2,

  // Orchestrator synthesis — minimum confidence required to act on a BUY/SELL.
  // Reverted 0.55 → 0.70 on 2026-05-21. The 0.55 experiment (run May 8-21)
  // halved the win rate: Apr 21-May 7 at 0.70 won 52%; May 7-21 at 0.55 won
  // 20-37%, net −$21K. Lowering the floor admitted low-quality trades rather
  // than finding more good ones. Do NOT drop below 0.65 without fresh data.
  ORCHESTRATOR_MIN_CONFIDENCE: parseFloat(process.env.ORCHESTRATOR_MIN_CONFIDENCE) || 0.7,
  // Execution-side belt-and-suspenders floor — independent from the orchestrator
  // floor so manual / chat / fallback decisions still hit a sanity gate.
  // Reverted 0.5 → 0.6 alongside the orchestrator floor (same rationale).
  EXECUTION_MIN_CONFIDENCE: parseFloat(process.env.EXECUTION_MIN_CONFIDENCE) || 0.6,

  // v2 Phase 0 agent cuts — reconciled 2026-05-29 (defaults match
  // production reality after the Option D config-drift audit).
  // The 2026-05-26 commit set these defaults to 'true' but the runtime_
  // config DB rows kept them OFF the entire time — my default change
  // was inert. Live data over the following 3 days didn't show
  // evidence the agents were contributing alpha, so accepting production
  // state (OFF) is the honest reconciliation. Migration 016 deletes
  // the redundant overrides so what's documented = what's running.
  BREAKOUT_AGENT_ENABLED:        (process.env.BREAKOUT_AGENT_ENABLED || 'false') === 'true',
  MEAN_REVERSION_AGENT_ENABLED:  (process.env.MEAN_REVERSION_AGENT_ENABLED || 'false') === 'true',
  SCREENER_LLM_RERANK_ENABLED:   (process.env.SCREENER_LLM_RERANK_ENABLED || 'false') === 'true',
  // v2 Phase 3 — strip-to-rules-only baseline. Both default TRUE so the
  // bot ships with LLM synthesis on (path-to-live disciplines hasn't
  // started yet for fresh installs); the OPERATOR flips them OFF at the
  // start of the 7-10 day rules-only observation window.
  // ORCHESTRATOR_LLM_ENABLED=false → orchestrator uses _fallbackDecisions
  //   (MTF-aligned BUYs at 0.8× confidence, 0.8× size) instead of Haiku/Sonnet.
  // TECHNICAL_LLM_ENABLED=false → Quant skips its batched LLM call; every
  //   symbol uses indicators.detectSignal directly (HOLD@0.30 / BUY|SELL@0.50).
  // Flip back to true to start Phase 4 ablation (one block at a time).
  ORCHESTRATOR_LLM_ENABLED:      (process.env.ORCHESTRATOR_LLM_ENABLED || 'true') === 'true',
  TECHNICAL_LLM_ENABLED:         (process.env.TECHNICAL_LLM_ENABLED || 'true') === 'true',
  // v2 Phase 4 block 4b/4c distinction. When ORCHESTRATOR_LLM_ENABLED=true
  // and this is FALSE, the orchestrator uses Haiku only — no debate phase,
  // no Sonnet upgrade on dissent (block 4b). When this is TRUE, full debate
  // + Sonnet-on-dissent (block 4c). Has no effect when ORCHESTRATOR_LLM_
  // ENABLED=false. Default true so a fresh install still gets full debate.
  ORCHESTRATOR_DEBATE_ENABLED:   (process.env.ORCHESTRATOR_DEBATE_ENABLED || 'true') === 'true',
  // v2 Phase 0b — news LLM cut. Default OFF, keyword-based critical-alert
  // detector (src/agents/news-keyword-alerts.js) provides the executor's
  // veto path. Flip ON to restore per-symbol sentiment grading + the
  // LLM's "softer" alert nuance. Saves ~$0.60/day when off.
  NEWS_PER_CYCLE_LLM_ENABLED:    (process.env.NEWS_PER_CYCLE_LLM_ENABLED || 'false') === 'true',

  // Minimum share price for any new BUY (both equity + momentum). Sub-$1
  // penny names have spreads + slippage that destroy the edge — every
  // large loss in the May 18-21 blotter was a sub-$1 stock. $3 default
  // keeps us out of that bucket without blocking normal small caps.
  MIN_PRICE: parseFloat(process.env.MIN_PRICE) || 3.0,

  // Gap-risk threshold multiplier — when premarket gap-down on an open
  // position exceeds this × stop-pct, exit at market open instead of
  // waiting for the 5-min monitor cycle to catch the (already-blown) stop.
  // 1.5 means a 5%-stop position exits on a -7.5% premarket gap.
  GAP_EXIT_THRESHOLD_MULT: parseFloat(process.env.GAP_EXIT_THRESHOLD_MULT) || 1.5,

  // Momentum Hunter — separate strategy pool for runner stocks already up
  // 30%+ on huge volume. High loss-rate, high winner-payoff. Ships OFF;
  // flip MOMENTUM_HUNTER_ENABLED=true at runtime to activate.
  MOMENTUM_HUNTER_ENABLED: false,
  // Defaults below reconciled 2026-05-29 to match production reality.
  // Operator set runtime overrides on 2026-05-15 (looser gap, lower
  // volume floor) and 2026-05-15 (tighter 5% stop). Live data behind
  // these settings was the dataset we've been analyzing — accepting
  // them as the documented config keeps "what's running" == "what's
  // in code." Migration 016 deletes the now-redundant overrides.
  MOMENTUM_GAP_PCT: 0.175,           // 17.5% min |%change| (was 0.30, prod override)
  MOMENTUM_MIN_VOLUME: 400_000,      // 400K shares today min (was 1M, prod override)
  MOMENTUM_RISK_PCT: 0.005,          // 0.5% portfolio per trade (vs 2% standard)
  MOMENTUM_STOP_PCT: 0.05,           // 5% stop (was 0.15, prod override).
                                     // Time-exit at 30 min is the real risk
                                     // control; the 5% stop is fast-move backstop.
  MOMENTUM_TARGET_PCT: 0.50,         // 50% target
  MOMENTUM_TIME_EXIT_MIN: 30,        // sell after 30 min if not gain threshold met
  MOMENTUM_MIN_GAIN_AT_EXIT: 0.20,   // 20% min unrealized at time-exit window
  MOMENTUM_MAX_OPEN: 3,              // max concurrent momentum positions
  MOMENTUM_CONFIDENCE: 0.60,         // confidence stamped on emitted signals
  // Percentage trailing stop for momentum. The May blotter showed the
  // win/loss asymmetry was fatal: avg loss >= avg win at a 30% win rate.
  // The fix is to let runners run (WGRX +16.7%, TE +7.1%) while protecting
  // gains, rather than dumping modest winners at the flat time-exit. Once
  // a momentum position is up ACTIVATE_PCT, trail TRAIL_PCT below the high.
  // The daily-ATR trail (used for equity) is too slow for intraday parabolas.
  MOMENTUM_TRAIL_ACTIVATE_PCT: 0.10, // start trailing once up 10%
  MOMENTUM_TRAIL_PCT: 0.06,          // trail 6% below the running high

  // Risk management (env overrides allowed). Defaults reconciled
  // 2026-05-29 to match production reality — operator set STOP_PCT and
  // TARGET_PCT runtime overrides on 2026-04-27 that have been in effect
  // ever since. Migration 016 deletes those redundant overrides.
  RISK_PCT: parseFloat(process.env.RISK_PCT) || 0.02, // 2% of portfolio per trade
  STOP_PCT: parseFloat(process.env.STOP_PCT) || 0.035, // 3.5% stop (was 0.03, prod override)
  TARGET_PCT: parseFloat(process.env.TARGET_PCT) || 0.10, // 10% target (was 0.06, prod override; ~3:1 R:R)
  MAX_POS_PCT: parseFloat(process.env.MAX_POS_PCT) || 0.1, // 10% max single position
  ATR_STOP_MULT: parseFloat(process.env.ATR_STOP_MULT) || 2.0, // Initial stop = entry - (daily ATR * this)
  ATR_STOP_MIN_PCT: parseFloat(process.env.ATR_STOP_MIN_PCT) || 0.02, // Floor on ATR-derived stop
  ATR_STOP_MAX_PCT: parseFloat(process.env.ATR_STOP_MAX_PCT) || 0.08, // Cap on ATR-derived stop
  REWARD_RATIO: parseFloat(process.env.REWARD_RATIO) || 2.0, // Target distance = stop distance * this
  VOL_TARGET_ENABLED: (process.env.VOL_TARGET_ENABLED || 'true') === 'true',
  VOL_TARGET_ATR_PCT: parseFloat(process.env.VOL_TARGET_ATR_PCT) || 0.025, // Symbols with ATR/price == this get 1.0x size
  VOL_TARGET_MIN_SCALE: parseFloat(process.env.VOL_TARGET_MIN_SCALE) || 0.4, // Size floor (don't shrink below 40%)
  VOL_TARGET_MAX_SCALE: parseFloat(process.env.VOL_TARGET_MAX_SCALE) || 1.5, // Size ceiling (don't upsize above 150%)
  TRAILING_ATR_MULT: 2.5, // Trailing stop = price - (daily ATR * multiplier)
  TRAILING_MIN_PCT: 0.02, // Minimum trailing distance — never less than 2% below highest price
  ATR_PERIOD: 14,
  PARTIAL_EXIT_PCT: 0.5, // Sell 50% of position when this % of target is hit
  PARTIAL_EXIT_TRIGGER: 0.5, // Trigger partial exit at 50% of take-profit distance
  MAX_DRAWDOWN_PCT: parseFloat(process.env.MAX_DRAWDOWN_PCT) || 0.1, // 10% max drawdown → pause
  CORRELATION_THRESHOLD: parseFloat(process.env.CORRELATION_THRESHOLD) || 0.85,
  // Hard cap on simultaneous open positions. Orthogonal to
  // MAX_PORTFOLIO_HEAT_PCT (which sums risk-dollars) and to MAX_POS_PCT
  // (which caps per-position size) — this gates pure count. 12 open at
  // once was the operator-flagged concentration concern; 8 is the default
  // floor that admits all five Phase 3+ active strategies a fair share
  // without piling on. Flip via runtime-config to suit current book.
  MAX_OPEN_POSITIONS: parseInt(process.env.MAX_OPEN_POSITIONS) || 8,
  // Orchestrator-initiated SELL on open equity positions. P4 of the
  // 2026-06-03 fine-tune: this discretionary exit was net-negative on
  // 28 closed trades. Mechanical exits (stop_loss / take_profit /
  // trailing_stop / momentum_time_exit / gap_exit) are doing the
  // disciplined work; the LLM-driven exit was overriding them on noise.
  // Default OFF — Nexus may still emit SELL decisions but Striker
  // refuses them. The structural exits + the news-keyword critical-
  // alert path remain unaffected. Operator can flip true to restore
  // the old behavior, but ideally a stricter regime-corroborated gate
  // ships before that happens (see TODO in execution-agent._executeSell).
  ORCHESTRATOR_SELL_ENABLED: (process.env.ORCHESTRATOR_SELL_ENABLED || 'false') === 'true',
  // Scanner / Scout dynamic universe (P5 of the 2026-06-03 fine-tune).
  // When false (default), scanner.buildWatchlist() and screener-agent
  // candidate discovery both ignore Alpaca most-active + top-movers
  // and operate on the static WATCHLIST + Scout's curated DISCOVERY_POOL
  // only. Honest mode: what's documented is what's traded.
  // When true, restores the prior behavior — scanner adds up to ~30
  // most-active symbols and Scout pulls from movers each cycle. Useful
  // when the operator wants broader discovery, but every dynamic name
  // it surfaced was an asymmetric risk: occasionally a BMNG-class
  // winner, more often a slow bleed across symbols never validated.
  SCANNER_DYNAMIC_UNIVERSE_ENABLED:
    (process.env.SCANNER_DYNAMIC_UNIVERSE_ENABLED || 'false') === 'true',
  // Fractional shares (small-account support). When TRUE, equity + ETF
  // sizing uses 4-decimal precision so a $500 account at MAX_POS_PCT=10%
  // can buy 0.16 shares of a $300 stock instead of being forced to either
  // skip the entry or violate the cap by buying 1 whole share. Default
  // FALSE — keeps the current whole-share behavior unless the operator
  // opts in. CRYPTO is always fractional regardless of this flag (it has
  // its own qtyPrecision=6 baseline). Alpaca rejects bracket orders for
  // fractional qty, so the executor falls back to monitor-enforced
  // stop/target when this is on (same pattern options use).
  FRACTIONAL_SHARES_ENABLED:
    (process.env.FRACTIONAL_SHARES_ENABLED || 'false') === 'true',
  // Per-symbol blocklist (2026-06-03 fine-tune follow-up). Hot-reloadable
  // via runtime-config as a comma-separated string ("BMNG,IBIT,..."). Checked
  // alongside isScannable at every BUY gate. Lets the operator surgically
  // kill a specific name (e.g. after a bad outcome) without bumping config
  // or touching the asset-class scannable flags. Default empty.
  SYMBOL_BLOCKLIST: (process.env.SYMBOL_BLOCKLIST || '')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),

  // Server
  PORT: process.env.PORT || 3001,

  // Security
  API_KEY: process.env.API_KEY || null,

  // Alerts (optional)
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL || null,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || null,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || null,

  // LLM guardrails
  LLM_DAILY_COST_CAP_USD: parseFloat(process.env.LLM_DAILY_COST_CAP_USD) || 5.0,
  // Token cap is a SAFETY NET; the cost cap above is the real bound.
  // With prompt caching active, token counts balloon (cache reads don't
  // count here but output + uncached input still add up). Set well above
  // any reasonable daily usage so hitting it means something went wrong
  // — a runaway loop, a prompt explosion, etc.
  LLM_DAILY_TOKEN_CAP: parseInt(process.env.LLM_DAILY_TOKEN_CAP) || 10_000_000,
  LLM_CIRCUIT_BREAKER_FAILURES: parseInt(process.env.LLM_CIRCUIT_BREAKER_FAILURES) || 3,

  // Agency mode — set USE_AGENCY=true in .env to enable multi-agent orchestration
  // When false, the original scanner/executor/monitor flow runs unchanged
  USE_AGENCY: process.env.USE_AGENCY === 'true',

  // -----------------------------------------------------------------
  // Options trading (Phase 1 MVP) — defaults. Hot-reloadable via
  // runtime-config (see src/runtime-config.ts ALLOWED_KEYS).
  // OPTIONS_ENABLED ships OFF; flip in Settings to begin paper trading.
  // -----------------------------------------------------------------
  OPTIONS_ENABLED: process.env.OPTIONS_ENABLED === 'true',
  MAX_OPTION_RISK_PCT: parseFloat(process.env.MAX_OPTION_RISK_PCT) || 0.01,
  MAX_DELTA_EXPOSURE_PCT: parseFloat(process.env.MAX_DELTA_EXPOSURE_PCT) || 0.05,
  THETA_DECAY_DAYS_THRESHOLD: parseInt(process.env.THETA_DECAY_DAYS_THRESHOLD) || 7,
});

module.exports = config;
