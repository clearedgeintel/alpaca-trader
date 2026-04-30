const config = require('../config');

// Endpoints that must remain reachable without an API key — e.g. Railway's
// healthcheck probe and Prometheus deep-health pings, which can't carry
// custom headers. Exact-match Set (no prefix matching) so we don't
// accidentally expose future `/api/health/admin`-style endpoints.
const PUBLIC_PATHS = new Set(['/api/status', '/api/health']);

function apiKeyAuth(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  if (!config.API_KEY) {
    // In production, missing API_KEY is a misconfiguration — return 503
    // rather than silently allowing unauthenticated traffic. In dev we
    // still skip auth (a single startup warning is logged from server.js).
    if (process.env.NODE_ENV === 'production') {
      return res.status(503).json({ success: false, error: 'API_KEY not configured' });
    }
    return next();
  }

  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key === config.API_KEY) return next();

  return res.status(401).json({ success: false, error: 'Invalid or missing API key' });
}

module.exports = apiKeyAuth;
module.exports.PUBLIC_PATHS = PUBLIC_PATHS;
