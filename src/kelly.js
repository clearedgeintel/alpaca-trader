/**
 * Kelly / half-Kelly position sizing.
 *
 * The Kelly criterion tells you the fraction of capital to risk per
 * trade to maximize long-run geometric growth:
 *
 *     f* = p - (1 - p) / b
 *
 * where p is win probability and b is the average-win / average-loss
 * ratio. Full Kelly is theoretically optimal but in practice has
 * painful drawdowns when your edge estimate is noisy — which it
 * always is. We default to half-Kelly (f* / 2) and clamp the final
 * multiplier to [0.5x, 2.0x] of the configured base RISK_PCT so no
 * single cycle can blow the account up.
 *
 * Inputs come from the `trades` table: closed trades only, long-side
 * only (the bot is long-only today). A symbol with fewer than
 * `minSampleSize` closed trades in the lookback is "cold start" and
 * the multiplier collapses to 1.0 (identical to today's behavior).
 *
 * When KELLY_ENABLED is false (the runtime default), this module is
 * informational — the execution-agent can fetch suggestions without
 * acting on them. Flip the flag from Settings when you're comfortable
 * with what the numbers look like.
 */

const db = require('./db');
const config = require('./config');
const runtimeConfig = require('./runtime-config');
const { log, error } = require('./logger');

// Safety bounds — no matter what the math says, no single trade risks
// more than double or less than half of the configured RISK_PCT. A
// negative-edge symbol (kellyF < 0) falls to the 0.5x floor.
const MULTIPLIER_MIN = 0.5;
const MULTIPLIER_MAX = 2.0;
// Absolute ceiling on kellyF — full-Kelly values above 5% are
// effectively never right for a real-money system. Clamp here before
// halving + converting to a multiplier.
const KELLY_ABS_MAX = 0.05;

function enabled() {
  const v = runtimeConfig.get('KELLY_ENABLED');
  return v === true || v === 'true';
}

/**
 * Per-symbol Kelly recommendation from closed-trade history.
 * Returns the same shape whether the symbol qualifies or not —
 * consumers should check `source === 'kelly'` before applying.
 */
async function computeKellyFraction(symbol, { lookbackDays = 60, minSampleSize = 20 } = {}) {
  let rows = [];
  try {
    const result = await db.query(
      `SELECT pnl, entry_price, qty
         FROM trades
        WHERE symbol = $1
          AND status = 'closed'
          AND pnl IS NOT NULL
          AND closed_at >= NOW() - ($2 || ' days')::interval`,
      [symbol, String(lookbackDays)],
    );
    rows = result.rows;
  } catch (err) {
    error(`kelly: failed to query trades for ${symbol}`, err);
    return emptyResult(symbol, 'error', { error: err.message });
  }

  // Split into wins/losses by dollar P&L. Ignore breakeven (pnl === 0)
  // so they don't drag the ratio.
  const wins = [];
  const losses = [];
  for (const r of rows) {
    const pnl = Number(r.pnl);
    const entry = Number(r.entry_price);
    const qty = Number(r.qty);
    if (!Number.isFinite(pnl) || !entry || !qty) continue;
    const cost = entry * qty;
    if (cost <= 0) continue;
    const pct = pnl / cost;
    if (pnl > 0) wins.push(pct);
    else if (pnl < 0) losses.push(Math.abs(pct));
  }

  const sampleSize = wins.length + losses.length;
  if (sampleSize < minSampleSize) {
    return emptyResult(symbol, 'cold_start', { sampleSize, minSampleSize });
  }

  const winRate = wins.length / sampleSize;
  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;

  // Degenerate cases — no wins or no losses in the window. Can happen
  // early on. Fall back to cold-start semantics; don't let the caller
  // see a divide-by-zero.
  if (avgLoss <= 0 || wins.length === 0) {
    return emptyResult(symbol, 'cold_start', { sampleSize, winRate, avgWin, avgLoss, reason: 'no_losses_yet' });
  }

  const b = avgWin / avgLoss;
  const rawKellyF = winRate - (1 - winRate) / b;
  // Clamp kellyF to a sane upper bound; the lower bound can be negative
  // (meaning "don't trade") and we expose it so the UI can show "edge=-x%".
  const kellyF = Math.min(KELLY_ABS_MAX, rawKellyF);
  const halfKellyF = kellyF / 2;
  const baseRiskPct = runtimeConfig.get('RISK_PCT') ?? config.RISK_PCT;
  const rawMultiplier = baseRiskPct > 0 ? halfKellyF / baseRiskPct : 1.0;
  // Negative kellyF (p*b < 1-p) → floor to the min; otherwise clamp [0.5, 2.0]
  const multiplier =
    rawMultiplier <= 0 ? MULTIPLIER_MIN : Math.max(MULTIPLIER_MIN, Math.min(MULTIPLIER_MAX, rawMultiplier));

  return {
    symbol,
    source: 'kelly',
    sampleSize,
    wins: wins.length,
    losses: losses.length,
    winRate: round(winRate, 4),
    avgWin: round(avgWin, 5),
    avgLoss: round(avgLoss, 5),
    winLossRatio: round(b, 3),
    kellyF: round(kellyF, 4),
    rawKellyF: round(rawKellyF, 4),
    halfKellyF: round(halfKellyF, 4),
    baseRiskPct: round(baseRiskPct, 4),
    multiplier: round(multiplier, 3),
  };
}

/**
 * Compute recommendations for a list of symbols in parallel.
 * Returns an array; ordering preserved.
 */
async function computeForSymbols(symbols, opts = {}) {
  return Promise.all(symbols.map((s) => computeKellyFraction(s, opts)));
}

/**
 * Single-line convenience: returns the effective multiplier for a
 * symbol, honoring the KELLY_ENABLED runtime flag. When disabled or
 * cold-start, returns 1.0 so existing sizing math is unchanged.
 */
async function kellyMultiplier(symbol, opts = {}) {
  if (!enabled()) return 1.0;
  const r = await computeKellyFraction(symbol, opts);
  return r.source === 'kelly' ? r.multiplier : 1.0;
}

function emptyResult(symbol, source, extra = {}) {
  return {
    symbol,
    source,
    sampleSize: 0,
    wins: 0,
    losses: 0,
    winRate: null,
    avgWin: null,
    avgLoss: null,
    winLossRatio: null,
    kellyF: null,
    rawKellyF: null,
    halfKellyF: null,
    multiplier: 1.0,
    ...extra,
  };
}

function round(n, d) {
  return Number.isFinite(n) ? +n.toFixed(d) : n;
}

module.exports = {
  enabled,
  computeKellyFraction,
  computeForSymbols,
  kellyMultiplier,
  MULTIPLIER_MIN,
  MULTIPLIER_MAX,
  KELLY_ABS_MAX,
};

// Silence lint on the convenience import kept for future use
void log;
