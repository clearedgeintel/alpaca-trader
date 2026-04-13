/**
 * Unit tests for the trade reconciler — assert diff logic and the
 * three auto-resolve scenarios (orphanPositions, orphanTrades,
 * qtyMismatches) produce the expected SQL.
 */

const mockDb = { query: jest.fn() };
const mockAlpaca = { getPositions: jest.fn() };

jest.mock('../src/db', () => mockDb);
jest.mock('../src/alpaca', () => mockAlpaca);
jest.mock('../src/logger', () => ({
  log: () => {}, warn: () => {}, error: () => {}, alert: () => {},
  runWithContext: (_ctx, fn) => fn(),
  newCorrelationId: (p = '') => `${p}_test`,
  getContext: () => ({}),
}));

const { computeDiff, runReconciliation } = require('../src/reconciler');

function dbOpenTradesReturning(rows) {
  mockDb.query.mockImplementationOnce(async (sql) => {
    if (/status = 'open'/i.test(sql)) return { rows };
    return { rows: [] };
  });
}

beforeEach(() => {
  mockDb.query.mockReset();
  mockAlpaca.getPositions.mockReset();
});

describe('computeDiff', () => {
  test('returns empty arrays when both sides agree', async () => {
    mockAlpaca.getPositions.mockResolvedValue([
      { symbol: 'AAPL', qty: '100', avg_entry_price: '150', current_price: '155', market_value: '15500' },
    ]);
    dbOpenTradesReturning([
      { id: 't1', symbol: 'AAPL', qty: 100, entry_price: '150', current_price: '155', status: 'open' },
    ]);

    const diff = await computeDiff();
    expect(diff.orphanPositions).toHaveLength(0);
    expect(diff.orphanTrades).toHaveLength(0);
    expect(diff.qtyMismatches).toHaveLength(0);
  });

  test('flags orphan Alpaca position (DB missing)', async () => {
    mockAlpaca.getPositions.mockResolvedValue([
      { symbol: 'TSLA', qty: '50', avg_entry_price: '200', current_price: '210', market_value: '10500' },
    ]);
    dbOpenTradesReturning([]);

    const diff = await computeDiff();
    expect(diff.orphanPositions).toHaveLength(1);
    expect(diff.orphanPositions[0]).toEqual({
      symbol: 'TSLA',
      alpacaQty: 50,
      avgEntryPrice: 200,
      currentPrice: 210,
      marketValue: 10500,
    });
  });

  test('flags orphan DB trade (Alpaca flat)', async () => {
    mockAlpaca.getPositions.mockResolvedValue([]);
    dbOpenTradesReturning([
      { id: 't9', symbol: 'NVDA', qty: 25, entry_price: '500', current_price: '510', status: 'open' },
    ]);

    const diff = await computeDiff();
    expect(diff.orphanTrades).toHaveLength(1);
    expect(diff.orphanTrades[0]).toEqual({
      symbol: 'NVDA', tradeId: 't9', dbQty: 25, entryPrice: 500, lastKnownPrice: 510,
    });
  });

  test('flags qty mismatch when both sides have the symbol', async () => {
    mockAlpaca.getPositions.mockResolvedValue([
      { symbol: 'MSFT', qty: '80', avg_entry_price: '300', current_price: '305', market_value: '24400' },
    ]);
    dbOpenTradesReturning([
      { id: 't5', symbol: 'MSFT', qty: 100, entry_price: '300', current_price: '305', status: 'open' },
    ]);

    const diff = await computeDiff();
    expect(diff.qtyMismatches).toHaveLength(1);
    expect(diff.qtyMismatches[0]).toEqual({
      symbol: 'MSFT', tradeId: 't5', dbQty: 100, alpacaQty: 80, delta: -20, currentPrice: 305,
    });
  });

  test('tolerates sub-1-share differences (fractional rounding)', async () => {
    mockAlpaca.getPositions.mockResolvedValue([
      { symbol: 'SPY', qty: '10.4', avg_entry_price: '400', current_price: '405', market_value: '4212' },
    ]);
    dbOpenTradesReturning([
      { id: 't2', symbol: 'SPY', qty: 10, entry_price: '400', current_price: '405', status: 'open' },
    ]);

    const diff = await computeDiff();
    expect(diff.qtyMismatches).toHaveLength(0);
  });
});

describe('runReconciliation', () => {
  test('dryRun returns diff without calling UPDATE/INSERT', async () => {
    mockAlpaca.getPositions.mockResolvedValue([
      { symbol: 'TSLA', qty: '50', avg_entry_price: '200', current_price: '210', market_value: '10500' },
    ]);
    dbOpenTradesReturning([]);

    const result = await runReconciliation({ dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.diff.orphanPositions).toHaveLength(1);
    expect(result.resolved).toEqual({ orphanPositions: 0, orphanTrades: 0, qtyMismatches: 0 });
    // Only the SELECT fired — no INSERTs
    const inserts = mockDb.query.mock.calls.filter(([sql]) => /INSERT|UPDATE/i.test(sql));
    expect(inserts).toHaveLength(0);
  });

  test('inserts trade row for orphan Alpaca position', async () => {
    mockAlpaca.getPositions.mockResolvedValue([
      { symbol: 'TSLA', qty: '50', avg_entry_price: '200', current_price: '210', market_value: '10500' },
    ]);
    dbOpenTradesReturning([]);
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'new' }] });

    const result = await runReconciliation({ dryRun: false });
    expect(result.resolved.orphanPositions).toBe(1);
    const inserts = mockDb.query.mock.calls.filter(([sql]) => /INSERT INTO trades/i.test(sql));
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toEqual(['TSLA', 50, 200, 210, 10500]);
  });

  test('closes DB trade at last known price when Alpaca is flat', async () => {
    mockAlpaca.getPositions.mockResolvedValue([]);
    dbOpenTradesReturning([
      { id: 't9', symbol: 'NVDA', qty: 25, entry_price: '500', current_price: '510', status: 'open' },
    ]);
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const result = await runReconciliation({ dryRun: false });
    expect(result.resolved.orphanTrades).toBe(1);
    const updates = mockDb.query.mock.calls.filter(([sql]) => /UPDATE trades[\s\S]+status = 'closed'/i.test(sql));
    expect(updates).toHaveLength(1);
    // P&L = (510 - 500) * 25 = 250
    const params = updates[0][1];
    expect(params[0]).toBe(510); // exit_price
    expect(params[1]).toBe(250); // pnl
    expect(params[3]).toBe('t9');
  });

  test('syncs qty mismatch', async () => {
    mockAlpaca.getPositions.mockResolvedValue([
      { symbol: 'MSFT', qty: '80', avg_entry_price: '300', current_price: '305', market_value: '24400' },
    ]);
    dbOpenTradesReturning([
      { id: 't5', symbol: 'MSFT', qty: 100, entry_price: '300', current_price: '305', status: 'open' },
    ]);
    mockDb.query.mockResolvedValueOnce({ rows: [] });

    const result = await runReconciliation({ dryRun: false });
    expect(result.resolved.qtyMismatches).toBe(1);
    const updates = mockDb.query.mock.calls.filter(([sql]) => /UPDATE trades[\s\S]+SET qty/i.test(sql));
    expect(updates).toHaveLength(1);
    expect(updates[0][1]).toEqual([80, 305, 't5']);
  });

  test('short-circuits early when no discrepancies', async () => {
    mockAlpaca.getPositions.mockResolvedValue([
      { symbol: 'AAPL', qty: '100', avg_entry_price: '150', current_price: '155', market_value: '15500' },
    ]);
    dbOpenTradesReturning([
      { id: 't1', symbol: 'AAPL', qty: 100, entry_price: '150', current_price: '155', status: 'open' },
    ]);

    const result = await runReconciliation({ dryRun: false });
    expect(result.resolved).toEqual({ orphanPositions: 0, orphanTrades: 0, qtyMismatches: 0 });
    const writes = mockDb.query.mock.calls.filter(([sql]) => /^(INSERT|UPDATE)/i.test(sql.trim()));
    expect(writes).toHaveLength(0);
  });
});
