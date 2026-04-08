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

/**
 * MACD — returns { macdLine, signalLine, histogram } for the last bar.
 * Standard params: fast=12, slow=26, signal=9
 */
function calcMacd(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
  if (closes.length < slowPeriod + signalPeriod) return null;

  const emaFast = emaArray(closes, fastPeriod);
  const emaSlow = emaArray(closes, slowPeriod);

  // MACD line = fast EMA - slow EMA
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (emaFast[i] == null || emaSlow[i] == null) {
      macdLine.push(null);
    } else {
      macdLine.push(emaFast[i] - emaSlow[i]);
    }
  }

  // Signal line = EMA of MACD line
  const validMacd = macdLine.filter(v => v != null);
  if (validMacd.length < signalPeriod) return null;

  const signalEma = emaArray(validMacd, signalPeriod);
  const last = validMacd.length - 1;
  const signalVal = signalEma[last];
  const macdVal = validMacd[last];

  return {
    macdLine: +macdVal.toFixed(4),
    signalLine: signalVal != null ? +signalVal.toFixed(4) : null,
    histogram: signalVal != null ? +((macdVal - signalVal).toFixed(4)) : null,
  };
}

/**
 * Bollinger Bands — returns { upper, middle, lower, bandwidth } for the last bar.
 * Default: 20-period SMA with 2 standard deviations.
 */
function bollingerBands(closes, period = 20, stdDevMult = 2) {
  if (closes.length < period) return null;

  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, c) => sum + (c - mean) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);

  return {
    upper: +(mean + stdDevMult * stdDev).toFixed(4),
    middle: +mean.toFixed(4),
    lower: +(mean - stdDevMult * stdDev).toFixed(4),
    bandwidth: mean > 0 ? +((stdDevMult * 2 * stdDev / mean) * 100).toFixed(2) : 0,
  };
}

/**
 * VWAP — Volume Weighted Average Price for the session.
 * Requires bars with { h, l, c, v } (high, low, close, volume).
 */
function calcVwap(bars) {
  if (!bars || bars.length === 0) return null;

  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  for (const bar of bars) {
    const typicalPrice = (bar.h + bar.l + bar.c) / 3;
    cumulativeTPV += typicalPrice * bar.v;
    cumulativeVolume += bar.v;
  }

  return cumulativeVolume > 0 ? +(cumulativeTPV / cumulativeVolume).toFixed(4) : null;
}

/**
 * Simple support/resistance detection using pivot points from recent bars.
 * Returns { support: number[], resistance: number[] } — up to 3 levels each.
 */
function findSupportResistance(bars, lookback = 50) {
  if (!bars || bars.length < lookback) return { support: [], resistance: [] };

  const slice = bars.slice(-lookback);
  const pivotHighs = [];
  const pivotLows = [];

  // Find local highs and lows (3-bar pivot)
  for (let i = 1; i < slice.length - 1; i++) {
    if (slice[i].h > slice[i - 1].h && slice[i].h > slice[i + 1].h) {
      pivotHighs.push(slice[i].h);
    }
    if (slice[i].l < slice[i - 1].l && slice[i].l < slice[i + 1].l) {
      pivotLows.push(slice[i].l);
    }
  }

  // Cluster nearby levels (within 0.5% of each other)
  const clusterLevels = (levels) => {
    if (levels.length === 0) return [];
    levels.sort((a, b) => a - b);
    const clusters = [];
    let cluster = [levels[0]];

    for (let i = 1; i < levels.length; i++) {
      const pctDiff = Math.abs(levels[i] - cluster[0]) / cluster[0];
      if (pctDiff < 0.005) {
        cluster.push(levels[i]);
      } else {
        clusters.push(cluster.reduce((a, b) => a + b, 0) / cluster.length);
        cluster = [levels[i]];
      }
    }
    clusters.push(cluster.reduce((a, b) => a + b, 0) / cluster.length);

    return clusters.slice(-3).map(v => +v.toFixed(4));
  };

  return {
    support: clusterLevels(pivotLows),
    resistance: clusterLevels(pivotHighs),
  };
}

module.exports = {
  emaArray,
  calcRsi,
  volumeRatio,
  detectSignal,
  calcMacd,
  bollingerBands,
  calcVwap,
  findSupportResistance,
};
