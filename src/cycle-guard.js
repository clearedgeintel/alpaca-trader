/**
 * Cycle guard — skips the full LLM agent chain when no indicator state
 * has changed since the last cycle. Computes a lightweight fingerprint
 * of each watchlist symbol's EMA cross direction, RSI bucket, and
 * volume-spike state. If the fingerprint matches the previous cycle,
 * the cycle is short-circuited (only the monitor runs for stop/target).
 *
 * SAFETY FLOOR: never skip more than MAX_CONSECUTIVE_SKIPS in a row.
 * Without this, a sideways market can stick on a single fingerprint for
 * hours and the orchestrator never runs at all (observed 2026-04-29).
 *
 * KILL SWITCH: runtime-config flag CYCLE_GUARD_ENABLED (default true).
 * Set to false to disable the guard entirely — useful when investigating
 * "no trades today" issues or to verify the guard is the bottleneck.
 */

const alpaca = require('./alpaca');
const { emaArray, calcRsi, volumeRatio } = require('./indicators');
const config = require('./config');
const runtimeConfig = require('./runtime-config');
const { log } = require('./logger');
const crypto = require('crypto');

// Max consecutive cycles we'll skip before forcing a run regardless of
// fingerprint. At 5-min cycles, 4 = ~20 min hard ceiling. Tunable via
// runtime-config CYCLE_GUARD_MAX_SKIPS.
const DEFAULT_MAX_CONSECUTIVE_SKIPS = 4;

let lastFingerprint = null;
let skippedCount = 0;
let consecutiveSkips = 0;
let totalChecks = 0;

function isEnabled() {
  const v = runtimeConfig.get('CYCLE_GUARD_ENABLED');
  // Treat undefined as enabled (default behavior). Only false disables it.
  return v !== false;
}

function maxConsecutiveSkips() {
  return Number(runtimeConfig.get('CYCLE_GUARD_MAX_SKIPS')) || DEFAULT_MAX_CONSECUTIVE_SKIPS;
}

/**
 * Returns true if the cycle should be SKIPPED (no material changes).
 * Returns false when indicators have moved → run the full agent chain.
 */
async function shouldSkipCycle(watchlist) {
  totalChecks++;

  // Kill switch
  if (!isEnabled()) {
    consecutiveSkips = 0;
    return false;
  }

  try {
    const barResults = await Promise.allSettled(
      watchlist.map((sym) => alpaca.getBars(sym, '5Min', 30)),
    );

    const parts = [];
    for (let i = 0; i < watchlist.length; i++) {
      const sym = watchlist[i];
      const bars = barResults[i].status === 'fulfilled' ? barResults[i].value : [];
      if (!bars || bars.length < 22) {
        parts.push(`${sym}:NODATA`);
        continue;
      }

      const closes = bars.map((b) => b.c);
      const volumes = bars.map((b) => b.v);

      const ema9 = emaArray(closes, config.EMA_FAST);
      const ema21 = emaArray(closes, config.EMA_SLOW);
      const rsi = calcRsi(closes, config.RSI_PERIOD);
      const volRatio = volumeRatio(volumes, config.VOLUME_LOOKBACK);

      const last = closes.length - 1;
      const crossDir = ema9[last] > ema21[last] ? 'BULL' : 'BEAR';
      const rsiBucket = rsi == null ? 'NA' :
        rsi < 30 ? 'OS' : rsi < 45 ? 'LO' : rsi < 55 ? 'MID' : rsi < 70 ? 'HI' : 'OB';
      const volSpike = volRatio >= (runtimeConfig.get('VOLUME_SPIKE_RATIO') || config.VOLUME_SPIKE_RATIO)
        ? 'SPIKE' : 'NORM';

      parts.push(`${sym}:${crossDir}:${rsiBucket}:${volSpike}`);
    }

    const fingerprint = crypto.createHash('md5').update(parts.join('|')).digest('hex');

    if (lastFingerprint && fingerprint === lastFingerprint) {
      // Safety floor: even if nothing changed, force a run after N consecutive
      // skips so the orchestrator gets a fresh look at things periodically.
      const cap = maxConsecutiveSkips();
      if (consecutiveSkips >= cap) {
        log(`Cycle guard: forcing run after ${consecutiveSkips} consecutive skips (cap=${cap})`);
        consecutiveSkips = 0;
        return false;
      }
      consecutiveSkips++;
      skippedCount++;
      log(`Cycle guard: SKIP (${consecutiveSkips}/${cap} consecutive, ${skippedCount}/${totalChecks} total)`);
      return true;
    }

    lastFingerprint = fingerprint;
    consecutiveSkips = 0;
    return false;
  } catch (err) {
    // On any error, don't skip — let the cycle run
    consecutiveSkips = 0;
    return false;
  }
}

function getStats() {
  return {
    totalChecks,
    skippedCount,
    consecutiveSkips,
    hitRate: totalChecks > 0 ? (skippedCount / totalChecks * 100).toFixed(1) + '%' : '0%',
    enabled: isEnabled(),
    maxConsecutiveSkips: maxConsecutiveSkips(),
  };
}

function reset() {
  lastFingerprint = null;
  skippedCount = 0;
  consecutiveSkips = 0;
  totalChecks = 0;
}

module.exports = { shouldSkipCycle, getStats, reset };
