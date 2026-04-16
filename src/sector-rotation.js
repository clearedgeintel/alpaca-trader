/**
 * Sector rotation detector.
 *
 * Aggregates per-sector N-day returns over a symbol universe so the
 * orchestrator (and the Dashboard) can see which sectors are leading
 * and which are lagging. Leans on two data sources already in the
 * codebase:
 *
 *   - Polygon `getTickerDetails` → `sic_description` is the sector label.
 *     Free tier; cached ~6h by the adapter.
 *   - Alpaca `getDailyBars` → price deltas.
 *
 * When Polygon is disabled (no API key or runtime flag off), every
 * `getTickerDetails` call returns null, every symbol maps to an
 * "Unknown" bucket, and rotation becomes a single row — which the
 * orchestrator and UI treat as "no rotation signal". The pipeline
 * never throws.
 */

const alpaca = require('./alpaca');
const datasources = require('./datasources');
const { log, warn } = require('./logger');

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min — EOD data, safe to cache
let cache = null; // { computedAt, key, value }

/**
 * Aggregate sector momentum across a symbol list.
 *
 * @param {object} opts
 * @param {string[]} opts.symbols — universe to score (required)
 * @param {number} [opts.days=5] — lookback window in trading days
 * @returns {Promise<{ sectors, leaders, laggards, computedAt, universeSize, coveredSymbols }>}
 */
async function computeRotation({ symbols, days = 5 } = {}) {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    return emptyResult({ reason: 'no symbols' });
  }

  const cacheKey = `${days}:${symbols.slice().sort().join(',')}`;
  if (cache && cache.key === cacheKey && Date.now() - cache.computedAt < CACHE_TTL_MS) {
    return cache.value;
  }

  // Fetch sector + bars per symbol in parallel; tolerate individual failures.
  const perSymbol = await Promise.all(
    symbols.map(async (sym) => {
      try {
        const [details, bars] = await Promise.all([
          datasources.getTickerDetails(sym),
          alpaca.getDailyBars(sym, days + 2),
        ]);
        const sector = (details?.sic_description || 'Unknown').trim();
        const ret = computeReturn(bars, days);
        return { symbol: sym, sector, ret };
      } catch (err) {
        warn(`sector-rotation: ${sym} skipped — ${err.message}`);
        return null;
      }
    }),
  );

  const valid = perSymbol.filter((r) => r && Number.isFinite(r.ret));

  // Group by sector, compute stats.
  const groups = new Map();
  for (const r of valid) {
    if (!groups.has(r.sector)) groups.set(r.sector, []);
    groups.get(r.sector).push(r);
  }

  const sectors = Array.from(groups.entries()).map(([name, rows]) => {
    const returns = rows.map((r) => r.ret);
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const topSymbols = rows
      .slice()
      .sort((a, b) => b.ret - a.ret)
      .slice(0, 3)
      .map((r) => ({ symbol: r.symbol, ret: r.ret }));
    return {
      name,
      avgReturn,
      symbolCount: rows.length,
      topSymbols,
      // Momentum score: mean-normalized within the current set; we fill after the loop.
      momentumScore: null,
    };
  });

  // Rank & momentum score (z-score relative to the universe)
  if (sectors.length > 1) {
    const mean = sectors.reduce((a, s) => a + s.avgReturn, 0) / sectors.length;
    const variance = sectors.reduce((a, s) => a + (s.avgReturn - mean) ** 2, 0) / sectors.length;
    const std = Math.sqrt(variance);
    for (const s of sectors) {
      s.momentumScore = std > 0 ? (s.avgReturn - mean) / std : 0;
    }
  } else if (sectors.length === 1) {
    sectors[0].momentumScore = 0;
  }

  sectors.sort((a, b) => b.avgReturn - a.avgReturn);

  const out = {
    sectors,
    leaders: sectors.slice(0, 3),
    laggards: sectors.slice(-3).reverse(),
    computedAt: new Date().toISOString(),
    universeSize: symbols.length,
    coveredSymbols: valid.length,
    lookbackDays: days,
  };

  cache = { computedAt: Date.now(), key: cacheKey, value: out };
  log(
    `sector-rotation: ${valid.length}/${symbols.length} symbols across ${sectors.length} sectors; leader=${out.leaders[0]?.name || 'n/a'} (${((out.leaders[0]?.avgReturn ?? 0) * 100).toFixed(2)}%)`,
  );
  return out;
}

/**
 * Return multiplier for a symbol's BUY confidence based on its sector
 * rank. Leader sectors (z > 0.5) get a mild boost; laggards (z < -0.5)
 * get dampened. Flat sectors pass through at 1.0. Never zeros out.
 *
 * Returns 1.0 when rotation data is unavailable — fail-open.
 */
function sectorBiasMultiplier(symbol, rotation) {
  if (!rotation?.sectors?.length) return 1.0;
  // Find the sector this symbol belongs to.
  for (const s of rotation.sectors) {
    if (s.topSymbols.some((t) => t.symbol === symbol)) {
      return scoreToMultiplier(s.momentumScore);
    }
  }
  return 1.0;
}

function scoreToMultiplier(z) {
  if (z == null || !Number.isFinite(z)) return 1.0;
  // Clamp to [-2, 2] z, map to [0.75, 1.20]
  const clamped = Math.max(-2, Math.min(2, z));
  return 1.0 + clamped * 0.1;
}

function computeReturn(bars, days) {
  if (!bars?.length) return NaN;
  const slice = bars.slice(-Math.max(2, days + 1));
  if (slice.length < 2) return NaN;
  const first = slice[0].c;
  const last = slice[slice.length - 1].c;
  if (!first || !last) return NaN;
  return (last - first) / first;
}

function emptyResult(extra = {}) {
  return {
    sectors: [],
    leaders: [],
    laggards: [],
    computedAt: new Date().toISOString(),
    universeSize: 0,
    coveredSymbols: 0,
    lookbackDays: 0,
    ...extra,
  };
}

function _resetForTests() {
  cache = null;
}

module.exports = { computeRotation, sectorBiasMultiplier, scoreToMultiplier, _resetForTests };
