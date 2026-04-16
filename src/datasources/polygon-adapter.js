/**
 * Polygon.io free-tier enrichment adapter.
 *
 * Free tier: ~5 calls/min, EOD data only (15min delay on bars).
 * We deliberately expose ONLY endpoints that work on the free tier.
 * Intraday bars, options chains, unusual flow, and dark-pool prints
 * require paid tiers — add those later as a separate module.
 *
 * Every method returns `null` (never throws) when:
 *   - POLYGON_API_KEY is unset
 *   - POLYGON_ENABLED runtime flag is false
 *   - token bucket is empty
 *   - circuit is open after repeated 429s
 *
 * This lets agents call Polygon unconditionally without try/catch.
 */

const { log, warn, error } = require('../logger');
const { retryWithBackoff } = require('../util/retry');
const { TtlCache } = require('./cache');

const BASE = 'https://api.polygon.io';

// Token bucket: 5 tokens, refills 5/min.
const BUCKET_CAPACITY = 5;
const REFILL_PER_MIN = 5;
let tokens = BUCKET_CAPACITY;
let lastRefill = Date.now();

// Circuit breaker on persistent 429
let consecutive429 = 0;
let circuitOpenUntil = 0;
const CIRCUIT_COOLDOWN_MS = 60 * 1000;

// Stats for /api/datasources/stats
const stats = {
  calls: 0,
  errors: 0,
  cacheHits: 0,
  lastError: null,
  ratelimited: false,
  disabledReason: null,
};

const cache = new TtlCache(5 * 60 * 1000);

let warnedAboutMissingKey = false;

function apiKey() {
  return process.env.POLYGON_API_KEY || null;
}

function runtimeEnabled() {
  try {
    const runtimeConfig = require('../runtime-config');
    const flag = runtimeConfig.get('POLYGON_ENABLED');
    return flag !== false; // default to true when unset
  } catch {
    return true;
  }
}

function refillBucket() {
  const now = Date.now();
  const elapsedMs = now - lastRefill;
  const refill = (elapsedMs / 60000) * REFILL_PER_MIN;
  if (refill >= 1) {
    tokens = Math.min(BUCKET_CAPACITY, tokens + Math.floor(refill));
    lastRefill = now;
  }
}

function tryTakeToken() {
  refillBucket();
  if (tokens > 0) {
    tokens -= 1;
    return true;
  }
  return false;
}

function isAvailable() {
  if (!apiKey()) {
    if (!warnedAboutMissingKey) {
      warn('Polygon disabled — POLYGON_API_KEY not set');
      warnedAboutMissingKey = true;
    }
    stats.disabledReason = 'no_api_key';
    return false;
  }
  if (!runtimeEnabled()) {
    stats.disabledReason = 'runtime_disabled';
    return false;
  }
  if (Date.now() < circuitOpenUntil) {
    stats.disabledReason = 'circuit_open';
    stats.ratelimited = true;
    return false;
  }
  stats.disabledReason = null;
  stats.ratelimited = false;
  return true;
}

async function polyFetch(path, params = {}) {
  if (!isAvailable()) return null;
  if (!tryTakeToken()) {
    stats.ratelimited = true;
    return null;
  }

  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('apiKey', apiKey());

  try {
    const data = await retryWithBackoff(
      async () => {
        const res = await fetch(url.toString());
        if (res.status === 429) {
          consecutive429 += 1;
          if (consecutive429 >= 3) {
            circuitOpenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
            warn(`Polygon circuit opened after ${consecutive429} 429s`);
          }
          const err = new Error('Polygon 429 rate limited');
          err.status = 429;
          throw err;
        }
        if (!res.ok) {
          const body = await res.text();
          const err = new Error(`Polygon ${res.status}: ${body.slice(0, 200)}`);
          err.status = res.status;
          throw err;
        }
        return res.json();
      },
      {
        retries: 2,
        baseMs: 1000,
        maxMs: 8000,
        shouldRetry: (err) => err.status === 429 || (err.status >= 500 && err.status < 600),
        label: `polygon ${path}`,
      },
    );
    consecutive429 = 0;
    stats.calls += 1;
    return data;
  } catch (err) {
    stats.errors += 1;
    stats.lastError = err.message;
    error(`Polygon fetch failed: ${path} — ${err.message}`);
    return null;
  }
}

async function cached(key, ttlMs, fetcher) {
  const hit = cache.get(key);
  if (hit !== undefined) {
    stats.cacheHits += 1;
    return hit;
  }
  const val = await fetcher();
  if (val != null) cache.set(key, val, ttlMs);
  return val;
}

/**
 * /v3/reference/tickers/{ticker}
 * Returns company name, market cap, SIC description, weighted shares, description.
 */
async function getTickerDetails(symbol) {
  return cached(`tickerDetails:${symbol}`, 6 * 60 * 60 * 1000, async () => {
    const data = await polyFetch(`/v3/reference/tickers/${symbol}`);
    if (!data?.results) return null;
    const r = data.results;
    return {
      symbol: r.ticker,
      name: r.name || null,
      description: r.description || null,
      marketCap: r.market_cap || null,
      sic_description: r.sic_description || null,
      primary_exchange: r.primary_exchange || null,
      share_class_shares_outstanding: r.share_class_shares_outstanding || null,
      weighted_shares_outstanding: r.weighted_shares_outstanding || null,
    };
  });
}

/**
 * /v2/reference/news?ticker=X — articles with insights[] sentiment.
 */
async function getNewsWithInsights(symbol, limit = 10) {
  return cached(`news:${symbol}:${limit}`, 10 * 60 * 1000, async () => {
    const data = await polyFetch('/v2/reference/news', { ticker: symbol, limit: String(limit), order: 'desc' });
    if (!data?.results) return null;
    return data.results.map((n) => ({
      id: n.id,
      headline: n.title,
      summary: n.description || '',
      author: n.author || '',
      source: n.publisher?.name || '',
      url: n.article_url,
      published_utc: n.published_utc,
      symbols: n.tickers || [],
      insights: (n.insights || []).map((i) => ({
        ticker: i.ticker,
        sentiment: i.sentiment,
        sentiment_reasoning: i.sentiment_reasoning,
      })),
    }));
  });
}

/**
 * /v3/reference/dividends?ticker=X — upcoming ex-dates.
 */
async function getDividends(symbol) {
  return cached(`div:${symbol}`, 15 * 60 * 1000, async () => {
    const data = await polyFetch('/v3/reference/dividends', { ticker: symbol, limit: '5', order: 'desc' });
    if (!data?.results) return null;
    return data.results.map((d) => ({
      ex_dividend_date: d.ex_dividend_date,
      pay_date: d.pay_date,
      cash_amount: d.cash_amount,
      dividend_type: d.dividend_type,
      frequency: d.frequency,
    }));
  });
}

/**
 * /v1/marketstatus/now — overall market + exchange open/close.
 */
async function getMarketStatus() {
  return cached('marketStatus', 15 * 60 * 1000, async () => {
    const data = await polyFetch('/v1/marketstatus/now');
    if (!data) return null;
    return {
      market: data.market,
      serverTime: data.serverTime,
      exchanges: data.exchanges,
      earlyHours: data.earlyHours,
      afterHours: data.afterHours,
    };
  });
}

function getStats() {
  refillBucket();
  return {
    enabled: isAvailable(),
    hasKey: !!apiKey(),
    runtimeEnabled: runtimeEnabled(),
    calls: stats.calls,
    errors: stats.errors,
    cacheHits: stats.cacheHits,
    cacheSize: cache.size(),
    tokensRemaining: tokens,
    ratelimited: stats.ratelimited || Date.now() < circuitOpenUntil,
    circuitOpen: Date.now() < circuitOpenUntil,
    lastError: stats.lastError,
    disabledReason: stats.disabledReason,
  };
}

// Test helper — resets module state between tests.
function _resetForTests() {
  tokens = BUCKET_CAPACITY;
  lastRefill = Date.now();
  consecutive429 = 0;
  circuitOpenUntil = 0;
  stats.calls = 0;
  stats.errors = 0;
  stats.cacheHits = 0;
  stats.lastError = null;
  stats.ratelimited = false;
  stats.disabledReason = null;
  cache.clear();
  warnedAboutMissingKey = false;
}

module.exports = {
  getTickerDetails,
  getNewsWithInsights,
  getDividends,
  getMarketStatus,
  getStats,
  _resetForTests,
};
