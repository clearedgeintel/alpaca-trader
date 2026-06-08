const { getAssetClass, getRiskParams, isCrypto, setSymbolClass, getAllAssetClasses, isScannable, isBlocked, isFractionalEnabled, roundQty } = require('../src/asset-classes');
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

  describe('FRACTIONAL_SHARES_ENABLED — small-account sizing', () => {
    // The roundQty / isFractionalEnabled paths consult runtime-config.
    // Monkey-patch so we control the flag value per test.
    let originalGet;
    beforeEach(() => { originalGet = runtimeConfig.get; });
    afterEach(() => { runtimeConfig.get = originalGet; });
    function setFlag(value) {
      runtimeConfig.get = jest.fn((key) => key === 'FRACTIONAL_SHARES_ENABLED' ? value : originalGet(key));
    }

    test('roundQty floors equities to whole shares when flag is off', () => {
      setFlag(false);
      // $500 portfolio × 10% cap / $300 AAPL = 0.1667 raw → floor to 0
      expect(roundQty(0.1667, 'AAPL')).toBe(0);
      expect(roundQty(1.9, 'MSFT')).toBe(1);
      expect(roundQty(0.99, 'SPY')).toBe(0);
    });

    test('roundQty preserves 4-decimal precision when flag is on', () => {
      setFlag(true);
      expect(roundQty(0.1667, 'AAPL')).toBe(0.1667);
      expect(roundQty(0.0005, 'AAPL')).toBe(0);   // below 0.001 min still floors to 0
      expect(roundQty(0.0015, 'AAPL')).toBe(0.0015);
      expect(roundQty(1.23456789, 'SPY')).toBe(1.2346);  // ETFs also fractional
    });

    test('crypto stays at 6 decimals regardless of flag', () => {
      setFlag(false);
      expect(roundQty(0.123456789, 'BTC/USD')).toBe(0.123457);
      setFlag(true);
      expect(roundQty(0.123456789, 'BTC/USD')).toBe(0.123457);
    });

    test('options stay whole-contract regardless of flag', () => {
      setFlag(true);
      expect(roundQty(1.5, 'AAPL250620C00200000')).toBe(1);
      expect(roundQty(2.9, 'AAPL250620C00200000')).toBe(2);
    });

    test('isFractionalEnabled flips with the flag for equities', () => {
      setFlag(false);
      expect(isFractionalEnabled('AAPL')).toBe(false);
      expect(isFractionalEnabled('SPY')).toBe(false);
      setFlag(true);
      expect(isFractionalEnabled('AAPL')).toBe(true);
      expect(isFractionalEnabled('SPY')).toBe(true);
    });

    test('isFractionalEnabled is always true for crypto', () => {
      setFlag(false);
      expect(isFractionalEnabled('BTC/USD')).toBe(true);
    });

    test('isFractionalEnabled is always false for options', () => {
      setFlag(true);
      expect(isFractionalEnabled('AAPL250620C00200000')).toBe(false);
    });

    test('small-account scenario: $500 + AAPL @ $300 + MAX_POS_PCT=10% works fractional', () => {
      // The bug the user hit: cap math is $500 × 0.10 / $300 = 0.1667 shares.
      // With flag off, this floors to 0 and the bot would (under old code)
      // silently floor to minQty=1 = $300 position = 60% of portfolio.
      // With flag on, sizing returns 0.1666 share = $50 = exactly 10% cap.
      setFlag(false);
      expect(roundQty(0.1667, 'AAPL')).toBe(0);
      setFlag(true);
      const qty = roundQty(0.1667, 'AAPL');
      expect(qty).toBe(0.1667);
      const position = qty * 300;
      expect(position).toBeCloseTo(50.01, 2);   // exactly the cap
    });
  });
});
