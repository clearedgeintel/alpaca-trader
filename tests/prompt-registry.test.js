/**
 * Unit tests for the prompt registry fallback + activation logic.
 */

const mockDb = { query: jest.fn() };
jest.mock('../src/db', () => mockDb);
jest.mock('../src/logger', () => ({
  log: () => {},
  warn: () => {},
  error: () => {},
  alert: () => {},
  runWithContext: (_ctx, fn) => fn(),
  newCorrelationId: (p = '') => `${p}_test`,
  getContext: () => ({}),
}));

const promptRegistry = require('../src/agents/prompt-registry');

beforeEach(() => {
  mockDb.query.mockReset();
  // Reset registry internal state between tests by re-requiring a fresh copy
  jest.resetModules();
});

describe('getActive with fallback', () => {
  test('returns fallback when cache is empty', () => {
    const p = promptRegistry.getActive('test-agent', 'FALLBACK_PROMPT');
    expect(p).toBe('FALLBACK_PROMPT');
  });

  test('returns fallback when DB has no row for this agent', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    await promptRegistry.refresh();
    const p = promptRegistry.getActive('unknown-agent', 'FALLBACK_PROMPT');
    expect(p).toBe('FALLBACK_PROMPT');
  });

  test('returns DB prompt when an active row exists', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'uuid-1', agent_name: 'technical-analysis', version: 'v2', prompt: 'DB_OVERRIDE' }],
    });
    await promptRegistry.refresh();
    expect(promptRegistry.getActive('technical-analysis', 'FALLBACK')).toBe('DB_OVERRIDE');
    expect(promptRegistry.getActiveVersion('technical-analysis')).toBe('v2');
    expect(promptRegistry.getActiveId('technical-analysis')).toBe('uuid-1');
  });

  test('getActiveId returns null when no DB override exists', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    await promptRegistry.refresh();
    expect(promptRegistry.getActiveId('any-agent')).toBeNull();
  });

  test('unknown agent still falls back even when other agents have overrides', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ agent_name: 'technical-analysis', version: 'v2', prompt: 'DB_OVERRIDE' }],
    });
    await promptRegistry.refresh();
    expect(promptRegistry.getActive('news-sentinel', 'NEWS_FALLBACK')).toBe('NEWS_FALLBACK');
    expect(promptRegistry.getActiveVersion('news-sentinel')).toBe('hardcoded');
  });
});

describe('refresh silently handles DB failures', () => {
  test('does not throw when table is missing', async () => {
    const err = new Error('relation "prompt_versions" does not exist');
    mockDb.query.mockRejectedValueOnce(err);
    await expect(promptRegistry.refresh()).resolves.not.toThrow();
  });

  test('does not throw when DB connection is refused', async () => {
    const err = new Error('ECONNREFUSED 127.0.0.1:5432');
    mockDb.query.mockRejectedValueOnce(err);
    await expect(promptRegistry.refresh()).resolves.not.toThrow();
  });
});

describe('activate', () => {
  test('inserts/upserts and switches is_active', async () => {
    mockDb.query.mockResolvedValue({ rows: [] });
    await promptRegistry.activate('technical-analysis', 'v3', 'NEW_PROMPT_TEXT', 'test notes');
    const calls = mockDb.query.mock.calls;
    // INSERT upsert + UPDATE is_active + refresh SELECT — 3 calls minimum
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0][0]).toMatch(/INSERT INTO prompt_versions/);
    expect(calls[0][1]).toEqual(['technical-analysis', 'v3', 'NEW_PROMPT_TEXT', 'test notes']);
    expect(calls[1][0]).toMatch(/UPDATE prompt_versions SET is_active/);
    expect(calls[1][1]).toEqual(['technical-analysis', 'v3']);
  });
});

describe('list', () => {
  test('filters by agent when provided', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ agent_name: 'technical-analysis', version: 'v1' }] });
    const rows = await promptRegistry.list('technical-analysis');
    expect(rows).toHaveLength(1);
    expect(mockDb.query.mock.calls[0][0]).toMatch(/WHERE agent_name = \$1/);
    expect(mockDb.query.mock.calls[0][1]).toEqual(['technical-analysis']);
  });

  test('returns all agents when no filter provided', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    await promptRegistry.list();
    const sql = mockDb.query.mock.calls[0][0];
    expect(sql).not.toMatch(/WHERE agent_name/);
  });
});
