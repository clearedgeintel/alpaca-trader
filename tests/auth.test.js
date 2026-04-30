/**
 * Auth middleware: healthcheck allowlist + production-mode hardening.
 */

describe('apiKeyAuth', () => {
  let originalNodeEnv;
  let originalApiKey;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    originalApiKey = process.env.API_KEY;
    jest.resetModules();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalApiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = originalApiKey;
    jest.resetModules();
  });

  function makeReqRes({ path = '/api/positions', headers = {}, query = {} } = {}) {
    const req = { path, headers, query };
    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.body = body; return this; },
    };
    return { req, res };
  }

  test('skips auth for /api/status (Railway healthcheck)', () => {
    delete process.env.API_KEY;
    process.env.NODE_ENV = 'production';
    const auth = require('../src/middleware/auth');
    const { req, res } = makeReqRes({ path: '/api/status' });
    const next = jest.fn();
    auth(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  test('skips auth for /api/health', () => {
    delete process.env.API_KEY;
    process.env.NODE_ENV = 'production';
    const auth = require('../src/middleware/auth');
    const { req, res } = makeReqRes({ path: '/api/health' });
    const next = jest.fn();
    auth(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('returns 503 in production when API_KEY is unset', () => {
    delete process.env.API_KEY;
    process.env.NODE_ENV = 'production';
    const auth = require('../src/middleware/auth');
    const { req, res } = makeReqRes({ path: '/api/positions' });
    const next = jest.fn();
    auth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ success: false, error: 'API_KEY not configured' });
  });

  test('passes through in dev when API_KEY is unset', () => {
    delete process.env.API_KEY;
    process.env.NODE_ENV = 'development';
    const auth = require('../src/middleware/auth');
    const { req, res } = makeReqRes({ path: '/api/positions' });
    const next = jest.fn();
    auth(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('accepts matching x-api-key header', () => {
    process.env.API_KEY = 'secret123';
    process.env.NODE_ENV = 'production';
    const auth = require('../src/middleware/auth');
    const { req, res } = makeReqRes({ path: '/api/positions', headers: { 'x-api-key': 'secret123' } });
    const next = jest.fn();
    auth(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('rejects missing key with 401', () => {
    process.env.API_KEY = 'secret123';
    process.env.NODE_ENV = 'production';
    const auth = require('../src/middleware/auth');
    const { req, res } = makeReqRes({ path: '/api/positions' });
    const next = jest.fn();
    auth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  test('rejects mismatched key with 401', () => {
    process.env.API_KEY = 'secret123';
    process.env.NODE_ENV = 'production';
    const auth = require('../src/middleware/auth');
    const { req, res } = makeReqRes({ path: '/api/positions', headers: { 'x-api-key': 'wrong' } });
    const next = jest.fn();
    auth(req, res, next);
    expect(res.statusCode).toBe(401);
  });

  test('exports PUBLIC_PATHS for downstream use (rate-limiter skip)', () => {
    const auth = require('../src/middleware/auth');
    expect(auth.PUBLIC_PATHS).toBeInstanceOf(Set);
    expect(auth.PUBLIC_PATHS.has('/api/status')).toBe(true);
    expect(auth.PUBLIC_PATHS.has('/api/health')).toBe(true);
    expect(auth.PUBLIC_PATHS.has('/api/positions')).toBe(false);
  });
});
