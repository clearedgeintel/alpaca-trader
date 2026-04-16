/**
 * Unit tests for the inter-agent debate module.
 */

const mockLlm = {
  ask: jest.fn(),
  askJson: jest.fn(),
  getUsage: jest.fn(() => ({})),
  isAvailable: jest.fn(() => true),
  snapshotAgentUsage: jest.fn(() => ({})),
  getAgentUsageDiff: jest.fn(() => ({})),
  MODELS: {},
  BudgetExhaustedError: class extends Error {},
};
jest.mock('../src/agents/llm', () => mockLlm);
jest.mock('../src/logger', () => ({
  log: () => {},
  warn: () => {},
  error: () => {},
  runWithContext: (_c, fn) => fn(),
  newCorrelationId: () => 'test',
  getContext: () => ({}),
}));

const { runDebate } = require('../src/agents/debate');

beforeEach(() => {
  mockLlm.ask.mockReset();
});

function reports(overrides = {}) {
  return {
    'technical-analysis': { signal: 'BUY', confidence: 0.8, reasoning: 'EMA cross + volume' },
    'news-sentinel': { signal: 'BUY', confidence: 0.6, reasoning: 'Positive earnings surprise' },
    'breakout-agent': { signal: 'BUY', confidence: 0.7, reasoning: 'Resistance break confirmed' },
    'mean-reversion': { signal: 'SELL', confidence: 0.65, reasoning: 'RSI 78, overbought reversion likely' },
    'risk-manager': { signal: 'HOLD', confidence: 0.5, reasoning: 'Sector heat elevated' },
    ...overrides,
  };
}

describe('runDebate', () => {
  test('skips entirely (zero LLM calls) when all active agents agree', async () => {
    const r = await runDebate({
      a: { signal: 'BUY', confidence: 0.8, reasoning: 'x' },
      b: { signal: 'BUY', confidence: 0.6, reasoning: 'y' },
      c: { signal: 'HOLD', confidence: 0.5, reasoning: 'z' },
    });
    expect(r.hasDissent).toBe(false);
    expect(r.debateRounds).toHaveLength(0);
    expect(mockLlm.ask).not.toHaveBeenCalled();
  });

  test('runs debate rounds when agents disagree', async () => {
    mockLlm.ask
      .mockResolvedValueOnce({ text: 'RSI is 78 — this is exhaustion, not a breakout.' })
      .mockResolvedValueOnce({ text: 'Volume confirms institutional buying despite high RSI.' });

    const r = await runDebate(reports());
    expect(r.hasDissent).toBe(true);
    expect(r.majority).toBe('BUY');
    expect(r.debateRounds).toHaveLength(1);
    expect(r.debateRounds[0].dissenter).toBe('mean-reversion');
    expect(r.debateRounds[0].responder).toBe('technical-analysis');
    expect(r.debateRounds[0].challenge).toMatch(/exhaustion/);
    expect(r.debateRounds[0].response).toMatch(/Volume confirms/);
    expect(mockLlm.ask).toHaveBeenCalledTimes(2);
  });

  test('caps at 3 debate rounds when dissenters exceed the limit', async () => {
    mockLlm.ask.mockResolvedValue({ text: 'mocked' });
    // 4 BUY (majority) vs 3 SELL (dissenters) → exactly 3 rounds (hits cap)
    const r = await runDebate({
      a: { signal: 'BUY', confidence: 0.9, reasoning: 'strong' },
      b: { signal: 'BUY', confidence: 0.8, reasoning: 'also strong' },
      c: { signal: 'BUY', confidence: 0.7, reasoning: 'bullish' },
      d: { signal: 'BUY', confidence: 0.6, reasoning: 'confirming' },
      e: { signal: 'SELL', confidence: 0.7, reasoning: 'dissent 1' },
      f: { signal: 'SELL', confidence: 0.6, reasoning: 'dissent 2' },
      g: { signal: 'SELL', confidence: 0.5, reasoning: 'dissent 3' },
    });
    expect(r.majority).toBe('BUY');
    expect(r.debateRounds).toHaveLength(3); // capped at 3
    expect(mockLlm.ask).toHaveBeenCalledTimes(6); // 3 rounds × 2 calls each
  });

  test('handles LLM failure in a debate round gracefully', async () => {
    mockLlm.ask.mockRejectedValueOnce(new Error('LLM timeout')).mockResolvedValueOnce({ text: 'fallback' });

    const r = await runDebate(reports());
    expect(r.hasDissent).toBe(true);
    expect(r.debateRounds).toHaveLength(1);
    expect(r.debateRounds[0].error).toMatch(/LLM timeout/);
    expect(r.debateRounds[0].challenge).toBeNull();
  });

  test('returns empty debate when all signals are HOLD', async () => {
    const r = await runDebate({
      a: { signal: 'HOLD', confidence: 0.5, reasoning: 'x' },
      b: { signal: 'HOLD', confidence: 0.4, reasoning: 'y' },
    });
    expect(r.hasDissent).toBe(false);
    expect(r.majority).toBe('HOLD');
  });

  test('identifies correct majority when SELL outnumbers BUY', async () => {
    mockLlm.ask.mockResolvedValue({ text: 'mocked' });
    const r = await runDebate({
      a: { signal: 'SELL', confidence: 0.8, reasoning: 'x' },
      b: { signal: 'SELL', confidence: 0.7, reasoning: 'y' },
      c: { signal: 'BUY', confidence: 0.6, reasoning: 'z' },
    });
    expect(r.majority).toBe('SELL');
    expect(r.debateRounds[0].dissenter).toBe('c');
    expect(r.debateRounds[0].dissenterSignal).toBe('BUY');
  });
});
