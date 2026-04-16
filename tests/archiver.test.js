/**
 * Unit tests for the nightly archiver. DB is mocked so we verify the
 * SQL shapes + audit-log writes + per-table retention wiring without
 * touching a real Postgres.
 */

const mockDb = { query: jest.fn() };
jest.mock('../src/db', () => mockDb);
jest.mock('../src/logger', () => ({
  log: () => {},
  warn: () => {},
  error: () => {},
  runWithContext: (_c, fn) => fn(),
  newCorrelationId: () => 'test',
  getContext: () => ({}),
}));

const archiver = require('../src/archiver');
const { DateTime } = require('luxon');

beforeEach(() => {
  mockDb.query.mockReset();
  archiver._resetForTests();
  delete process.env.SIGNALS_RETENTION_DAYS;
  delete process.env.AGENT_REPORTS_RETENTION_DAYS;
  delete process.env.AGENT_METRICS_RETENTION_DAYS;
  delete process.env.SENTIMENT_RETENTION_DAYS;
  delete process.env.ARCHIVER_TIME_ET;
});

describe('retentionConfig', () => {
  test('returns sensible defaults when env is empty', () => {
    const cfg = archiver.retentionConfig();
    expect(cfg).toEqual({
      signals: 90,
      agent_reports: 60,
      agent_metrics: 60,
      sentiment_snapshots: 90,
    });
  });

  test('honors env-var overrides', () => {
    process.env.SIGNALS_RETENTION_DAYS = '30';
    process.env.SENTIMENT_RETENTION_DAYS = '180';
    const cfg = archiver.retentionConfig();
    expect(cfg.signals).toBe(30);
    expect(cfg.sentiment_snapshots).toBe(180);
  });

  test('ignores non-positive / non-numeric overrides', () => {
    process.env.SIGNALS_RETENTION_DAYS = 'garbage';
    process.env.AGENT_METRICS_RETENTION_DAYS = '-5';
    const cfg = archiver.retentionConfig();
    expect(cfg.signals).toBe(90);
    expect(cfg.agent_metrics).toBe(60);
  });
});

describe('runArchiver', () => {
  test('deletes from every tracked table and writes one archive_log row each', async () => {
    // Mock the cutoff SELECT + DELETE + INSERT INTO archive_log sequence per table (4 tables × 3 calls = 12 queries)
    mockDb.query.mockImplementation(async (sql) => {
      if (/SELECT NOW\(\)/.test(sql)) return { rows: [{ cutoff: new Date('2025-01-01T00:00:00Z') }] };
      if (/^DELETE FROM/i.test(sql)) return { rowCount: 5 };
      if (/INSERT INTO archive_log/.test(sql)) return { rows: [] };
      return { rows: [] };
    });

    const r = await archiver.runArchiver();

    expect(r.results).toHaveLength(4);
    expect(r.totalDeleted).toBe(20); // 4 tables × 5 rows each
    const tables = r.results.map((x) => x.table);
    expect(tables).toEqual(['signals', 'agent_reports', 'agent_metrics', 'sentiment_snapshots']);
    for (const row of r.results) {
      expect(row.error).toBeNull();
      expect(row.rowsDeleted).toBe(5);
    }

    // Each table should have written one archive_log row
    const inserts = mockDb.query.mock.calls.filter(([sql]) => /INSERT INTO archive_log/.test(sql));
    expect(inserts).toHaveLength(4);
  });

  test('uses captured_at column for sentiment_snapshots, created_at otherwise', async () => {
    mockDb.query.mockImplementation(async (sql) => {
      if (/SELECT NOW\(\)/.test(sql)) return { rows: [{ cutoff: new Date() }] };
      if (/^DELETE FROM/i.test(sql)) return { rowCount: 0 };
      return { rows: [] };
    });

    await archiver.runArchiver();

    const deleteSqls = mockDb.query.mock.calls.map(([sql]) => sql).filter((s) => /^DELETE FROM/i.test(s));
    const sentimentSql = deleteSqls.find((s) => /FROM sentiment_snapshots/.test(s));
    const signalsSql = deleteSqls.find((s) => /FROM signals/.test(s));
    expect(sentimentSql).toMatch(/captured_at < /);
    expect(signalsSql).toMatch(/created_at < /);
  });

  test('individual table failure does not halt the run; error is logged to archive_log', async () => {
    let callCount = 0;
    mockDb.query.mockImplementation(async (sql) => {
      if (/SELECT NOW\(\)/.test(sql)) return { rows: [{ cutoff: new Date() }] };
      if (/^DELETE FROM agent_reports/i.test(sql)) {
        callCount++;
        throw new Error('table busy');
      }
      if (/^DELETE FROM/i.test(sql)) return { rowCount: 2 };
      return { rows: [] };
    });

    const r = await archiver.runArchiver();
    expect(r.results).toHaveLength(4);
    const failed = r.results.find((x) => x.table === 'agent_reports');
    expect(failed.error).toMatch(/table busy/);
    expect(failed.rowsDeleted).toBe(0);
    // Other tables still succeeded (2 rows each, 3 tables)
    expect(r.totalDeleted).toBe(6);
  });
});

describe('getArchiveStatus', () => {
  test('returns recent archive_log rows + current retention config', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          ran_at: '2026-04-15T02:30:00Z',
          table_name: 'signals',
          rows_deleted: 1200,
          retention_days: 90,
          cutoff_at: '2026-01-15T00:00:00Z',
          duration_ms: 450,
          error: null,
        },
      ],
    });

    const status = await archiver.getArchiveStatus(5);
    expect(status.recent).toHaveLength(1);
    expect(status.recent[0].table_name).toBe('signals');
    expect(status.retention).toEqual({
      signals: 90,
      agent_reports: 60,
      agent_metrics: 60,
      sentiment_snapshots: 90,
    });
    expect(mockDb.query.mock.calls[0][1]).toEqual([5]);
  });

  test('returns empty rows + error field when DB query fails', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('connection lost'));
    const status = await archiver.getArchiveStatus();
    expect(status.recent).toEqual([]);
    expect(status.error).toMatch(/connection lost/);
  });
});

describe('shouldFireNow', () => {
  function et(iso) {
    return DateTime.fromISO(iso, { zone: 'America/New_York' });
  }

  beforeEach(() => archiver._resetForTests());

  test('fires after the configured ET hour when not yet run today', () => {
    expect(archiver.shouldFireNow(et('2026-04-15T03:00:00'))).toBe(true);
  });

  test('does not fire before the configured ET hour', () => {
    expect(archiver.shouldFireNow(et('2026-04-15T01:00:00'))).toBe(false);
  });

  test('honors ARCHIVER_TIME_ET override', () => {
    process.env.ARCHIVER_TIME_ET = '04:00';
    expect(archiver.shouldFireNow(et('2026-04-15T03:30:00'))).toBe(false);
    expect(archiver.shouldFireNow(et('2026-04-15T04:10:00'))).toBe(true);
  });
});
