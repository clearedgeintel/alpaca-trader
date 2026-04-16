/**
 * Unit tests for the daily digest scheduler — sendDigest content shape
 * and shouldFireNow scheduling logic.
 */

const mockDb = { query: jest.fn(async () => ({ rows: [] })) };
const mockAlpaca = {
  getAccount: jest.fn(async () => ({ portfolio_value: 100000 })),
  getPositions: jest.fn(async () => []),
};
const mockLlm = {
  getUsage: jest.fn(() => ({
    estimatedCostUsd: 0.42,
    callCount: 50,
    totalInputTokens: 5000,
    cacheReadTokens: 15000,
  })),
};
const mockAlerting = { alert: jest.fn(async () => {}) };

jest.mock('../src/db', () => mockDb);
jest.mock('../src/alpaca', () => mockAlpaca);
jest.mock('../src/agents/llm', () => mockLlm);
jest.mock('../src/alerting', () => mockAlerting);
jest.mock('../src/logger', () => ({
  log: () => {},
  warn: () => {},
  error: () => {},
  alert: () => {},
  runWithContext: (_ctx, fn) => fn(),
  newCorrelationId: () => 'test',
  getContext: () => ({}),
}));

const { sendDigest, shouldFireNow, _resetForTests } = require('../src/daily-digest');
const { DateTime } = require('luxon');

beforeEach(() => {
  mockDb.query.mockReset().mockResolvedValue({ rows: [] });
  mockAlpaca.getAccount.mockReset().mockResolvedValue({ portfolio_value: 100000 });
  mockAlpaca.getPositions.mockReset().mockResolvedValue([]);
  mockAlerting.alert.mockReset();
});

describe('sendDigest', () => {
  test('sends an info-severity alert with summary fields', async () => {
    mockDb.query.mockImplementation(async (sql) => {
      if (/FROM daily_performance/.test(sql)) {
        return { rows: [{ total_pnl: 250, total_trades: 4, win_rate: 75, portfolio_value: 100250 }] };
      }
      return { rows: [] };
    });
    mockAlpaca.getPositions.mockResolvedValue([
      { symbol: 'AAPL', qty: '10', avg_entry_price: '150', unrealized_pl: '50', unrealized_plpc: '0.005' },
    ]);

    await sendDigest();

    expect(mockAlerting.alert).toHaveBeenCalledTimes(1);
    const arg = mockAlerting.alert.mock.calls[0][0];
    expect(arg.severity).toBe('info');
    expect(arg.title).toMatch(/Daily digest/);
    expect(arg.message).toMatch(/Realized P&L:.*\+\$250\.00/);
    expect(arg.message).toMatch(/4 trades, 75% win/);
    expect(arg.message).toMatch(/AAPL/);
    expect(arg.message).toMatch(/cache hit 75%/);
    expect(arg.metadata.totalPnl).toBe(250);
    expect(arg.metadata.totalTrades).toBe(4);
  });

  test('falls back to closed-trades aggregate when daily_performance is empty', async () => {
    mockDb.query.mockImplementation(async (sql) => {
      if (/FROM daily_performance/.test(sql)) return { rows: [] };
      if (/FROM trades/.test(sql)) {
        return { rows: [{ n: 3, total_pnl: -120, wins: 1 }] };
      }
      return { rows: [] };
    });

    await sendDigest();
    const arg = mockAlerting.alert.mock.calls[0][0];
    expect(arg.message).toMatch(/\$-120\.00/);
    expect(arg.message).toMatch(/3 trades, 33\.3% win/);
  });

  test('handles zero open positions gracefully', async () => {
    await sendDigest();
    const arg = mockAlerting.alert.mock.calls[0][0];
    expect(arg.message).toMatch(/0 open positions/);
    expect(arg.message).not.toMatch(/Open positions:/);
  });

  test('truncates open-positions list after 10 entries', async () => {
    const lots = Array.from({ length: 15 }, (_, i) => ({
      symbol: `SYM${i}`,
      qty: '5',
      avg_entry_price: '10',
      unrealized_pl: '1',
      unrealized_plpc: '0.001',
    }));
    mockAlpaca.getPositions.mockResolvedValue(lots);

    await sendDigest();
    const msg = mockAlerting.alert.mock.calls[0][0].message;
    expect(msg).toMatch(/and 5 more/);
  });

  test('survives Alpaca getPositions errors', async () => {
    mockAlpaca.getPositions.mockRejectedValue(new Error('Alpaca down'));
    await expect(sendDigest()).resolves.not.toThrow();
    expect(mockAlerting.alert).toHaveBeenCalledTimes(1);
  });
});

describe('shouldFireNow', () => {
  // We test by passing a synthetic DateTime to bypass real-time.
  function et(iso) {
    return DateTime.fromISO(iso, { zone: 'America/New_York' });
  }

  beforeEach(() => {
    _resetForTests();
  });

  test('fires on a weekday after the configured time when not yet sent today', () => {
    delete process.env.DAILY_DIGEST_TIME_ET;
    // Tuesday April 14 2026 at 16:30 ET — past default 16:05
    expect(shouldFireNow(et('2026-04-14T16:30:00'))).toBe(true);
  });

  test('does not fire before the configured time', () => {
    delete process.env.DAILY_DIGEST_TIME_ET;
    expect(shouldFireNow(et('2026-04-14T15:00:00'))).toBe(false);
  });

  test('does not fire on Saturday', () => {
    expect(shouldFireNow(et('2026-04-18T18:00:00'))).toBe(false);
  });

  test('does not fire on Sunday', () => {
    expect(shouldFireNow(et('2026-04-19T18:00:00'))).toBe(false);
  });

  test('honors DAILY_DIGEST_TIME_ET override', () => {
    process.env.DAILY_DIGEST_TIME_ET = '20:00';
    expect(shouldFireNow(et('2026-04-14T17:00:00'))).toBe(false);
    expect(shouldFireNow(et('2026-04-14T20:30:00'))).toBe(true);
    delete process.env.DAILY_DIGEST_TIME_ET;
  });
});
