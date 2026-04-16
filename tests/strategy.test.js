/**
 * Unit tests for the strategy module — now DB-backed. We mock the DB so
 * the tests verify the in-memory mirror stays consistent and the
 * persistence queries fire with the right shape.
 */

const mockDb = { query: jest.fn(async () => ({ rows: [] })) };
jest.mock('../src/db', () => mockDb);
jest.mock('../src/logger', () => ({ log: () => {}, error: () => {}, warn: () => {}, alert: () => {} }));

const strategy = require('../src/strategy');

beforeEach(() => {
  mockDb.query.mockReset().mockResolvedValue({ rows: [] });
  strategy._resetForTests();
});

describe('strategy — reads', () => {
  test('default strategy is hybrid when nothing is set', () => {
    expect(strategy.getStrategy('AAPL')).toBe('hybrid');
  });

  test('getAllStrategies returns default + overrides snapshot', async () => {
    await strategy.setStrategy('TSLA', 'rules');
    const all = strategy.getAllStrategies();
    expect(all.default).toBe('hybrid');
    expect(all.overrides.TSLA).toBe('rules');
  });
});

describe('strategy — persistence', () => {
  test('setStrategy writes an upsert row to strategy_config', async () => {
    await strategy.setStrategy('TSLA', 'rules');
    expect(strategy.getStrategy('TSLA')).toBe('rules');
    const call = mockDb.query.mock.calls.find(([sql]) => /INSERT INTO strategy_config/.test(sql));
    expect(call).toBeDefined();
    expect(call[0]).toMatch(/ON CONFLICT \(scope, key\) DO UPDATE/);
    expect(call[1]).toEqual(['TSLA', 'rules']);
  });

  test('setDefaultStrategy writes a scope=default row', async () => {
    await strategy.setDefaultStrategy('llm');
    expect(strategy.getStrategy('AAPL')).toBe('llm');
    const call = mockDb.query.mock.calls.find(
      ([sql, params]) => /INSERT INTO strategy_config/.test(sql) && params?.[0] === 'llm',
    );
    expect(call).toBeDefined();
  });

  test('clearStrategy deletes the row and reverts to default', async () => {
    await strategy.setStrategy('TSLA', 'rules');
    await strategy.clearStrategy('TSLA');
    expect(strategy.getStrategy('TSLA')).toBe('hybrid');
    const del = mockDb.query.mock.calls.find(([sql]) => /DELETE FROM strategy_config/.test(sql));
    expect(del).toBeDefined();
    expect(del[1]).toEqual(['TSLA']);
  });

  test('DB write failure does not throw — in-memory state still updates', async () => {
    mockDb.query.mockImplementationOnce(() => Promise.reject(new Error('table missing')));
    await expect(strategy.setStrategy('X', 'rules')).resolves.not.toThrow();
    expect(strategy.getStrategy('X')).toBe('rules');
  });
});

describe('strategy — init', () => {
  test('loads persisted overrides + default from DB on startup', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        { scope: 'default', key: '__default__', mode: 'llm' },
        { scope: 'symbol', key: 'AAPL', mode: 'rules' },
        { scope: 'symbol', key: 'TSLA', mode: 'llm' },
      ],
    });
    await strategy.init();
    expect(strategy.getStrategy('AAPL')).toBe('rules');
    expect(strategy.getStrategy('TSLA')).toBe('llm');
    // Symbols without an override fall through to the new default
    expect(strategy.getStrategy('MSFT')).toBe('llm');
  });

  test('init is non-fatal when the table is missing', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('relation "strategy_config" does not exist'));
    await expect(strategy.init()).resolves.not.toThrow();
    // Falls back to built-in default
    expect(strategy.getStrategy('AAPL')).toBe('hybrid');
  });
});

describe('strategy — validation', () => {
  test('setStrategy rejects invalid modes', async () => {
    await expect(strategy.setStrategy('AAPL', 'banana')).rejects.toThrow(/Invalid strategy mode/);
  });

  test('setDefaultStrategy rejects invalid modes', async () => {
    await expect(strategy.setDefaultStrategy('banana')).rejects.toThrow(/Invalid strategy mode/);
  });
});

describe('strategy — usesRules / usesLlm', () => {
  test('usesRules is true for rules and hybrid', async () => {
    await strategy.setStrategy('AAPL', 'rules');
    expect(strategy.usesRules('AAPL')).toBe(true);
    await strategy.setStrategy('AAPL', 'hybrid');
    expect(strategy.usesRules('AAPL')).toBe(true);
    await strategy.setStrategy('AAPL', 'llm');
    expect(strategy.usesRules('AAPL')).toBe(false);
  });

  test('usesLlm is true for llm and hybrid', async () => {
    await strategy.setStrategy('AAPL', 'llm');
    expect(strategy.usesLlm('AAPL')).toBe(true);
    await strategy.setStrategy('AAPL', 'hybrid');
    expect(strategy.usesLlm('AAPL')).toBe(true);
    await strategy.setStrategy('AAPL', 'rules');
    expect(strategy.usesLlm('AAPL')).toBe(false);
  });
});
