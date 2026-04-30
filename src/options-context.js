/**
 * Option-chain summary builder for the orchestrator.
 *
 * The orchestrator runs frequently and pays Sonnet rates per call; we
 * can NOT include every option contract in the userMessage. This module
 * fetches a tiny per-underlying snapshot — typically 6-10 contracts
 * total — covering near-the-money calls AND puts at the next 1-2
 * expirations within the THETA_DECAY_DAYS_THRESHOLD ≤ DTE ≤ 60 day
 * band. The LLM picks an OCC symbol from this set when it wants to
 * express a view as an option instead of shares.
 *
 * Cached per-underlying for 5 min so repeated cycles within the same
 * session don't spam the chain endpoint.
 *
 * NO-OP when OPTIONS_ENABLED is false — returns {} so the orchestrator
 * can unconditionally call buildChainSummary() and skip the prompt
 * branch when the result is empty.
 */

const alpaca = require('./alpaca');
const config = require('./config');
const runtimeConfig = require('./runtime-config');
const { log, error } = require('./logger');

const CACHE_TTL_MS = 5 * 60 * 1000;
// underlying → { ts, contracts: [...] }
const cache = new Map();

// How wide of a strike band around spot to surface (in % of spot)
const STRIKE_BAND_PCT = 0.05; // ±5%
// Max rows to keep per underlying after filtering (sorted by |strike-spot|)
const MAX_PER_UNDERLYING = 8;
// DTE band the LLM is allowed to pick from
const MIN_DTE_BUFFER = 0; // tightened by THETA_DECAY_DAYS_THRESHOLD
const MAX_DTE = 60;

/**
 * Build a compact chain summary for the given underlyings. Returns
 *   { AAPL: [{ symbol, type, strike, expiration, dte, premium,
 *              delta, theta, iv, openInterest }, ...], ... }
 *
 * Empty object when OPTIONS_ENABLED is false. Skips underlyings whose
 * snapshot fetches fail (logged, not thrown).
 */
async function buildChainSummary(underlyings) {
  if (!Array.isArray(underlyings) || underlyings.length === 0) return {};
  if (!runtimeConfig.get('OPTIONS_ENABLED')) return {};

  const dteThreshold =
    runtimeConfig.get('THETA_DECAY_DAYS_THRESHOLD') ?? config.THETA_DECAY_DAYS_THRESHOLD;
  const minDte = Math.max(MIN_DTE_BUFFER, dteThreshold + 1);

  const out = {};
  for (const underlying of underlyings) {
    try {
      const cached = cache.get(underlying);
      if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
        out[underlying] = cached.contracts;
        continue;
      }

      const contracts = await fetchAndSummarize(underlying, { minDte, maxDte: MAX_DTE });
      cache.set(underlying, { ts: Date.now(), contracts });
      if (contracts.length > 0) out[underlying] = contracts;
    } catch (err) {
      error(`option-chain summary failed for ${underlying}`, err);
    }
  }
  return out;
}

async function fetchAndSummarize(underlying, { minDte, maxDte }) {
  // Spot price for strike-band filtering. If it fails, return nothing
  // for this underlying — better than including too-far OTM strikes.
  let spot;
  try {
    const snap = await alpaca.getSnapshot(underlying);
    spot = snap?.latestTrade?.p || snap?.minuteBar?.c || snap?.dailyBar?.c;
  } catch (e) {
    return [];
  }
  if (!spot || !(spot > 0)) return [];

  const strikeMin = +(spot * (1 - STRIKE_BAND_PCT)).toFixed(2);
  const strikeMax = +(spot * (1 + STRIKE_BAND_PCT)).toFixed(2);

  const chain = await alpaca.getOptionChain(underlying, {
    strikePriceGte: strikeMin,
    strikePriceLte: strikeMax,
    limit: 200,
  });
  if (!Array.isArray(chain) || chain.length === 0) return [];

  // Annotate with DTE + |distance from spot|; filter by DTE band; sort
  // so the most-relevant contracts come first; cap at MAX_PER_UNDERLYING.
  const today = Date.now();
  const annotated = chain
    .map((c) => {
      const dte =
        c.expiration && c.strike != null
          ? Math.floor((Date.parse(c.expiration + 'T16:00:00-04:00') - today) / (24 * 60 * 60 * 1000))
          : null;
      return {
        symbol: c.symbol,
        type: c.type,
        strike: c.strike,
        expiration: c.expiration,
        dte,
        premium: c.last ?? (c.bid != null && c.ask != null ? +(((c.bid + c.ask) / 2).toFixed(3)) : null),
        delta: c.delta,
        theta: c.theta,
        iv: c.impliedVolatility,
        openInterest: c.openInterest,
        moneyness: c.strike != null ? Math.abs(c.strike - spot) : null,
      };
    })
    .filter((c) => c.dte != null && c.dte >= minDte && c.dte <= maxDte)
    .filter((c) => c.premium != null && c.premium > 0)
    .sort((a, b) => {
      // Prefer near-the-money first, then nearer expiration
      const m = (a.moneyness ?? Infinity) - (b.moneyness ?? Infinity);
      if (m !== 0) return m;
      return (a.dte ?? Infinity) - (b.dte ?? Infinity);
    })
    .slice(0, MAX_PER_UNDERLYING)
    .map(({ moneyness, ...rest }) => rest); // strip the helper field

  return annotated;
}

function resetCache() {
  cache.clear();
}

module.exports = { buildChainSummary, resetCache };
