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
    // Disabled 2026-06-03 — honest-stats audit showed the crypto-proxy
    // book was net-negative once the BMNG carry trade was stripped. No
    // independent validation that we have edge in crypto; turn off the
    // entry path until the operator decides to re-enable per Priority 1
    // of the path-to-live fine-tune. SELL/close path is unaffected so
    // existing positions can wind down naturally.
    scannable: false,
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
    // Disabled 2026-06-03 — same audit. The single sub-$1 carry trade
    // (BMNG +$176K) masked an otherwise -$11K bleed across this class.
    // Operator can re-enable per-class once an independent validation
    // window shows edge. Existing positions still close normally.
    scannable: false,
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
  //
  // DISABLED 2026-06-03 (scannable: false, OPTIONS_ENABLED cleared).
  // The implementation is correct — multiplier applied at every site,
  // pnl_pct uses entry premium, stops/targets enforced on premium curve.
  // The problem is the 50% / 100% ratio at observed 20% win rate:
  //   EV/trade = 0.2 × 100% − 0.8 × 50% = −20% of premium per trade.
  // Break-even needs ~33% win rate at 50/100. Until we have ≥ 30
  // closed-trade evidence at a positive-EV ratio, this stays off.
  // Re-enabling without changing the ratio AND validating the win rate
  // is provably losing math. See migration 018 for the kill rationale.
  option: {
    label: 'Options',
    riskPct: 0.01, // 1% of portfolio per contract (premium paid)
    stopPct: 0.5, // 50% loss of premium = stop
    targetPct: 1.0, // 100% gain of premium = target
    maxPosPct: 0.05, // 5% max per single contract
    trailingAtrMult: null, // ATR trailing not meaningful on premium curves
    barTimeframe: '5Min',
    scannable: false, // see DISABLED note above; do not flip without ratio validation
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
 * Crypto uses fractional shares (6 decimals); equities use whole shares
 * unless FRACTIONAL_SHARES_ENABLED is on (small-account opt-in), in which
 * case us_equity + ETF allow 4-decimal precision.
 *
 * The function defensively skips runtime-config when called from a context
 * that hasn't booted it (e.g. some unit tests). Callers in production go
 * through the live runtime-config path.
 */
function roundQty(rawQty, symbol) {
  const params = getRiskParams(symbol);
  let precision = params.qtyPrecision ?? 0;
  let minQty = params.minQty ?? 1;

  // Fractional override — only for the two classes Alpaca supports it on
  // (us_equity + etf). Crypto already has precision=6; options/penny stay
  // whole-unit because the broker doesn't accept fractional there.
  const cls = params.assetClass || getAssetClass(symbol);
  if (cls === 'us_equity' || cls === 'etf') {
    try {
      const rc = require('./runtime-config');
      if (rc.get('FRACTIONAL_SHARES_ENABLED') === true) {
        precision = 4;
        minQty = 0.001;
      }
    } catch { /* runtime-config not available — fall through to whole-share defaults */ }
  }

  const rounded = precision === 0 ? Math.floor(rawQty) : +rawQty.toFixed(precision);
  return rounded >= minQty ? rounded : 0;
}

/**
 * True when the SIZED qty for this symbol will be fractional (decimal).
 * Used by the order placement path to skip bracket orders (Alpaca rejects
 * brackets combined with fractional qty) and time_in_force='gtc'-style
 * extended-hours which fractional doesn't support.
 *
 * Independent of the actual qty value — checks the configured precision
 * for the symbol's class. Equity/ETF symbols return true only when the
 * runtime flag is on; crypto always returns true.
 */
function isFractionalEnabled(symbol) {
  if (isOptionSymbol(symbol)) return false; // options can't fractionalize
  const cls = getAssetClass(symbol);
  if (cls === 'crypto') return true;
  if (cls === 'us_equity' || cls === 'etf') {
    try {
      return require('./runtime-config').get('FRACTIONAL_SHARES_ENABLED') === true;
    } catch { return false; }
  }
  return false;
}

/**
 * Check if a symbol's asset class trades 24/7 (bypasses market hours).
 */
function is24h(symbol) {
  const params = getRiskParams(symbol);
  return params.is24h === true;
}

/**
 * True when the symbol's asset class is enabled for autonomous entry
 * (`scannable: true` in ASSET_CLASSES). Used as a BUY-side veto by
 * the scanner, screener, executor, and execution-agent. SELL/close
 * paths bypass this check so positions already on the book can wind
 * down naturally after a class gets turned off.
 *
 * Defaults to TRUE when an asset class definition is missing — the
 * helper should never be the reason a legitimate entry is silently
 * dropped because of a typo upstream.
 */
function isScannable(symbol) {
  const cls = getAssetClass(symbol);
  const params = ASSET_CLASSES[cls];
  if (!params) return true;
  return params.scannable !== false;
}

/**
 * True when the symbol is on the runtime-config blocklist. Surgical
 * per-symbol kill used alongside isScannable — flips on the asset-
 * class veto for individual names without changing the class flag.
 *
 * For OCC options, also checks the underlying symbol so blocking
 * "AAPL" stops new BUYs of AAPL250620C00200000 etc. SELLs aren't
 * checked so existing positions can still close.
 *
 * Reads from runtime-config so additions take effect within the
 * 30-second refresh window without a restart.
 */
function isBlocked(symbol) {
  const runtimeConfig = require('./runtime-config');
  const list = runtimeConfig.get('SYMBOL_BLOCKLIST') || [];
  if (!Array.isArray(list) || list.length === 0) return false;
  const up = (symbol || '').toUpperCase();
  if (list.includes(up)) return true;
  // OCC option → check the underlying too
  if (isOptionSymbol(up)) {
    const parsed = parseOptionSymbol(up);
    if (parsed && list.includes(parsed.underlying.toUpperCase())) return true;
  }
  return false;
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
  isScannable,
  isBlocked,
  isFractionalEnabled,
  roundQty,
  CRYPTO_SYMBOLS,
  ETF_SYMBOLS,
};
