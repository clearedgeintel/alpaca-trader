/**
 * Jest mock factory for the Alpaca client.
 * Usage:
 *   const { createAlpacaMock } = require('../mocks/alpaca')
 *   const alpacaMock = createAlpacaMock({ ... overrides })
 *   jest.mock('../../src/alpaca', () => alpacaMock)
 *
 * Each method is a jest.fn() so tests can do:
 *   alpacaMock.placeOrder.mockResolvedValueOnce({ ... })
 *   expect(alpacaMock.placeOrder).toHaveBeenCalledWith(...)
 */

const DEFAULT_ACCOUNT = {
  buying_power: 100000,
  portfolio_value: 100000,
  cash: 100000,
};

const DEFAULT_SNAPSHOT = (symbol, price = 100) => ({
  symbol,
  latestTrade: { p: price, s: 100, t: new Date().toISOString() },
  latestQuote: { bp: price - 0.01, ap: price + 0.01 },
  minuteBar: { o: price, h: price, l: price, c: price, v: 1000 },
  dailyBar: { o: price * 0.99, h: price * 1.01, l: price * 0.98, c: price, v: 500000 },
  prevDailyBar: { c: price * 0.98 },
});

// 30 days of bars with realistic ATR (~1% of price)
function defaultDailyBars(symbol = 'AAPL', startPrice = 100) {
  const bars = [];
  let price = startPrice;
  for (let i = 0; i < 30; i++) {
    const drift = (Math.sin(i / 3) * 0.005) + ((i - 15) * 0.001);
    const open = price;
    const close = +(price * (1 + drift)).toFixed(2);
    const high = +(Math.max(open, close) * 1.008).toFixed(2);
    const low = +(Math.min(open, close) * 0.992).toFixed(2);
    bars.push({
      t: new Date(Date.now() - (29 - i) * 24 * 60 * 60 * 1000).toISOString(),
      o: open, h: high, l: low, c: close, v: 1000000,
    });
    price = close;
  }
  return bars;
}

function createAlpacaMock(overrides = {}) {
  return {
    getAccount: jest.fn(async () => ({ ...DEFAULT_ACCOUNT })),
    getPositions: jest.fn(async () => []),
    getPosition: jest.fn(async () => null),
    getSnapshot: jest.fn(async (symbol) => DEFAULT_SNAPSHOT(symbol)),
    getMultiSnapshots: jest.fn(async (symbols) => {
      const out = {};
      for (const s of symbols) out[s] = { price: 100, volume: 500000, changeFromPrevClose: 0, open: 99, high: 101, low: 98, close: 100, prevClose: 99 };
      return out;
    }),
    getBars: jest.fn(async (symbol) => defaultDailyBars(symbol)),
    getDailyBars: jest.fn(async (symbol) => defaultDailyBars(symbol)),
    getOrder: jest.fn(async (orderId) => ({
      id: orderId, status: 'filled', filled_qty: '10', filled_avg_price: '100.00',
    })),
    getOrders: jest.fn(async () => []),
    placeOrder: jest.fn(async (symbol, qty, side) => ({
      id: `order-${symbol}-${Date.now()}`, symbol, qty: String(qty), side,
      status: 'filled', filled_qty: String(qty), filled_avg_price: '100.00',
    })),
    placeBracketOrder: jest.fn(async (symbol, qty, side) => ({
      id: `bracket-${symbol}-${Date.now()}`, symbol, qty: String(qty), side,
      status: 'filled', filled_qty: String(qty), filled_avg_price: '100.00',
      order_class: 'bracket',
    })),
    closePosition: jest.fn(async (symbol) => ({ symbol, status: 'closed' })),
    getNews: jest.fn(async () => []),
    getMostActive: jest.fn(async () => []),
    getTopMovers: jest.fn(async () => ({ gainers: [], losers: [] })),
    getAssets: jest.fn(async () => []),
    ...overrides,
  };
}

module.exports = { createAlpacaMock, defaultDailyBars, DEFAULT_ACCOUNT, DEFAULT_SNAPSHOT };
