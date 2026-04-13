/**
 * Unit tests for risk agent pure math:
 * - _calcSectorExposure
 * - _calcPortfolioHeat
 *
 * These are side-effect-free calculations. We still mock the agent's
 * module-level deps so requiring it doesn't crash.
 */

jest.mock('../src/db', () => ({ query: jest.fn() }));
jest.mock('../src/alpaca', () => ({ getAccount: jest.fn(), getPositions: jest.fn() }));
jest.mock('../src/agents/llm', () => ({ askJson: jest.fn(), isAvailable: jest.fn(() => true) }));
jest.mock('../src/agents/message-bus', () => ({ messageBus: { publish: jest.fn() } }));
jest.mock('../src/correlation', () => ({ checkCorrelationRisk: jest.fn(async () => ({ allowed: true })) }));
jest.mock('../src/logger', () => ({
  log: () => {}, error: () => {}, warn: () => {}, alert: () => {},
  runWithContext: (_ctx, fn) => fn(),
  newCorrelationId: (p = '') => `${p}_test`,
  getContext: () => ({}),
}));

const riskAgent = require('../src/agents/risk-agent');

describe('_calcSectorExposure', () => {
  test('groups positions by sector and returns percentages of portfolio', () => {
    const trades = [
      { symbol: 'AAPL', current_price: '150', qty: 10 }, // Tech: 1500
      { symbol: 'MSFT', current_price: '300', qty: 5 },  // Tech: 1500
      { symbol: 'TSLA', current_price: '200', qty: 10 }, // Auto: 2000
      { symbol: 'NVDA', current_price: '400', qty: 2 },  // Semi: 800
    ];
    const result = riskAgent._calcSectorExposure(trades, 10000);
    expect(result.Technology).toBeCloseTo(0.3, 3);
    expect(result.Automotive).toBeCloseTo(0.2, 3);
    expect(result.Semiconductors).toBeCloseTo(0.08, 3);
  });

  test('maps unknown symbols to "Unknown" sector', () => {
    const trades = [{ symbol: 'XYZ123', current_price: '50', qty: 4 }];
    const result = riskAgent._calcSectorExposure(trades, 1000);
    expect(result.Unknown).toBeCloseTo(0.2, 3);
  });

  test('returns empty object for empty trade list', () => {
    expect(riskAgent._calcSectorExposure([], 10000)).toEqual({});
  });

  test('returns 0 exposure when portfolioValue <= 0', () => {
    const trades = [{ symbol: 'AAPL', current_price: '150', qty: 10 }];
    const result = riskAgent._calcSectorExposure(trades, 0);
    expect(result.Technology).toBe(0);
  });

  test('handles string current_price values (parseFloat conversion)', () => {
    const trades = [{ symbol: 'AAPL', current_price: '150.50', qty: 10 }];
    const result = riskAgent._calcSectorExposure(trades, 10000);
    expect(result.Technology).toBeCloseTo(0.1505, 4);
  });
});

describe('_calcPortfolioHeat', () => {
  test('sums risk_dollars and divides by portfolio value', () => {
    const trades = [
      { risk_dollars: 100 },
      { risk_dollars: 200 },
      { risk_dollars: 300 },
    ];
    expect(riskAgent._calcPortfolioHeat(trades, 10000)).toBeCloseTo(0.06, 3);
  });

  test('returns 0 for empty trades', () => {
    expect(riskAgent._calcPortfolioHeat([], 10000)).toBe(0);
  });

  test('returns 0 when portfolioValue <= 0', () => {
    expect(riskAgent._calcPortfolioHeat([{ risk_dollars: 100 }], 0)).toBe(0);
  });

  test('defaults missing risk_dollars to 0', () => {
    const trades = [{ risk_dollars: 100 }, {}, { risk_dollars: null }];
    expect(riskAgent._calcPortfolioHeat(trades, 1000)).toBeCloseTo(0.1, 3);
  });

  test('parses string risk_dollars via parseFloat', () => {
    const trades = [{ risk_dollars: '150.50' }, { risk_dollars: '49.50' }];
    expect(riskAgent._calcPortfolioHeat(trades, 1000)).toBeCloseTo(0.2, 3);
  });
});
