const { getAssetClass, getRiskParams, isCrypto, setSymbolClass, getAllAssetClasses } = require('../src/asset-classes');

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

    expect(equity.stopPct).toBe(0.03);
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
});
