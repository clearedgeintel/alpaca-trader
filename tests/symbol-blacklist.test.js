/**
 * Unit tests for the per-symbol intraday P&L guards + consecutive-loss
 * blacklist.
 */

const mockDb = { query: jest.fn() };
jest.mock('../src/db', () => mockDb);
jest.mock('../src/logger', () => ({
  log: () => {},
  warn: () => {},
  error: () => {},
  alert: () => {},
  runWithContext: (_ctx, fn) => fn(),
  newCorrelationId: () => 'test',
  getContext: () => ({}),
}));

const { checkSymbolGuards } = require('../src/symbol-blacklist');

function dayPnlRow(pnl) {
  return { rows: [{ day_pnl: pnl }] };
}

function streakRows(pnls) {
  return { rows: pnls.map((p) => ({ pnl: p })) };
}

beforeEach(() => {
  mockDb.query.mockReset();
});

describe('day-loss cap', () => {
  test('allows a trade when today P&L is flat', async () => {
    mockDb.query.mockResolvedValueOnce(dayPnlRow(0));
    mockDb.query.mockResolvedValueOnce(streakRows([]));
    const r = await checkSymbolGuards('AAPL', 100000);
    expect(r.blocked).toBe(false);
  });

  test('allows a winning symbol regardless of magnitude', async () => {
    mockDb.query.mockResolvedValueOnce(dayPnlRow(5000));
    mockDb.query.mockResolvedValueOnce(streakRows([]));
    const r = await checkSymbolGuards('AAPL', 100000);
    expect(r.blocked).toBe(false);
  });

  test('blocks when day loss exceeds 1.5% of portfolio (default)', async () => {
    // -2000 on a 100k portfolio = 2% loss > 1.5% cap
    mockDb.query.mockResolvedValueOnce(dayPnlRow(-2000));
    const r = await checkSymbolGuards('AAPL', 100000);
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/day-loss cap/);
    expect(r.dayPnl).toBe(-2000);
  });

  test('allows when day loss is under the cap', async () => {
    // -1000 on a 100k portfolio = 1% loss, under 1.5%
    mockDb.query.mockResolvedValueOnce(dayPnlRow(-1000));
    mockDb.query.mockResolvedValueOnce(streakRows([]));
    const r = await checkSymbolGuards('AAPL', 100000);
    expect(r.blocked).toBe(false);
    expect(r.dayPnl).toBe(-1000);
  });

  test('does not block if portfolio value is unknown (divide-by-zero guard)', async () => {
    mockDb.query.mockResolvedValueOnce(dayPnlRow(-5000));
    mockDb.query.mockResolvedValueOnce(streakRows([]));
    const r = await checkSymbolGuards('AAPL', 0);
    expect(r.blocked).toBe(false);
  });
});

describe('consecutive-loss blacklist', () => {
  test('blocks after 3 consecutive losers (default threshold)', async () => {
    mockDb.query.mockResolvedValueOnce(dayPnlRow(-100));
    mockDb.query.mockResolvedValueOnce(streakRows([-50, -75, -40]));
    const r = await checkSymbolGuards('TSLA', 100000);
    expect(r.blocked).toBe(true);
    expect(r.reason).toMatch(/3 consecutive losses/);
  });

  test('does not block when streak is interrupted by a winner', async () => {
    mockDb.query.mockResolvedValueOnce(dayPnlRow(-100));
    mockDb.query.mockResolvedValueOnce(streakRows([-50, 200, -75]));
    const r = await checkSymbolGuards('TSLA', 100000);
    expect(r.blocked).toBe(false);
    expect(r.streak).toBe(1);
  });

  test('does not block when there are fewer than N closed trades', async () => {
    mockDb.query.mockResolvedValueOnce(dayPnlRow(-100));
    mockDb.query.mockResolvedValueOnce(streakRows([-50, -75])); // only 2 losers
    const r = await checkSymbolGuards('TSLA', 100000);
    expect(r.blocked).toBe(false);
    expect(r.streak).toBe(2);
  });
});

describe('DB failure handling', () => {
  test('fails open (does not block) when DB query throws', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('connection reset'));
    const r = await checkSymbolGuards('AAPL', 100000);
    expect(r.blocked).toBe(false);
  });
});
