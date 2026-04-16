/**
 * Unit tests for the Smart Order Router — pure math + enabled-flag
 * short-circuits. End-to-end fill behavior is validated by integration
 * tests with real Alpaca paper-trading.
 */

const mockAlpaca = {
  placeOrder: jest.fn(),
  placeLimitOrder: jest.fn(),
  cancelOrder: jest.fn(),
  getOrder: jest.fn(),
  getSnapshot: jest.fn(),
};
jest.mock('../src/alpaca', () => mockAlpaca);

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

const sor = require('../src/smart-order-router');

const snapshot = (bid, ask) => ({
  latestQuote: { bp: bid, ap: ask },
});

beforeEach(() => {
  Object.values(mockAlpaca).forEach((fn) => fn.mockReset?.());
  mockRuntimeConfig.get.mockReset().mockReturnValue(undefined);
});

describe('computeMidPrice', () => {
  test('returns midpoint of bid/ask', () => {
    expect(sor.computeMidPrice(snapshot(99.98, 100.02))).toBeCloseTo(100.0, 4);
  });

  test('returns null when bid or ask is missing', () => {
    expect(sor.computeMidPrice(snapshot(0, 100))).toBeNull();
    expect(sor.computeMidPrice(snapshot(100, 0))).toBeNull();
    expect(sor.computeMidPrice({})).toBeNull();
  });

  test('returns null when bid >= ask (crossed book)', () => {
    expect(sor.computeMidPrice(snapshot(101, 100))).toBeNull();
    expect(sor.computeMidPrice(snapshot(100, 100))).toBeNull();
  });
});

describe('computeLimitPrice', () => {
  test('BUY limit sits above mid by offsetBps', () => {
    // mid=100, offset=2bps → limit = 100 + (100 * 0.0002) = 100.02
    const limit = sor.computeLimitPrice(snapshot(99.98, 100.02), 'buy', 2);
    expect(limit).toBeCloseTo(100.02, 4);
  });

  test('SELL limit sits below mid by offsetBps', () => {
    const limit = sor.computeLimitPrice(snapshot(99.98, 100.02), 'sell', 2);
    expect(limit).toBeCloseTo(99.98, 4);
  });

  test('returns null when no usable quote', () => {
    expect(sor.computeLimitPrice(snapshot(0, 0), 'buy')).toBeNull();
  });
});

describe('computeSavingsBps', () => {
  test('BUY: savings positive when filled below ask', () => {
    // ask=100.02, filled=100.00 → savings = (100.02 - 100.00) / 100.02 * 10000 = ~2bps
    const savings = sor.computeSavingsBps('buy', 100.0, snapshot(99.98, 100.02));
    expect(savings).toBeGreaterThan(0);
    expect(savings).toBeLessThan(5);
  });

  test('SELL: savings positive when filled above bid', () => {
    const savings = sor.computeSavingsBps('sell', 100.0, snapshot(99.98, 100.02));
    expect(savings).toBeGreaterThan(0);
  });

  test('zero when no quote', () => {
    expect(sor.computeSavingsBps('buy', 100, snapshot(0, 0))).toBe(0);
  });
});

describe('placeSmartOrder — disabled', () => {
  test('routes straight to market when SMART_ORDER_ROUTING_ENABLED is false', async () => {
    mockAlpaca.placeOrder.mockResolvedValueOnce({ id: 'mkt-1', status: 'filled' });
    const r = await sor.placeSmartOrder({ symbol: 'AAPL', qty: 10, side: 'buy', snapshot: snapshot(99, 101) });
    expect(r.strategy).toBe('market');
    expect(r.savingsBps).toBe(0);
    expect(mockAlpaca.placeLimitOrder).not.toHaveBeenCalled();
    expect(mockAlpaca.placeOrder).toHaveBeenCalledTimes(1);
  });
});

describe('placeSmartOrder — enabled', () => {
  beforeEach(() => {
    mockRuntimeConfig.get.mockImplementation((k) => {
      if (k === 'SMART_ORDER_ROUTING_ENABLED') return true;
      if (k === 'SOR_OFFSET_BPS') return 2;
      if (k === 'SOR_TIMEOUT_MS') return 100; // fast for tests
      if (k === 'SOR_POLL_MS') return 20;
      return undefined;
    });
  });

  test('uses limit order when quote available', async () => {
    mockAlpaca.placeLimitOrder.mockResolvedValueOnce({ id: 'lim-1', status: 'new' });
    mockAlpaca.getOrder.mockResolvedValue({
      id: 'lim-1',
      status: 'filled',
      filled_qty: '10',
      filled_avg_price: '100.00',
    });
    const r = await sor.placeSmartOrder({ symbol: 'AAPL', qty: 10, side: 'buy', snapshot: snapshot(99.98, 100.02) });
    expect(r.strategy).toBe('limit');
    expect(r.savingsBps).toBeGreaterThan(0);
    expect(mockAlpaca.placeLimitOrder).toHaveBeenCalledTimes(1);
  });

  test('falls back to market when no quote available', async () => {
    mockAlpaca.placeOrder.mockResolvedValueOnce({ id: 'mkt-1', status: 'filled' });
    const r = await sor.placeSmartOrder({ symbol: 'AAPL', qty: 10, side: 'buy', snapshot: snapshot(0, 0) });
    expect(r.strategy).toBe('market_fallback');
    expect(r.reason).toBe('no_quote');
    expect(mockAlpaca.placeLimitOrder).not.toHaveBeenCalled();
  });

  test('falls back to market on timeout (no fill)', async () => {
    mockAlpaca.placeLimitOrder.mockResolvedValueOnce({ id: 'lim-1', status: 'new' });
    mockAlpaca.getOrder.mockResolvedValue({ id: 'lim-1', status: 'new', filled_qty: '0', filled_avg_price: '0' });
    mockAlpaca.cancelOrder.mockResolvedValueOnce({});
    mockAlpaca.placeOrder.mockResolvedValueOnce({ id: 'mkt-1', status: 'filled' });
    const r = await sor.placeSmartOrder({ symbol: 'AAPL', qty: 10, side: 'buy', snapshot: snapshot(99.98, 100.02) });
    expect(r.strategy).toBe('market_fallback');
    expect(r.reason).toBe('timeout_nofill');
    expect(mockAlpaca.cancelOrder).toHaveBeenCalledWith('lim-1');
    expect(mockAlpaca.placeOrder).toHaveBeenCalledTimes(1);
  });

  test('handles limit submit failure by falling back to market', async () => {
    mockAlpaca.placeLimitOrder.mockRejectedValueOnce(new Error('Alpaca 400 bad limit price'));
    mockAlpaca.placeOrder.mockResolvedValueOnce({ id: 'mkt-1', status: 'filled' });
    const r = await sor.placeSmartOrder({ symbol: 'AAPL', qty: 10, side: 'buy', snapshot: snapshot(99.98, 100.02) });
    expect(r.strategy).toBe('market_fallback');
    expect(r.reason).toBe('limit_submit_failed');
  });

  test('fetches a fresh snapshot when caller does not provide one', async () => {
    mockAlpaca.getSnapshot.mockResolvedValueOnce(snapshot(99.98, 100.02));
    mockAlpaca.placeLimitOrder.mockResolvedValueOnce({ id: 'lim-1', status: 'new' });
    mockAlpaca.getOrder.mockResolvedValue({
      id: 'lim-1',
      status: 'filled',
      filled_qty: '5',
      filled_avg_price: '100.00',
    });
    const r = await sor.placeSmartOrder({ symbol: 'AAPL', qty: 5, side: 'sell' });
    expect(mockAlpaca.getSnapshot).toHaveBeenCalledWith('AAPL');
    expect(r.strategy).toBe('limit');
  });
});
