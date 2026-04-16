/**
 * Unit tests for the Prometheus metrics registry.
 * Verifies the instruments are registered, observations stick, and the
 * text scrape output includes the expected metric names.
 */

const mockDb = { query: jest.fn(async () => ({ rows: [{ n: 0 }] })) };
const mockLlm = {
  getUsage: jest.fn(() => ({
    dailyCostCapUsd: 15,
    estimatedCostUsd: 1.23,
    circuitBreakerOpen: false,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    callCount: 0,
  })),
};
const mockDatasources = {
  _providers: {
    polygon: { getStats: () => ({ calls: 7, ratelimited: false, errors: 0, cacheHits: 3 }) },
  },
};

jest.mock('../src/db', () => mockDb);
jest.mock('../src/agents/llm', () => mockLlm);
jest.mock('../src/datasources', () => mockDatasources);
jest.mock('../src/logger', () => ({
  log: () => {},
  warn: () => {},
  error: () => {},
  runWithContext: (_c, fn) => fn(),
  newCorrelationId: () => 'test',
  getContext: () => ({}),
}));

const metrics = require('../src/metrics');

beforeEach(() => metrics._reset());

describe('registry setup', () => {
  test('exposes a Prometheus content-type', () => {
    expect(metrics._contentType()).toMatch(/text\/plain/);
  });

  test('scrape output includes expected metric names', async () => {
    const text = await metrics._metrics();
    for (const name of [
      'llm_calls_total',
      'llm_tokens_total',
      'llm_cost_usd_total',
      'llm_budget_remaining_usd',
      'llm_circuit_breaker_open',
      'trades_opened_total',
      'trades_closed_total',
      'positions_open',
      'agency_cycle_duration_seconds',
      'agent_cycle_duration_seconds',
      'polygon_calls_total_scraped',
      'polygon_rate_limited',
    ]) {
      expect(text).toMatch(new RegExp(`# HELP ${name} `));
    }
  });
});

describe('counter increments', () => {
  test('llmCallsTotal.inc bumps a labelled series', async () => {
    metrics.llmCallsTotal.inc({ agent: 'orchestrator', model: 'claude-sonnet-4-6' });
    metrics.llmCallsTotal.inc({ agent: 'orchestrator', model: 'claude-sonnet-4-6' });
    const text = await metrics._metrics();
    expect(text).toMatch(/llm_calls_total\{[^}]*agent="orchestrator"[^}]*model="[^"]+"[^}]*\} 2/);
  });

  test('tradesOpenedTotal + tradesClosedTotal record by reason', async () => {
    metrics.tradesOpenedTotal.inc();
    metrics.tradesClosedTotal.inc({ reason: 'stop_loss' });
    metrics.tradesClosedTotal.inc({ reason: 'stop_loss' });
    metrics.tradesClosedTotal.inc({ reason: 'take_profit' });
    const text = await metrics._metrics();
    expect(text).toMatch(/trades_opened_total\S* 1/);
    expect(text).toMatch(/trades_closed_total\{[^}]*reason="stop_loss"[^}]*\} 2/);
    expect(text).toMatch(/trades_closed_total\{[^}]*reason="take_profit"[^}]*\} 1/);
  });

  test('llmTokensTotal by direction', async () => {
    metrics.llmTokensTotal.inc({ direction: 'input' }, 100);
    metrics.llmTokensTotal.inc({ direction: 'cache_read' }, 4000);
    const text = await metrics._metrics();
    expect(text).toMatch(/llm_tokens_total\{[^}]*direction="input"[^}]*\} 100/);
    expect(text).toMatch(/llm_tokens_total\{[^}]*direction="cache_read"[^}]*\} 4000/);
  });
});

describe('scrape-time gauges', () => {
  test('llm_budget_remaining_usd derives from getUsage()', async () => {
    // getUsage returns cap 15 and spend 1.23 → remaining 13.77
    const text = await metrics._metrics();
    expect(text).toMatch(/llm_budget_remaining_usd\S* 13\.77/);
  });

  test('polygon_calls_total_scraped pulls from datasources stats', async () => {
    const text = await metrics._metrics();
    expect(text).toMatch(/polygon_calls_total_scraped\S* 7/);
  });

  test('positions_open queries the DB at scrape time', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ n: 4 }] });
    const text = await metrics._metrics();
    expect(text).toMatch(/positions_open\S* 4/);
  });
});

describe('histograms', () => {
  test('agency_cycle_duration_seconds records observations', async () => {
    metrics.agencyCycleDuration.observe(2.5);
    metrics.agencyCycleDuration.observe(12);
    const text = await metrics._metrics();
    // Histogram emits _count and _sum lines
    expect(text).toMatch(/agency_cycle_duration_seconds_count\S* 2/);
    expect(text).toMatch(/agency_cycle_duration_seconds_sum\S* 14\.5/);
  });

  test('agent_cycle_duration_seconds segments by agent label', async () => {
    metrics.agentCycleDuration.observe({ agent: 'technical' }, 0.8);
    metrics.agentCycleDuration.observe({ agent: 'news' }, 3.2);
    const text = await metrics._metrics();
    expect(text).toMatch(/agent_cycle_duration_seconds_count\{[^}]*agent="technical"[^}]*\} 1/);
    expect(text).toMatch(/agent_cycle_duration_seconds_sum\{[^}]*agent="news"[^}]*\} 3\.2/);
  });
});
