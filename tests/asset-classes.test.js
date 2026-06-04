const { getAssetClass, getRiskParams, isCrypto, setSymbolClass, getAllAssetClasses, isScannable, isBlocked } = require('../src/asset-classes');
const runtimeConfig = require('../src/runtime-config');

describe('asset-classes', () => {
  test('classifies known equity symbols', () => {
    expect(getAssetClass('AAPL')).toBe('us_equity');
    expect(getAssetClass('MSFT')).toBe('us_equity');
  });

  test('classifies crypto symbols', () => {
    expect(getAssetClass('BTC/USD')).toBe('crypto');
    expect(getAssetClass('ETH/USD')).toBe('crypto');
    expect(isCrypto('BTC/USD')).toBe(true);
    expect(isCrypto('AAPL')).toBe(false);
  });

  test('classifies ETF symbols', () => {
    expect(getAssetClass('SPY')).toBe('etf');
    expect(getAssetClass('QQQ')).toBe('etf');
  });

  test('defaults to us_equity for unknown symbols', () => {
    expect(getAssetClass('UNKNOWN_SYMBOL')).toBe('us_equity');
  });

  test('getRiskParams returns asset-class-specific values', () => {
    const equity = getRiskParams('AAPL');
    const crypto = getRiskParams('BTC/USD');
    const etf = getRiskParams('SPY');

    expect(equity.stopPct).toBe(0.035);
    expect(crypto.stopPct).toBe(0.05);
    expect(etf.stopPct).toBe(0.02);

    expect(crypto.riskPct).toBeLessThan(equity.riskPct);
    expect(etf.maxPosPct).toBeGreaterThan(equity.maxPosPct);
  });

  test('setSymbolClass overrides classification', () => {
    setSymbolClass('CUSTOM', 'crypto');
    expect(getAssetClass('CUSTOM')).toBe('crypto');
    // Clean up
    setSymbolClass('CUSTOM', 'us_equity');
  });

  test('getAllAssetClasses returns all classes', () => {
    const classes = getAllAssetClasses();
    expect(Object.keys(classes)).toContain('us_equity');
    expect(Object.keys(classes)).toContain('crypto');
    expect(Object.keys(classes)).toContain('etf');
  });

  describe('isScannable — autonomous-entry gate', () => {
    test('us_equity is scannable (default ON)', () => {
      expect(isScannable('AAPL')).toBe(true);
      expect(isScannable('MSFT')).toBe(true);
    });

    test('etf is scannable', () => {
      expect(isScannable('SPY')).toBe(true);
      expect(isScannable('QQQ')).toBe(true);
    });

    test('crypto is unscannable (turned off 2026-06-03)', () => {
      expect(isScannable('BTC/USD')).toBe(false);
      expect(isScannable('ETH/USD')).toBe(false);
    });

    test('option (OCC) is unscannable', () => {
      expect(isScannable('AAPL250620C00200000')).toBe(false);
    });

    test('penny_stock class is unscannable when seeded', () => {
      setSymbolClass('BMNG', 'penny_stock');
      expect(isScannable('BMNG')).toBe(false);
      setSymbolClass('BMNG', 'us_equity'); // cleanup
    });

    test('unknown asset class defaults to scannable (safe default)', () => {
      // Defensive — never silently drop a legitimate entry over a typo upstream.
      expect(isScannable('SOMETHING_NEW')).toBe(true);
    });
  });

  describe('isBlocked — per-symbol kill list', () => {
    // We monkey-patch runtimeConfig.get for these tests so we don't need
    // a real DB. The helper reads from runtime-config every call.
    let originalGet;
    beforeEach(() => {
      originalGet = runtimeConfig.get;
    });
    afterEach(() => {
      runtimeConfig.get = originalGet;
    });

    function setBlocklist(list) {
      runtimeConfig.get = jest.fn((key) => key === 'SYMBOL_BLOCKLIST' ? list : originalGet(key));
    }

    test('empty blocklist allows everything', () => {
      setBlocklist([]);
      expect(isBlocked('AAPL')).toBe(false);
      expect(isBlocked('BMNG')).toBe(false);
    });

    test('exact match blocks the symbol', () => {
      setBlocklist(['BMNG', 'IBIT']);
      expect(isBlocked('BMNG')).toBe(true);
      expect(isBlocked('IBIT')).toBe(true);
      expect(isBlocked('AAPL')).toBe(false);
    });

    test('match is case-insensitive (symbols stored upper)', () => {
      setBlocklist(['BMNG']);
      expect(isBlocked('bmng')).toBe(true);
      expect(isBlocked('Bmng')).toBe(true);
    });

    test('blocking the underlying also blocks its OCC options', () => {
      // Operator says "no more AAPL"; the bot also stops new AAPL options.
      setBlocklist(['AAPL']);
      expect(isBlocked('AAPL250620C00200000')).toBe(true);
      expect(isBlocked('AAPL250620P00150000')).toBe(true);
      expect(isBlocked('MSFT250620C00400000')).toBe(false);
    });

    test('non-array blocklist value is treated as empty', () => {
      // Defensive against a malformed runtime-config write.
      setBlocklist(null);
      expect(isBlocked('BMNG')).toBe(false);
      setBlocklist('not-an-array');
      expect(isBlocked('BMNG')).toBe(false);
    });
  });
});
