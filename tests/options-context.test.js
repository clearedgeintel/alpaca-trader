/**
 * Option-chain summary builder used by the orchestrator.
 *
 * Critical properties to lock down:
 *   - Returns {} when OPTIONS_ENABLED is false (no Alpaca calls made)
 *   - Filters out expired / too-near-expiry contracts using
 *     THETA_DECAY_DAYS_THRESHOLD
 *   - Filters out contracts outside the ±5% strike band around spot
 *   - Caps at MAX_PER_UNDERLYING contracts after sorting by moneyness
 *   - Skips zero/null premium rows
 *   - Caches per-underlying so repeated cycles don't refetch
 */

const mockRuntimeConfig = { get: jest.fn() };
jest.mock('../src/runtime-config', () => mockRuntimeConfig);

const mockAlpaca = {
  getSnapshot: jest.fn(),
  getOptionChain: jest.fn(),
};
jest.mock('../src/alpaca', () => mockAlpaca);

const { buildChainSummary, resetCache } = require('../src/options-context');

function isoDateInDays(days, base = new Date()) {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function makeContract({ symbol = 'TEST', strike = 100, type = 'call', dte = 30, premium = 1.5, delta = 0.5, iv = 0.3, oi = 500 }) {
  return {
    symbol,
    type,
    strike,
    expiration: isoDateInDays(dte),
    last: premium,
    bid: premium - 0.05,
    ask: premium + 0.05,
    delta,
    impliedVolatility: iv,
    openInterest: oi,
    theta: -0.05,
  };
}

describe('buildChainSummary', () => {
  beforeEach(() => {
    mockRuntimeConfig.get.mockReset();
    mockAlpaca.getSnapshot.mockReset();
    mockAlpaca.getOptionChain.mockReset();
    resetCache();
  });

  test('returns {} and makes ZERO Alpaca calls when OPTIONS_ENABLED=false', async () => {
    mockRuntimeConfig.get.mockReturnValue(false);

    const result = await buildChainSummary(['AAPL', 'MSFT']);

    expect(result).toEqual({});
    expect(mockAlpaca.getSnapshot).not.toHaveBeenCalled();
    expect(mockAlpaca.getOptionChain).not.toHaveBeenCalled();
  });

  test('returns {} for empty/non-array input', async () => {
    expect(await buildChainSummary([])).toEqual({});
    expect(await buildChainSummary(null)).toEqual({});
    expect(await buildChainSummary(undefined)).toEqual({});
  });

  test('returns chains for enabled underlyings, sorted by moneyness', async () => {
    mockRuntimeConfig.get.mockImplementation((k) => {
      if (k === 'OPTIONS_ENABLED') return true;
      if (k === 'THETA_DECAY_DAYS_THRESHOLD') return 7;
      return null;
    });
    mockAlpaca.getSnapshot.mockResolvedValue({ latestTrade: { p: 100 } });
    mockAlpaca.getOptionChain.mockResolvedValue([
      makeContract({ symbol: 'AAPLITM', strike: 95, dte: 30, premium: 5.5 }),
      makeContract({ symbol: 'AAPLATM', strike: 100, dte: 30, premium: 2.0 }),
      makeContract({ symbol: 'AAPLOTM', strike: 105, dte: 30, premium: 0.8 }),
    ]);

    const result = await buildChainSummary(['AAPL']);
    expect(Object.keys(result)).toEqual(['AAPL']);
    expect(result.AAPL).toHaveLength(3);
    // First entry should be the closest to spot (ATM)
    expect(result.AAPL[0].symbol).toBe('AAPLATM');
    expect(result.AAPL[0].dte).toBeGreaterThanOrEqual(29);
  });

  test('filters out contracts within THETA_DECAY_DAYS_THRESHOLD', async () => {
    mockRuntimeConfig.get.mockImplementation((k) => {
      if (k === 'OPTIONS_ENABLED') return true;
      if (k === 'THETA_DECAY_DAYS_THRESHOLD') return 7;
      return null;
    });
    mockAlpaca.getSnapshot.mockResolvedValue({ latestTrade: { p: 100 } });
    mockAlpaca.getOptionChain.mockResolvedValue([
      makeContract({ symbol: 'TOOSOON', strike: 100, dte: 5, premium: 1 }),
      makeContract({ symbol: 'JUSTRIGHT', strike: 100, dte: 14, premium: 2 }),
      makeContract({ symbol: 'JUSTRIGHT2', strike: 100, dte: 30, premium: 3 }),
    ]);

    const result = await buildChainSummary(['SPY']);
    const symbols = result.SPY.map((c) => c.symbol);
    expect(symbols).not.toContain('TOOSOON');
    expect(symbols).toContain('JUSTRIGHT');
    expect(symbols).toContain('JUSTRIGHT2');
  });

  test('skips zero-premium contracts', async () => {
    mockRuntimeConfig.get.mockImplementation((k) => {
      if (k === 'OPTIONS_ENABLED') return true;
      if (k === 'THETA_DECAY_DAYS_THRESHOLD') return 7;
      return null;
    });
    mockAlpaca.getSnapshot.mockResolvedValue({ latestTrade: { p: 100 } });
    mockAlpaca.getOptionChain.mockResolvedValue([
      { ...makeContract({ symbol: 'ZERO', strike: 100, dte: 30 }), last: 0, bid: 0, ask: 0 },
      makeContract({ symbol: 'PRICED', strike: 100, dte: 30, premium: 1 }),
    ]);

    const result = await buildChainSummary(['SPY']);
    const symbols = result.SPY.map((c) => c.symbol);
    expect(symbols).not.toContain('ZERO');
    expect(symbols).toContain('PRICED');
  });

  test('caches per-underlying so a second call within TTL skips Alpaca', async () => {
    mockRuntimeConfig.get.mockImplementation((k) => {
      if (k === 'OPTIONS_ENABLED') return true;
      if (k === 'THETA_DECAY_DAYS_THRESHOLD') return 7;
      return null;
    });
    mockAlpaca.getSnapshot.mockResolvedValue({ latestTrade: { p: 100 } });
    mockAlpaca.getOptionChain.mockResolvedValue([makeContract({ symbol: 'X', strike: 100, dte: 30, premium: 1 })]);

    await buildChainSummary(['AAPL']);
    await buildChainSummary(['AAPL']);

    expect(mockAlpaca.getSnapshot).toHaveBeenCalledTimes(1);
    expect(mockAlpaca.getOptionChain).toHaveBeenCalledTimes(1);
  });

  test('one underlying failure does not break others', async () => {
    mockRuntimeConfig.get.mockImplementation((k) => {
      if (k === 'OPTIONS_ENABLED') return true;
      if (k === 'THETA_DECAY_DAYS_THRESHOLD') return 7;
      return null;
    });
    mockAlpaca.getSnapshot.mockImplementation(async (sym) => {
      if (sym === 'BAD') throw new Error('boom');
      return { latestTrade: { p: 100 } };
    });
    mockAlpaca.getOptionChain.mockResolvedValue([makeContract({ symbol: 'X', strike: 100, dte: 30, premium: 1 })]);

    const result = await buildChainSummary(['AAPL', 'BAD', 'MSFT']);
    expect(result.AAPL).toBeDefined();
    expect(result.MSFT).toBeDefined();
    expect(result.BAD).toBeUndefined();
  });

  test('caps total contracts per underlying at the configured max', async () => {
    mockRuntimeConfig.get.mockImplementation((k) => {
      if (k === 'OPTIONS_ENABLED') return true;
      if (k === 'THETA_DECAY_DAYS_THRESHOLD') return 7;
      return null;
    });
    mockAlpaca.getSnapshot.mockResolvedValue({ latestTrade: { p: 100 } });
    // 20 contracts in the band — helper should cap at MAX_PER_UNDERLYING (8)
    const many = Array.from({ length: 20 }, (_, i) =>
      makeContract({ symbol: `C${i}`, strike: 99 + i * 0.1, dte: 30, premium: 1 + i * 0.1 }),
    );
    mockAlpaca.getOptionChain.mockResolvedValue(many);

    const result = await buildChainSummary(['SPY']);
    expect(result.SPY.length).toBeLessThanOrEqual(8);
  });
});
