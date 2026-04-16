/**
 * Unit tests for the breakout + mean-reversion specialized agents.
 * Mocks Alpaca + LLM so we test the indicator computation and
 * report-shape plumbing without network calls.
 */

const { createAlpacaMock, defaultDailyBars } = require('./mocks/alpaca');

const mockAlpaca = createAlpacaMock();
const mockLlm = {
  ask: jest.fn(),
  askJson: jest.fn(),
  getUsage: jest.fn(() => ({
    estimatedCostUsd: 0,
    callCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  })),
  isAvailable: jest.fn(() => true),
  snapshotAgentUsage: jest.fn(() => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 })),
  getAgentUsageDiff: jest.fn(() => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 })),
  MODELS: { fast: 'test-model', standard: 'test-model' },
  BudgetExhaustedError: class extends Error {},
};
const mockDb = { query: jest.fn(async () => ({ rows: [] })) };

jest.mock('../src/alpaca', () => mockAlpaca);
jest.mock('../src/agents/llm', () => mockLlm);
jest.mock('../src/db', () => mockDb);
jest.mock('../src/socket', () => ({ events: { agentReport: () => {} } }));
jest.mock('../src/logger', () => ({
  log: () => {},
  warn: () => {},
  error: () => {},
  runWithContext: (_c, fn) => fn(),
  newCorrelationId: () => 'test',
  getContext: () => ({}),
}));

beforeEach(() => {
  mockAlpaca.getDailyBars.mockReset().mockImplementation(async (s) => defaultDailyBars(s, 150));
  mockLlm.askJson.mockReset();
  mockDb.query.mockReset().mockResolvedValue({ rows: [] });
});

describe('breakout-agent', () => {
  const breakoutAgent = require('../src/agents/breakout-agent');

  test('analyze returns a report with symbolReports keyed by symbol', async () => {
    mockLlm.askJson.mockResolvedValueOnce({
      data: {
        symbols: {
          AAPL: { signal: 'BUY', confidence: 0.65, pattern: 'resistance_break', reasoning: 'test' },
        },
      },
      text: '{}',
      inputTokens: 10,
      outputTokens: 10,
    });

    const report = await breakoutAgent.analyze({ symbols: ['AAPL'] });

    expect(report).toHaveProperty('signal');
    expect(report).toHaveProperty('confidence');
    expect(report).toHaveProperty('data.symbolReports');
    expect(report.data.symbolReports.AAPL).toBeDefined();
    expect(report.data.symbolReports.AAPL.indicators).toBeDefined();
    expect(report.data.symbolReports.AAPL.indicators).toHaveProperty('bollinger');
    expect(report.data.symbolReports.AAPL.indicators).toHaveProperty('nearestResistance');
    expect(report.data.symbolReports.AAPL.indicators).toHaveProperty('volumeRatio');
  });

  test('handles LLM failure gracefully', async () => {
    mockLlm.askJson.mockRejectedValueOnce(new Error('LLM down'));
    const report = await breakoutAgent.analyze({ symbols: ['AAPL'] });
    expect(report.signal).toBe('HOLD');
    expect(report.data.symbolReports.AAPL.indicators).toBeDefined();
  });

  test('skips symbols with insufficient bars', async () => {
    mockAlpaca.getDailyBars.mockResolvedValueOnce([{ t: '2026-01-01', o: 1, h: 1, l: 1, c: 1, v: 100 }]);
    mockLlm.askJson.mockResolvedValueOnce({ data: { symbols: {} }, text: '{}', inputTokens: 0, outputTokens: 0 });
    const report = await breakoutAgent.analyze({ symbols: ['THIN'] });
    expect(report.data.symbolReports.THIN?.indicators).toBeNull();
  });
});

describe('mean-reversion-agent', () => {
  const meanRevAgent = require('../src/agents/mean-reversion-agent');

  test('analyze returns a report with symbolReports keyed by symbol', async () => {
    mockLlm.askJson.mockResolvedValueOnce({
      data: {
        symbols: {
          AAPL: { signal: 'BUY', confidence: 0.55, pattern: 'rsi_oversold', reasoning: 'test' },
        },
      },
      text: '{}',
      inputTokens: 10,
      outputTokens: 10,
    });

    const report = await meanRevAgent.analyze({ symbols: ['AAPL'] });

    expect(report).toHaveProperty('signal');
    expect(report).toHaveProperty('confidence');
    expect(report).toHaveProperty('data.symbolReports');
    expect(report.data.symbolReports.AAPL).toBeDefined();
    expect(report.data.symbolReports.AAPL.indicators).toHaveProperty('bollinger');
    expect(report.data.symbolReports.AAPL.indicators).toHaveProperty('rsi');
    expect(report.data.symbolReports.AAPL.indicators).toHaveProperty('distFromEma21Pct');
    expect(report.data.symbolReports.AAPL.indicators).toHaveProperty('distFromVwapPct');
  });

  test('handles LLM failure gracefully', async () => {
    mockLlm.askJson.mockRejectedValueOnce(new Error('LLM down'));
    const report = await meanRevAgent.analyze({ symbols: ['AAPL'] });
    expect(report.signal).toBe('HOLD');
  });

  test('derives overall signal from buy vs sell counts', async () => {
    mockLlm.askJson.mockResolvedValueOnce({
      data: {
        symbols: {
          AAPL: { signal: 'BUY', confidence: 0.6, pattern: 'rsi_oversold', reasoning: 'a' },
          TSLA: { signal: 'SELL', confidence: 0.7, pattern: 'rsi_overbought', reasoning: 'b' },
          MSFT: { signal: 'BUY', confidence: 0.5, pattern: 'ema_revert', reasoning: 'c' },
        },
      },
      text: '{}',
      inputTokens: 10,
      outputTokens: 10,
    });
    const report = await meanRevAgent.analyze({ symbols: ['AAPL', 'TSLA', 'MSFT'] });
    expect(report.signal).toBe('BUY'); // 2 buys > 1 sell
    expect(report.reasoning).toMatch(/2 oversold BUY/);
  });
});

describe('agent personas', () => {
  test('breakout-agent and mean-reversion have personas registered', () => {
    // Can't import ESM from CJS tests, so just verify the file exists
    const fs = require('fs');
    const content = fs.readFileSync('trader-ui/src/lib/agentPersonas.js', 'utf8');
    expect(content).toMatch(/'breakout-agent'/);
    expect(content).toMatch(/'mean-reversion'/);
    expect(content).toMatch(/Rupture/);
    expect(content).toMatch(/Bounce/);
  });
});
