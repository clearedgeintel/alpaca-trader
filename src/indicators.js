const config = require('./config');

/**
 * Calculates EMA for each bar. Returns array with null for bars before first full period.
 */
function emaArray(closes, period) {
  const result = [];
  const k = 2 / (period + 1);

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else if (i === period - 1) {
      // Seed with SMA of first `period` values
      let sum = 0;
      for (let j = 0; j <= i; j++) sum += closes[j];
      result.push(sum / period);
    } else {
      result.push(closes[i] * k + result[i - 1] * (1 - k));
    }
  }

  return result;
}

/**
 * Wilder smoothing RSI for the last bar in the closes array.
 * Returns null if not enough data.
 */
function calcRsi(closes, period) {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  // Initial average gain/loss over first `period` changes
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  // Wilder smoothing for remaining bars
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change >= 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Last volume divided by average of prior `lookback` bars.
 */
function volumeRatio(volumes, lookback) {
  if (volumes.length < lookback + 1) return 0;

  const lastVol = volumes[volumes.length - 1];
  let sum = 0;
  for (let i = volumes.length - 1 - lookback; i < volumes.length - 1; i++) {
    sum += volumes[i];
  }
  const avg = sum / lookback;
  return avg === 0 ? 0 : lastVol / avg;
}

/**
 * Master function — takes raw bar array, runs all indicators, returns signal object.
 * signal will be 'BUY', 'SELL', or 'NONE'.
 */
function detectSignal(bars) {
  const closes = bars.map(b => b.c);
  const volumes = bars.map(b => b.v);

  const ema9Arr = emaArray(closes, config.EMA_FAST);
  const ema21Arr = emaArray(closes, config.EMA_SLOW);
  const rsi = calcRsi(closes, config.RSI_PERIOD);
  const volRatio = volumeRatio(volumes, config.VOLUME_LOOKBACK);

  const last = bars.length - 1;
  const prev = last - 1;

  const curEma9 = ema9Arr[last];
  const curEma21 = ema21Arr[last];
  const prevEma9 = ema9Arr[prev];
  const prevEma21 = ema21Arr[prev];

  if (curEma9 == null || curEma21 == null || prevEma9 == null || prevEma21 == null || rsi == null) {
    return { signal: 'NONE', reason: 'Insufficient data for indicators' };
  }

  const avgVol = volumes.length > config.VOLUME_LOOKBACK
    ? volumes.slice(-config.VOLUME_LOOKBACK - 1, -1).reduce((a, b) => a + b, 0) / config.VOLUME_LOOKBACK
    : 0;

  const base = {
    close: closes[last],
    ema9: curEma9,
    ema21: curEma21,
    rsi,
    volume: volumes[last],
    avg_volume: Math.round(avgVol),
    volume_ratio: Math.round(volRatio * 100) / 100,
  };

  // BUY: EMA9 crossed above EMA21 + RSI in zone + volume spike
  const emaBullCross = prevEma9 <= prevEma21 && curEma9 > curEma21;
  const rsiInBuyZone = rsi > config.RSI_BUY_MIN && rsi < config.RSI_BUY_MAX;
  const volumeConfirmed = volRatio >= config.VOLUME_SPIKE_RATIO;

  if (emaBullCross && rsiInBuyZone && volumeConfirmed) {
    return {
      signal: 'BUY',
      reason: `EMA9 crossed above EMA21, RSI=${rsi.toFixed(1)}, vol ratio=${volRatio.toFixed(2)}`,
      ...base,
    };
  }

  // SELL: EMA9 crossed below EMA21 + RSI below threshold
  const emaBearCross = prevEma9 >= prevEma21 && curEma9 < curEma21;
  const rsiInSellZone = rsi < config.RSI_SELL_MAX;

  if (emaBearCross && rsiInSellZone) {
    return {
      signal: 'SELL',
      reason: `EMA9 crossed below EMA21, RSI=${rsi.toFixed(1)}`,
      ...base,
    };
  }

  return { signal: 'NONE', reason: 'No crossover detected', ...base };
}

module.exports = { emaArray, calcRsi, volumeRatio, detectSignal };
