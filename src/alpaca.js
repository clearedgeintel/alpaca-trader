const { log, error } = require('./logger');

const BASE_URL = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
const DATA_URL = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';

function headers() {
  return {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
    'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET,
    'Content-Type': 'application/json',
  };
}

async function alpacaFetch(url, options = {}) {
  const res = await fetch(url, { ...options, headers: headers() });

  if (res.status === 429) {
    log('Rate limited by Alpaca, backing off 10s...');
    await new Promise(r => setTimeout(r, 10000));
    const retry = await fetch(url, { ...options, headers: headers() });
    if (!retry.ok) {
      const body = await retry.text();
      error(`Alpaca retry failed: ${retry.status} ${url}`, body);
      throw new Error(`Alpaca ${retry.status}: ${body}`);
    }
    return retry.json();
  }

  if (!res.ok) {
    const body = await res.text();
    error(`Alpaca error: ${res.status} ${url}`, body);
    throw new Error(`Alpaca ${res.status}: ${body}`);
  }

  return res.json();
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
  const params = new URLSearchParams({ timeframe, limit: String(limit) });
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

module.exports = {
  getAccount,
  getBars,
  getPositions,
  getPosition,
  placeOrder,
  closePosition,
  getOrders,
};
