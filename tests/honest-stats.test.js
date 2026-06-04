/**
 * Tests for src/lib/honest-stats — the honest P&L analyzer that surfaces
 * the BMNG-style "one trade carries the book" scenario.
 *
 * The fixtures intentionally encode the real situations the dashboard card
 * must catch:
 *   - one giant outlier carrying the book
 *   - profit-factor = null when there are no losses (instead of Infinity)
 *   - asset-class classification by symbol structure + price band
 *   - MAD outlier flagging in a tight distribution
 *   - empty-input edge case
 *   - CSV parsing with quoted fields
 */

const {
  analyze,
  stats,
  median,
  flagOutliers,
  assetClass,
  parseCsvLine,
  adaptDbRow,
} = require('../src/lib/honest-stats');

const t = (over) => ({
  symbol: 'AAPL',
  pnl: 0,
  pnlPct: 0,
  entry: 100,
  exitReason: 'stop_loss',
  status: 'closed',
  ...over,
});

describe('median', () => {
  test('odd length', () => expect(median([3, 1, 2])).toBe(2));
  test('even length', () => expect(median([1, 2, 3, 4])).toBe(2.5));
  test('empty', () => expect(median([])).toBe(0));
});

describe('flagOutliers', () => {
  test('flags one giant carry-trade in a tight distribution', () => {
    const pnls = [-100, -50, -75, -120, -80, -90, -110, -65, -95, -105, 165_000];
    const flags = flagOutliers(pnls);
    expect(flags[flags.length - 1]).toBe(true);
    // The losses are tight around -90 and shouldn't get flagged
    expect(flags.slice(0, -1).every((f) => f === false)).toBe(true);
  });

  test('flags nothing when MAD is zero (all values equal)', () => {
    expect(flagOutliers([5, 5, 5, 5])).toEqual([false, false, false, false]);
  });

  test('empty input', () => expect(flagOutliers([])).toEqual([]));
});

describe('stats', () => {
  test('profit factor is null (not Infinity) when there are no losses', () => {
    const s = stats([10, 20, 30]);
    expect(s.profitFactor).toBeNull();
    expect(s.winRate).toBe(1);
    expect(s.net).toBe(60);
  });

  test('profit factor is 0 when there are no wins', () => {
    const s = stats([-10, -20, -30]);
    expect(s.profitFactor).toBe(0);
    expect(s.winRate).toBe(0);
    expect(s.net).toBe(-60);
  });

  test('expectancy matches winRate*avgWin + lossRate*avgLoss', () => {
    const s = stats([100, -50, 100, -50]);
    expect(s.winRate).toBe(0.5);
    expect(s.avgWin).toBe(100);
    expect(s.avgLoss).toBe(-50);
    expect(s.expectancy).toBe(25);
  });

  test('empty input', () => {
    const s = stats([]);
    expect(s.n).toBe(0);
    expect(s.net).toBe(0);
    expect(s.winRate).toBe(0);
  });
});

describe('assetClass', () => {
  test('option by OCC regex', () => {
    expect(assetClass(t({ symbol: 'AAPL250620C00200000' }))).toBe('option');
  });

  test('ETF by membership', () => {
    expect(assetClass(t({ symbol: 'SPY' }))).toBe('etf');
    expect(assetClass(t({ symbol: 'TQQQ' }))).toBe('etf');
  });

  test('crypto proxy ETF', () => {
    expect(assetClass(t({ symbol: 'IBIT' }))).toBe('crypto_etf');
  });

  test('sub-$1 by entry price', () => {
    expect(assetClass(t({ symbol: 'BMNG', entry: 0.45 }))).toBe('sub_$1');
  });

  test('penny $1-5 by entry price', () => {
    expect(assetClass(t({ symbol: 'XYZ', entry: 3.5 }))).toBe('penny_$1-5');
  });

  test('equity by default', () => {
    expect(assetClass(t({ symbol: 'AAPL', entry: 150 }))).toBe('equity');
  });
});

describe('analyze — BMNG carry scenario', () => {
  // The real scenario: one sub-$1 stock returns +$165K, all other 10 trades
  // are losing equity trades. Raw net is positive, but the book is bleeding
  // and the report needs to flag that loudly.
  const trades = [
    t({ symbol: 'BMNG', entry: 0.45, pnl: 165_000, exitReason: 'take_profit' }),
    t({ symbol: 'AAPL', entry: 200, pnl: -2_000 }),
    t({ symbol: 'MSFT', entry: 400, pnl: -1_500 }),
    t({ symbol: 'NVDA', entry: 800, pnl: -3_000 }),
    t({ symbol: 'TSLA', entry: 300, pnl: -1_800 }),
    t({ symbol: 'AMD',  entry: 150, pnl: -1_200 }),
    t({ symbol: 'META', entry: 500, pnl: -2_500 }),
    t({ symbol: 'GOOG', entry: 150, pnl: -800 }),
    t({ symbol: 'AMZN', entry: 180, pnl: -1_400 }),
    t({ symbol: 'SPY',  entry: 500, pnl: -1_000 }),
    t({ symbol: 'QQQ',  entry: 450, pnl: -900 }),
  ];

  let r;
  beforeAll(() => { r = analyze(trades); });

  test('raw net is positive but misleading', () => {
    expect(r.raw.net).toBe(165_000 - 16_100);
    expect(r.raw.net).toBeGreaterThan(0);
  });

  test('robust net (BMNG stripped) is negative', () => {
    expect(r.robust.net).toBeLessThan(0);
    expect(r.outliers).toHaveLength(1);
    expect(r.outliers[0].symbol).toBe('BMNG');
  });

  test('one-trade-carries-book flag fires', () => {
    expect(r.oneTradeCarriesBook).toBe(true);
    expect(r.largestWinPctOfGrossProfit).toBe(1);   // BMNG is the only winner
  });

  test('net excluding largest win is the true book P&L', () => {
    expect(r.netExcludingLargestWin).toBe(-16_100);
  });

  test('byClass surfaces sub_$1 as the carry source', () => {
    expect(r.byClass.sub_$1.net).toBe(165_000);
    expect(r.byClass.equity.net).toBeLessThan(0);
    expect(r.byClass.etf.net).toBeLessThan(0);
  });

  test('byExitReason segregates the take_profit from stop_loss bleed', () => {
    expect(r.byExitReason.take_profit.net).toBe(165_000);
    expect(r.byExitReason.stop_loss.net).toBeLessThan(0);
  });

  test('non-closed and NaN-pnl trades are excluded', () => {
    const mixed = [
      ...trades,
      t({ symbol: 'OPEN', status: 'open', pnl: 99_999 }),
      t({ symbol: 'NULL', pnl: NaN }),
    ];
    const r2 = analyze(mixed);
    expect(r2.raw.n).toBe(trades.length);
  });
});

describe('analyze — healthy book without carry', () => {
  const trades = [
    t({ symbol: 'AAPL', entry: 200, pnl: 300, exitReason: 'take_profit' }),
    t({ symbol: 'MSFT', entry: 400, pnl: 250, exitReason: 'trailing_stop' }),
    t({ symbol: 'NVDA', entry: 800, pnl: -150, exitReason: 'stop_loss' }),
    t({ symbol: 'GOOG', entry: 150, pnl: 200, exitReason: 'take_profit' }),
    t({ symbol: 'AMD',  entry: 150, pnl: -120, exitReason: 'stop_loss' }),
    t({ symbol: 'META', entry: 500, pnl: 180, exitReason: 'trailing_stop' }),
    t({ symbol: 'TSLA', entry: 300, pnl: -100, exitReason: 'stop_loss' }),
    t({ symbol: 'AMZN', entry: 180, pnl: 220, exitReason: 'take_profit' }),
  ];

  let r;
  beforeAll(() => { r = analyze(trades); });

  test('one-trade-carries-book does not fire', () => {
    expect(r.oneTradeCarriesBook).toBe(false);
    expect(r.largestWinPctOfGrossProfit).toBeLessThan(0.4);
  });

  test('robust and raw agree closely (no extreme outliers)', () => {
    expect(r.outliers).toHaveLength(0);
    expect(r.robust.net).toBe(r.raw.net);
  });
});

describe('parseCsvLine', () => {
  test('plain row', () => {
    expect(parseCsvLine('AAPL,100,closed')).toEqual(['AAPL', '100', 'closed']);
  });

  test('quoted field containing a comma', () => {
    expect(parseCsvLine('AAPL,"$1,000",closed')).toEqual(['AAPL', '$1,000', 'closed']);
  });

  test('quoted field with escaped quote', () => {
    expect(parseCsvLine('AAPL,"he said ""hi""",closed')).toEqual(['AAPL', 'he said "hi"', 'closed']);
  });

  test('trailing empty field', () => {
    expect(parseCsvLine('AAPL,100,')).toEqual(['AAPL', '100', '']);
  });
});

describe('adaptDbRow', () => {
  test('parses numeric strings from pg', () => {
    const row = {
      symbol: 'AAPL',
      pnl: '123.45',
      pnl_pct: '0.025',
      entry_price: '200.00',
      exit_reason: 'take_profit',
      status: 'closed',
    };
    const t = adaptDbRow(row);
    expect(t.pnl).toBe(123.45);
    expect(t.pnlPct).toBe(0.025);
    expect(t.entry).toBe(200);
    expect(t.status).toBe('closed');
  });

  test('handles null entry_price', () => {
    const t = adaptDbRow({ symbol: 'AAPL', pnl: '0', entry_price: null, status: 'closed' });
    expect(t.entry).toBeNull();
  });
});
