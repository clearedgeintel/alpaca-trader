const alpaca = require('./alpaca');
const { log, error } = require('./logger');

/**
 * Compute a Pearson correlation matrix for a set of symbols using daily returns.
 *
 * @param {string[]} symbols - Symbols to correlate
 * @param {number} [days=30] - Number of trading days of history
 * @returns {Promise<{matrix: Object, highCorrelations: Array}>}
 */
async function computeCorrelationMatrix(symbols, days = 30) {
  if (symbols.length < 2) {
    return { matrix: {}, highCorrelations: [] };
  }

  // Fetch daily bars for all symbols in parallel
  const barsBySymbol = {};
  const results = await Promise.allSettled(
    symbols.map(async (sym) => {
      const bars = await alpaca.getDailyBars(sym, days + 5);
      barsBySymbol[sym] = bars;
    }),
  );

  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected') {
      error(`Correlation: failed to fetch bars for ${symbols[i]}`, results[i].reason);
    }
  }

  // Compute daily returns for each symbol
  const returnsBySymbol = {};
  for (const [sym, bars] of Object.entries(barsBySymbol)) {
    if (!bars || bars.length < 2) continue;
    const returns = [];
    for (let i = 1; i < bars.length; i++) {
      returns.push((bars[i].c - bars[i - 1].c) / bars[i - 1].c);
    }
    returnsBySymbol[sym] = returns;
  }

  const availableSymbols = Object.keys(returnsBySymbol);
  if (availableSymbols.length < 2) {
    return { matrix: {}, highCorrelations: [] };
  }

  // Align return arrays to same length (use shortest)
  const minLen = Math.min(...availableSymbols.map((s) => returnsBySymbol[s].length));
  for (const sym of availableSymbols) {
    returnsBySymbol[sym] = returnsBySymbol[sym].slice(-minLen);
  }

  // Build correlation matrix
  const matrix = {};
  const highCorrelations = [];

  for (const symA of availableSymbols) {
    matrix[symA] = {};
    for (const symB of availableSymbols) {
      if (symA === symB) {
        matrix[symA][symB] = 1.0;
        continue;
      }

      const corr = pearsonCorrelation(returnsBySymbol[symA], returnsBySymbol[symB]);
      matrix[symA][symB] = +corr.toFixed(3);

      // Track high correlations (only once per pair, above threshold)
      if (symA < symB && Math.abs(corr) >= 0.7) {
        highCorrelations.push({
          symbolA: symA,
          symbolB: symB,
          correlation: +corr.toFixed(3),
          risk: Math.abs(corr) >= 0.85 ? 'high' : 'moderate',
        });
      }
    }
  }

  highCorrelations.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

  return { matrix, highCorrelations };
}

/**
 * Check if adding a new symbol would create excessive correlation with existing positions.
 *
 * @param {string} newSymbol - Symbol to check
 * @param {string[]} existingSymbols - Currently held symbols
 * @param {number} [threshold=0.85] - Correlation threshold for rejection
 * @returns {Promise<{allowed: boolean, reason: string, correlations: Array}>}
 */
async function checkCorrelationRisk(newSymbol, existingSymbols, threshold = 0.85) {
  if (existingSymbols.length === 0) {
    return { allowed: true, reason: 'No existing positions', correlations: [] };
  }

  const allSymbols = [newSymbol, ...existingSymbols];
  const { matrix } = await computeCorrelationMatrix(allSymbols, 30);

  if (!matrix[newSymbol]) {
    return { allowed: true, reason: 'Insufficient data for correlation check', correlations: [] };
  }

  const correlations = [];
  for (const sym of existingSymbols) {
    const corr = matrix[newSymbol]?.[sym];
    if (corr != null) {
      correlations.push({ symbol: sym, correlation: corr });
    }
  }

  const blocked = correlations.find((c) => Math.abs(c.correlation) >= threshold);
  if (blocked) {
    return {
      allowed: false,
      reason: `High correlation (${blocked.correlation}) with existing position ${blocked.symbol}`,
      correlations,
    };
  }

  return { allowed: true, reason: 'Correlation within limits', correlations };
}

function pearsonCorrelation(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;

  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0,
    sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }

  const denom = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (denom === 0) return 0;

  return (n * sumXY - sumX * sumY) / denom;
}

module.exports = { computeCorrelationMatrix, checkCorrelationRisk };
