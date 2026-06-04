/**
 * honest-stats.ts
 * -----------------------------------------------------------------------------
 * Honest P&L stats so the dashboard stops flattering the system. The raw
 * +$165K was one trade (BMNG); the rest of the book was negative. This reports
 * BOTH the raw number and a robust, outlier-stripped view, plus where each
 * trade fell — by asset class and by exit reason.
 *
 * Used in three places:
 *   - Dashboard "Honest Stats" card (src/server.js → /api/analytics/honest-stats)
 *   - CLI: `npx tsx scripts/honest-stats.ts trades_2026-06-04.csv`
 *   - Tests: tests/honest-stats.test.js
 *
 * The CSV loader stays here for the CLI path; the server uses adaptDbRow()
 * to map the trades table directly.
 */

export {}; // mark as module for TS; runtime-config.ts follows the same pattern
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { readFileSync } = require('node:fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('node:path');

export interface Trade {
  symbol: string;
  pnl: number;
  pnlPct: number | null;
  entry: number | null;
  exitReason: string;
  status: string;
}

export type AssetClass = 'option' | 'crypto_etf' | 'etf' | 'sub_$1' | 'penny_$1-5' | 'equity';

const OPTION_RE = /^[A-Z.]{1,6}\d{6}[CP]\d{8}$/;
const ETFS = new Set([
  'SPY', 'QQQ', 'IWM', 'DIA', 'XLE', 'XLF', 'XLK', 'XLV',
  'SOXL', 'SOXS', 'TQQQ', 'SQQQ', 'TSLL', 'SPXL', 'SPXS', 'LABU', 'LABD',
]);
const CRYPTO_PROXY = new Set(['IBIT', 'BITO', 'BITX', 'ETHU', 'GBTC', 'ETHE', 'FBTC']);

export function assetClass(t: Trade): AssetClass {
  const s = (t.symbol || '').toUpperCase();
  if (OPTION_RE.test(s)) return 'option';
  if (CRYPTO_PROXY.has(s)) return 'crypto_etf';
  if (ETFS.has(s)) return 'etf';
  const e = t.entry ?? 0;
  if (e > 0 && e < 1) return 'sub_$1';
  if (e >= 1 && e < 5) return 'penny_$1-5';
  return 'equity';
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Median Absolute Deviation outlier flag: |x - median| > k * 1.4826 * MAD.
 * Returns a boolean per input — true means "outlier, exclude from robust view."
 * If MAD is zero (e.g. all values equal), nothing is flagged.
 */
export function flagOutliers(xs: number[], k = 5): boolean[] {
  if (!xs.length) return [];
  const med = median(xs);
  const mad = median(xs.map((x) => Math.abs(x - med)));
  const scale = 1.4826 * mad;
  if (scale === 0) return xs.map(() => false);
  return xs.map((x) => Math.abs(x - med) > k * scale);
}

export interface Stats {
  n: number;
  wins: number;
  winRate: number;            // 0-1
  net: number;                // sum of P&L
  avgWin: number;             // mean of positive P&L
  avgLoss: number;            // mean of negative P&L (negative number)
  winLossRatio: number;       // avgWin / |avgLoss|, 0 when no losses
  expectancy: number;         // winRate * avgWin + (1-winRate) * avgLoss
  profitFactor: number | null;// gp / gl; null when gl == 0 (instead of Infinity)
  medianPnl: number;
}

export function stats(pnls: number[]): Stats {
  const n = pnls.length;
  const w = pnls.filter((p) => p > 0);
  const l = pnls.filter((p) => p < 0);
  const gp = w.reduce((a, b) => a + b, 0);
  const gl = Math.abs(l.reduce((a, b) => a + b, 0));
  const avgWin = w.length ? gp / w.length : 0;
  const avgLoss = l.length ? -gl / l.length : 0;
  const winRate = n ? w.length / n : 0;
  return {
    n,
    wins: w.length,
    winRate,
    net: pnls.reduce((a, b) => a + b, 0),
    avgWin,
    avgLoss,
    winLossRatio: avgLoss ? avgWin / Math.abs(avgLoss) : 0,
    expectancy: winRate * avgWin + (1 - winRate) * avgLoss,
    profitFactor: gl ? gp / gl : null,
    medianPnl: median(pnls),
  };
}

export interface Report {
  raw: Stats;
  robust: Stats;                                          // outliers removed (both tails)
  outliers: { symbol: string; pnl: number }[];
  largestWin: number;
  largestWinPctOfGrossProfit: number;
  netExcludingLargestWin: number;
  oneTradeCarriesBook: boolean;                           // largestWin > 40% of gross profit
  byClass: Record<string, Stats>;
  byExitReason: Record<string, Stats>;
}

export function analyze(trades: Trade[]): Report {
  const closed = trades.filter((t) => t.status === 'closed' && Number.isFinite(t.pnl));
  const pnls = closed.map((t) => t.pnl);

  const flags = flagOutliers(pnls);
  const outliers = closed
    .map((t, i) => ({ t, flagged: flags[i] }))
    .filter((x) => x.flagged)
    .map((x) => ({ symbol: x.t.symbol, pnl: x.t.pnl }));
  const robustPnls = pnls.filter((_, i) => !flags[i]);

  const wins = pnls.filter((p) => p > 0);
  const grossProfit = wins.reduce((a, b) => a + b, 0);
  const largestWin = wins.length ? Math.max(...wins) : 0;
  const largestWinPctOfGrossProfit = grossProfit ? largestWin / grossProfit : 0;

  const group = (key: (t: Trade) => string): Record<string, Stats> => {
    const m: Record<string, number[]> = {};
    for (const t of closed) (m[key(t)] = m[key(t)] || []).push(t.pnl);
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, stats(v)]));
  };

  const rawStats = stats(pnls);

  return {
    raw: rawStats,
    robust: stats(robustPnls),
    outliers,
    largestWin,
    largestWinPctOfGrossProfit,
    netExcludingLargestWin: rawStats.net - largestWin,
    oneTradeCarriesBook: largestWinPctOfGrossProfit > 0.4,
    byClass: group(assetClass),
    byExitReason: group((t) => t.exitReason || 'unknown'),
  };
}

// --- DB adapter (for the server endpoint) ---------------------------------

/**
 * Maps a `trades` row (as returned by pg) into the Trade shape this lib expects.
 * Numeric columns come back as strings from pg — we parse them here. Use this
 * from src/server.js so the lib stays I/O-free + unit-testable.
 */
export function adaptDbRow(row: any): Trade {
  return {
    symbol: String(row.symbol || ''),
    pnl: row.pnl == null ? NaN : Number(row.pnl),
    pnlPct: row.pnl_pct == null ? null : Number(row.pnl_pct),
    entry: row.entry_price == null ? null : Number(row.entry_price),
    exitReason: String(row.exit_reason || ''),
    status: String(row.status || ''),
  };
}

// --- CSV loader (for the CLI) ---------------------------------------------

/**
 * Loads trades from a CSV with the standard /api/trades export header. Handles
 * quoted fields containing commas — the prior simple split assumed the date
 * column never contained one, which we can't guarantee across exports.
 */
export function loadTradesCsv(filepath: string): Trade[] {
  const text = readFileSync(filepath, 'utf8').trim();
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]);
  const idx = (name: string) => header.indexOf(name);
  const iSym = idx('symbol');
  const iPnl = idx('pnl');
  const iPct = idx('pnl_pct');
  const iEntry = idx('entry_price');
  const iReason = idx('exit_reason');
  const iStatus = idx('status');

  const num = (s: string | undefined) => (s == null || s === '' ? null : Number(s));

  const trades: Trade[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    if (c.length === 0 || c.every((x) => x === '')) continue;
    trades.push({
      symbol: c[iSym] ?? '',
      pnl: c[iPnl] == null || c[iPnl] === '' ? NaN : Number(c[iPnl]),
      pnlPct: num(c[iPct]),
      entry: num(c[iEntry]),
      exitReason: c[iReason] ?? '',
      status: c[iStatus] ?? '',
    });
  }
  return trades;
}

/**
 * Minimal RFC 4180-ish CSV splitter. Handles double-quoted fields and escaped
 * quotes ("") inside quoted fields. Does NOT handle newlines inside quotes —
 * acceptable for the trades export which has single-line rows.
 */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// --- pretty printer (for the CLI) -----------------------------------------

export function money(n: number): string {
  return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function line(label: string, s: Stats): string {
  const pf = s.profitFactor == null ? 'inf' : s.profitFactor.toFixed(2);
  return `${label.padEnd(20)} n=${String(s.n).padStart(3)}  win ${(s.winRate * 100).toFixed(0).padStart(3)}%  ` +
    `net ${money(s.net).padStart(11)}  exp ${money(s.expectancy).padStart(7)}/t  pf ${pf}`;
}

export function formatReport(r: Report): string {
  const out: string[] = [];
  out.push('=== HONEST P&L ===');
  out.push(line('RAW (all closed)', r.raw));
  out.push(line('ROBUST (ex-outlier)', r.robust));
  out.push('');
  out.push(`Largest single win: ${money(r.largestWin)} = ${(r.largestWinPctOfGrossProfit * 100).toFixed(0)}% of all gross profit`);
  out.push(`Net EXCLUDING largest win: ${money(r.netExcludingLargestWin)}`);
  if (r.oneTradeCarriesBook) {
    out.push('  WARNING: one trade carries the book. Treat the raw net as unrepeatable.');
  }
  const outlierText = r.outliers.map((o) => `${o.symbol} ${money(o.pnl)}`).join(', ') || 'none';
  out.push(`Outliers flagged (${r.outliers.length}): ${outlierText}`);
  out.push('');
  out.push('=== BY ASSET CLASS ===');
  for (const [k, s] of Object.entries(r.byClass).sort((a, b) => b[1].net - a[1].net)) out.push(line(k, s));
  out.push('');
  out.push('=== BY EXIT REASON ===');
  for (const [k, s] of Object.entries(r.byExitReason).sort((a, b) => b[1].net - a[1].net)) out.push(line(k, s));
  return out.join('\n');
}

// --- CommonJS interop ------------------------------------------------------
//
// src/server.js is CJS and tsx makes this file requirable directly. The
// runtime-config.ts file follows this same pattern: keep the TS `export`
// surface for tooling, and explicit module.exports for CJS callers.
module.exports = {
  assetClass,
  median,
  flagOutliers,
  stats,
  analyze,
  adaptDbRow,
  loadTradesCsv,
  parseCsvLine,
  money,
  formatReport,
};
