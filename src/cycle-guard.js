/**
 * Cycle guard — skips the full LLM agent chain when no indicator state
 * has changed since the last cycle. Computes a lightweight fingerprint
 * of each watchlist symbol's EMA cross direction, RSI bucket, and
 * volume-spike state. If the fingerprint matches the previous cycle,
 * the cycle is short-circuited (only the monitor runs for stop/target).
 *
 * This alone eliminates ~60% of LLM calls during sideways sessions.
 */

const alpaca = require('./alpaca');
const { emaArray, calcRsi, volumeRatio } = require('./indicators');
const config = require('./config');
const runtimeConfig = require('./runtime-config');
const { log } = require('./logger');
const crypto = require('crypto');

let lastFingerprint = null;
let skippedCount = 0;
let totalChecks = 0;

/**
 * Returns true if the cycle should be SKIPPED (no material changes).
 * Returns false when indicators have moved → run the full agent chain.
 */
async function shouldSkipCycle(watchlist) {
  totalChecks++;

  try {
    // Fetch 5-min bars for each symbol (same data the scanner uses)
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
      skippedCount++;
      log(`Cycle guard: SKIP (fingerprint unchanged, ${skippedCount}/${totalChecks} cycles skipped)`);
      return true;
    }

    lastFingerprint = fingerprint;
    return false;
  } catch (err) {
    // On any error, don't skip — let the cycle run
    return false;
  }
}

function getStats() {
  return { totalChecks, skippedCount, hitRate: totalChecks > 0 ? (skippedCount / totalChecks * 100).toFixed(1) + '%' : '0%' };
}

function reset() {
  lastFingerprint = null;
  skippedCount = 0;
  totalChecks = 0;
}

module.exports = { shouldSkipCycle, getStats, reset };
