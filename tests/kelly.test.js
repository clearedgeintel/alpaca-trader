/**
 * Unit tests for the Kelly sizing module. DB + runtime-config mocked so
 * the math is tested against deterministic inputs. No network; no
 * real Postgres.
 */

const mockDb = { query: jest.fn() };
jest.mock('../src/db', () => mockDb);

const mockRuntimeConfig = {
  get: jest.fn(() => undefined),
  getAll: jest.fn(() => ({})),
  getEffective: jest.fn(() => ({})),
  set: jest.fn(),
  remove: jest.fn(),
  refresh: jest.fn(),
  init: jest.fn(),
};
jest.mock('../src/runtime-config', () => mockRuntimeConfig);

jest.mock('../src/logger', () => ({
  log: () => {},
  warn: () => {},
  error: () => {},
  runWithContext: (_c, fn) => fn(),
  newCorrelationId: () => 'test',
  getContext: () => ({}),
}));

const kelly = require('../src/kelly');

function trade(pnl, entryPrice = 100, qty = 10) {
  return { pnl, entry_price: entryPrice, qty };
}

beforeEach(() => {
  mockDb.query.mockReset();
  mockRuntimeConfig.get.mockReset().mockReturnValue(undefined);
});

describe('computeKellyFraction — qualifying samples', () => {
  test('positive-edge symbol produces kelly > 0 and multiplier > 1', async () => {
    // 60% win rate, avg win = 5%, avg loss = 2% → kelly f = 0.6 - 0.4 / 2.5 = 0.44 → clamped to 5%
    // half = 2.5%, baseRisk = 2% → multiplier = 1.25 (within [0.5, 2])
    const wins = Array.from({ length: 12 }, () => trade(50)); // 5% of $1000
    const losses = Array.from({ length: 8 }, () => trade(-20)); // 2% of $1000
    mockDb.query.mockResolvedValueOnce({ rows: [...wins, ...losses] });

    const r = await kelly.computeKellyFraction('AAPL', { lookbackDays: 30, minSampleSize: 20 });
    expect(r.source).toBe('kelly');
    expect(r.sampleSize).toBe(20);
    expect(r.winRate).toBeCloseTo(0.6, 2);
    expect(r.avgWin).toBeCloseTo(0.05, 2);
    expect(r.avgLoss).toBeCloseTo(0.02, 2);
    // Kelly is clamped to absolute max 5%
    expect(r.kellyF).toBeLessThanOrEqual(0.05);
    // rawKellyF preserves the unclamped value for UI
    expect(r.rawKellyF).toBeGreaterThan(0.4);
    expect(r.multiplier).toBeGreaterThan(1);
    expect(r.multiplier).toBeLessThanOrEqual(2);
  });

  test('negative-edge symbol (losing strategy) collapses multiplier to the 0.5 floor', async () => {
    // 30% win rate, avg win 2%, avg loss 3% → kelly = 0.3 - 0.7 * (3/2) = 0.3 - 1.05 = -0.75
    const wins = Array.from({ length: 6 }, () => trade(20));
    const losses = Array.from({ length: 14 }, () => trade(-30));
    mockDb.query.mockResolvedValueOnce({ rows: [...wins, ...losses] });

    const r = await kelly.computeKellyFraction('BAD', { lookbackDays: 30, minSampleSize: 20 });
    expect(r.source).toBe('kelly');
    expect(r.rawKellyF).toBeLessThan(0);
    expect(r.multiplier).toBe(kelly.MULTIPLIER_MIN);
  });

  test('respects the caller-supplied base RISK_PCT when computing the multiplier', async () => {
    const wins = Array.from({ length: 15 }, () => trade(80)); // avg +8%
    const losses = Array.from({ length: 5 }, () => trade(-20)); // avg -2%
    mockDb.query.mockResolvedValueOnce({ rows: [...wins, ...losses] });
    mockRuntimeConfig.get.mockImplementation((k) => (k === 'RISK_PCT' ? 0.04 : undefined)); // 4% base

    const r = await kelly.computeKellyFraction('X', { lookbackDays: 30, minSampleSize: 20 });
    expect(r.baseRiskPct).toBeCloseTo(0.04);
    // halfKellyF / baseRiskPct, clamped to [0.5, 2]
    const expected = r.halfKellyF / 0.04;
    const clamped = Math.max(0.5, Math.min(2, expected));
    expect(r.multiplier).toBeCloseTo(clamped, 2);
  });
});

describe('computeKellyFraction — degenerate / cold-start', () => {
  test('fewer than minSampleSize closed trades yields cold_start with multiplier 1.0', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [trade(50), trade(-20)] });
    const r = await kelly.computeKellyFraction('NEW', { minSampleSize: 20 });
    expect(r.source).toBe('cold_start');
    expect(r.multiplier).toBe(1.0);
    expect(r.sampleSize).toBe(2);
  });

  test('no closed trades returns cold_start with zero sample', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    const r = await kelly.computeKellyFraction('EMPTY', { minSampleSize: 20 });
    expect(r.source).toBe('cold_start');
    expect(r.sampleSize).toBe(0);
    expect(r.multiplier).toBe(1.0);
  });

  test('no losing trades (divide-by-zero guard) returns cold_start', async () => {
    const wins = Array.from({ length: 25 }, () => trade(50));
    mockDb.query.mockResolvedValueOnce({ rows: wins });
    const r = await kelly.computeKellyFraction('LUCKY', { minSampleSize: 20 });
    expect(r.source).toBe('cold_start');
    expect(r.multiplier).toBe(1.0);
  });

  test('ignores breakeven trades (pnl === 0)', async () => {
    const wins = Array.from({ length: 10 }, () => trade(50));
    const losses = Array.from({ length: 10 }, () => trade(-20));
    const breakevens = Array.from({ length: 5 }, () => trade(0));
    mockDb.query.mockResolvedValueOnce({ rows: [...wins, ...losses, ...breakevens] });
    const r = await kelly.computeKellyFraction('AAPL', { minSampleSize: 20 });
    expect(r.sampleSize).toBe(20); // breakevens excluded
    expect(r.winRate).toBeCloseTo(0.5);
  });

  test('DB error returns error source + multiplier 1.0', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('connection lost'));
    const r = await kelly.computeKellyFraction('X');
    expect(r.source).toBe('error');
    expect(r.multiplier).toBe(1.0);
  });
});

describe('kellyMultiplier', () => {
  test('returns 1.0 when KELLY_ENABLED is false (suggestion-only mode)', async () => {
    mockRuntimeConfig.get.mockImplementation(() => undefined); // default off
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    const m = await kelly.kellyMultiplier('AAPL');
    expect(m).toBe(1.0);
    // DB should never be queried when disabled
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('returns computed multiplier when KELLY_ENABLED is true and sample qualifies', async () => {
    mockRuntimeConfig.get.mockImplementation((k) => (k === 'KELLY_ENABLED' ? true : undefined));
    const wins = Array.from({ length: 15 }, () => trade(50));
    const losses = Array.from({ length: 5 }, () => trade(-20));
    mockDb.query.mockResolvedValueOnce({ rows: [...wins, ...losses] });
    const m = await kelly.kellyMultiplier('AAPL');
    expect(m).toBeGreaterThan(1);
    expect(m).toBeLessThanOrEqual(2);
  });

  test('returns 1.0 on cold-start even when enabled', async () => {
    mockRuntimeConfig.get.mockImplementation((k) => (k === 'KELLY_ENABLED' ? true : undefined));
    mockDb.query.mockResolvedValueOnce({ rows: [trade(50), trade(-20)] }); // only 2 trades
    const m = await kelly.kellyMultiplier('X');
    expect(m).toBe(1.0);
  });
});

describe('enabled()', () => {
  test('false by default', () => {
    mockRuntimeConfig.get.mockReturnValue(undefined);
    expect(kelly.enabled()).toBe(false);
  });

  test('true when runtime-config returns boolean true', () => {
    mockRuntimeConfig.get.mockImplementation((k) => (k === 'KELLY_ENABLED' ? true : undefined));
    expect(kelly.enabled()).toBe(true);
  });

  test('true when runtime-config returns string "true"', () => {
    mockRuntimeConfig.get.mockImplementation((k) => (k === 'KELLY_ENABLED' ? 'true' : undefined));
    expect(kelly.enabled()).toBe(true);
  });
});

describe('computeForSymbols', () => {
  test('returns one result per input symbol, preserving order', async () => {
    mockDb.query.mockImplementation(async () => ({ rows: [] }));
    const r = await kelly.computeForSymbols(['AAPL', 'TSLA', 'MSFT']);
    expect(r).toHaveLength(3);
    expect(r.map((x) => x.symbol)).toEqual(['AAPL', 'TSLA', 'MSFT']);
  });
});
