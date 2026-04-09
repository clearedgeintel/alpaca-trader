const config = require('../config');

function apiKeyAuth(req, res, next) {
  // If no API_KEY configured, skip auth (dev convenience)
  if (!config.API_KEY) return next();

  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (key === config.API_KEY) return next();

  return res.status(401).json({ success: false, error: 'Invalid or missing API key' });
}

module.exports = apiKeyAuth;
