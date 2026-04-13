require('dotenv').config();

const config = Object.freeze({
  // Watchlist — these are the symbols scanned every cycle
  WATCHLIST: ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'META', 'GOOGL', 'AMZN'],

  // Scheduler
  SCAN_INTERVAL_MS: 5 * 60 * 1000,     // 5 minutes
  MONITOR_INTERVAL_MS: 5 * 60 * 1000,  // 5 minutes

  // Market hours (ET)
  MARKET_OPEN_HOUR: 9,
  MARKET_OPEN_MIN: 35,   // 9:35 AM — skip open volatility
  MARKET_CLOSE_HOUR: 15,
  MARKET_CLOSE_MIN: 50,  // 3:50 PM — stop before close

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
  VOLUME_SPIKE_RATIO: 1.2,

  // Risk management (env overrides allowed)
  RISK_PCT: parseFloat(process.env.RISK_PCT) || 0.02,       // 2% of portfolio per trade
  STOP_PCT: parseFloat(process.env.STOP_PCT) || 0.03,       // 3% stop loss
  TARGET_PCT: parseFloat(process.env.TARGET_PCT) || 0.06,   // 6% take profit (2:1 R:R)
  MAX_POS_PCT: parseFloat(process.env.MAX_POS_PCT) || 0.10, // 10% max single position
  TRAILING_ATR_MULT: 2.5, // Trailing stop = price - (daily ATR * multiplier)
  TRAILING_MIN_PCT: 0.02, // Minimum trailing distance — never less than 2% below highest price
  ATR_PERIOD: 14,
  PARTIAL_EXIT_PCT: 0.50,  // Sell 50% of position when this % of target is hit
  PARTIAL_EXIT_TRIGGER: 0.50, // Trigger partial exit at 50% of take-profit distance
  MAX_DRAWDOWN_PCT: parseFloat(process.env.MAX_DRAWDOWN_PCT) || 0.10, // 10% max drawdown → pause
  CORRELATION_THRESHOLD: parseFloat(process.env.CORRELATION_THRESHOLD) || 0.85,

  // Server
  PORT: process.env.PORT || 3001,

  // Security
  API_KEY: process.env.API_KEY || null,

  // Alerts (optional)
  SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL || null,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || null,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || null,

  // LLM guardrails
  LLM_DAILY_COST_CAP_USD: parseFloat(process.env.LLM_DAILY_COST_CAP_USD) || 5.00,
  LLM_DAILY_TOKEN_CAP: parseInt(process.env.LLM_DAILY_TOKEN_CAP) || 2_000_000,
  LLM_CIRCUIT_BREAKER_FAILURES: parseInt(process.env.LLM_CIRCUIT_BREAKER_FAILURES) || 3,

  // Agency mode — set USE_AGENCY=true in .env to enable multi-agent orchestration
  // When false, the original scanner/executor/monitor flow runs unchanged
  USE_AGENCY: process.env.USE_AGENCY === 'true',
});

module.exports = config;
