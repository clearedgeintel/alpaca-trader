const { log, error } = require('./logger');

// Well-known active penny stock tickers — refreshed periodically from market data
// These are symbols commonly found on Yahoo's "Most Active Penny Stocks" screener
const PENNY_CANDIDATES = [
  'SIRI',
  'PLUG',
  'SOFI',
  'NIO',
  'GRAB',
  'DNA',
  'TELL',
  'HIMS',
  'OPEN',
  'WISH',
  'CLOV',
  'BB',
  'NOK',
  'SNDL',
  'ACB',
  'TLRY',
  'CGC',
  'OGI',
  'BNGO',
  'SENS',
  'GNUS',
  'ZOM',
  'MVIS',
  'CLNE',
  'WKHS',
  'GOEV',
  'LAZR',
  'VUZI',
  'BARK',
  'PSFE',
  'MAPS',
  'GENI',
  'JOBY',
  'STEM',
  'ORGN',
  'NKLA',
  'FFIE',
  'MULN',
  'BKKT',
  'BTBT',
  'MARA',
  'RIOT',
  'BITF',
  'CIFR',
  'IREN',
  'CLSK',
  'CORZ',
  'SOUN',
  'RKLB',
  'LUNR',
  'ASTS',
];

/**
 * Fetch most active penny stocks by checking real-time prices via Alpaca.
 * Filters to stocks under $5 with high volume.
 *
 * @param {number} [limit=15] - Max symbols to return
 * @returns {Promise<Array<{symbol, price, change, changePct, volume}>>}
 */
async function getMostActivePennyStocks(limit = 15) {
  try {
    // Use Alpaca snapshots to get real-time data for penny candidates
    const alpaca = require('./alpaca');
    const snapshots = await alpaca.getMultiSnapshots(PENNY_CANDIDATES);

    const pennyStocks = [];
    for (const [symbol, snap] of Object.entries(snapshots)) {
      const price = snap.price || 0;
      const volume = snap.volume || 0;
      const prevClose = snap.prevClose || price;
      const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;

      // Filter: price under $5, volume over 500k, price above $0.10
      if (price > 0.1 && price < 5.0 && volume > 500000) {
        pennyStocks.push({
          symbol,
          price: +price.toFixed(4),
          change: +(price - prevClose).toFixed(4),
          changePct: +changePct.toFixed(2),
          volume,
          name: symbol,
        });
      }
    }

    // Sort by volume descending
    pennyStocks.sort((a, b) => b.volume - a.volume);
    const result = pennyStocks.slice(0, limit);

    if (result.length > 0) {
      log(`Penny stock screen: found ${result.length} stocks under $5 with high volume`);
    }

    return result;
  } catch (err) {
    error('Penny stock screen failed', err);
    return [];
  }
}

module.exports = { getMostActivePennyStocks, PENNY_CANDIDATES };
