const winston = require('winston');
const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');

// AsyncLocalStorage context so correlation IDs follow async work automatically.
// Set via runWithContext(ctx, fn) — read by the logger for every log line.
const contextStorage = new AsyncLocalStorage();

function getContext() {
  return contextStorage.getStore() || {};
}

/**
 * Run fn inside a correlation context. The context is a plain object
 * (e.g. { cycleId, tradeId, agent, requestId }). Nested calls inherit
 * the parent context and override only the keys they set.
 */
function runWithContext(ctx, fn) {
  const merged = { ...(contextStorage.getStore() || {}), ...ctx };
  return contextStorage.run(merged, fn);
}

function newCorrelationId(prefix = '') {
  const id = crypto.randomBytes(6).toString('hex');
  return prefix ? `${prefix}_${id}` : id;
}

// Format: JSON (for log aggregators) when LOG_FORMAT=json, otherwise colored text.
const useJson = process.env.LOG_FORMAT === 'json';

const textFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message, data, error: err, ...rest }) => {
    // Context (cycleId, tradeId, etc.) bubbles up from the log call site
    const ctx = rest.ctx
      ? Object.entries(rest.ctx)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')
      : '';
    const parts = [`[${timestamp}] ${level}: ${message}`];
    if (ctx) parts.push(`(${ctx})`);
    if (data) parts.push(JSON.stringify(data));
    if (err) parts.push(err);
    return parts.join(' ');
  }),
);

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp()),
  transports: [
    new winston.transports.Console({
      format: useJson ? jsonFormat : textFormat,
    }),
  ],
});

function withCtx(meta) {
  const ctx = getContext();
  if (!ctx || Object.keys(ctx).length === 0) return meta;
  // In JSON mode, spread context keys onto the top-level object so queries
  // like `cycleId = "X"` work directly. In text mode, keep `ctx` nested so
  // the formatter can print it compactly.
  return useJson ? { ...meta, ...ctx } : { ...meta, ctx };
}

function log(message, data = null) {
  logger.info(message, withCtx(data ? { data } : {}));
}

function warn(message, data = null) {
  logger.warn(message, withCtx(data ? { data } : {}));
}

function error(message, err) {
  logger.error(message, withCtx({ error: err?.message || err, stack: err?.stack }));
}

// Backwards-compat shim: legacy logger.alert(message) maps to the new
// multi-channel alerting module with severity=warn. New code should
// import `./alerting` directly for explicit severity + metadata.
async function alert(message) {
  logger.error(`ALERT: ${message}`, withCtx({}));
  try {
    // Lazy require to avoid circular deps (alerting.js requires logger)
    const alerting = require('./alerting');
    await alerting.alert({ severity: 'warn', title: 'Alert', message: String(message) });
  } catch (err) {
    logger.error('Failed to dispatch alert', withCtx({ error: err?.message || err }));
  }
}

module.exports = { log, warn, error, alert, runWithContext, getContext, newCorrelationId };
