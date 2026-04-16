export {};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require('./config');

// -------- Types --------

export interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface SignalResult {
  signal: 'BUY' | 'SELL' | 'NONE';
  reason: string;
  close?: number;
  ema9?: number;
  ema21?: number;
  rsi?: number;
  volume?: number;
  avg_volume?: number;
  volume_ratio?: number;
}

export interface MacdResult {
  macdLine: number;
  signalLine: number | null;
  histogram: number | null;
}

export interface BollingerResult {
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number;
}

export interface SupportResistance {
  support: number[];
  resistance: number[];
}

// -------- Functions --------

function emaArray(closes: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  const k = 2 / (period + 1);

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j <= i; j++) sum += closes[j];
      result.push(sum / period);
    } else {
      result.push(closes[i] * k + (result[i - 1] as number) * (1 - k));
    }
  }

  return result;
}

function calcRsi(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

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

function volumeRatio(volumes: number[], lookback: number): number {
  if (volumes.length < lookback + 1) return 0;

  const lastVol = volumes[volumes.length - 1];
  let sum = 0;
  for (let i = volumes.length - 1 - lookback; i < volumes.length - 1; i++) {
    sum += volumes[i];
  }
  const avg = sum / lookback;
  return avg === 0 ? 0 : lastVol / avg;
}

function detectSignal(bars: Bar[]): SignalResult {
  const closes = bars.map((b) => b.c);
  const volumes = bars.map((b) => b.v);

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

  const lastVol = volumes[last];
  const avgVol = volRatio > 0 ? Math.round(lastVol / volRatio) : 0;

  const base = {
    close: closes[last],
    ema9: curEma9,
    ema21: curEma21,
    rsi,
    volume: lastVol,
    avg_volume: avgVol,
    volume_ratio: Math.round(volRatio * 100) / 100,
  };

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

function calcMacd(
  closes: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9,
): MacdResult | null {
  if (closes.length < slowPeriod + signalPeriod) return null;

  const emaFast = emaArray(closes, fastPeriod);
  const emaSlow = emaArray(closes, slowPeriod);

  const macdLine: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (emaFast[i] == null || emaSlow[i] == null) {
      macdLine.push(null);
    } else {
      macdLine.push((emaFast[i] as number) - (emaSlow[i] as number));
    }
  }

  const validMacd = macdLine.filter((v): v is number => v != null);
  if (validMacd.length < signalPeriod) return null;

  const signalEma = emaArray(validMacd, signalPeriod);
  const last = validMacd.length - 1;
  const signalVal = signalEma[last];
  const macdVal = validMacd[last];

  return {
    macdLine: +macdVal.toFixed(4),
    signalLine: signalVal != null ? +signalVal.toFixed(4) : null,
    histogram: signalVal != null ? +(macdVal - signalVal).toFixed(4) : null,
  };
}

function bollingerBands(closes: number[], period: number = 20, stdDevMult: number = 2): BollingerResult | null {
  if (closes.length < period) return null;

  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, c) => sum + (c - mean) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);

  return {
    upper: +(mean + stdDevMult * stdDev).toFixed(4),
    middle: +mean.toFixed(4),
    lower: +(mean - stdDevMult * stdDev).toFixed(4),
    bandwidth: mean > 0 ? +(((stdDevMult * 2 * stdDev) / mean) * 100).toFixed(2) : 0,
  };
}

function calcVwap(bars: Bar[]): number | null {
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

function findSupportResistance(bars: Bar[], lookback: number = 50): SupportResistance {
  if (!bars || bars.length < lookback) return { support: [], resistance: [] };

  const slice = bars.slice(-lookback);
  const pivotHighs: number[] = [];
  const pivotLows: number[] = [];

  for (let i = 1; i < slice.length - 1; i++) {
    if (slice[i].h > slice[i - 1].h && slice[i].h > slice[i + 1].h) {
      pivotHighs.push(slice[i].h);
    }
    if (slice[i].l < slice[i - 1].l && slice[i].l < slice[i + 1].l) {
      pivotLows.push(slice[i].l);
    }
  }

  const clusterLevels = (levels: number[]): number[] => {
    if (levels.length === 0) return [];
    levels.sort((a, b) => a - b);
    const clusters: number[] = [];
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

    return clusters.slice(-3).map((v) => +v.toFixed(4));
  };

  return {
    support: clusterLevels(pivotLows),
    resistance: clusterLevels(pivotHighs),
  };
}

function calcAtr(bars: Bar[], period: number = 14): number | null {
  if (!bars || bars.length < period + 1) return null;

  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].h;
    const low = bars[i].l;
    const prevClose = bars[i - 1].c;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return +atr.toFixed(4);
}

// CommonJS export for backward compat with all existing .js callers
module.exports = {
  emaArray,
  calcRsi,
  volumeRatio,
  detectSignal,
  calcMacd,
  bollingerBands,
  calcVwap,
  findSupportResistance,
  calcAtr,
};
