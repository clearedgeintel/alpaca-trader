/**
 * Unit tests for persistFillEvent — the Alpaca WS bridge into the trades
 * table. We mock the DB so we can assert the SQL shape and parameters.
 */

const mockDb = { query: jest.fn() };
jest.mock('../src/db', () => mockDb);
jest.mock('../src/socket', () => ({ emit: jest.fn(), events: {} }));
jest.mock('../src/logger', () => ({
  log: () => {}, error: () => {}, warn: () => {}, alert: () => {},
  runWithContext: (_ctx, fn) => fn(),
  newCorrelationId: (p = '') => `${p}_test`,
  getContext: () => ({}),
}));

const { persistFillEvent } = require('../src/alpaca-stream');

beforeEach(() => {
  mockDb.query.mockReset();
});

describe('persistFillEvent', () => {
  test('ignores events other than fill / partial_fill', async () => {
    for (const event of ['new', 'accepted', 'canceled', 'expired', 'rejected']) {
      const result = await persistFillEvent(event, { id: 'x', filled_qty: '10', filled_avg_price: '100' });
      expect(result.updated).toBe(false);
      expect(result.reason).toMatch(/ignoring/);
    }
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('ignores when order has no id', async () => {
    const result = await persistFillEvent('fill', {});
    expect(result.updated).toBe(false);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('ignores when filled qty or price is 0/missing', async () => {
    expect((await persistFillEvent('fill', { id: 'x' })).updated).toBe(false);
    expect((await persistFillEvent('fill', { id: 'x', filled_qty: '0', filled_avg_price: '100' })).updated).toBe(false);
    expect((await persistFillEvent('fill', { id: 'x', filled_qty: '10', filled_avg_price: '0' })).updated).toBe(false);
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  test('updates trades row for a full fill', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'trade-123', symbol: 'AAPL' }] });
    const result = await persistFillEvent('fill', {
      id: 'order-abc', filled_qty: '100', filled_avg_price: '185.50',
    });
    expect(result.updated).toBe(true);
    expect(result.tradeId).toBe('trade-123');
    expect(result.filledQty).toBe(100);
    expect(result.filledPrice).toBe(185.5);
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE trades/);
    expect(sql).toMatch(/alpaca_order_id = \$3/);
    expect(params).toEqual([100, 185.5, 'order-abc']);
  });

  test('updates trades row for a partial_fill with the current filled qty', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'trade-456', symbol: 'TSLA' }] });
    const result = await persistFillEvent('partial_fill', {
      id: 'order-def', filled_qty: '40', filled_avg_price: '210.25',
    });
    expect(result.updated).toBe(true);
    expect(result.filledQty).toBe(40); // partial — not the full ordered qty
    const [, params] = mockDb.query.mock.calls[0];
    expect(params[0]).toBe(40);
    expect(params[1]).toBe(210.25);
  });

  test('returns no-match when the order id is unknown', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    const result = await persistFillEvent('fill', {
      id: 'order-unknown', filled_qty: '10', filled_avg_price: '50',
    });
    expect(result.updated).toBe(false);
    expect(result.reason).toMatch(/no matching open trade/);
  });

  test('returns error info when DB throws, does not rethrow', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('connection reset'));
    const result = await persistFillEvent('fill', {
      id: 'order-x', filled_qty: '10', filled_avg_price: '50',
    });
    expect(result.updated).toBe(false);
    expect(result.reason).toMatch(/connection reset/);
  });
});
