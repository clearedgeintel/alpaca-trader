/**
 * Kelly / half-Kelly position sizing.
 *
 * f* = p - (1 - p) / b
 *
 * Half-Kelly by default; multiplier clamped to [0.5x, 2.0x].
 */

export {};
/* eslint-disable @typescript-eslint/no-var-requires */
const db = require('./db');
const config = require('./config');
const runtimeConfig = require('./runtime-config');
const { error: logError } = require('./logger');

const MULTIPLIER_MIN = 0.5;
const MULTIPLIER_MAX = 2.0;
const KELLY_ABS_MAX = 0.05;

interface KellyOptions {
  lookbackDays?: number;
  minSampleSize?: number;
}

interface KellyResult {
  symbol: string;
  source: 'kelly' | 'cold_start' | 'error';
  sampleSize: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  winLossRatio: number | null;
  kellyF: number | null;
  rawKellyF: number | null;
  halfKellyF: number | null;
  baseRiskPct?: number;
  multiplier: number;
  minSampleSize?: number;
  error?: string;
  reason?: string;
}

function enabled(): boolean {
  const v = runtimeConfig.get('KELLY_ENABLED');
  return v === true || v === 'true';
}

function round(n: number, d: number): number {
  return Number.isFinite(n) ? +n.toFixed(d) : n;
}

function emptyResult(symbol: string, source: KellyResult['source'], extra: Partial<KellyResult> = {}): KellyResult {
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

async function computeKellyFraction(symbol: string, opts: KellyOptions = {}): Promise<KellyResult> {
  const { lookbackDays = 60, minSampleSize = 20 } = opts;

  let rows: Array<{ pnl: string; entry_price: string; qty: string }> = [];
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`kelly: failed to query trades for ${symbol}`, err);
    return emptyResult(symbol, 'error', { error: msg });
  }

  const wins: number[] = [];
  const losses: number[] = [];
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

  if (avgLoss <= 0 || wins.length === 0) {
    return emptyResult(symbol, 'cold_start', { sampleSize, winRate, avgWin, avgLoss, reason: 'no_losses_yet' });
  }

  const b = avgWin / avgLoss;
  const rawKellyF = winRate - (1 - winRate) / b;
  const kellyF = Math.min(KELLY_ABS_MAX, rawKellyF);
  const halfKellyF = kellyF / 2;
  const baseRiskPct: number = runtimeConfig.get('RISK_PCT') ?? config.RISK_PCT;
  const rawMultiplier = baseRiskPct > 0 ? halfKellyF / baseRiskPct : 1.0;
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

async function computeForSymbols(symbols: string[], opts: KellyOptions = {}): Promise<KellyResult[]> {
  return Promise.all(symbols.map((s) => computeKellyFraction(s, opts)));
}

async function kellyMultiplier(symbol: string, opts: KellyOptions = {}): Promise<number> {
  if (!enabled()) return 1.0;
  const r = await computeKellyFraction(symbol, opts);
  return r.source === 'kelly' ? r.multiplier : 1.0;
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
