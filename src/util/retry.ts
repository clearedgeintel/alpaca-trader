export {};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { warn } = require('../logger');

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  shouldRetry?: (err: any) => boolean;
  onRetry?: (err: any, attempt: number, delayMs: number) => void;
  label?: string;
}

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  jitter?: boolean;
}

/**
 * Retry an async function with exponential backoff and full jitter.
 * Total calls = retries + 1. The function receives the 0-indexed attempt
 * number for adaptive logic.
 */
async function retryWithBackoff<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { retries = 3, baseMs = 500, maxMs = 15000, shouldRetry = () => true, onRetry, label = 'retry' } = options;

  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !shouldRetry(err)) throw err;

      const retryAfterMs = parseRetryAfter(err);
      const expBackoff = Math.min(maxMs, baseMs * Math.pow(2, attempt));
      const jittered = Math.random() * expBackoff;
      const delay = retryAfterMs != null ? Math.max(retryAfterMs, jittered) : jittered;

      if (onRetry) {
        try {
          onRetry(err, attempt, delay);
        } catch {
          /* observer is best-effort */
        }
      }
      warn(
        `[${label}] attempt ${attempt + 1}/${retries + 1} failed: ${(err as any)?.message}. retrying in ${Math.round(delay)}ms`,
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Parse Retry-After hints from common error shapes (number, Date, ISO,
 * Fetch Response headers, Anthropic SDK headers). Returns ms or null.
 */
function parseRetryAfter(err: any): number | null {
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Exponential backoff delay — used by websocket reconnect loops that want
 * predictable cadence without a function wrapper.
 */
function backoffDelay(attempt: number, { baseMs = 1000, maxMs = 60000, jitter = true }: BackoffOptions = {}): number {
  const base = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  return jitter ? Math.random() * base : base;
}

// CommonJS export for backward compat with all existing .js callers
module.exports = { retryWithBackoff, backoffDelay, sleep, parseRetryAfter };
