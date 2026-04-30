/**
 * IP allowlist middleware: pass-through when disabled, 403 when enabled
 * and IP not in list, healthcheck paths always exempt.
 */

const mockRuntimeConfig = { get: jest.fn() };
jest.mock('../src/runtime-config', () => mockRuntimeConfig);

// auth.js exports PUBLIC_PATHS — let it load naturally (no DB reads in middleware path).

const ipAllowlist = require('../src/middleware/ip-allowlist');

function makeReqRes({ ip = '203.0.113.1', path = '/api/positions' } = {}) {
  const req = { ip, path };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return { req, res };
}

describe('ipAllowlist', () => {
  beforeEach(() => {
    mockRuntimeConfig.get.mockReset();
  });

  test('passes through when IP_ALLOWLIST_ENABLED=false', () => {
    mockRuntimeConfig.get.mockImplementation((k) => (k === 'IP_ALLOWLIST_ENABLED' ? false : null));
    const { req, res } = makeReqRes();
    const next = jest.fn();
    ipAllowlist(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('passes through with empty allowlist (avoids self-lockout)', () => {
    mockRuntimeConfig.get.mockImplementation((k) => {
      if (k === 'IP_ALLOWLIST_ENABLED') return true;
      if (k === 'IP_ALLOWLIST') return [];
      return null;
    });
    const { req, res } = makeReqRes();
    const next = jest.fn();
    ipAllowlist(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('allows IPs in the list', () => {
    mockRuntimeConfig.get.mockImplementation((k) => {
      if (k === 'IP_ALLOWLIST_ENABLED') return true;
      if (k === 'IP_ALLOWLIST') return ['203.0.113.1', '198.51.100.5'];
      return null;
    });
    const { req, res } = makeReqRes({ ip: '203.0.113.1' });
    const next = jest.fn();
    ipAllowlist(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('rejects IPs not in the list with 403', () => {
    mockRuntimeConfig.get.mockImplementation((k) => {
      if (k === 'IP_ALLOWLIST_ENABLED') return true;
      if (k === 'IP_ALLOWLIST') return ['203.0.113.1'];
      return null;
    });
    const { req, res } = makeReqRes({ ip: '198.51.100.99' });
    const next = jest.fn();
    ipAllowlist(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ success: false, error: 'IP not in allowlist' });
  });

  test('always exempts /api/status (healthcheck)', () => {
    mockRuntimeConfig.get.mockImplementation((k) => {
      if (k === 'IP_ALLOWLIST_ENABLED') return true;
      if (k === 'IP_ALLOWLIST') return ['203.0.113.1'];
      return null;
    });
    const { req, res } = makeReqRes({ ip: '198.51.100.99', path: '/api/status' });
    const next = jest.fn();
    ipAllowlist(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  test('always exempts /api/health', () => {
    mockRuntimeConfig.get.mockImplementation((k) => {
      if (k === 'IP_ALLOWLIST_ENABLED') return true;
      if (k === 'IP_ALLOWLIST') return ['203.0.113.1'];
      return null;
    });
    const { req, res } = makeReqRes({ ip: '198.51.100.99', path: '/api/health' });
    const next = jest.fn();
    ipAllowlist(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});
