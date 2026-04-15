/**
 * Datasource registry — single entry point for all market-data reads.
 *
 * Alpaca remains primary (bars, snapshots, screeners). Polygon is an
 * enrichment layer that returns `null` when disabled/unavailable, so
 * callers can unconditionally request enrichment fields without branching.
 */

const alpaca = require('./alpaca-adapter');
const polygon = require('./polygon-adapter');

module.exports = {
  // Primary (Alpaca) — pass-through with identical signatures
  getBars: alpaca.getBars,
  getDailyBars: alpaca.getDailyBars,
  getSnapshot: alpaca.getSnapshot,
  getMultiSnapshots: alpaca.getMultiSnapshots,
  getNews: alpaca.getNews,
  getMostActive: alpaca.getMostActive,
  getTopMovers: alpaca.getTopMovers,
  getAssets: alpaca.getAssets,

  // Enrichment (Polygon free tier) — returns null when unavailable
  getTickerDetails: polygon.getTickerDetails,
  getNewsWithInsights: polygon.getNewsWithInsights,
  getDividends: polygon.getDividends,
  getMarketStatus: polygon.getMarketStatus,

  // Provider handles (for stats endpoints and tests)
  _providers: { alpaca, polygon },
};
