const { log, error } = require('./logger');
const { retryWithBackoff } = require('./util/retry');

const BASE_URL = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
const DATA_URL = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';

function headers() {
  return {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET,
    'Content-Type': 'application/json',
  };
}

class AlpacaHttpError extends Error {
  constructor(status, body, url) {
    super(`Alpaca ${status}: ${body}`);
    this.name = 'AlpacaHttpError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

function isRetryableAlpaca(err) {
  if (err instanceof AlpacaHttpError) {
    return err.status === 429 || (err.status >= 500 && err.status < 600);
  }
  // Fetch network errors (DNS, ECONNRESET, timeout) throw TypeError
  return err?.name === 'TypeError' || err?.code === 'ECONNRESET' || err?.code === 'ETIMEDOUT';
}

async function alpacaFetch(url, options = {}) {
  return retryWithBackoff(async () => {
    const res = await fetch(url, { ...options, headers: headers() });
    if (!res.ok) {
      const body = await res.text();
      const retryAfter = res.headers.get('retry-after');
      const err = new AlpacaHttpError(res.status, body, url);
      if (retryAfter) err.retryAfter = retryAfter;
      throw err;
    }
    return res.json();
  }, {
    retries: 4,
    baseMs: 500,
    maxMs: 15000,
    shouldRetry: isRetryableAlpaca,
    label: `alpaca ${url.split('?')[0].split('/').slice(-2).join('/')}`,
    onRetry: (err) => {
      if (err instanceof AlpacaHttpError && err.status === 429) {
        log(`Rate limited by Alpaca (${err.url})`);
      }
    },
  }).catch((err) => {
    // Final failure — log and rethrow in the legacy Error format
    if (err instanceof AlpacaHttpError) {
      error(`Alpaca error: ${err.status} ${err.url}`, err.body);
    } else {
      error(`Alpaca network error: ${url}`, err.message);
    }
    throw err;
  });
}

async function getAccount() {
  const data = await alpacaFetch(`${BASE_URL}/v2/account`);
  return {
    buying_power: parseFloat(data.buying_power),
    portfolio_value: parseFloat(data.portfolio_value),
    cash: parseFloat(data.cash),
  };
}

async function getBars(symbol, timeframe, limit) {
  // Calculate start date based on timeframe and limit to ensure enough data
  const now = new Date();
  let daysBack = 7; // default
  if (timeframe === '1Day' || timeframe === '1Week') daysBack = Math.ceil(limit * 2);
  else if (timeframe === '1Hour') daysBack = Math.ceil(limit / 6.5) + 2;
  else if (timeframe === '15Min') daysBack = Math.ceil(limit / 26) + 2;
  else if (timeframe === '5Min') daysBack = Math.ceil(limit / 78) + 2;
  const start = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  const params = new URLSearchParams({ timeframe, limit: String(limit), start });
  const data = await alpacaFetch(`${DATA_URL}/v2/stocks/${symbol}/bars?${params}`);
  return (data.bars || []).map(b => ({
    t: b.t,
    o: b.o,
    h: b.h,
    l: b.l,
    c: b.c,
    v: b.v,
  }));
}

async function getPositions() {
  return alpacaFetch(`${BASE_URL}/v2/positions`);
}

async function getPosition(symbol) {
  try {
    return await alpacaFetch(`${BASE_URL}/v2/positions/${symbol}`);
  } catch (err) {
    if (err.message.includes('404')) return null;
    throw err;
  }
}

async function placeOrder(symbol, qty, side) {
  return alpacaFetch(`${BASE_URL}/v2/orders`, {
    method: 'POST',
    body: JSON.stringify({
      symbol,
      qty: String(qty),
      side,
      type: 'market',
      time_in_force: 'day',
    }),
  });
}

async function placeBracketOrder(symbol, qty, side, stopPrice, takeProfitPrice) {
  return alpacaFetch(`${BASE_URL}/v2/orders`, {
    method: 'POST',
    body: JSON.stringify({
      symbol,
      qty: String(qty),
      side,
      type: 'market',
      time_in_force: 'day',
      order_class: 'bracket',
      stop_loss: { stop_price: String(stopPrice) },
      take_profit: { limit_price: String(takeProfitPrice) },
    }),
  });
}

async function getOrder(orderId) {
  return alpacaFetch(`${BASE_URL}/v2/orders/${orderId}`);
}

async function closePosition(symbol) {
  try {
    return await alpacaFetch(`${BASE_URL}/v2/positions/${symbol}`, {
      method: 'DELETE',
    });
  } catch (err) {
    if (err.message.includes('404')) return null;
    throw err;
  }
}

async function getOrders(status = 'all', limit = 50) {
  const params = new URLSearchParams({ status, limit: String(limit) });
  return alpacaFetch(`${BASE_URL}/v2/orders?${params}`);
}

async function getDailyBars(symbol, limit = 200) {
  // Set start date far enough back to get the requested number of bars
  const start = new Date();
  start.setDate(start.getDate() - Math.ceil(limit * 1.5)); // Account for weekends/holidays
  const params = new URLSearchParams({ timeframe: '1Day', limit: String(limit), start: start.toISOString() });
  const data = await alpacaFetch(`${DATA_URL}/v2/stocks/${symbol}/bars?${params}`);
  return (data.bars || []).map(b => ({
    t: b.t,
    o: b.o,
    h: b.h,
    l: b.l,
    c: b.c,
    v: b.v,
  }));
}

async function getSnapshot(symbol) {
  return alpacaFetch(`${DATA_URL}/v2/stocks/${symbol}/snapshot`);
}

async function getNews(symbols = [], limit = 20) {
  const params = new URLSearchParams({ limit: String(limit), sort: 'desc' });
  if (symbols.length > 0) {
    params.set('symbols', symbols.join(','));
  }
  const data = await alpacaFetch(`${DATA_URL}/v1beta1/news?${params}`);
  return (data.news || []).map(n => ({
    id: n.id,
    headline: n.headline,
    summary: n.summary || '',
    author: n.author || '',
    source: n.source,
    url: n.url,
    images: n.images || [],
    symbols: n.symbols || [],
    created_at: n.created_at,
  }));
}

/**
 * Get most active stocks by volume.
 * Returns up to `top` symbols sorted by trade count / volume.
 */
async function getMostActive(top = 20) {
  const data = await alpacaFetch(`${DATA_URL}/v1beta1/screener/stocks/most-actives?top=${top}`);
  return (data.most_actives || []).map(s => ({
    symbol: s.symbol,
    volume: s.volume,
    trade_count: s.trade_count,
  }));
}

/**
 * Get top market movers — gainers and losers by percentage change.
 */
async function getTopMovers(marketType = 'stocks', top = 20) {
  const data = await alpacaFetch(`${DATA_URL}/v1beta1/screener/${marketType}/movers?top=${top}`);
  return {
    gainers: (data.gainers || []).map(s => ({
      symbol: s.symbol,
      price: s.price,
      change: s.change,
      percent_change: s.percent_change,
    })),
    losers: (data.losers || []).map(s => ({
      symbol: s.symbol,
      price: s.price,
      change: s.change,
      percent_change: s.percent_change,
    })),
  };
}

/**
 * Get snapshots for multiple symbols at once.
 */
async function getMultiSnapshots(symbols) {
  const params = new URLSearchParams({ symbols: symbols.join(',') });
  const data = await alpacaFetch(`${DATA_URL}/v2/stocks/snapshots?${params}`);
  const results = {};
  for (const [symbol, snap] of Object.entries(data || {})) {
    results[symbol] = {
      price: snap.latestTrade?.p || snap.minuteBar?.c || 0,
      open: snap.dailyBar?.o || 0,
      high: snap.dailyBar?.h || 0,
      low: snap.dailyBar?.l || 0,
      close: snap.dailyBar?.c || 0,
      volume: snap.dailyBar?.v || 0,
      prevClose: snap.prevDailyBar?.c || 0,
      changeFromPrevClose: snap.prevDailyBar?.c
        ? ((snap.dailyBar?.c || 0) - snap.prevDailyBar.c) / snap.prevDailyBar.c * 100
        : 0,
    };
  }
  return results;
}

/**
 * Get tradeable assets filtered by status and class.
 */
async function getAssets(status = 'active', assetClass = 'us_equity') {
  const params = new URLSearchParams({ status, asset_class: assetClass });
  return alpacaFetch(`${BASE_URL}/v2/assets?${params}`);
}

module.exports = {
  getAccount,
  getBars,
  getDailyBars,
  getSnapshot,
  getMultiSnapshots,
  getNews,
  getMostActive,
  getTopMovers,
  getAssets,
  getPositions,
  getPosition,
  placeOrder,
  placeBracketOrder,
  getOrder,
  closePosition,
  getOrders,
};
