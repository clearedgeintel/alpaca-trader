const { emaArray, calcRsi, volumeRatio, detectSignal, calcAtr, calcMacd, bollingerBands } = require('../src/indicators');

describe('emaArray', () => {
  test('returns nulls for bars before period', () => {
    const result = emaArray([1, 2, 3, 4, 5], 3);
    expect(result[0]).toBeNull();
    expect(result[1]).toBeNull();
    expect(result[2]).toBeCloseTo(2, 1); // SMA of [1,2,3]
  });

  test('computes EMA correctly after seed', () => {
    const closes = [10, 11, 12, 13, 14, 15];
    const result = emaArray(closes, 3);
    expect(result[2]).toBeCloseTo(11, 0); // SMA seed
    expect(result[3]).toBeGreaterThan(result[2]); // Trending up
  });

  test('handles single-element period', () => {
    const result = emaArray([5, 10, 15], 1);
    expect(result[0]).toBe(5);
    expect(result[1]).toBe(10);
    expect(result[2]).toBe(15);
  });
});

describe('calcRsi', () => {
  test('returns null with insufficient data', () => {
    expect(calcRsi([1, 2, 3], 14)).toBeNull();
  });

  test('returns 100 when all gains', () => {
    const closes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const rsi = calcRsi(closes, 14);
    expect(rsi).toBe(100);
  });

  test('returns value between 0 and 100', () => {
    const closes = [44, 44.3, 44.1, 43.6, 44.3, 44.8, 45.1, 45.4, 45.1, 45.3,
      45.6, 46, 46.3, 46.3, 46, 46.3, 46.5];
    const rsi = calcRsi(closes, 14);
    expect(rsi).toBeGreaterThan(0);
    expect(rsi).toBeLessThan(100);
  });
});

describe('volumeRatio', () => {
  test('returns 0 with insufficient data', () => {
    expect(volumeRatio([100], 5)).toBe(0);
  });

  test('returns 2 when last vol is double average', () => {
    const volumes = [100, 100, 100, 100, 100, 200];
    expect(volumeRatio(volumes, 5)).toBe(2);
  });

  test('returns 1 when volume equals average', () => {
    const volumes = [100, 100, 100, 100, 100, 100];
    expect(volumeRatio(volumes, 5)).toBe(1);
  });
});

describe('calcAtr', () => {
  test('returns null with insufficient data', () => {
    expect(calcAtr([{ h: 10, l: 9, c: 9.5 }], 14)).toBeNull();
  });

  test('computes positive ATR for volatile bars', () => {
    const bars = Array.from({ length: 20 }, (_, i) => ({
      h: 100 + (i % 2 === 0 ? 3 : 1),
      l: 100 - (i % 2 === 0 ? 1 : 3),
      c: 100 + (i % 2 === 0 ? 2 : -2),
    }));
    const atr = calcAtr(bars, 14);
    expect(atr).toBeGreaterThan(0);
  });
});

describe('calcMacd', () => {
  test('returns null with insufficient data', () => {
    expect(calcMacd([1, 2, 3])).toBeNull();
  });

  test('returns macdLine, signalLine, histogram', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 5) * 10);
    const result = calcMacd(closes);
    expect(result).toHaveProperty('macdLine');
    expect(result).toHaveProperty('signalLine');
    expect(result).toHaveProperty('histogram');
  });
});

describe('bollingerBands', () => {
  test('returns null with insufficient data', () => {
    expect(bollingerBands([1, 2, 3], 20)).toBeNull();
  });

  test('upper > middle > lower', () => {
    const closes = Array.from({ length: 25 }, (_, i) => 100 + i * 0.5);
    const bb = bollingerBands(closes);
    expect(bb.upper).toBeGreaterThan(bb.middle);
    expect(bb.middle).toBeGreaterThan(bb.lower);
  });
});

describe('detectSignal', () => {
  test('returns NONE with insufficient bars', () => {
    const bars = Array.from({ length: 10 }, (_, i) => ({
      t: `2024-01-0${i + 1}`, o: 100, h: 101, l: 99, c: 100, v: 1000,
    }));
    expect(detectSignal(bars).signal).toBe('NONE');
  });

  test('returns object with required fields', () => {
    const bars = Array.from({ length: 55 }, (_, i) => ({
      t: `2024-01-${String(i + 1).padStart(2, '0')}`,
      o: 100 + i * 0.1,
      h: 101 + i * 0.1,
      l: 99 + i * 0.1,
      c: 100 + i * 0.1,
      v: 10000 + i * 100,
    }));
    const result = detectSignal(bars);
    expect(result).toHaveProperty('signal');
    expect(result).toHaveProperty('reason');
    expect(['BUY', 'SELL', 'NONE']).toContain(result.signal);
  });
});
