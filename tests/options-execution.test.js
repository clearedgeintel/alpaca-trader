/**
 * Phase 1B option-execution surface area:
 *   - placeOptionOrder input validation
 *   - daysToExpiry threshold logic (boundary cases)
 *
 * Doesn't exercise the full execution-agent path (that requires DB +
 * Alpaca mocks); integration tests at that level land in a follow-up
 * once we wire a richer mock harness for option snapshots.
 */

const { isOptionSymbol, parseOptionSymbol, daysToExpiry } = require('../src/asset-classes');

// --- Mock the alpacaFetch network call so placeOptionOrder can be exercised ---
jest.mock('../src/util/retry', () => ({
  retryWithBackoff: (fn) => fn(0),
  backoffDelay: () => 0,
  sleep: () => Promise.resolve(),
  parseRetryAfter: () => null,
}));

// Minimal fetch stub that records the request body so we can assert on it.
let lastRequest = null;
global.fetch = jest.fn(async (url, opts) => {
  lastRequest = { url, body: JSON.parse(opts.body) };
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ id: 'test-order-id', status: 'accepted' }),
    text: async () => '',
  };
});

const { placeOptionOrder } = require('../src/alpaca');

describe('placeOptionOrder input validation', () => {
  beforeEach(() => {
    lastRequest = null;
    process.env.ALPACA_API_KEY = 'test';
    process.env.ALPACA_API_SECRET = 'test';
  });

  test('rejects non-OCC symbols', async () => {
    await expect(placeOptionOrder('AAPL', 1, 'buy')).rejects.toThrow(/not an OCC option symbol/);
    await expect(placeOptionOrder('BTC/USD', 1, 'buy')).rejects.toThrow(/not an OCC option symbol/);
    await expect(placeOptionOrder('', 1, 'buy')).rejects.toThrow(/not an OCC option symbol/);
  });

  test('rejects invalid side', async () => {
    await expect(placeOptionOrder('AAPL240419C00150000', 1, 'short')).rejects.toThrow(/side must be/);
    await expect(placeOptionOrder('AAPL240419C00150000', 1, 'BUY')).rejects.toThrow(/side must be/); // case-sensitive
  });

  test('rejects limit order without limitPrice', async () => {
    await expect(
      placeOptionOrder('AAPL240419C00150000', 1, 'buy', { orderType: 'limit' }),
    ).rejects.toThrow(/limit orders require/);
    await expect(
      placeOptionOrder('AAPL240419C00150000', 1, 'buy', { orderType: 'limit', limitPrice: 0 }),
    ).rejects.toThrow(/limit orders require/);
    await expect(
      placeOptionOrder('AAPL240419C00150000', 1, 'buy', { orderType: 'limit', limitPrice: -1 }),
    ).rejects.toThrow(/limit orders require/);
  });

  test('builds a market order body with order_class=simple, time_in_force=day', async () => {
    await placeOptionOrder('AAPL240419C00150000', 2, 'buy');
    expect(lastRequest.body).toEqual({
      symbol: 'AAPL240419C00150000',
      qty: '2',
      side: 'buy',
      type: 'market',
      time_in_force: 'day',
      order_class: 'simple',
    });
  });

  test('builds a limit order body with limit_price set', async () => {
    await placeOptionOrder('SPY261218P00450000', 5, 'sell', { orderType: 'limit', limitPrice: 1.25 });
    expect(lastRequest.body).toEqual({
      symbol: 'SPY261218P00450000',
      qty: '5',
      side: 'sell',
      type: 'limit',
      time_in_force: 'day',
      order_class: 'simple',
      limit_price: '1.25',
    });
  });
});

describe('daysToExpiry boundary cases', () => {
  test('a contract expiring today returns 0 or close to it', () => {
    const today = new Date();
    const yy = String(today.getUTCFullYear()).slice(-2);
    const mm = String(today.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(today.getUTCDate()).padStart(2, '0');
    const sym = `AAPL${yy}${mm}${dd}C00150000`;
    const days = daysToExpiry(sym);
    // -1, 0, or possibly +0 depending on local TZ vs the 4pm-ET expiry stamp
    expect(days).toBeGreaterThanOrEqual(-1);
    expect(days).toBeLessThanOrEqual(0);
  });

  test('a contract 8 days out is over the default THETA threshold (7)', () => {
    const future = new Date();
    future.setUTCDate(future.getUTCDate() + 8);
    const yy = String(future.getUTCFullYear()).slice(-2);
    const mm = String(future.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(future.getUTCDate()).padStart(2, '0');
    const sym = `AAPL${yy}${mm}${dd}C00150000`;
    expect(daysToExpiry(sym)).toBeGreaterThanOrEqual(7);
  });

  test('a contract 5 days out is under the default THETA threshold', () => {
    const future = new Date();
    future.setUTCDate(future.getUTCDate() + 5);
    const yy = String(future.getUTCFullYear()).slice(-2);
    const mm = String(future.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(future.getUTCDate()).padStart(2, '0');
    const sym = `AAPL${yy}${mm}${dd}C00150000`;
    expect(daysToExpiry(sym)).toBeLessThanOrEqual(5);
  });
});

describe('isOptionSymbol routing safety', () => {
  test('does not false-positive on common equity tickers', () => {
    const equities = ['AAPL', 'GOOGL', 'BRK.B', 'TSLA', 'SPY', 'QQQ'];
    for (const sym of equities) expect(isOptionSymbol(sym)).toBe(false);
  });

  test('does not false-positive on crypto pairs', () => {
    expect(isOptionSymbol('BTC/USD')).toBe(false);
    expect(isOptionSymbol('ETH/USD')).toBe(false);
  });

  test('parseOptionSymbol round-trips with the regex matcher', () => {
    const sym = 'AAPL240419C00150000';
    expect(isOptionSymbol(sym)).toBe(true);
    const p = parseOptionSymbol(sym);
    expect(p).not.toBeNull();
    expect(p.underlying).toBe('AAPL');
  });
});
