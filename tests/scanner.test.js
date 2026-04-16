/**
 * Unit tests for the legacy scanner — watchlist build, per-symbol gating,
 * signal detection, and batched runScan. Mocks Alpaca + DB + executor +
 * strategy so the test isolates scanner's orchestration logic from
 * downstream writes.
 */

const { createAlpacaMock, defaultDailyBars } = require('./mocks/alpaca');
const { createDbMock } = require('./mocks/db');

const mockAlpaca = createAlpacaMock();
const mockDb = createDbMock();
const mockExecutor = { executeSignal: jest.fn(async () => {}) };
const mockStrategy = { usesRules: jest.fn(() => true) };
const mockIndicators = { detectSignal: jest.fn() };

jest.mock('../src/alpaca', () => mockAlpaca);
jest.mock('../src/db', () => mockDb);
jest.mock('../src/executor', () => mockExecutor);
jest.mock('../src/strategy', () => mockStrategy);
jest.mock('../src/indicators', () => mockIndicators);
jest.mock('../src/logger', () => ({
  log: () => {},
  warn: () => {},
  error: () => {},
  runWithContext: (_c, fn) => fn(),
  newCorrelationId: () => 'test',
  getContext: () => ({}),
}));

const scanner = require('../src/scanner');

beforeEach(() => {
  mockDb._reset();
  mockExecutor.executeSignal.mockReset().mockResolvedValue(undefined);
  mockStrategy.usesRules.mockReset().mockReturnValue(true);
  mockAlpaca.getMostActive.mockReset().mockResolvedValue([]);
  mockAlpaca.getTopMovers.mockReset().mockResolvedValue({ gainers: [], losers: [] });
  mockAlpaca.getBars.mockReset().mockImplementation(async (s) => defaultDailyBars(s));
  // Default: no signal. Individual tests override to produce BUY.
  mockIndicators.detectSignal.mockReset().mockReturnValue({
    signal: 'NONE',
    reason: 'default',
    close: 100,
    ema9: 100,
    ema21: 100,
    rsi: 50,
    volume: 1_000_000,
    avg_volume: 1_000_000,
    volume_ratio: 1.0,
  });
});

describe('buildWatchlist (via runScan)', () => {
  test('merges static + active + gainers + losers, deduping', async () => {
    mockAlpaca.getMostActive.mockResolvedValueOnce([
      { symbol: 'AAPL', volume: 1_000_000 }, // duplicate of static — should dedupe
      { symbol: 'PLTR', volume: 800_000 },
      { symbol: 'RARE', volume: 100_000 }, // below 500k — should skip
    ]);
    mockAlpaca.getTopMovers.mockResolvedValueOnce({
      gainers: [{ symbol: 'GAIN', percent_change: 3.2, price: 50 }],
      losers: [{ symbol: 'LOSE', percent_change: -3.0, price: 30 }],
    });

    await scanner.runScan();
    const last = scanner.getLastScan();

    expect(last.watchlist).toContain('PLTR');
    expect(last.watchlist).toContain('GAIN');
    expect(last.watchlist).toContain('LOSE');
    expect(last.watchlist).not.toContain('RARE'); // volume floor
    // AAPL should appear exactly once (dedupe)
    expect(last.watchlist.filter((s) => s === 'AAPL')).toHaveLength(1);
  });

  test('falls back to static watchlist when Alpaca screener throws', async () => {
    mockAlpaca.getMostActive.mockRejectedValueOnce(new Error('Alpaca 500'));
    await scanner.runScan();
    const last = scanner.getLastScan();
    // Falls back to config.WATCHLIST — should still run on those symbols
    expect(last.symbolCount).toBeGreaterThan(0);
    expect(last.watchlist).toContain('AAPL'); // always in static watchlist
  });

  test('skips gainers outside $10-$500 price band', async () => {
    mockAlpaca.getTopMovers.mockResolvedValueOnce({
      gainers: [
        { symbol: 'CHEAP', percent_change: 5, price: 3 }, // too cheap
        { symbol: 'PRICY', percent_change: 5, price: 900 }, // too expensive
        { symbol: 'JUST', percent_change: 5, price: 100 },
      ],
      losers: [],
    });
    await scanner.runScan();
    const last = scanner.getLastScan();
    expect(last.watchlist).toContain('JUST');
    expect(last.watchlist).not.toContain('CHEAP');
    expect(last.watchlist).not.toContain('PRICY');
  });
});

describe('scanSymbol gating', () => {
  test('skips symbols configured as llm-only strategy', async () => {
    mockStrategy.usesRules.mockImplementation((sym) => sym !== 'AAPL');
    await scanner.runScan();
    const last = scanner.getLastScan();
    const aapl = last.results.find((r) => r.symbol === 'AAPL');
    expect(aapl?.status).toBe('skipped');
    expect(aapl?.reason).toMatch(/llm-only/);
  });

  test('skips when bars returned are shorter than EMA_SLOW + 2', async () => {
    mockAlpaca.getBars.mockImplementation(async (s) => {
      // EMA_SLOW=21 → need >=23 bars. Return 10.
      return defaultDailyBars(s).slice(0, 10);
    });
    await scanner.runScan();
    const last = scanner.getLastScan();
    const skipped = last.results.filter((r) => r.status === 'skipped');
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped[0].reason).toMatch(/insufficient bars/);
  });

  test('does not insert signal or call executor when detectSignal returns NONE', async () => {
    // Default synthetic bars produce NONE most of the time — verify no inserts.
    await scanner.runScan();
    expect(mockExecutor.executeSignal).not.toHaveBeenCalled();
    expect(mockDb._getRows('signals')).toHaveLength(0);
  });
});

describe('scanSymbol with BUY signal', () => {
  test('inserts signal row and forwards to executor.executeSignal in a transaction', async () => {
    mockIndicators.detectSignal.mockReturnValue({
      signal: 'BUY',
      reason: 'bullish crossover',
      close: 150,
      ema9: 151,
      ema21: 148,
      rsi: 55,
      volume: 2_000_000,
      avg_volume: 1_000_000,
      volume_ratio: 2.0,
    });

    await scanner.runScan();

    const signals = mockDb._getRows('signals');
    const buys = signals.filter((s) => s.signal === 'BUY');
    expect(buys.length).toBeGreaterThan(0);
    expect(mockExecutor.executeSignal).toHaveBeenCalled();
    const firstCall = mockExecutor.executeSignal.mock.calls[0];
    expect(firstCall[0]).toMatchObject({ signal: 'BUY', reason: 'bullish crossover' });
    expect(firstCall[0].id).toBeDefined(); // signal_id threaded through
    expect(firstCall[1]).toBeDefined(); // transactional client passed
  });
});

describe('runScan resilience', () => {
  test('continues batch when one symbol throws', async () => {
    // getBars throws for one symbol; others succeed.
    let calls = 0;
    mockAlpaca.getBars.mockImplementation(async (s) => {
      calls++;
      if (calls === 2) throw new Error('Alpaca 429');
      return defaultDailyBars(s);
    });

    await expect(scanner.runScan()).resolves.not.toThrow();
    const last = scanner.getLastScan();
    // Most symbols still produced results despite the one failure
    expect(last.results.length).toBeGreaterThan(0);
  });
});

describe('getLastScan shape', () => {
  test('reports signalsFound / scanned / skipped counts', async () => {
    mockStrategy.usesRules.mockImplementation(() => false);
    await scanner.runScan();
    const last = scanner.getLastScan();
    expect(last.skipped).toBeGreaterThan(0);
    expect(last.scanned).toBe(0);
    expect(last.signalsFound).toBe(0);
  });
});
