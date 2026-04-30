/**
 * Datasource registry — single entry point for all market-data reads.
 *
 * Alpaca remains primary (bars, snapshots, screeners). Polygon is an
 * enrichment layer that returns `null` when disabled/unavailable, so
 * callers can unconditionally request enrichment fields without branching.
 */

export {};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const alpaca = require('./alpaca-adapter');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const polygon = require('./polygon-adapter');

// Adapter shape — adapters expose a superset of these but the registry
// only re-exports a stable surface. Adapter modules are still .js, so
// each method is implicitly `any` here; tightening waits for those
// modules to migrate.
export interface DatasourceRegistry {
  // Primary (Alpaca) — pass-through with identical signatures
  getBars: typeof alpaca.getBars;
  getDailyBars: typeof alpaca.getDailyBars;
  getSnapshot: typeof alpaca.getSnapshot;
  getMultiSnapshots: typeof alpaca.getMultiSnapshots;
  getNews: typeof alpaca.getNews;
  getMostActive: typeof alpaca.getMostActive;
  getTopMovers: typeof alpaca.getTopMovers;
  getAssets: typeof alpaca.getAssets;

  // Enrichment (Polygon free tier) — returns null when unavailable
  getTickerDetails: typeof polygon.getTickerDetails;
  getNewsWithInsights: typeof polygon.getNewsWithInsights;
  getDividends: typeof polygon.getDividends;
  getMarketStatus: typeof polygon.getMarketStatus;

  _providers: { alpaca: typeof alpaca; polygon: typeof polygon };
}

const registry: DatasourceRegistry = {
  getBars: alpaca.getBars,
  getDailyBars: alpaca.getDailyBars,
  getSnapshot: alpaca.getSnapshot,
  getMultiSnapshots: alpaca.getMultiSnapshots,
  getNews: alpaca.getNews,
  getMostActive: alpaca.getMostActive,
  getTopMovers: alpaca.getTopMovers,
  getAssets: alpaca.getAssets,

  getTickerDetails: polygon.getTickerDetails,
  getNewsWithInsights: polygon.getNewsWithInsights,
  getDividends: polygon.getDividends,
  getMarketStatus: polygon.getMarketStatus,

  _providers: { alpaca, polygon },
};

module.exports = registry;
