const { evaluateGap, runGapCheck, _resetForTests } = require('../src/gap-risk');

beforeEach(() => _resetForTests());

const snap = (current, prevClose) => ({
  prevDailyBar: { c: prevClose },
  latestTrade: { p: current },
});

const trade = (overrides = {}) => ({
  id: 1,
  symbol: 'AAPL',
  status: 'open',
  side: 'buy',
  entry_price: '100',
  stop_loss: '95',
  option_type: null,
  ...overrides,
});

describe('evaluateGap (pure decision)', () => {
  test('5% stop + -10% gap → exits (10% > 1.5 × 5% = 7.5%)', () => {
    const decision = evaluateGap(trade(), snap(90, 100), { thresholdMult: 1.5 });
    expect(decision).not.toBeNull();
    expect(decision.symbol).toBe('AAPL');
    expect(decision.reason).toMatch(/gap_risk_exit/);
  });

  test('5% stop + -6% gap → no exit (6% < 7.5% threshold)', () => {
    const decision = evaluateGap(trade(), snap(94, 100), { thresholdMult: 1.5 });
    expect(decision).toBeNull();
  });

  test('5% stop + -8% gap → exits (right at edge)', () => {
    const decision = evaluateGap(trade(), snap(92, 100), { thresholdMult: 1.5 });
    expect(decision).not.toBeNull();
  });

  test('5% stop + +10% gap → no exit (gap UP is good for long)', () => {
    const decision = evaluateGap(trade(), snap(110, 100), { thresholdMult: 1.5 });
    expect(decision).toBeNull();
  });

  test('threshold multiplier of 2.0 raises the bar', () => {
    // -8% gap, 5% stop. 2.0 × 5% = 10% threshold. 8% < 10% → no exit.
    const decision = evaluateGap(trade(), snap(92, 100), { thresholdMult: 2.0 });
    expect(decision).toBeNull();
  });

  test('options are skipped (different exit logic)', () => {
    const decision = evaluateGap(
      trade({ option_type: 'call', symbol: 'AAPL240419C00150000' }),
      snap(50, 100),
      { thresholdMult: 1.5 },
    );
    expect(decision).toBeNull();
  });

  test('short positions are skipped (v2 long-only)', () => {
    const decision = evaluateGap(trade({ side: 'sell' }), snap(110, 100), { thresholdMult: 1.5 });
    expect(decision).toBeNull();
  });

  test('missing snapshot data → null (no false-positive)', () => {
    expect(evaluateGap(trade(), {}, {})).toBeNull();
    expect(evaluateGap(trade(), { prevDailyBar: { c: 100 } }, {})).toBeNull();
    expect(evaluateGap(trade(), { latestTrade: { p: 90 } }, {})).toBeNull();
  });

  test('inverted stop > entry (bad data) → null', () => {
    const decision = evaluateGap(
      trade({ entry_price: '100', stop_loss: '110' }),
      snap(90, 100),
      { thresholdMult: 1.5 },
    );
    expect(decision).toBeNull();
  });

  test('falls back to minuteBar.c when latestTrade is missing', () => {
    const decision = evaluateGap(
      trade(),
      { prevDailyBar: { c: 100 }, minuteBar: { c: 88 } },
      { thresholdMult: 1.5 },
    );
    expect(decision).not.toBeNull();
  });
});

describe('runGapCheck (integration with deps)', () => {
  test('exits the right positions, leaves others alone', async () => {
    const log = jest.fn();
    const error = jest.fn();
    const closePosition = jest.fn().mockResolvedValue({});
    const dbQuery = jest.fn();
    // open trades query
    dbQuery.mockResolvedValueOnce({
      rows: [
        trade({ id: 1, symbol: 'GAPDOWN', entry_price: '100', stop_loss: '95' }),
        trade({ id: 2, symbol: 'FLAT', entry_price: '100', stop_loss: '95' }),
        trade({ id: 3, symbol: 'GAPUP', entry_price: '100', stop_loss: '95' }),
      ],
    });
    // each subsequent query is the UPDATE
    dbQuery.mockResolvedValue({ rows: [] });

    const snapshots = {
      GAPDOWN: snap(88, 100), // -12% gap, 5% stop → exit (12% > 7.5%)
      FLAT: snap(100.5, 100), // -0.5% gap → no exit
      GAPUP: snap(110, 100), // +10% gap → no exit
    };
    const getSnapshot = jest.fn((sym) => Promise.resolve(snapshots[sym]));

    const result = await runGapCheck({
      db: { query: dbQuery },
      alpaca: { getSnapshot, closePosition },
      config: { GAP_EXIT_THRESHOLD_MULT: 1.5 },
      log,
      error,
    });

    expect(result.ran).toBe(true);
    expect(result.exits).toBe(1);
    expect(closePosition).toHaveBeenCalledTimes(1);
    expect(closePosition).toHaveBeenCalledWith('GAPDOWN');
  });

  test('returns gracefully when no open positions', async () => {
    const dbQuery = jest.fn().mockResolvedValue({ rows: [] });
    const closePosition = jest.fn();
    const result = await runGapCheck({
      db: { query: dbQuery },
      alpaca: { getSnapshot: jest.fn(), closePosition },
      config: {},
      log: jest.fn(),
      error: jest.fn(),
    });
    expect(result.exits).toBe(0);
    expect(closePosition).not.toHaveBeenCalled();
  });

  test('continues past snapshot fetch failures on individual symbols', async () => {
    const closePosition = jest.fn().mockResolvedValue({});
    const dbQuery = jest.fn()
      .mockResolvedValueOnce({
        rows: [
          trade({ id: 1, symbol: 'OK', entry_price: '100', stop_loss: '95' }),
          trade({ id: 2, symbol: 'BAD', entry_price: '100', stop_loss: '95' }),
        ],
      })
      .mockResolvedValue({ rows: [] });
    const getSnapshot = jest.fn((sym) => {
      if (sym === 'BAD') return Promise.reject(new Error('feed broken'));
      return Promise.resolve(snap(85, 100)); // OK gaps down enough to exit
    });
    const result = await runGapCheck({
      db: { query: dbQuery },
      alpaca: { getSnapshot, closePosition },
      config: { GAP_EXIT_THRESHOLD_MULT: 1.5 },
      log: jest.fn(),
      error: jest.fn(),
    });
    expect(result.exits).toBe(1);
    expect(closePosition).toHaveBeenCalledWith('OK');
  });
});
