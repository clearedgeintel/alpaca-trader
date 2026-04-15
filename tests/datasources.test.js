/**
 * Unit tests for the datasource registry + Polygon adapter.
 * Uses a mocked global fetch so no network is hit.
 */

jest.mock('../src/logger', () => ({
  log: () => {}, warn: () => {}, error: () => {},
  runWithContext: (_c, fn) => fn(),
  newCorrelationId: () => 'test',
  getContext: () => ({}),
}));

jest.mock('../src/runtime-config', () => ({
  get: jest.fn(() => undefined),
  getAll: jest.fn(() => ({})),
  getEffective: jest.fn(() => ({})),
  set: jest.fn(),
  remove: jest.fn(),
  refresh: jest.fn(),
  init: jest.fn(),
}));

const runtimeConfig = require('../src/runtime-config');
const polygon = require('../src/datasources/polygon-adapter');

const originalFetch = global.fetch;

function mockFetchOnce(status, body) {
  global.fetch = jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    json: async () => body,
  }));
}

function mockFetchSequence(...responses) {
  const fn = jest.fn();
  for (const r of responses) {
    fn.mockImplementationOnce(async () => ({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => typeof r.body === 'string' ? r.body : JSON.stringify(r.body),
      json: async () => r.body,
    }));
  }
  global.fetch = fn;
  return fn;
}

beforeEach(() => {
  polygon._resetForTests();
  runtimeConfig.get.mockReset().mockReturnValue(undefined);
  delete process.env.POLYGON_API_KEY;
});

afterAll(() => { global.fetch = originalFetch; });

describe('polygon-adapter — disabled path', () => {
  test('returns null from every method when POLYGON_API_KEY is unset', async () => {
    global.fetch = jest.fn(); // should never be called
    expect(await polygon.getTickerDetails('AAPL')).toBeNull();
    expect(await polygon.getNewsWithInsights('AAPL')).toBeNull();
    expect(await polygon.getDividends('AAPL')).toBeNull();
    expect(await polygon.getMarketStatus()).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('returns null when POLYGON_ENABLED runtime flag is false', async () => {
    process.env.POLYGON_API_KEY = 'test-key';
    runtimeConfig.get.mockImplementation(k => k === 'POLYGON_ENABLED' ? false : undefined);
    global.fetch = jest.fn();
    expect(await polygon.getTickerDetails('AAPL')).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('polygon-adapter — enabled path', () => {
  beforeEach(() => { process.env.POLYGON_API_KEY = 'test-key'; });

  test('getTickerDetails parses /v3/reference/tickers response', async () => {
    mockFetchOnce(200, { results: {
      ticker: 'AAPL', name: 'Apple Inc.', market_cap: 3000000000000,
      sic_description: 'Electronic Computers', description: 'Apple designs…',
    }});
    const r = await polygon.getTickerDetails('AAPL');
    expect(r).toMatchObject({ symbol: 'AAPL', name: 'Apple Inc.', marketCap: 3e12, sic_description: 'Electronic Computers' });
  });

  test('second call to same ticker is served from cache (no extra fetch)', async () => {
    const fn = mockFetchSequence({ status: 200, body: { results: { ticker: 'AAPL', name: 'Apple', market_cap: 1 } } });
    await polygon.getTickerDetails('AAPL');
    await polygon.getTickerDetails('AAPL');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('getNewsWithInsights preserves insights[] sentiment field', async () => {
    mockFetchOnce(200, { results: [
      { id: 'n1', title: 'AAPL up', article_url: 'https://x/1', description: 's', published_utc: '2026-04-15T00:00:00Z', tickers: ['AAPL'], insights: [{ ticker: 'AAPL', sentiment: 'positive', sentiment_reasoning: 'beat earnings' }] },
    ]});
    const r = await polygon.getNewsWithInsights('AAPL', 5);
    expect(r).toHaveLength(1);
    expect(r[0].insights[0]).toMatchObject({ ticker: 'AAPL', sentiment: 'positive' });
  });

  test('429 after retries returns null and increments error count', async () => {
    mockFetchSequence(
      { status: 429, body: 'rate limited' },
      { status: 429, body: 'rate limited' },
      { status: 429, body: 'rate limited' },
    );
    const r = await polygon.getTickerDetails('AAPL');
    expect(r).toBeNull();
    const s = polygon.getStats();
    expect(s.errors).toBe(1);
  });

  test('token bucket blocks the 6th call in a burst', async () => {
    mockFetchOnce(200, { results: { ticker: 'X', name: 'X', market_cap: 1 } });
    global.fetch = jest.fn(async () => ({
      ok: true, status: 200,
      text: async () => '{}',
      json: async () => ({ results: { ticker: 'X', name: 'X', market_cap: 1 } }),
    }));
    // 5 unique symbols → consume all 5 tokens
    const syms = ['A','B','C','D','E'];
    for (const s of syms) await polygon.getTickerDetails(s);
    // 6th unique symbol → bucket empty, should return null without fetching
    const callsBefore = global.fetch.mock.calls.length;
    const r = await polygon.getTickerDetails('F');
    expect(r).toBeNull();
    expect(global.fetch.mock.calls.length).toBe(callsBefore);
  });
});

describe('datasource registry', () => {
  test('exposes Alpaca data methods and Polygon enrichment', () => {
    const ds = require('../src/datasources');
    expect(typeof ds.getDailyBars).toBe('function');
    expect(typeof ds.getSnapshot).toBe('function');
    expect(typeof ds.getTickerDetails).toBe('function');
    expect(typeof ds.getNewsWithInsights).toBe('function');
  });
});

describe('TtlCache', () => {
  const { TtlCache } = require('../src/datasources/cache');

  test('returns undefined after ttl expires', () => {
    const c = new TtlCache(50);
    c.set('k', 1);
    expect(c.get('k')).toBe(1);
    const then = Date.now();
    while (Date.now() - then < 60) { /* busy wait 60ms */ }
    expect(c.get('k')).toBeUndefined();
  });

  test('evicts oldest entry when over capacity', () => {
    const c = new TtlCache(60000);
    // Cache caps at 500; insert 501 to force eviction of the first.
    for (let i = 0; i < 501; i++) c.set(`k${i}`, i);
    expect(c.get('k0')).toBeUndefined();
    expect(c.get('k500')).toBe(500);
  });
});
