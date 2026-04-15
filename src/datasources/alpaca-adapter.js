/**
 * Thin pass-through over src/alpaca.js data-read methods.
 * Trading methods stay on alpaca.js — callers requiring orders/account
 * should keep importing alpaca directly.
 */

const alpaca = require('../alpaca');

module.exports = {
  getBars: alpaca.getBars,
  getDailyBars: alpaca.getDailyBars,
  getSnapshot: alpaca.getSnapshot,
  getMultiSnapshots: alpaca.getMultiSnapshots,
  getNews: alpaca.getNews,
  getMostActive: alpaca.getMostActive,
  getTopMovers: alpaca.getTopMovers,
  getAssets: alpaca.getAssets,
};
