const config = require('../config');

// Endpoints that must remain reachable without an API key — e.g. Railway's
// healthcheck probe and Prometheus deep-health pings, which can't carry
// custom headers. Exact-match Set (no prefix matching) so we don't
// accidentally expose future `/api/health/admin`-style endpoints.
const PUBLIC_PATHS = new Set(['/api/status', '/api/health']);

// This middleware is mounted with app.use('/api/', ...), so inside it req.path
// is RELATIVE to the mount (e.g. '/health', '/logo/AAPL') — not '/api/health'.
// Match the allowlist against the full original URL instead. Falls back to
// req.path for unit tests that pass a full path directly.
function fullPath(req) {
  return (req.originalUrl || req.path || '').split('?')[0];
}

// Public company logos: served straight to <img> tags that can't send the
// x-api-key header, and the data is non-sensitive (public ticker logos). GET
// only, so the POST /api/logo/cache/clear admin route stays gated.
function isPublicLogo(req, path) {
  return req.method === 'GET' && path.startsWith('/api/logo/');
}

function apiKeyAuth(req, res, next) {
  const path = fullPath(req);
  if (PUBLIC_PATHS.has(path) || isPublicLogo(req, path)) return next();

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
