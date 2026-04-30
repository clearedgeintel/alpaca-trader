/**
 * IP allowlist middleware.
 *
 * Pass-through when `IP_ALLOWLIST_ENABLED=false` (default — preserves
 * today's behavior). When enabled, requests whose `req.ip` isn't in
 * the `IP_ALLOWLIST` runtime-config array get a 403.
 *
 * Healthcheck paths (`/api/status`, `/api/health`) are exempt so
 * Railway probes still work even with the allowlist on.
 *
 * Mounted in server.js between apiKeyAuth and the routes.
 */

const runtimeConfig = require('../runtime-config');
const { PUBLIC_PATHS } = require('./auth');

function ipAllowlist(req, res, next) {
  if (PUBLIC_PATHS.has(req.path)) return next();

  if (!runtimeConfig.get('IP_ALLOWLIST_ENABLED')) return next();

  const allowed = runtimeConfig.get('IP_ALLOWLIST') || [];
  if (allowed.length === 0) return next(); // empty list = no enforcement (avoid lockout)

  // req.ip respects trust-proxy (Express must be configured with
  // app.set('trust proxy', ...) for X-Forwarded-For to be honored).
  const clientIp = req.ip;
  if (allowed.includes(clientIp)) return next();

  return res.status(403).json({
    success: false,
    error: 'IP not in allowlist',
  });
}

module.exports = ipAllowlist;
