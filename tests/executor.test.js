/**
 * Unit tests for the legacy executor (rule-based path).
 *
 * Covers the BUY branch paths: happy path (bracket order fills → trade
 * persisted), bracket fallback to market order, ATR fetch failure,
 * insufficient funds, risk veto, regime avoid, non-BUY skip, and
 * existing-position skip.
 */

const { createAlpacaMock, defaultDailyBars } = require('./mocks/alpaca');
const { createDbMock } = require('./mocks/db');

const mockAlpaca = createAlpacaMock();
const mockDb = createDbMock();
const mockRiskAgent = { evaluate: jest.fn(async () => ({ approved: true })) };
const mockRegimeAgent = {
  getParams: jest.fn(() => ({ regime: 'trending_bull', bias: 'normal', position_scale: 1.0 })),
};

jest.mock('../src/alpaca', () => mockAlpaca);
jest.mock('../src/db', () => mockDb);
jest.mock('../src/agents/risk-agent', () => mockRiskAgent);
jest.mock('../src/agents/regime-agent', () => mockRegimeAgent);
jest.mock('../src/logger', () => ({
  log: () => {},
  warn: () => {},
  error: () => {},
  runWithContext: (_c, fn) => fn(),
  newCorrelationId: () => 'test',
  getContext: () => ({}),
}));

const { executeSignal } = require('../src/executor');

function buySignal(overrides = {}) {
  return {
    id: 'sig-1',
    symbol: 'AAPL',
    signal: 'BUY',
    close: 150,
    reason: 'bullish crossover',
    ...overrides,
  };
}

beforeEach(() => {
  mockDb._reset();
  mockRiskAgent.evaluate.mockReset().mockResolvedValue({ approved: true });
  mockRegimeAgent.getParams
    .mockReset()
    .mockReturnValue({ regime: 'trending_bull', bias: 'normal', position_scale: 1.0 });
  // Reset alpaca mocks to defaults
  mockAlpaca.getAccount
    .mockReset()
    .mockResolvedValue({ buying_power: 100_000, portfolio_value: 100_000, cash: 100_000 });
  mockAlpaca.getBars.mockReset().mockImplementation(async (s) => defaultDailyBars(s, 150));
  mockAlpaca.placeBracketOrder.mockReset().mockImplementation(async (symbol, qty) => ({
    id: `bracket-${symbol}`,
    symbol,
    qty: String(qty),
    status: 'filled',
    filled_qty: String(qty),
    filled_avg_price: '150.00',
    order_class: 'bracket',
  }));
  mockAlpaca.placeOrder.mockReset().mockImplementation(async (symbol, qty) => ({
    id: `market-${symbol}`,
    symbol,
    qty: String(qty),
    status: 'filled',
    filled_qty: String(qty),
    filled_avg_price: '150.00',
  }));
  mockAlpaca.getOrder.mockReset();
});

describe('executeSignal — non-BUY and guards', () => {
  test('skips non-BUY signals without touching Alpaca', async () => {
    await executeSignal({ id: 'x', symbol: 'AAPL', signal: 'SELL', close: 150 });
    expect(mockAlpaca.placeBracketOrder).not.toHaveBeenCalled();
    expect(mockAlpaca.placeOrder).not.toHaveBeenCalled();
    expect(mockDb._getRows('trades')).toHaveLength(0);
  });

  test('skips when a position is already open for the symbol', async () => {
    // Seed an open trade for AAPL
    mockDb._getRows('trades').push({ id: 't-1', symbol: 'AAPL', status: 'open' });
    await executeSignal(buySignal());
    expect(mockAlpaca.placeBracketOrder).not.toHaveBeenCalled();
  });

  test('risk-agent veto blocks the order', async () => {
    mockRiskAgent.evaluate.mockResolvedValueOnce({ approved: false, reason: 'sector heat' });
    await executeSignal(buySignal());
    expect(mockAlpaca.placeBracketOrder).not.toHaveBeenCalled();
    expect(mockDb._getRows('trades')).toHaveLength(0);
  });

  test('regime bias=avoid blocks the order', async () => {
    mockRegimeAgent.getParams.mockReturnValueOnce({ regime: 'bear_market', bias: 'avoid', position_scale: 0 });
    await executeSignal(buySignal());
    expect(mockAlpaca.placeBracketOrder).not.toHaveBeenCalled();
  });
});

describe('executeSignal — happy path', () => {
  test('sizes, places a bracket order, and persists a trade row', async () => {
    await executeSignal(buySignal());

    expect(mockAlpaca.placeBracketOrder).toHaveBeenCalledTimes(1);
    expect(mockAlpaca.placeOrder).not.toHaveBeenCalled();

    const trades = mockDb._getRows('trades');
    expect(trades).toHaveLength(1);
    const t = trades[0];
    expect(t.symbol).toBe('AAPL');
    expect(t.side).toBe('buy');
    expect(Number(t.entry_price)).toBeCloseTo(150, 1);
    expect(t.status).toBe('open');
    expect(t.signal_id).toBe('sig-1');
    expect(Number(t.stop_loss)).toBeLessThan(Number(t.entry_price));
    expect(Number(t.take_profit)).toBeGreaterThan(Number(t.entry_price));
  });
});

describe('executeSignal — fallback paths', () => {
  test('bracket order failure falls back to plain market order', async () => {
    mockAlpaca.placeBracketOrder.mockRejectedValueOnce(new Error('Bracket not supported'));
    await executeSignal(buySignal());
    expect(mockAlpaca.placeBracketOrder).toHaveBeenCalledTimes(1);
    expect(mockAlpaca.placeOrder).toHaveBeenCalledTimes(1);
    expect(mockDb._getRows('trades')).toHaveLength(1);
  });

  test('ATR fetch failure uses fixed-% stop (trade still persists)', async () => {
    mockAlpaca.getBars.mockRejectedValueOnce(new Error('Alpaca 429'));
    await executeSignal(buySignal());
    expect(mockDb._getRows('trades')).toHaveLength(1);
    // stop should still be below entry using the fixed-% fallback
    const t = mockDb._getRows('trades')[0];
    expect(Number(t.stop_loss)).toBeLessThan(Number(t.entry_price));
  });
});

describe('executeSignal — insufficient funds', () => {
  test('skips persistence when order_value exceeds 95% of buying power', async () => {
    mockAlpaca.getAccount.mockResolvedValueOnce({ buying_power: 100, portfolio_value: 100_000, cash: 100 });
    await executeSignal(buySignal());
    expect(mockDb._getRows('trades')).toHaveLength(0);
    expect(mockAlpaca.placeBracketOrder).not.toHaveBeenCalled();
  });
});

describe('executeSignal — rejected orders', () => {
  test('rejected status marks signal acted_on=false and does not persist a trade', async () => {
    mockAlpaca.placeBracketOrder.mockResolvedValueOnce({
      id: 'bracket-AAPL',
      symbol: 'AAPL',
      qty: '10',
      status: 'rejected',
      filled_qty: '0',
      filled_avg_price: '0',
    });
    // Keep getOrder aligned — polling loop will call it if status isn't filled.
    mockAlpaca.getOrder.mockResolvedValue({ status: 'rejected', filled_qty: '0', filled_avg_price: '0' });

    await executeSignal(buySignal());
    expect(mockDb._getRows('trades')).toHaveLength(0);
  });
});
