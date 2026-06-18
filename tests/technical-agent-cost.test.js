/**
 * Quant (technical-analysis) cost-control regression tests — the slim
 * payload + verdict-cache hashing introduced in the 2026-06-17 LLM-cost
 * audit (Tier 1). Quant was ~82% of the daily LLM bill; these guard the
 * compression and cache-key behavior that the savings depend on.
 */

const technicalAgent = require('../src/agents/technical-agent');

// Shape mirrors one entry of _gatherIndicators()'s timeframeData.
function tf(overrides = {}) {
  return {
    available: true,
    price: 100,
    ema9: 101,
    ema21: 100,
    emaTrend: 'bullish',
    emaCrossover: 'bullish_cross',
    rsi: 62.4,
    macd: { macdLine: 0.5, signalLine: 0.3, histogram: 0.2 },
    bollingerBands: { upper: 105, middle: 100, lower: 95, bandwidth: 0.1 },
    bbPosition: 'upper_half',
    vwap: 99.5,
    vwapPosition: 'above',
    supportResistance: { support: [95, 90], resistance: [105, 110] },
    volumeRatio: 1.8,
    ...overrides,
  };
}

describe('TechnicalAgent._slimForLlm', () => {
  it('keeps only the derived signals and drops raw indicator objects', () => {
    const slim = technicalAgent._slimForLlm({ '5min': tf() });
    expect(slim['5min']).toEqual({
      trend: 'bullish',
      cross: 'bullish_cross',
      rsi: 62.4,
      bb: 'upper_half',
      vwap: 'above',
      vol: 1.8,
      macd: 'positive',
    });
    // Raw numeric/object fields must not leak into the LLM payload.
    expect(slim['5min']).not.toHaveProperty('ema9');
    expect(slim['5min']).not.toHaveProperty('bollingerBands');
    expect(slim['5min']).not.toHaveProperty('supportResistance');
    expect(slim['5min']).not.toHaveProperty('vwap', 99.5);
  });

  it('compresses MACD histogram to a sign (and null when absent)', () => {
    expect(technicalAgent._slimForLlm({ d: tf({ macd: { histogram: -0.4 } }) }).d.macd).toBe('negative');
    expect(technicalAgent._slimForLlm({ d: tf({ macd: null }) }).d.macd).toBeNull();
    expect(technicalAgent._slimForLlm({ d: tf({ macd: { histogram: null } }) }).d.macd).toBeNull();
  });

  it('omits unavailable timeframes', () => {
    const slim = technicalAgent._slimForLlm({ '5min': tf(), '1hour': { available: false } });
    expect(Object.keys(slim)).toEqual(['5min']);
  });
});

describe('TechnicalAgent._verdictHash', () => {
  it('is stable for identical snapshots and differs when a signal moves', () => {
    const a = technicalAgent._slimForLlm({ '5min': tf() });
    const b = technicalAgent._slimForLlm({ '5min': tf() }); // same inputs
    const c = technicalAgent._slimForLlm({ '5min': tf({ rsi: 71.2 }) }); // rsi moved

    expect(technicalAgent._verdictHash(a)).toBe(technicalAgent._verdictHash(b));
    expect(technicalAgent._verdictHash(a)).not.toBe(technicalAgent._verdictHash(c));
  });

  it('ignores raw-value churn that does not change a derived signal', () => {
    // price/ema drift that keeps the same trend/cross/bb/vwap/rsi must hash
    // identically — that is exactly when the cache should reuse the verdict.
    const a = technicalAgent._slimForLlm({ '5min': tf({ price: 100.01, ema9: 101.02 }) });
    const b = technicalAgent._slimForLlm({ '5min': tf({ price: 100.04, ema9: 101.07 }) });
    expect(technicalAgent._verdictHash(a)).toBe(technicalAgent._verdictHash(b));
  });
});
