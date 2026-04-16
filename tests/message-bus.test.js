/**
 * Unit tests for the agent message bus:
 * - publish validates type and generates UUID ids
 * - subscribe/unsubscribe semantics
 * - history filtering and 500-message cap
 * - DB persistence is fire-and-forget (failures don't block)
 */

jest.mock('../src/db', () => ({
  query: jest.fn(async () => ({ rows: [] })),
}));
jest.mock('../src/logger', () => ({
  log: () => {},
  error: () => {},
  warn: () => {},
  alert: () => {},
  runWithContext: (_ctx, fn) => fn(),
  newCorrelationId: (p = '') => `${p}_test`,
  getContext: () => ({}),
}));

const { messageBus, MESSAGE_TYPES } = require('../src/agents/message-bus');

beforeEach(() => {
  // Clear internal history between tests — it's a singleton
  messageBus._history.length = 0;
  messageBus.removeAllListeners();
});

describe('publish', () => {
  test('assigns a UUID, timestamp, and appends to history', async () => {
    const msg = await messageBus.publish('SIGNAL', 'scout', { symbol: 'AAPL', signal: 'BUY' });
    expect(msg.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(msg.type).toBe('SIGNAL');
    expect(msg.from).toBe('scout');
    expect(new Date(msg.timestamp).toString()).not.toBe('Invalid Date');
    expect(messageBus._history).toHaveLength(1);
  });

  test('throws on unknown message type', async () => {
    await expect(messageBus.publish('UNKNOWN', 'x', {})).rejects.toThrow(/Invalid message type/);
  });

  test('all MESSAGE_TYPES are accepted', async () => {
    for (const t of MESSAGE_TYPES) {
      await expect(messageBus.publish(t, 'test', {})).resolves.toBeTruthy();
    }
    expect(messageBus._history).toHaveLength(MESSAGE_TYPES.length);
  });

  test('emits typed event AND wildcard "message" event', async () => {
    const typed = jest.fn();
    const wildcard = jest.fn();
    messageBus.on('SIGNAL', typed);
    messageBus.on('message', wildcard);

    await messageBus.publish('SIGNAL', 'scout', { symbol: 'AAPL' });

    expect(typed).toHaveBeenCalledTimes(1);
    expect(wildcard).toHaveBeenCalledTimes(1);
    expect(typed.mock.calls[0][0].type).toBe('SIGNAL');
  });

  test('caps history at _maxHistory (500) entries', async () => {
    messageBus._maxHistory = 5; // shrink for the test
    for (let i = 0; i < 8; i++) {
      await messageBus.publish('REPORT', 'test', { i });
    }
    expect(messageBus._history).toHaveLength(5);
    expect(messageBus._history[0].payload.i).toBe(3); // oldest kept
    expect(messageBus._history[4].payload.i).toBe(7); // newest
    messageBus._maxHistory = 500; // restore
  });

  test('db persistence failure does not reject publish', async () => {
    const db = require('../src/db');
    db.query.mockRejectedValueOnce(new Error('DB down'));
    // Publish should still resolve; error is swallowed internally
    await expect(messageBus.publish('REPORT', 'test', {})).resolves.toBeTruthy();
  });
});

describe('subscribe / unsubscribe', () => {
  test('subscribe returns an unsubscribe function that stops delivery', async () => {
    const handler = jest.fn();
    const unsub = messageBus.subscribe('ALERT', handler);

    await messageBus.publish('ALERT', 'x', {});
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    await messageBus.publish('ALERT', 'x', {});
    expect(handler).toHaveBeenCalledTimes(1); // still 1
  });

  test('subscribeAll listens on "message" wildcard', async () => {
    const handler = jest.fn();
    messageBus.subscribeAll(handler);
    await messageBus.publish('VETO', 'vega', {});
    await messageBus.publish('DECISION', 'nexus', {});
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('getHistory', () => {
  test('filters by type', async () => {
    await messageBus.publish('SIGNAL', 'scout', { symbol: 'AAPL' });
    await messageBus.publish('ALERT', 'herald', { symbol: 'AAPL' });
    await messageBus.publish('SIGNAL', 'scout', { symbol: 'MSFT' });

    const signals = messageBus.getHistory({ type: 'SIGNAL' });
    expect(signals).toHaveLength(2);
    expect(signals.every((m) => m.type === 'SIGNAL')).toBe(true);
  });

  test('filters by from', async () => {
    await messageBus.publish('REPORT', 'scout', {});
    await messageBus.publish('REPORT', 'vega', {});
    const scoutOnly = messageBus.getHistory({ from: 'scout' });
    expect(scoutOnly).toHaveLength(1);
  });

  test('filters by payload.symbol', async () => {
    await messageBus.publish('SIGNAL', 'x', { symbol: 'AAPL' });
    await messageBus.publish('SIGNAL', 'x', { symbol: 'TSLA' });
    expect(messageBus.getHistory({ symbol: 'AAPL' })).toHaveLength(1);
  });

  test('limit returns last N entries', async () => {
    for (let i = 0; i < 10; i++) {
      await messageBus.publish('REPORT', 'test', { i });
    }
    const last3 = messageBus.getHistory({ limit: 3 });
    expect(last3).toHaveLength(3);
    expect(last3[0].payload.i).toBe(7);
    expect(last3[2].payload.i).toBe(9);
  });
});
