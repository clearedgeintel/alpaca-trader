/**
 * OCC option-symbol parser + daysToExpiry helper.
 *
 * Phase 1 MVP: only single-leg long calls/puts. The regex must reject
 * anything else (equities, crypto pairs, futures) so getAssetClass
 * can rely on it.
 */

const {
  isOption,
  isOptionSymbol,
  parseOptionSymbol,
  daysToExpiry,
  getAssetClass,
  getRiskParams,
} = require('../src/asset-classes');

describe('isOptionSymbol', () => {
  test.each([
    ['AAPL240419C00150000', true], // Apple, 2024-04-19, call, $150
    ['SPY261218P00450000', true],  // SPY, 2026-12-18, put, $450
    ['A240419C00100000', true],    // 1-letter root
    ['BRKB251231C00400000', true], // Berkshire B, 5-letter root
  ])('detects valid OCC symbol %s', (sym, expected) => {
    expect(isOptionSymbol(sym)).toBe(expected);
    expect(isOption(sym)).toBe(expected);
  });

  test.each([
    ['AAPL', false],            // bare equity
    ['BTC/USD', false],         // crypto pair
    ['SPY', false],             // ETF
    ['', false],                // empty
    [null, false],              // null
    [undefined, false],         // undefined
    ['AAPL240419X00150000', false], // bad type letter
    ['AAPL2404190C00150000', false], // bad date width
    ['aapl240419c00150000', false],  // lowercase (OCC is uppercase)
    [123, false],               // non-string
  ])('rejects non-option %s', (sym, expected) => {
    expect(isOptionSymbol(sym)).toBe(expected);
  });
});

describe('parseOptionSymbol', () => {
  test('decodes a call with sub-dollar strike encoding', () => {
    const r = parseOptionSymbol('AAPL240419C00150000');
    expect(r).toEqual({
      underlying: 'AAPL',
      expiration: '2024-04-19',
      type: 'call',
      strike: 150,
      contractMultiplier: 100,
    });
  });

  test('decodes a put with non-integer strike', () => {
    const r = parseOptionSymbol('SPY261218P00457500'); // $457.50
    expect(r.type).toBe('put');
    expect(r.strike).toBe(457.5);
  });

  test('handles 5-letter root', () => {
    const r = parseOptionSymbol('BRKB251231C00400000');
    expect(r.underlying).toBe('BRKB');
    expect(r.expiration).toBe('2025-12-31');
  });

  test('returns null for non-option symbols', () => {
    expect(parseOptionSymbol('AAPL')).toBeNull();
    expect(parseOptionSymbol('BTC/USD')).toBeNull();
    expect(parseOptionSymbol(null)).toBeNull();
  });
});

describe('daysToExpiry', () => {
  test('returns positive count for a future expiry', () => {
    const future = new Date();
    future.setDate(future.getDate() + 14);
    const yy = String(future.getUTCFullYear()).slice(-2);
    const mm = String(future.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(future.getUTCDate()).padStart(2, '0');
    const sym = `AAPL${yy}${mm}${dd}C00150000`;
    const days = daysToExpiry(sym);
    expect(days).toBeGreaterThanOrEqual(13);
    expect(days).toBeLessThanOrEqual(14);
  });

  test('returns negative for an expired contract', () => {
    expect(daysToExpiry('AAPL200101C00150000')).toBeLessThan(0);
  });

  test('returns null for non-option symbols', () => {
    expect(daysToExpiry('AAPL')).toBeNull();
  });
});

describe('getAssetClass + getRiskParams routing', () => {
  test('routes OCC symbols to the option asset class', () => {
    expect(getAssetClass('AAPL240419C00150000')).toBe('option');
    const params = getRiskParams('AAPL240419C00150000');
    expect(params.assetClass).toBe('option');
    expect(params.isOption).toBe(true);
    expect(params.contractMultiplier).toBe(100);
    expect(params.riskPct).toBe(0.01); // 1% Phase-1 default
    expect(params.maxPosPct).toBe(0.05); // 5% Phase-1 default
  });

  test('still routes equities to us_equity', () => {
    expect(getAssetClass('AAPL')).toBe('us_equity');
  });

  test('still routes crypto to crypto', () => {
    expect(getAssetClass('BTC/USD')).toBe('crypto');
  });
});
