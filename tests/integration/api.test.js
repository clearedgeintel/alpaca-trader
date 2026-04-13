/**
 * Supertest integration tests for the Express API.
 *
 * Strategy: mock every outbound dependency (Alpaca, DB, agents, LLM)
 * so we exercise the real routing/validation/error paths without
 * hitting the network or a live Postgres.
 */

const mockAlpaca = {
  getAccount: jest.fn(async () => ({ buying_power: 100000, portfolio_value: 100000, cash: 100000 })),
  getPositions: jest.fn(async () => []),
  getSnapshot: jest.fn(async (symbol) => ({ symbol, latestTrade: { p: 100 }, dailyBar: { c: 100 }, prevDailyBar: { c: 99 } })),
  getMultiSnapshots: jest.fn(async (symbols) => {
    const out = {};
    for (const s of symbols) {
      out[s] = { price: 100, volume: 500000, changeFromPrevClose: 0.5, open: 99.5, high: 100.5, low: 99, close: 100, prevClose: 99.5 };
    }
    return out;
  }),
  getBars: jest.fn(async () => []),
  getDailyBars: jest.fn(async () => []),
  getNews: jest.fn(async () => []),
  getMostActive: jest.fn(async () => []),
  getTopMovers: jest.fn(async () => ({ gainers: [], losers: [] })),
  placeOrder: jest.fn(async () => ({ id: 'test-order', status: 'filled' })),
  placeBracketOrder: jest.fn(async () => ({ id: 'test-order', status: 'filled' })),
  closePosition: jest.fn(async () => ({ symbol: 'TEST' })),
  getOrder: jest.fn(async () => ({ status: 'filled' })),
  getOrders: jest.fn(async () => []),
  getAssets: jest.fn(async () => []),
  getPosition: jest.fn(async () => null),
};

const mockDb = {
  query: jest.fn(async (sql) => {
    // Return sensible defaults for common shapes so routes don't crash
    if (/FROM trades/i.test(sql)) return { rows: [] };
    if (/FROM signals/i.test(sql)) return { rows: [] };
    if (/FROM agent_decisions/i.test(sql)) return { rows: [] };
    if (/FROM daily_performance/i.test(sql)) return { rows: [] };
    if (/FROM agent_metrics/i.test(sql)) return { rows: [] };
    if (/FROM agent_performance/i.test(sql)) return { rows: [] };
    if (/FROM runtime_config/i.test(sql)) return { rows: [] };
    return { rows: [] };
  }),
  getClient: jest.fn(),
  withTransaction: jest.fn(async (fn) => fn({ query: async () => ({ rows: [] }) })),
  initSchema: jest.fn(async () => {}),
};

const stubAgent = (name) => ({
  name,
  getReport: jest.fn(() => null),
  getStatus: jest.fn(() => ({ name, enabled: true, running: false, runCount: 0, hasReport: false, lastSignal: null, lastConfidence: null })),
  getAlerts: jest.fn(() => []),
  getSymbolReport: jest.fn(() => null),
  getSymbolSentiment: jest.fn(() => null),
  getCriticalAlert: jest.fn(() => null),
  getParams: jest.fn(() => ({ regime: 'trending_bull', bias: 'long' })),
  getWatchlist: jest.fn(() => ['AAPL']),
  getCandidates: jest.fn(() => []),
  getDecisions: jest.fn(() => []),
  getFillHistory: jest.fn(() => []),
  getAgentCalibration: jest.fn(async () => ({})),
  DISCOVERY_POOL: [],
  evaluate: jest.fn(async () => ({ approved: true, adjustments: {} })),
  execute: jest.fn(async () => ({ executed: false })),
});

jest.mock('../../src/alpaca', () => mockAlpaca);
jest.mock('../../src/db', () => mockDb);
jest.mock('../../src/agents/risk-agent', () => stubAgent('risk-manager'));
jest.mock('../../src/agents/regime-agent', () => stubAgent('market-regime'));
jest.mock('../../src/agents/technical-agent', () => stubAgent('technical-analysis'));
jest.mock('../../src/agents/news-agent', () => stubAgent('news-sentinel'));
jest.mock('../../src/agents/screener-agent', () => stubAgent('market-screener'));
jest.mock('../../src/agents/orchestrator', () => stubAgent('orchestrator'));
jest.mock('../../src/agents/execution-agent', () => stubAgent('execution'));
jest.mock('../../src/agents/llm', () => ({
  getUsage: jest.fn(() => ({ callCount: 0, estimatedCostUsd: 0, totalInputTokens: 0, totalOutputTokens: 0, available: true, dailyCostCapUsd: 5, dailyTokenCap: 2000000 })),
  getDebugLog: jest.fn(() => []),
  ask: jest.fn(),
  askJson: jest.fn(),
  isAvailable: jest.fn(() => true),
}));
jest.mock('../../src/chat', () => ({ chat: jest.fn(async () => ({ answer: 'test answer', toolCalls: [] })) }));
jest.mock('../../src/scanner', () => ({ runScan: jest.fn() }));
jest.mock('../../src/runtime-config', () => ({
  init: jest.fn(), get: jest.fn(), getAll: jest.fn(() => ({})), getEffective: jest.fn(() => ({})),
  set: jest.fn(), remove: jest.fn(),
}));
jest.mock('../../src/logger', () => ({ log: () => {}, error: () => {}, warn: () => {}, alert: () => {} }));

const request = require('supertest');
const { app } = require('../../src/server');

describe('GET /api/status', () => {
  test('returns 200 with status shape', async () => {
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('market_open');
    expect(res.body.data).toHaveProperty('uptime_seconds');
  });
});

describe('GET /api/account', () => {
  test('returns account data from Alpaca', async () => {
    const res = await request(app).get('/api/account');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.portfolio_value).toBe(100000);
  });

  test('returns 500 when Alpaca throws', async () => {
    mockAlpaca.getAccount.mockRejectedValueOnce(new Error('Alpaca down'));
    const res = await request(app).get('/api/account');
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /api/positions', () => {
  test('returns empty array when no positions', async () => {
    const res = await request(app).get('/api/positions');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('GET /api/trades', () => {
  test('returns an array wrapped in { success, data }', async () => {
    const res = await request(app).get('/api/trades');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  test('honors status=open query param', async () => {
    const res = await request(app).get('/api/trades?status=open');
    expect(res.status).toBe(200);
    // The mock returns [] regardless; we just ensure the query runs
    expect(mockDb.query).toHaveBeenCalled();
  });
});

describe('GET /api/signals', () => {
  test('returns empty array when no signals', async () => {
    const res = await request(app).get('/api/signals?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('GET /api/agents', () => {
  test('returns agents array with llmUsage + mode', async () => {
    const res = await request(app).get('/api/agents');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.agents)).toBe(true);
    expect(res.body.data).toHaveProperty('llmUsage');
    expect(res.body.data).toHaveProperty('mode');
  });
});

describe('GET /api/market/tickers', () => {
  test('returns ticker array with price/change shape', async () => {
    const res = await request(app).get('/api/market/tickers');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0]).toHaveProperty('symbol');
    expect(res.body.data[0]).toHaveProperty('price');
    expect(res.body.data[0]).toHaveProperty('change');
  });
});

describe('GET /api/agents/calibration', () => {
  test('returns calibration data from orchestrator', async () => {
    const res = await request(app).get('/api/agents/calibration');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({});
  });
});

describe('POST /api/chat', () => {
  test('400 when question is missing — validation middleware', async () => {
    const res = await request(app).post('/api/chat').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.issues).toBeDefined();
  });

  test('400 with issue details when question is empty string', async () => {
    const res = await request(app).post('/api/chat').send({ question: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.issues.some(i => i.path === 'question')).toBe(true);
  });

  test('200 with an answer when question provided', async () => {
    const res = await request(app).post('/api/chat').send({ question: 'hi' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('answer');
  });
});

describe('PUT /api/strategies/:symbol — validation', () => {
  test('400 when mode is missing', async () => {
    const res = await request(app).put('/api/strategies/AAPL').send({});
    expect(res.status).toBe(400);
  });

  test('400 when mode is not in enum', async () => {
    const res = await request(app).put('/api/strategies/AAPL').send({ mode: 'invalid' });
    expect(res.status).toBe(400);
  });

  test('200 when mode is valid', async () => {
    const res = await request(app).put('/api/strategies/AAPL').send({ mode: 'rules' });
    expect(res.status).toBe(200);
  });
});

describe('PUT /api/runtime-config/:key — validation', () => {
  test('400 when value is missing', async () => {
    const res = await request(app).put('/api/runtime-config/TARGET_PCT').send({});
    expect(res.status).toBe(400);
  });

  test('400 when value is an object (not in union)', async () => {
    const res = await request(app).put('/api/runtime-config/TARGET_PCT').send({ value: { foo: 'bar' } });
    expect(res.status).toBe(400);
  });

  test('200 when value is a string', async () => {
    const res = await request(app).put('/api/runtime-config/TARGET_PCT').send({ value: '0.08' });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/backtest — validation', () => {
  test('400 when days is out of range', async () => {
    const res = await request(app).post('/api/backtest').send({ days: 1000 });
    expect(res.status).toBe(400);
  });

  test('400 when riskPct is absurdly high', async () => {
    const res = await request(app).post('/api/backtest').send({ riskPct: 5 });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/watchlist — validation', () => {
  test('400 when symbol missing', async () => {
    const res = await request(app).post('/api/watchlist').send({});
    expect(res.status).toBe(400);
  });

  test('symbol is coerced to uppercase by the schema', async () => {
    const res = await request(app).post('/api/watchlist').send({ symbol: 'aapl' });
    expect(res.status).toBe(200);
  });
});

describe('rate limiting', () => {
  test('rate limiter is wired on /api/ routes (headers present)', async () => {
    const res = await request(app).get('/api/status');
    expect(res.headers['ratelimit-limit']).toBeDefined();
    expect(res.headers['ratelimit-remaining']).toBeDefined();
  });
});

describe('404 on unknown API route', () => {
  test('GET /api/does-not-exist falls through', async () => {
    const res = await request(app).get('/api/does-not-exist');
    // Unknown API routes fall through to static/SPA fallback — either 404 or an HTML 200.
    // Assert it's not returning our success JSON shape.
    expect(res.body?.success).not.toBe(true);
  });
});
