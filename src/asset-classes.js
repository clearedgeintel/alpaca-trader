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
  // Single-leg options (Phase 1 MVP). Risk parameters intentionally
  // tighter than equity because:
  //   - Delta-adjusted exposure is layered on top via MAX_DELTA_EXPOSURE_PCT
  //   - Options can lose 100% in a session if entered near expiry
  //   - No bracket orders most contracts — monitor enforces stop/target
  //     in dollar terms relative to entry premium.
  // riskPct here = max % of portfolio paid in PREMIUM. The orchestrator's
  // delta-adjusted notional check is the second gate.
  option: {
    label: 'Options',
    riskPct: 0.01, // 1% of portfolio per contract (premium paid)
    stopPct: 0.5, // 50% loss of premium = stop
    targetPct: 1.0, // 100% gain of premium = target
    maxPosPct: 0.05, // 5% max per single contract
    trailingAtrMult: null, // ATR trailing not meaningful on premium curves
    barTimeframe: '5Min',
    scannable: false, // not in the screener watchlist (MVP)
    qtyPrecision: 0, // contracts are whole numbers
    minQty: 1,
    isOption: true,
    contractMultiplier: 100, // standard equity option = 100 shares
  },
};

// -----------------------------------------------------------------
// OCC option symbol parsing
// Format: ROOT(1-6 alpha) + YYMMDD + C|P + STRIKE(8 digits, 1/1000ths)
// Example: AAPL240419C00150000 = AAPL, 2024-04-19, Call, strike $150.000
// -----------------------------------------------------------------
const OCC_REGEX = /^([A-Z]{1,6})(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;

/**
 * True if `symbol` is an OCC-format option contract (e.g. AAPL240419C00150000).
 * Equities ('AAPL'), crypto ('BTC/USD') and ETFs ('SPY') return false.
 */
function isOptionSymbol(symbol) {
  if (typeof symbol !== 'string') return false;
  return OCC_REGEX.test(symbol);
}

/**
 * Parse an OCC symbol into its components. Returns null if not a valid
 * option symbol.
 *   { underlying, expiration: 'YYYY-MM-DD', type: 'call'|'put', strike: number, contractMultiplier: 100 }
 */
function parseOptionSymbol(symbol) {
  const m = OCC_REGEX.exec(String(symbol));
  if (!m) return null;
  const [, underlying, yy, mm, dd, cp, strikeStr] = m;
  // OCC year encoding: 2-digit; 24 → 2024, 99 → 2099 (Alpaca/CBOE convention).
  const year = 2000 + parseInt(yy, 10);
  const expiration = `${year}-${mm}-${dd}`;
  return {
    underlying,
    expiration,
    type: cp === 'C' ? 'call' : 'put',
    strike: parseInt(strikeStr, 10) / 1000,
    contractMultiplier: 100,
  };
}

/**
 * Days from `from` (Date or ISO) to the option's expiration, inclusive.
 * Negative when expired. Returns null when the symbol isn't an option.
 */
function daysToExpiry(symbol, from = new Date()) {
  const parsed = parseOptionSymbol(symbol);
  if (!parsed) return null;
  const exp = new Date(`${parsed.expiration}T16:00:00-04:00`); // 4pm ET (close)
  const ref = from instanceof Date ? from : new Date(from);
  return Math.floor((exp.getTime() - ref.getTime()) / (24 * 60 * 60 * 1000));
}

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
 * OCC-format option symbols are detected by structure (no manual mapping).
 */
function getAssetClass(symbol) {
  if (isOptionSymbol(symbol)) return 'option';
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
 * Check if a symbol is a single-leg option contract (OCC format).
 * Convenience wrapper around isOptionSymbol so call sites can use a
 * uniform `isOption(sym)` regardless of whether the predicate is by
 * structure or by class lookup.
 */
function isOption(symbol) {
  return isOptionSymbol(symbol);
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
  isOption,
  isOptionSymbol,
  parseOptionSymbol,
  daysToExpiry,
  is24h,
  roundQty,
  CRYPTO_SYMBOLS,
  ETF_SYMBOLS,
};
