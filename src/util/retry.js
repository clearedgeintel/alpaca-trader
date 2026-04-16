const { log, warn } = require('../logger');

/**
 * Retry an async function with exponential backoff and full jitter.
 *
 * @param {Function} fn - async function to execute. Receives attempt number (0-indexed).
 * @param {Object} options
 * @param {number} [options.retries=3] - max retry attempts (total calls = retries + 1)
 * @param {number} [options.baseMs=500] - initial backoff window
 * @param {number} [options.maxMs=15000] - backoff cap
 * @param {Function} [options.shouldRetry] - (err) => boolean; decides if err is retryable
 * @param {Function} [options.onRetry] - (err, attempt, delayMs) => void; observer hook
 * @param {string} [options.label] - label for logging
 * @returns {Promise<any>} resolves with fn's return; rejects with last error after retries exhausted
 */
async function retryWithBackoff(fn, options = {}) {
  const { retries = 3, baseMs = 500, maxMs = 15000, shouldRetry = () => true, onRetry, label = 'retry' } = options;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !shouldRetry(err)) throw err;

      // Prefer explicit retry-after hint on the error if present
      const retryAfterMs = parseRetryAfter(err);
      const expBackoff = Math.min(maxMs, baseMs * Math.pow(2, attempt));
      const jittered = Math.random() * expBackoff; // full jitter
      const delay = retryAfterMs != null ? Math.max(retryAfterMs, jittered) : jittered;

      if (onRetry) {
        try {
          onRetry(err, attempt, delay);
        } catch {}
      }
      warn(
        `[${label}] attempt ${attempt + 1}/${retries + 1} failed: ${err.message}. retrying in ${Math.round(delay)}ms`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Parse Retry-After hints from an error. Supports:
 * - err.retryAfter (seconds number or Date)
 * - err.response?.headers.get('retry-after') (Fetch Response)
 * - err.headers?.['retry-after'] (Anthropic SDK-style)
 * Returns ms or null.
 */
function parseRetryAfter(err) {
  const raw =
    err?.retryAfter ??
    err?.response?.headers?.get?.('retry-after') ??
    err?.headers?.['retry-after'] ??
    err?.headers?.['Retry-After'];
  if (raw == null) return null;

  if (typeof raw === 'number') return raw * 1000;
  if (raw instanceof Date) return Math.max(0, raw.getTime() - Date.now());

  const numeric = Number(raw);
  if (!Number.isNaN(numeric)) return numeric * 1000;

  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());

  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Exponential backoff delay (no jitter) — used by websocket reconnect loops
 * that want predictable backoff without a function wrapper.
 */
function backoffDelay(attempt, { baseMs = 1000, maxMs = 60000, jitter = true } = {}) {
  const base = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  return jitter ? Math.random() * base : base;
}

module.exports = { retryWithBackoff, backoffDelay, sleep, parseRetryAfter };
