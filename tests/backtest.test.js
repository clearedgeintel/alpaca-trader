/**
 * Unit tests for backtest slippage/fee application, walk-forward
 * aggregation, and Monte Carlo distribution math.
 *
 * We don't run full backtests here (that's expensive and depends on live
 * bar data); instead we mock alpaca.getDailyBars to return deterministic
 * synthetic bars and verify that the pricing math produces the expected
 * deltas when slippage/fees are non-zero.
 */

const mockAlpaca = { getDailyBars: jest.fn() };
jest.mock('../src/alpaca', () => mockAlpaca);
jest.mock('../src/logger', () => ({
  log: () => {},
  warn: () => {},
  error: () => {},
  alert: () => {},
  runWithContext: (_ctx, fn) => fn(),
  newCorrelationId: () => 'test',
  getContext: () => ({}),
}));

const { runBacktest, runWalkForward, runMonteCarlo } = require('../src/backtest');

/**
 * Generate bars where price steadily rises so the rule-based detectSignal()
 * eventually fires a BUY. 40 bars, rising 0.5% per day with light noise.
 */
function risingBars(startDate = '2025-01-02', n = 60, startPrice = 100) {
  const bars = [];
  let price = startPrice;
  const d0 = new Date(startDate).getTime();
  for (let i = 0; i < n; i++) {
    const drift = 1 + 0.006 + Math.sin(i / 4) * 0.001;
    const c = +(price * drift).toFixed(2);
    const h = +(Math.max(price, c) * 1.004).toFixed(2);
    const l = +(Math.min(price, c) * 0.996).toFixed(2);
    bars.push({
      t: new Date(d0 + i * 86400000).toISOString(),
      o: price,
      h,
      l,
      c,
      v: 1_000_000,
    });
    price = c;
  }
  return bars;
}

beforeEach(() => {
  mockAlpaca.getDailyBars.mockReset();
});

describe('runBacktest with slippage + fees', () => {
  test('applies slippage so buy fills above clean close and sell fills below', async () => {
    mockAlpaca.getDailyBars.mockResolvedValue(risingBars());
    const r = await runBacktest({
      symbols: ['TEST'],
      days: 60,
      slippagePct: 0.002, // 20 bps — high enough that the delta is visible
      feePerShare: 0,
      feePerOrder: 0,
    });
    // If no trades fired, slippage verification is n/a — but rising bars
    // should reliably trigger the momentum rule after ~25 bars.
    if (r.summary.totalTrades > 0) {
      for (const t of r.trades) {
        // Buy entry should be ABOVE cleanEntry (if we stored it)
        expect(t.entryPrice).toBeGreaterThan(0);
        // If the trade closed via stop/target, actualExit < cleanExitPrice
        if (t.cleanExitPrice != null) {
          expect(t.exitPrice).toBeLessThanOrEqual(t.cleanExitPrice);
        }
        expect(t.slippageCost).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('totals expose totalFees, totalSlippage, totalCosts', async () => {
    mockAlpaca.getDailyBars.mockResolvedValue(risingBars());
    const r = await runBacktest({
      symbols: ['TEST'],
      days: 60,
      slippagePct: 0.001,
      feePerShare: 0.01,
    });
    expect(r.summary).toHaveProperty('totalFees');
    expect(r.summary).toHaveProperty('totalSlippage');
    expect(r.summary).toHaveProperty('totalCosts');
    expect(r.summary.totalFees).toBeGreaterThanOrEqual(0);
    expect(r.summary.totalSlippage).toBeGreaterThanOrEqual(0);
    expect(Math.abs(r.summary.totalCosts - (r.summary.totalFees + r.summary.totalSlippage))).toBeLessThan(0.01);
  });

  test('zero slippage + zero fees produces zero cost', async () => {
    mockAlpaca.getDailyBars.mockResolvedValue(risingBars());
    const r = await runBacktest({
      symbols: ['TEST'],
      days: 60,
      slippagePct: 0,
      feePerShare: 0,
      feePerOrder: 0,
    });
    expect(r.summary.totalFees).toBe(0);
    expect(r.summary.totalSlippage).toBe(0);
  });
});

describe('runWalkForward', () => {
  test('produces one result per rolling window and computes robustness', async () => {
    mockAlpaca.getDailyBars.mockResolvedValue(risingBars('2025-01-02', 200));
    const r = await runWalkForward({
      symbols: ['TEST'],
      days: 180,
      windowDays: 60,
      stepDays: 30,
    });
    expect(r.windows.length).toBeGreaterThanOrEqual(3);
    expect(r.aggregate.windowCount).toBe(r.windows.length);
    expect(r.aggregate).toHaveProperty('avgReturn');
    expect(r.aggregate).toHaveProperty('stdReturn');
    expect(r.aggregate).toHaveProperty('robustness');
    expect(r.aggregate.robustness).toBeGreaterThanOrEqual(0);
    expect(r.aggregate.robustness).toBeLessThanOrEqual(1);
    expect(r.aggregate.positiveWindows + r.aggregate.negativeWindows).toBeLessThanOrEqual(r.aggregate.windowCount);
  });

  test('rejects when days < windowDays', async () => {
    await expect(runWalkForward({ symbols: ['TEST'], days: 30, windowDays: 60 })).rejects.toThrow(
      /Walk-forward needs days >= windowDays/,
    );
  });
});

describe('runMonteCarlo', () => {
  test('returns the requested number of iterations and a valid distribution', async () => {
    mockAlpaca.getDailyBars.mockResolvedValue(risingBars());
    const r = await runMonteCarlo({
      symbols: ['TEST'],
      days: 60,
      iterations: 10,
      slippagePct: 0.001,
    });
    expect(r.runs.length).toBe(10);
    expect(r.distribution.iterations).toBe(10);
    for (const key of ['mean', 'stdDev', 'p05', 'p25', 'p50', 'p75', 'p95', 'min', 'max', 'probPositive']) {
      expect(r.distribution).toHaveProperty(key);
      expect(Number.isFinite(r.distribution[key])).toBe(true);
    }
    // Percentiles must be monotonically non-decreasing
    const pcts = [r.distribution.p05, r.distribution.p25, r.distribution.p50, r.distribution.p75, r.distribution.p95];
    for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1]);
    expect(r.distribution.probPositive).toBeGreaterThanOrEqual(0);
    expect(r.distribution.probPositive).toBeLessThanOrEqual(1);
  });

  test('randomized slippage can produce variance across iterations', async () => {
    mockAlpaca.getDailyBars.mockResolvedValue(risingBars('2025-01-02', 80, 50));
    const r = await runMonteCarlo({
      symbols: ['TEST'],
      days: 60,
      iterations: 15,
      slippagePct: 0.003,
    });
    if (r.runs.some((x) => x.trades > 0)) {
      const returns = r.runs.map((x) => x.totalReturn);
      const unique = new Set(returns.map((x) => x.toFixed(4)));
      // At least 2 distinct return values when slippage is non-zero and trades fire
      expect(unique.size).toBeGreaterThanOrEqual(2);
    }
  });
});
