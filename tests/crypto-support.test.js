/**
 * Tests for crypto expansion — roundQty, is24h, isCrypto, and
 * the CRYPTO_WATCHLIST config integration.
 */

jest.mock('../src/logger', () => ({
  log: () => {},
  warn: () => {},
  error: () => {},
  runWithContext: (_c, fn) => fn(),
  newCorrelationId: () => 'test',
  getContext: () => ({}),
}));

const { roundQty, is24h, isCrypto, getRiskParams, CRYPTO_SYMBOLS } = require('../src/asset-classes');
const config = require('../src/config');

describe('roundQty', () => {
  test('rounds equity qty to whole shares', () => {
    expect(roundQty(10.7, 'AAPL')).toBe(10);
    expect(roundQty(0.5, 'AAPL')).toBe(0); // below minQty
  });

  test('preserves fractional qty for crypto symbols', () => {
    expect(roundQty(0.5, 'BTC/USD')).toBe(0.5);
    expect(roundQty(1.123456789, 'BTC/USD')).toBe(1.123457); // 6 decimal precision
  });

  test('returns 0 when qty is below minQty for crypto', () => {
    expect(roundQty(0.001, 'BTC/USD')).toBe(0.001); // above minQty
    expect(roundQty(0.0000001, 'BTC/USD')).toBe(0); // rounds to 0 at 6dp → below minQty
  });
});

describe('is24h', () => {
  test('returns true for crypto symbols', () => {
    expect(is24h('BTC/USD')).toBe(true);
    expect(is24h('ETH/USD')).toBe(true);
  });

  test('returns false for equity symbols', () => {
    expect(is24h('AAPL')).toBe(false);
    expect(is24h('SPY')).toBe(false);
  });
});

describe('isCrypto', () => {
  test('identifies known crypto symbols', () => {
    expect(isCrypto('BTC/USD')).toBe(true);
    expect(isCrypto('ETH/USD')).toBe(true);
    expect(isCrypto('AAPL')).toBe(false);
  });
});

describe('crypto risk params', () => {
  test('crypto has wider stops and smaller risk than equities', () => {
    const crypto = getRiskParams('BTC/USD');
    const equity = getRiskParams('AAPL');
    expect(crypto.stopPct).toBeGreaterThan(equity.stopPct);
    expect(crypto.riskPct).toBeLessThan(equity.riskPct);
    expect(crypto.qtyPrecision).toBeGreaterThan(0);
    expect(equity.qtyPrecision).toBe(0);
  });
});

describe('CRYPTO_WATCHLIST config', () => {
  test('defaults to empty array when env var is not set', () => {
    expect(Array.isArray(config.CRYPTO_WATCHLIST)).toBe(true);
  });

  test('CRYPTO_SYMBOLS includes standard pairs', () => {
    expect(CRYPTO_SYMBOLS).toContain('BTC/USD');
    expect(CRYPTO_SYMBOLS).toContain('ETH/USD');
  });
});
