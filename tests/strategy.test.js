const {
  getStrategy,
  setStrategy,
  setDefaultStrategy,
  getAllStrategies,
  clearStrategy,
  usesRules,
  usesLlm,
} = require('../src/strategy');

// Mock logger
jest.mock('../src/logger', () => ({ log: jest.fn(), error: jest.fn(), warn: jest.fn(), alert: jest.fn() }));

describe('strategy', () => {
  afterEach(() => {
    // Reset state
    clearStrategy('TSLA');
    clearStrategy('AAPL');
    setDefaultStrategy('hybrid');
  });

  test('default strategy is hybrid', () => {
    expect(getStrategy('AAPL')).toBe('hybrid');
  });

  test('setStrategy overrides per symbol', () => {
    setStrategy('TSLA', 'rules');
    expect(getStrategy('TSLA')).toBe('rules');
    expect(getStrategy('AAPL')).toBe('hybrid'); // Unaffected
  });

  test('setDefaultStrategy changes fallback', () => {
    setDefaultStrategy('llm');
    expect(getStrategy('AAPL')).toBe('llm');
  });

  test('clearStrategy reverts to default', () => {
    setStrategy('TSLA', 'rules');
    clearStrategy('TSLA');
    expect(getStrategy('TSLA')).toBe('hybrid');
  });

  test('setStrategy rejects invalid modes', () => {
    expect(() => setStrategy('AAPL', 'invalid')).toThrow();
  });

  test('usesRules returns true for rules and hybrid', () => {
    setStrategy('AAPL', 'rules');
    expect(usesRules('AAPL')).toBe(true);
    setStrategy('AAPL', 'hybrid');
    expect(usesRules('AAPL')).toBe(true);
    setStrategy('AAPL', 'llm');
    expect(usesRules('AAPL')).toBe(false);
  });

  test('usesLlm returns true for llm and hybrid', () => {
    setStrategy('AAPL', 'llm');
    expect(usesLlm('AAPL')).toBe(true);
    setStrategy('AAPL', 'hybrid');
    expect(usesLlm('AAPL')).toBe(true);
    setStrategy('AAPL', 'rules');
    expect(usesLlm('AAPL')).toBe(false);
  });

  test('getAllStrategies returns default and overrides', () => {
    setStrategy('TSLA', 'rules');
    const all = getAllStrategies();
    expect(all.default).toBe('hybrid');
    expect(all.overrides.TSLA).toBe('rules');
  });
});
