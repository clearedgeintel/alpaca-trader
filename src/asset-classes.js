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
    qtyPrecision: 0, // whole shares
    minQty: 1,
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
    qtyPrecision: 6, // fractional — BTC needs 8, most alts need 4-6
    minQty: 0.000001,
    is24h: true, // bypasses market-hours gate
  },
  penny_stock: {
    label: 'Penny Stocks',
    riskPct: 0.005,
    stopPct: 0.08,
    targetPct: 0.15,
    maxPosPct: 0.03,
    trailingAtrMult: 3.5,
    barTimeframe: '5Min',
    scannable: true,
    qtyPrecision: 0,
    minQty: 1,
  },
  etf: {
    label: 'ETFs',
    riskPct: 0.02,
    stopPct: 0.02,
    targetPct: 0.04,
    maxPosPct: 0.15,
    trailingAtrMult: 1.5,
    barTimeframe: '5Min',
    scannable: true,
    qtyPrecision: 0,
    minQty: 1,
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

/**
 * Round a quantity to the appropriate precision for the symbol's asset class.
 * Crypto uses fractional shares (6 decimals); equities use whole shares.
 */
function roundQty(rawQty, symbol) {
  const params = getRiskParams(symbol);
  const precision = params.qtyPrecision ?? 0;
  const minQty = params.minQty ?? 1;
  const rounded = precision === 0 ? Math.floor(rawQty) : +rawQty.toFixed(precision);
  return rounded >= minQty ? rounded : 0;
}

/**
 * Check if a symbol's asset class trades 24/7 (bypasses market hours).
 */
function is24h(symbol) {
  const params = getRiskParams(symbol);
  return params.is24h === true;
}

module.exports = {
  getAssetClass,
  getRiskParams,
  setSymbolClass,
  getAllAssetClasses,
  isCrypto,
  is24h,
  roundQty,
  CRYPTO_SYMBOLS,
  ETF_SYMBOLS,
};
