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
  return retryWithBackoff(
    async () => {
      const res = await fetch(url, { ...options, headers: headers() });
      if (!res.ok) {
        const body = await res.text();
        const retryAfter = res.headers.get('retry-after');
        const err = new AlpacaHttpError(res.status, body, url);
        if (retryAfter) err.retryAfter = retryAfter;
        throw err;
      }
      return res.json();
    },
    {
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
    },
  ).catch((err) => {
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
  return (data.bars || []).map((b) => ({
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
  const { isCrypto } = require('./asset-classes');
  return alpacaFetch(`${BASE_URL}/v2/orders`, {
    method: 'POST',
    body: JSON.stringify({
      symbol,
      qty: String(qty),
      side,
      type: 'market',
      time_in_force: isCrypto(symbol) ? 'gtc' : 'day',
    }),
  });
}

/**
 * Place a limit order. Used by the Smart Order Router to capture
 * spread vs crossing the full bid-ask. time_in_force = 'gtc' for
 * crypto (Alpaca requirement); 'day' for equities so unfilled orders
 * don't carry overnight.
 */
async function placeLimitOrder(symbol, qty, side, limitPrice) {
  const { isCrypto } = require('./asset-classes');
  return alpacaFetch(`${BASE_URL}/v2/orders`, {
    method: 'POST',
    body: JSON.stringify({
      symbol,
      qty: String(qty),
      side,
      type: 'limit',
      limit_price: String(limitPrice),
      time_in_force: isCrypto(symbol) ? 'gtc' : 'day',
    }),
  });
}

/**
 * Cancel an open order by ID. Idempotent — 404 (already filled or
 * cancelled) is swallowed; any other error bubbles up.
 */
async function cancelOrder(orderId) {
  try {
    return await alpacaFetch(`${BASE_URL}/v2/orders/${orderId}`, { method: 'DELETE' });
  } catch (err) {
    if (err.message.includes('404')) return null;
    throw err;
  }
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
  return (data.bars || []).map((b) => ({
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
  return (data.news || []).map((n) => ({
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
  return (data.most_actives || []).map((s) => ({
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
    gainers: (data.gainers || []).map((s) => ({
      symbol: s.symbol,
      price: s.price,
      change: s.change,
      percent_change: s.percent_change,
    })),
    losers: (data.losers || []).map((s) => ({
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
        ? (((snap.dailyBar?.c || 0) - snap.prevDailyBar.c) / snap.prevDailyBar.c) * 100
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

// =============================================================================
// Options (Phase 1 MVP) — single-leg long calls/puts via Alpaca's
// /v1beta1/options endpoints. Every helper is a no-op return when
// OPTIONS_ENABLED is false at the runtime-config level — call sites
// must check the flag themselves; these helpers do NOT auto-skip
// because the orchestrator/agency may want chain data for analysis
// even when trading is disabled.
//
// Data lives at https://data.alpaca.markets/v1beta1/options/...
// Trading uses the same /v2/orders endpoint with order_class='simple'
// (a future phase will add 'mleg' for multi-leg).
//
// Endpoints used:
//   GET /v1beta1/options/snapshots/{underlying}                 chain
//   GET /v1beta1/options/snapshots?symbols={contract}           single
//   GET /v1beta1/options/snapshots/{underlying}?type=...&...    filtered
//
// Greeks (delta/gamma/theta/vega/rho/iv) are returned alongside the
// quote+last-trade in the snapshot payload. We pluck them out so
// downstream agents see a flat shape.
// =============================================================================

/**
 * Convenience wrapper around `isOptionSymbol` from asset-classes for
 * call sites that already require alpaca but don't want a second import.
 */
function isOptionSymbol(symbol) {
  const { isOptionSymbol: detect } = require('./asset-classes');
  return detect(symbol);
}

/**
 * Fetch the option chain (per-contract snapshots + Greeks) for an
 * underlying symbol. Returns an array of normalized contract entries.
 *
 * @param {string} underlying — equity symbol (e.g. 'AAPL')
 * @param {Object} [params]
 * @param {string} [params.expiration]      ISO date 'YYYY-MM-DD' to filter
 * @param {'call'|'put'} [params.type]      filter by side
 * @param {number} [params.strikePriceGte]  min strike
 * @param {number} [params.strikePriceLte]  max strike
 * @param {number} [params.limit=100]       max rows (Alpaca caps at 1000)
 *
 * @returns {Promise<Array<{
 *   symbol: string, underlying: string, expiration: string,
 *   type: 'call'|'put', strike: number,
 *   bid: number|null, ask: number|null, last: number|null,
 *   delta: number|null, gamma: number|null, theta: number|null,
 *   vega: number|null, rho: number|null, impliedVolatility: number|null,
 *   openInterest: number|null, volume: number|null
 * }>>}
 */
async function getOptionChain(underlying, params = {}) {
  if (!underlying) throw new Error('getOptionChain: underlying is required');
  const qp = new URLSearchParams();
  if (params.expiration) qp.set('expiration_date', params.expiration);
  if (params.type) qp.set('type', params.type);
  if (params.strikePriceGte != null) qp.set('strike_price_gte', String(params.strikePriceGte));
  if (params.strikePriceLte != null) qp.set('strike_price_lte', String(params.strikePriceLte));
  qp.set('limit', String(params.limit || 100));

  const url = `${DATA_URL}/v1beta1/options/snapshots/${underlying}?${qp}`;
  const data = await alpacaFetch(url);
  const snapshots = data.snapshots || {};

  const results = [];
  for (const [contractSymbol, snap] of Object.entries(snapshots)) {
    results.push(normalizeOptionSnapshot(contractSymbol, snap));
  }
  return results;
}

/**
 * Fetch a single contract snapshot (quote, last trade, Greeks).
 * Returns null if the contract is unknown or has no data.
 */
async function getOptionSnapshot(contractSymbol) {
  if (!contractSymbol) throw new Error('getOptionSnapshot: contractSymbol is required');
  const url = `${DATA_URL}/v1beta1/options/snapshots?symbols=${encodeURIComponent(contractSymbol)}`;
  const data = await alpacaFetch(url);
  const snap = data?.snapshots?.[contractSymbol];
  if (!snap) return null;
  return normalizeOptionSnapshot(contractSymbol, snap);
}

/**
 * Greeks-only convenience accessor. Returns
 *   { delta, gamma, theta, vega, rho, impliedVolatility }
 * or null when the contract has no current snapshot.
 */
async function getOptionGreeks(contractSymbol) {
  const snap = await getOptionSnapshot(contractSymbol);
  if (!snap) return null;
  return {
    delta: snap.delta,
    gamma: snap.gamma,
    theta: snap.theta,
    vega: snap.vega,
    rho: snap.rho,
    impliedVolatility: snap.impliedVolatility,
  };
}

/**
 * Normalize Alpaca's nested snapshot shape into a flat object that
 * matches the surface other agents expect. Missing fields → null.
 */
function normalizeOptionSnapshot(contractSymbol, snap) {
  const { parseOptionSymbol } = require('./asset-classes');
  const parsed = parseOptionSymbol(contractSymbol) || {};
  const greeks = snap.greeks || {};
  const quote = snap.latestQuote || snap.quote || {};
  const trade = snap.latestTrade || snap.trade || {};
  return {
    symbol: contractSymbol,
    underlying: parsed.underlying || null,
    expiration: parsed.expiration || null,
    type: parsed.type || null,
    strike: parsed.strike != null ? parsed.strike : null,
    bid: quote.bp != null ? Number(quote.bp) : null,
    ask: quote.ap != null ? Number(quote.ap) : null,
    last: trade.p != null ? Number(trade.p) : null,
    delta: greeks.delta != null ? Number(greeks.delta) : null,
    gamma: greeks.gamma != null ? Number(greeks.gamma) : null,
    theta: greeks.theta != null ? Number(greeks.theta) : null,
    vega: greeks.vega != null ? Number(greeks.vega) : null,
    rho: greeks.rho != null ? Number(greeks.rho) : null,
    impliedVolatility: snap.impliedVolatility != null ? Number(snap.impliedVolatility) : null,
    openInterest: snap.openInterest != null ? Number(snap.openInterest) : null,
    volume: snap.dailyBar?.v != null ? Number(snap.dailyBar.v) : null,
  };
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
  placeLimitOrder,
  cancelOrder,
  placeBracketOrder,
  getOrder,
  closePosition,
  getOrders,
  // Options (Phase 1 MVP) — call sites must check OPTIONS_ENABLED at the
  // runtime-config level before invoking trading. Read paths (chain,
  // snapshot, greeks) are safe to call regardless.
  isOptionSymbol,
  getOptionChain,
  getOptionSnapshot,
  getOptionGreeks,
};
