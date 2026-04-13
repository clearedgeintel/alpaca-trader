/**
 * Integration tests for the critical trade lifecycle:
 * orchestrator decision -> execution agent -> (risk veto) -> Alpaca order ->
 * atomic signal+trade+decision-link write -> rollback semantics.
 *
 * These tests mock Alpaca, DB, and dependent agents. They run the real
 * execution-agent code path so regressions in sizing, transactions, or
 * retries will surface here.
 *
 * NOTE: jest.mock() factories are hoisted above imports. Variables
 * referenced inside them must be prefixed with "mock" to be allowed.
 */

const { createAlpacaMock } = require('../mocks/alpaca');
const { createDbMock } = require('../mocks/db');

// Names must start with "mock" per Jest's jest.mock() hoisting rules
const mockAlpaca = createAlpacaMock();
const mockDb = createDbMock();
const mockRiskAgent = { evaluate: jest.fn(async () => ({ approved: true, adjustments: {} })) };
const mockRegimeAgent = { getParams: jest.fn(() => ({ regime: 'trending_bull', bias: 'long', position_scale: 1.0 })) };
const mockNewsAgent = { getCriticalAlert: jest.fn(() => null) };
const mockTechnicalAgent = { getSymbolReport: jest.fn(() => null) };
const mockMessageBus = { publish: jest.fn(async () => {}) };
const mockSocket = { emit: jest.fn(), events: { tradeUpdate: jest.fn(), tradeClosed: jest.fn(), accountUpdate: jest.fn(), agentReport: jest.fn() } };

jest.mock('../../src/alpaca', () => mockAlpaca);
jest.mock('../../src/db', () => mockDb);
jest.mock('../../src/agents/risk-agent', () => mockRiskAgent);
jest.mock('../../src/agents/regime-agent', () => mockRegimeAgent);
jest.mock('../../src/agents/news-agent', () => mockNewsAgent);
jest.mock('../../src/agents/technical-agent', () => mockTechnicalAgent);
jest.mock('../../src/agents/message-bus', () => ({ messageBus: mockMessageBus }));
jest.mock('../../src/socket', () => mockSocket);
jest.mock('../../src/logger', () => ({
  log: () => {}, error: () => {}, warn: () => {}, alert: () => {},
  runWithContext: (_ctx, fn) => fn(),
  newCorrelationId: (p = '') => `${p}_test`,
  getContext: () => ({}),
}));

const executionAgent = require('../../src/agents/execution-agent');

beforeEach(() => {
  mockDb._reset();
  jest.clearAllMocks();
  // Re-apply default mock implementations after clearAllMocks()
  mockAlpaca.getAccount.mockResolvedValue({ buying_power: 100000, portfolio_value: 100000, cash: 100000 });
  mockAlpaca.getSnapshot.mockImplementation(async (symbol) => ({
    symbol,
    latestTrade: { p: 100, s: 100, t: new Date().toISOString() },
    minuteBar: { c: 100 },
    dailyBar: { c: 100, o: 99, h: 101, l: 98, v: 500000 },
    prevDailyBar: { c: 98 },
  }));
  mockAlpaca.getDailyBars.mockImplementation(async (_symbol) => {
    // 30 bars with sinusoidal variance so ATR/RSI produce non-null values
    const bars = [];
    for (let i = 0; i < 30; i++) {
      const c = 100 + Math.sin(i / 3) * 2;
      bars.push({ t: new Date(Date.now() - (29 - i) * 86400000).toISOString(),
        o: c - 0.5, h: c + 0.8, l: c - 0.8, c, v: 1000000 });
    }
    return bars;
  });
  mockAlpaca.placeOrder.mockImplementation(async (symbol, qty, side) => ({
    id: `order-${symbol}-${Date.now()}`, symbol, qty: String(qty), side, status: 'filled',
    filled_qty: String(qty), filled_avg_price: '100.00',
  }));
  mockAlpaca.getPosition.mockResolvedValue(null);
  mockRiskAgent.evaluate.mockResolvedValue({ approved: true, adjustments: {} });
  mockRegimeAgent.getParams.mockReturnValue({ regime: 'trending_bull', bias: 'long', position_scale: 1.0 });
  mockNewsAgent.getCriticalAlert.mockReturnValue(null);
});

describe('execution lifecycle — happy path BUY', () => {
  test('writes signal + trade + links decision, all in one atomic transaction', async () => {
    // Seed an orchestrator decision row so the signal_id back-link has something to update
    await mockDb.query(
      `INSERT INTO agent_decisions (symbol, action, confidence, reasoning, agent_inputs, duration_ms) VALUES ($1, $2, $3, $4, $5, $6)`,
      ['AAPL', 'BUY', 0.8, 'TA bullish alignment', '{}', 500]
    );

    const result = await executionAgent.execute({
      symbol: 'AAPL', action: 'BUY', confidence: 0.8, reasoning: 'Multi-timeframe bullish',
      size_adjustment: 1.0,
    });

    expect(result.executed).toBe(true);
    expect(mockAlpaca.placeOrder).toHaveBeenCalledTimes(1);
    expect(mockAlpaca.placeOrder).toHaveBeenCalledWith('AAPL', expect.any(Number), 'buy');

    const signals = mockDb._getRows('signals');
    const trades = mockDb._getRows('trades');
    const decisions = mockDb._getRows('agent_decisions');

    expect(signals).toHaveLength(1);
    expect(signals[0].symbol).toBe('AAPL');
    expect(signals[0].signal).toBe('BUY');

    expect(trades).toHaveLength(1);
    expect(trades[0].symbol).toBe('AAPL');
    expect(trades[0].status).toBe('open');
    // Atomic link — trade's signal_id matches the signal we just inserted
    expect(trades[0].signal_id).toBe(signals[0].id);

    // Decision was back-linked to the signal
    expect(decisions[0].signal_id).toBe(signals[0].id);
  });
});

describe('retry behavior — Alpaca 503 then 200', () => {
  test('retry helper succeeds on third attempt without duplicate work', async () => {
    const { retryWithBackoff } = require('../../src/util/retry');
    let attempts = 0;
    const placeOrderStub = jest.fn(async () => {
      attempts++;
      if (attempts < 3) { const e = new Error('Service Unavailable'); e.status = 503; throw e; }
      return { id: 'order-123', status: 'filled' };
    });
    const result = await retryWithBackoff(placeOrderStub, {
      retries: 3, baseMs: 10,
      shouldRetry: (e) => e.status === 503,
      label: 'test-alpaca-retry',
    });
    expect(result.id).toBe('order-123');
    expect(attempts).toBe(3);
    expect(placeOrderStub).toHaveBeenCalledTimes(3);
  });
});

describe('transaction rollback — orphan order detection', () => {
  test('when INSERT INTO trades fails, signals row does NOT persist but Alpaca order remains placed', async () => {
    // Monkey-patch mockDb.withTransaction to inject failure on the trades INSERT
    const originalWithTx = mockDb.withTransaction;
    mockDb.withTransaction = async (fn) => {
      const client = await mockDb.getClient();
      const wrappedClient = {
        async query(sql, params) {
          if (/^INSERT INTO trades/i.test(sql.trim())) {
            throw new Error('Simulated DB failure on trades INSERT');
          }
          return client.query(sql, params);
        },
        release() { client.release(); },
      };
      try {
        await wrappedClient.query('BEGIN');
        const r = await fn(wrappedClient);
        await wrappedClient.query('COMMIT');
        return r;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        wrappedClient.release();
      }
    };

    let thrown = null;
    try {
      await executionAgent.execute({
        symbol: 'TSLA', action: 'BUY', confidence: 0.8, reasoning: 'test', size_adjustment: 1.0,
      });
    } catch (err) {
      thrown = err;
    }

    // Alpaca order WAS still placed (the orphan scenario requiring reconciliation)
    expect(mockAlpaca.placeOrder).toHaveBeenCalledTimes(1);
    expect(thrown).toBeTruthy();
    expect(thrown.message).toMatch(/trades INSERT/);

    // Signals row was rolled back — not present in final state
    expect(mockDb._getRows('signals')).toHaveLength(0);
    expect(mockDb._getRows('trades')).toHaveLength(0);

    mockDb.withTransaction = originalWithTx;
  });
});
