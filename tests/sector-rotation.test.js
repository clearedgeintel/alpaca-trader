/**
 * Unit tests for the sector rotation aggregator. Mocks the two
 * upstream data sources (alpaca.getDailyBars and datasources.getTickerDetails)
 * so the math is deterministic — no network hits.
 */

const mockAlpaca = { getDailyBars: jest.fn() };
const mockDatasources = { getTickerDetails: jest.fn() };

jest.mock('../src/alpaca', () => mockAlpaca);
jest.mock('../src/datasources', () => mockDatasources);
jest.mock('../src/logger', () => ({
  log: () => {}, warn: () => {}, error: () => {},
  runWithContext: (_c, fn) => fn(),
  newCorrelationId: () => 'test',
  getContext: () => ({}),
}));

const sectorRotation = require('../src/sector-rotation');

function bars(closes) {
  return closes.map((c, i) => ({
    t: new Date(2026, 3, 10 + i).toISOString(),
    o: c, h: c * 1.01, l: c * 0.99, c, v: 1_000_000,
  }));
}

beforeEach(() => {
  mockAlpaca.getDailyBars.mockReset();
  mockDatasources.getTickerDetails.mockReset();
  sectorRotation._resetForTests();
});

describe('computeRotation', () => {
  test('groups symbols by sector and computes sector avg return', async () => {
    mockDatasources.getTickerDetails.mockImplementation(async (sym) => {
      if (['AAPL', 'MSFT'].includes(sym)) return { sic_description: 'Electronic Computers' };
      if (['JPM', 'BAC'].includes(sym)) return { sic_description: 'Banks' };
      return null;
    });
    mockAlpaca.getDailyBars.mockImplementation(async (sym) => {
      // 5-day returns — Tech +6%/+4% (avg 5%), Banks -2%/-4% (avg -3%)
      const map = {
        AAPL: bars([100, 101, 102, 104, 105, 106]),
        MSFT: bars([200, 201, 202, 204, 207, 208]),
        JPM:  bars([100, 100, 99, 98, 98, 98]),
        BAC:  bars([50, 50, 49, 48, 48, 48]),
      };
      return map[sym] || bars([100, 100, 100, 100, 100, 100]);
    });

    const r = await sectorRotation.computeRotation({ symbols: ['AAPL', 'MSFT', 'JPM', 'BAC'], days: 5 });

    expect(r.sectors).toHaveLength(2);
    const tech = r.sectors.find(s => s.name === 'Electronic Computers');
    const banks = r.sectors.find(s => s.name === 'Banks');
    expect(tech.symbolCount).toBe(2);
    expect(tech.avgReturn).toBeGreaterThan(0);
    expect(banks.avgReturn).toBeLessThan(0);
    expect(r.leaders[0].name).toBe('Electronic Computers');
    expect(r.laggards[0].name).toBe('Banks');
  });

  test('falls back to Unknown sector when Polygon returns null', async () => {
    mockDatasources.getTickerDetails.mockResolvedValue(null);
    mockAlpaca.getDailyBars.mockResolvedValue(bars([100, 101, 102, 103, 104, 105]));
    const r = await sectorRotation.computeRotation({ symbols: ['AAPL', 'MSFT'], days: 5 });
    expect(r.sectors).toHaveLength(1);
    expect(r.sectors[0].name).toBe('Unknown');
    expect(r.coveredSymbols).toBe(2);
  });

  test('skips symbols whose bar fetch throws without killing the batch', async () => {
    mockDatasources.getTickerDetails.mockResolvedValue({ sic_description: 'Energy' });
    mockAlpaca.getDailyBars.mockImplementation(async (sym) => {
      if (sym === 'BROKEN') throw new Error('Alpaca 500');
      return bars([100, 101, 102, 103, 104, 105]);
    });
    const r = await sectorRotation.computeRotation({ symbols: ['OK1', 'BROKEN', 'OK2'], days: 5 });
    expect(r.coveredSymbols).toBe(2);
    expect(r.universeSize).toBe(3);
  });

  test('empty symbol list returns empty structure, not a throw', async () => {
    const r = await sectorRotation.computeRotation({ symbols: [], days: 5 });
    expect(r.sectors).toEqual([]);
    expect(r.leaders).toEqual([]);
    expect(r.laggards).toEqual([]);
  });

  test('cache hit: second call with same inputs skips data fetches', async () => {
    mockDatasources.getTickerDetails.mockResolvedValue({ sic_description: 'Tech' });
    mockAlpaca.getDailyBars.mockResolvedValue(bars([100, 102, 104, 106, 108, 110]));
    await sectorRotation.computeRotation({ symbols: ['AAPL'], days: 5 });
    const fetchCountBefore = mockAlpaca.getDailyBars.mock.calls.length;
    await sectorRotation.computeRotation({ symbols: ['AAPL'], days: 5 });
    expect(mockAlpaca.getDailyBars.mock.calls.length).toBe(fetchCountBefore);
  });

  test('momentum score is z-score of sector avgReturn vs universe mean', async () => {
    mockDatasources.getTickerDetails.mockImplementation(async (sym) => ({
      sic_description: sym.startsWith('T') ? 'Tech' : sym.startsWith('B') ? 'Bank' : 'Energy',
    }));
    mockAlpaca.getDailyBars.mockImplementation(async (sym) => {
      // Tech leads, Energy flat, Banks lag
      if (sym === 'T1') return bars([100, 105, 108, 110, 112, 115]);
      if (sym === 'B1') return bars([100, 99, 98, 97, 96, 95]);
      if (sym === 'E1') return bars([100, 100, 100, 100, 100, 100]);
      return bars([100, 100, 100, 100, 100, 100]);
    });
    const r = await sectorRotation.computeRotation({ symbols: ['T1', 'B1', 'E1'], days: 5 });
    const tech = r.sectors.find(s => s.name === 'Tech');
    const bank = r.sectors.find(s => s.name === 'Bank');
    expect(tech.momentumScore).toBeGreaterThan(0);
    expect(bank.momentumScore).toBeLessThan(0);
  });
});

describe('sectorBiasMultiplier', () => {
  test('leader sector symbol gets >1.0 multiplier', () => {
    const rotation = {
      sectors: [
        { name: 'Tech', momentumScore: 1.5, topSymbols: [{ symbol: 'AAPL', ret: 0.05 }] },
        { name: 'Bank', momentumScore: -1.5, topSymbols: [{ symbol: 'JPM', ret: -0.03 }] },
      ],
    };
    expect(sectorRotation.sectorBiasMultiplier('AAPL', rotation)).toBeGreaterThan(1.0);
    expect(sectorRotation.sectorBiasMultiplier('JPM', rotation)).toBeLessThan(1.0);
  });

  test('returns 1.0 when rotation is null or empty (fail-open)', () => {
    expect(sectorRotation.sectorBiasMultiplier('AAPL', null)).toBe(1.0);
    expect(sectorRotation.sectorBiasMultiplier('AAPL', { sectors: [] })).toBe(1.0);
  });

  test('returns 1.0 for symbols not in the topSymbols list', () => {
    const rotation = {
      sectors: [{ name: 'Tech', momentumScore: 2, topSymbols: [{ symbol: 'AAPL' }] }],
    };
    expect(sectorRotation.sectorBiasMultiplier('UNKNOWN', rotation)).toBe(1.0);
  });
});

describe('scoreToMultiplier', () => {
  test('clamps extreme z-scores to bounded multiplier range', () => {
    expect(sectorRotation.scoreToMultiplier(10)).toBeCloseTo(1.2, 3);
    expect(sectorRotation.scoreToMultiplier(-10)).toBeCloseTo(0.8, 3);
    expect(sectorRotation.scoreToMultiplier(0)).toBe(1.0);
  });

  test('returns 1.0 for non-finite input', () => {
    expect(sectorRotation.scoreToMultiplier(null)).toBe(1.0);
    expect(sectorRotation.scoreToMultiplier(NaN)).toBe(1.0);
    expect(sectorRotation.scoreToMultiplier(Infinity)).toBe(1.0);
  });
});
