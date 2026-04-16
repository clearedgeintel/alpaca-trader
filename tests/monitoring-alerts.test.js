/**
 * Tests for monitoring-alerts threshold rules. All upstream modules
 * are mocked; we assert which alerts fire for a given state.
 */

const mockAlerting = { info: jest.fn(), warn: jest.fn(), critical: jest.fn(), alert: jest.fn() };
jest.mock('../src/alerting', () => mockAlerting);

const mockRuntimeConfig = {
  get: jest.fn(() => undefined),
  getAll: jest.fn(() => ({})),
  getEffective: jest.fn(() => ({})),
  set: jest.fn(),
  remove: jest.fn(),
  refresh: jest.fn(),
  init: jest.fn(),
};
jest.mock('../src/runtime-config', () => mockRuntimeConfig);

const mockLlm = { getUsage: jest.fn() };
jest.mock('../src/agents/llm', () => mockLlm);

const mockDb = { query: jest.fn() };
jest.mock('../src/db', () => mockDb);

jest.mock('../src/server', () => ({ _getLastScanTime: jest.fn(() => null) }));
jest.mock('../src/logger', () => ({
  log: () => {},
  warn: () => {},
  error: () => {},
  runWithContext: (_c, fn) => fn(),
  newCorrelationId: () => 'test',
  getContext: () => ({}),
}));

const monitoring = require('../src/monitoring-alerts');

beforeEach(() => {
  Object.values(mockAlerting).forEach((fn) => fn.mockReset?.());
  mockRuntimeConfig.get.mockReset().mockImplementation((k) => {
    // Safe defaults for all threshold keys
    if (k === 'MONITORING_ALERTS_ENABLED') return undefined; // default true
    return undefined;
  });
  mockLlm.getUsage.mockReset().mockReturnValue({
    estimatedCostUsd: 1.0,
    dailyCostCapUsd: 15.0,
    circuitBreakerOpen: false,
    breakerOpenUntil: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  });
  mockDb.query.mockReset().mockResolvedValue({ rows: [{ day_pnl: 0, peak: 0, n: 0 }] });
});

describe('runAlertChecks — disabled', () => {
  test('returns early with no fires when MONITORING_ALERTS_ENABLED is explicitly false', async () => {
    mockRuntimeConfig.get.mockImplementation((k) => (k === 'MONITORING_ALERTS_ENABLED' ? false : undefined));
    const r = await monitoring.runAlertChecks();
    expect(r.enabled).toBe(false);
    expect(r.fired).toEqual([]);
    expect(mockAlerting.critical).not.toHaveBeenCalled();
    expect(mockAlerting.warn).not.toHaveBeenCalled();
  });
});

describe('LLM cost thresholds', () => {
  test('fires warn at 80% of cap', async () => {
    mockLlm.getUsage.mockReturnValue({ estimatedCostUsd: 12, dailyCostCapUsd: 15, circuitBreakerOpen: false });
    const r = await monitoring.runAlertChecks();
    expect(r.fired.some((f) => f.rule === 'llm_cost_warn')).toBe(true);
    expect(mockAlerting.warn).toHaveBeenCalled();
    expect(mockAlerting.critical).not.toHaveBeenCalled();
  });

  test('fires critical at 95% of cap', async () => {
    mockLlm.getUsage.mockReturnValue({ estimatedCostUsd: 14.5, dailyCostCapUsd: 15, circuitBreakerOpen: false });
    const r = await monitoring.runAlertChecks();
    expect(r.fired.some((f) => f.rule === 'llm_cost_critical')).toBe(true);
    expect(mockAlerting.critical).toHaveBeenCalled();
  });

  test('no alert below warn threshold', async () => {
    mockLlm.getUsage.mockReturnValue({ estimatedCostUsd: 5, dailyCostCapUsd: 15, circuitBreakerOpen: false });
    const r = await monitoring.runAlertChecks();
    expect(r.fired.some((f) => f.rule.startsWith('llm_cost'))).toBe(false);
  });
});

describe('Circuit breaker', () => {
  test('fires critical when breaker open with >60s remaining', async () => {
    mockLlm.getUsage.mockReturnValue({
      estimatedCostUsd: 1,
      dailyCostCapUsd: 15,
      circuitBreakerOpen: true,
      breakerOpenUntil: new Date(Date.now() + 120_000).toISOString(),
    });
    const r = await monitoring.runAlertChecks();
    expect(r.fired.some((f) => f.rule === 'circuit_breaker_open')).toBe(true);
  });

  test('does not fire for short-duration breaker (< 60s remaining)', async () => {
    mockLlm.getUsage.mockReturnValue({
      estimatedCostUsd: 1,
      dailyCostCapUsd: 15,
      circuitBreakerOpen: true,
      breakerOpenUntil: new Date(Date.now() + 30_000).toISOString(),
    });
    const r = await monitoring.runAlertChecks();
    expect(r.fired.some((f) => f.rule === 'circuit_breaker_open')).toBe(false);
  });
});

describe('Daily drawdown', () => {
  test('fires critical when loss exceeds 5% of portfolio', async () => {
    // day_pnl = -6000, peak = 100000 → 6% drawdown
    mockDb.query.mockResolvedValue({ rows: [{ day_pnl: -6000, peak: 100000, n: 0 }] });
    const r = await monitoring.runAlertChecks();
    expect(r.fired.some((f) => f.rule === 'daily_drawdown')).toBe(true);
    expect(mockAlerting.critical).toHaveBeenCalledWith(
      expect.stringMatching(/drawdown/i),
      expect.any(String),
      expect.any(Object),
    );
  });

  test('does not fire when gains outweigh losses', async () => {
    mockDb.query.mockResolvedValue({ rows: [{ day_pnl: 500, peak: 100000, n: 0 }] });
    const r = await monitoring.runAlertChecks();
    expect(r.fired.some((f) => f.rule === 'daily_drawdown')).toBe(false);
  });
});

describe('Open positions threshold', () => {
  test('fires warn when open positions exceed limit', async () => {
    // Tweak DB response to return day_pnl=0 for drawdown check, and n=25 for positions
    let call = 0;
    mockDb.query.mockImplementation(async () => {
      call++;
      if (call === 1) return { rows: [{ day_pnl: 0, peak: 0 }] };
      return { rows: [{ n: 25 }] };
    });
    const r = await monitoring.runAlertChecks();
    expect(r.fired.some((f) => f.rule === 'open_positions_high')).toBe(true);
  });
});

describe('runAlertChecks resilience', () => {
  test('one failed check does not kill the batch', async () => {
    mockLlm.getUsage.mockImplementation(() => {
      throw new Error('LLM module not ready');
    });
    const r = await monitoring.runAlertChecks();
    expect(r.enabled).toBe(true);
    // Other checks still ran even though llm failed
    expect(r.checked.length).toBeGreaterThan(0);
  });
});
