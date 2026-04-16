const config = require('./config');

/**
 * Asset class definitions with per-class risk parameters.
 * Each class can override the global defaults from config.
 */
const ASSET_CLASSES = {
  us_equity: {
    label: 'US Equities',
    riskPct: config.RISK_PCT,
    stopPct: config.STOP_PCT,
    targetPct: config.TARGET_PCT,
    maxPosPct: config.MAX_POS_PCT,
    trailingAtrMult: config.TRAILING_ATR_MULT,
    barTimeframe: '5Min',
    scannable: true,
  },
  crypto: {
    label: 'Crypto',
    riskPct: 0.01, // 1% risk — higher volatility
    stopPct: 0.05, // 5% stop — wider for crypto
    targetPct: 0.1, // 10% target
    maxPosPct: 0.05, // 5% max single position
    trailingAtrMult: 3.0, // Wider trailing for crypto volatility
    barTimeframe: '5Min',
    scannable: true,
  },
  penny_stock: {
    label: 'Penny Stocks',
    riskPct: 0.005, // 0.5% risk — very small positions
    stopPct: 0.08, // 8% stop — penny stocks are volatile
    targetPct: 0.15, // 15% target — need big moves to justify risk
    maxPosPct: 0.03, // 3% max single position
    trailingAtrMult: 3.5, // Wide trailing for high volatility
    barTimeframe: '5Min',
    scannable: true,
  },
  etf: {
    label: 'ETFs',
    riskPct: 0.02,
    stopPct: 0.02, // 2% tighter stop — less volatile
    targetPct: 0.04, // 4% target
    maxPosPct: 0.15, // 15% max — ETFs are diversified
    trailingAtrMult: 1.5,
    barTimeframe: '5Min',
    scannable: true,
  },
};

// Symbol → asset class mapping
const SYMBOL_CLASS_MAP = {};

// Known crypto symbols (Alpaca supported)
const CRYPTO_SYMBOLS = ['BTC/USD', 'ETH/USD', 'SOL/USD', 'DOGE/USD', 'AVAX/USD', 'LINK/USD', 'DOT/USD', 'MATIC/USD'];
for (const sym of CRYPTO_SYMBOLS) SYMBOL_CLASS_MAP[sym] = 'crypto';

// Known ETF symbols
const ETF_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'DIA', 'XLF', 'XLE', 'XLK', 'XLV', 'GLD', 'SLV', 'TLT', 'VXX', 'ARKK'];
for (const sym of ETF_SYMBOLS) SYMBOL_CLASS_MAP[sym] = 'etf';

/**
 * Get the asset class for a symbol. Defaults to us_equity.
 */
function getAssetClass(symbol) {
  return SYMBOL_CLASS_MAP[symbol] || 'us_equity';
}

/**
 * Get risk parameters for a symbol based on its asset class.
 */
function getRiskParams(symbol) {
  const cls = getAssetClass(symbol);
  return { ...ASSET_CLASSES[cls], assetClass: cls };
}

/**
 * Register a symbol as a specific asset class.
 */
function setSymbolClass(symbol, assetClass) {
  if (ASSET_CLASSES[assetClass]) {
    SYMBOL_CLASS_MAP[symbol] = assetClass;
  }
}

/**
 * Get all defined asset classes and their params.
 */
function getAllAssetClasses() {
  return { ...ASSET_CLASSES };
}

/**
 * Check if a symbol is a crypto pair.
 */
function isCrypto(symbol) {
  return getAssetClass(symbol) === 'crypto';
}

module.exports = {
  getAssetClass,
  getRiskParams,
  setSymbolClass,
  getAllAssetClasses,
  isCrypto,
  CRYPTO_SYMBOLS,
  ETF_SYMBOLS,
};
