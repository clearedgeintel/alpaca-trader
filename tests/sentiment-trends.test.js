/**
 * Unit tests for the sentiment trends aggregator. We mock the DB so
 * the tests exercise only the query shapes + result parsing; an
 * integration test against a real Postgres would be a follow-up.
 */

const mockDb = { query: jest.fn() };
jest.mock('../src/db', () => mockDb);
jest.mock('../src/logger', () => ({
  log: () => {}, warn: () => {}, error: () => {},
  runWithContext: (_c, fn) => fn(),
  newCorrelationId: () => 'test',
  getContext: () => ({}),
}));

const { getTrend, getShifts } = require('../src/sentiment-trends');

beforeEach(() => mockDb.query.mockReset());

describe('getTrend', () => {
  test('passes symbol + days and returns rows as-is', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [
      { t: '2026-04-14T00:00:00Z', sentiment: 0.3, urgency: 'low', article_count: 2, polygon_positive: 1, polygon_negative: 0 },
      { t: '2026-04-15T00:00:00Z', sentiment: 0.6, urgency: 'medium', article_count: 3, polygon_positive: 2, polygon_negative: 0 },
    ]});
    const r = await getTrend('AAPL', 7);
    expect(mockDb.query.mock.calls[0][1]).toEqual(['AAPL', '7']);
    expect(r).toHaveLength(2);
    expect(r[1].sentiment).toBe(0.6);
  });

  test('returns empty array on DB failure (fail-open)', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('connection refused'));
    const r = await getTrend('AAPL', 7);
    expect(r).toEqual([]);
  });
});

describe('getShifts', () => {
  test('parses delta + direction from endpoint query rows', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [
      { symbol: 'AAPL', first_sentiment: '0.100', last_sentiment: '0.700', delta: '0.600',
        sample_size: '5', avg_sentiment: '0.400',
        first_at: '2026-04-14T00:00:00Z', last_at: '2026-04-15T00:00:00Z' },
      { symbol: 'TSLA', first_sentiment: '0.500', last_sentiment: '-0.200', delta: '-0.700',
        sample_size: '3', avg_sentiment: '0.100',
        first_at: '2026-04-14T06:00:00Z', last_at: '2026-04-15T00:00:00Z' },
    ]});
    const r = await getShifts({ hours: 24, threshold: 0.4 });
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ symbol: 'AAPL', delta: 0.6, direction: 'bullish' });
    expect(r[1]).toMatchObject({ symbol: 'TSLA', delta: -0.7, direction: 'bearish' });
  });

  test('passes hours + threshold as SQL parameters', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    await getShifts({ hours: 6, threshold: 0.5 });
    expect(mockDb.query.mock.calls[0][1]).toEqual(['6', 0.5]);
  });

  test('uses default hours=24 threshold=0.4 when no options passed', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    await getShifts();
    expect(mockDb.query.mock.calls[0][1]).toEqual(['24', 0.4]);
  });

  test('returns empty array on DB failure (fail-open)', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('boom'));
    const r = await getShifts({ hours: 24, threshold: 0.4 });
    expect(r).toEqual([]);
  });

  test('excludes rows with fewer than 2 snapshots (enforced in SQL WHERE)', async () => {
    // This test verifies we *trust* the SQL WHERE clause by asserting the
    // query text includes the guard — a real DB isn't available here.
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    await getShifts();
    const sql = mockDb.query.mock.calls[0][0];
    expect(sql).toMatch(/sample_size\s*>=\s*2/);
    expect(sql).toMatch(/ABS\(last_sentiment - first_sentiment\)\s*>=\s*\$2/);
  });
});
