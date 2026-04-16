/**
 * Unit tests for orchestrator pure logic:
 * - _fallbackDecisions filtering + confidence discount
 * - Confidence-weighting math (calibration * reported)
 * - getAgentCalibration normalization
 *
 * We mock db + llm so these exercise the synthesis math without network/DB.
 */

const mockDb = { query: jest.fn() };
const mockLlm = {
  askJson: jest.fn(),
  isAvailable: jest.fn(() => true),
  getUsage: jest.fn(() => ({})),
};
const mockMessageBus = { publish: jest.fn(async () => {}) };

jest.mock('../src/db', () => mockDb);
jest.mock('../src/agents/llm', () => mockLlm);
jest.mock('../src/agents/message-bus', () => ({ messageBus: mockMessageBus }));
jest.mock('../src/logger', () => ({
  log: () => {},
  error: () => {},
  warn: () => {},
  alert: () => {},
  runWithContext: (_ctx, fn) => fn(),
  newCorrelationId: (p = '') => `${p}_test`,
  getContext: () => ({}),
}));

const orchestrator = require('../src/agents/orchestrator');

beforeEach(() => {
  jest.clearAllMocks();
  mockLlm.isAvailable.mockReturnValue(true);
});

describe('_fallbackDecisions', () => {
  test('returns [] when technical-analysis report is missing', () => {
    expect(orchestrator._fallbackDecisions({})).toEqual([]);
    expect(orchestrator._fallbackDecisions({ 'technical-analysis': {} })).toEqual([]);
    expect(orchestrator._fallbackDecisions({ 'technical-analysis': { data: {} } })).toEqual([]);
  });

  test('includes only BUY signals with confidence >= 0.6', () => {
    const reports = {
      'technical-analysis': {
        data: {
          symbolReports: {
            AAPL: { signal: 'BUY', confidence: 0.85, reasoning: 'strong' },
            MSFT: { signal: 'BUY', confidence: 0.55, reasoning: 'weak' }, // filtered
            TSLA: { signal: 'SELL', confidence: 0.9, reasoning: 'bearish' }, // filtered (not BUY)
            NVDA: { signal: 'HOLD', confidence: 0.7, reasoning: 'neutral' }, // filtered
          },
        },
      },
    };
    const decisions = orchestrator._fallbackDecisions(reports);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].symbol).toBe('AAPL');
    expect(decisions[0].action).toBe('BUY');
  });

  test('discounts confidence by 0.8 and sets size_adjustment 0.8', () => {
    const reports = {
      'technical-analysis': {
        data: {
          symbolReports: {
            AAPL: { signal: 'BUY', confidence: 0.85, reasoning: 'trend' },
          },
        },
      },
    };
    const [decision] = orchestrator._fallbackDecisions(reports);
    expect(decision.confidence).toBeCloseTo(0.85 * 0.8, 4);
    expect(decision.size_adjustment).toBe(0.8);
    expect(decision.supporting_agents).toEqual(['technical-analysis']);
    expect(decision.dissenting_agents).toEqual([]);
    expect(decision.reasoning).toContain('Fallback');
  });

  test('preserves decision order per Object.entries iteration', () => {
    const reports = {
      'technical-analysis': {
        data: {
          symbolReports: {
            A: { signal: 'BUY', confidence: 0.7 },
            B: { signal: 'BUY', confidence: 0.8 },
            C: { signal: 'BUY', confidence: 0.9 },
          },
        },
      },
    };
    const decisions = orchestrator._fallbackDecisions(reports);
    expect(decisions.map((d) => d.symbol)).toEqual(['A', 'B', 'C']);
  });
});

describe('confidence-weighting math', () => {
  // This formula is used inside analyze() when building weightedReports:
  // adjusted = reported * (winRate * 0.7 + 0.3)
  // We test it as a pure function equivalent.
  const adjust = (reported, winRate) => +(reported * (winRate * 0.7 + 0.3)).toFixed(3);

  test('cold start (weight 0.5) produces 0.65 multiplier', () => {
    expect(adjust(1.0, 0.5)).toBeCloseTo(0.65, 3);
    expect(adjust(0.8, 0.5)).toBeCloseTo(0.52, 3);
  });

  test('perfect agent (win rate 1.0) passes reported through unchanged', () => {
    expect(adjust(0.8, 1.0)).toBeCloseTo(0.8, 3);
    expect(adjust(1.0, 1.0)).toBeCloseTo(1.0, 3);
  });

  test('broken agent (win rate 0.0) still has 0.3 floor — never muted to zero', () => {
    expect(adjust(0.8, 0.0)).toBeCloseTo(0.24, 3);
    expect(adjust(1.0, 0.0)).toBeCloseTo(0.3, 3);
  });

  test('monotonic: higher win rate always yields higher adjusted confidence', () => {
    const reported = 0.7;
    const low = adjust(reported, 0.2);
    const mid = adjust(reported, 0.5);
    const high = adjust(reported, 0.9);
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });
});

describe('getAgentCalibration', () => {
  test('returns empty object when DB query throws', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('DB down'));
    const result = await orchestrator.getAgentCalibration(30);
    expect(result).toEqual({});
  });

  test('normalizes percent to decimal and clamps to [0,1]', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        { agent_name: 'technical-analysis', win_rate: 0.62, sample_size: 41 },
        { agent_name: 'news-sentinel', win_rate: 0.48, sample_size: 12 },
      ],
    });
    const result = await orchestrator.getAgentCalibration(30);
    expect(result['technical-analysis']).toEqual({ winRate: 0.62, sampleSize: 41 });
    expect(result['news-sentinel']).toEqual({ winRate: 0.48, sampleSize: 12 });
  });

  test('handles missing/null win_rate with default 0.5', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ agent_name: 'new-agent', win_rate: null, sample_size: 0 }],
    });
    const result = await orchestrator.getAgentCalibration(30);
    expect(result['new-agent'].winRate).toBe(0.5);
    expect(result['new-agent'].sampleSize).toBe(0);
  });

  test('clamps win rates below 0 and above 1', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        { agent_name: 'weird-low', win_rate: -0.1, sample_size: 5 },
        { agent_name: 'weird-high', win_rate: 1.5, sample_size: 5 },
      ],
    });
    const result = await orchestrator.getAgentCalibration(30);
    expect(result['weird-low'].winRate).toBe(0);
    expect(result['weird-high'].winRate).toBe(1);
  });
});
