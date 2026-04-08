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

  // Risk management
  RISK_PCT: 0.02,       // 2% of portfolio per trade
  STOP_PCT: 0.03,       // 3% stop loss
  TARGET_PCT: 0.06,     // 6% take profit (2:1 R:R)
  MAX_POS_PCT: 0.10,    // 10% max single position

  // Server
  PORT: process.env.PORT || 3001,

  // Agency mode — set USE_AGENCY=true in .env to enable multi-agent orchestration
  // When false, the original scanner/executor/monitor flow runs unchanged
  USE_AGENCY: process.env.USE_AGENCY === 'true',
});

module.exports = config;
