// Test the pure pearsonCorrelation function via the module internals
// We test computeCorrelationMatrix indirectly since it requires API calls

describe('correlation module', () => {
  let correlation;

  beforeAll(() => {
    // Mock alpaca module before requiring correlation
    jest.mock('../src/alpaca', () => ({
      getDailyBars: jest.fn(),
    }));
    jest.mock('../src/logger', () => ({
      log: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      alert: jest.fn(),
    }));
    correlation = require('../src/correlation');
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  test('computeCorrelationMatrix returns empty for < 2 symbols', async () => {
    const result = await correlation.computeCorrelationMatrix(['AAPL']);
    expect(result.matrix).toEqual({});
    expect(result.highCorrelations).toEqual([]);
  });

  test('computeCorrelationMatrix handles API failures gracefully', async () => {
    const alpaca = require('../src/alpaca');
    alpaca.getDailyBars.mockRejectedValue(new Error('API down'));

    const result = await correlation.computeCorrelationMatrix(['AAPL', 'MSFT']);
    expect(result.matrix).toEqual({});
  });

  test('computeCorrelationMatrix computes valid matrix', async () => {
    const alpaca = require('../src/alpaca');

    // Generate correlated returns
    alpaca.getDailyBars.mockImplementation(async (sym) => {
      const base = sym === 'AAPL' ? 150 : 300;
      return Array.from({ length: 35 }, (_, i) => ({
        t: `2024-01-${String(i + 1).padStart(2, '0')}`,
        o: base + i,
        h: base + i + 1,
        l: base + i - 1,
        c: base + i + (sym === 'AAPL' ? 0.5 : 0.5), // Perfectly correlated
        v: 10000,
      }));
    });

    const result = await correlation.computeCorrelationMatrix(['AAPL', 'MSFT'], 30);
    expect(result.matrix['AAPL']['AAPL']).toBe(1);
    expect(result.matrix['MSFT']['MSFT']).toBe(1);
    expect(result.matrix['AAPL']['MSFT']).toBeGreaterThan(0.9);
  });
});
