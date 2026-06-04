/**
 * Tests for src/lib/market-recap — daily + range trading recap generator.
 *
 * The lib reads from db.query() and shares honest-stats analysis with the
 * Honest P&L card. Fixtures cover:
 *   - Single-day vs multi-day range normalization
 *   - Headline math (largest win/loss, best setup, portfolio delta)
 *   - Investigation-note severity rules
 *   - Markdown formatter output shape
 *   - DB-fetch graceful failures (missing tables, etc.)
 */

const { generateRecap, formatAsMarkdown, formatAsHtml, _normalizeRange, _buildHeadline, _buildInvestigationNotes } = require('../src/lib/market-recap');

describe('_normalizeRange', () => {
  test('single day', () => {
    const r = _normalizeRange({ from: '2026-06-04', to: '2026-06-04' });
    expect(r.isSingleDay).toBe(true);
    expect(r.from).toBe('2026-06-04');
    expect(r.to).toBe('2026-06-04');
    expect(r.label).toMatch(/2026-06-04/);
  });

  test('multi-day range', () => {
    const r = _normalizeRange({ from: '2026-06-01', to: '2026-06-04' });
    expect(r.isSingleDay).toBe(false);
    expect(r.label).toBe('2026-06-01 → 2026-06-04');
  });

  test('rejects from > to', () => {
    expect(() => _normalizeRange({ from: '2026-06-10', to: '2026-06-01' })).toThrow();
  });

  test('rejects invalid date', () => {
    expect(() => _normalizeRange({ from: 'not-a-date', to: '2026-06-01' })).toThrow();
  });
});

describe('_buildHeadline', () => {
  const open = (over) => ({ id: 1, symbol: 'AAPL', created_at: new Date('2026-06-04T13:30:00Z'), ...over });
  const closed = (over) => ({
    id: 1,
    symbol: 'AAPL',
    side: 'buy',
    qty: 10,
    entry_price: 200,
    exit_price: 210,
    pnl: 100,
    pnl_pct: 5,
    exit_reason: 'take_profit',
    created_at: new Date('2026-06-04T13:30:00Z'),
    closed_at: new Date('2026-06-04T15:00:00Z'),
    strategy_pool: 'equity',
    ...over,
  });

  test('computes net P&L and win rate', () => {
    const h = _buildHeadline([
      closed({ pnl: 100 }),
      closed({ pnl: -50 }),
      closed({ pnl: 200 }),
    ], [], null);
    expect(h.netPnl).toBe(250);
    expect(h.nClosed).toBe(3);
    expect(h.nWins).toBe(2);
    expect(h.nLosses).toBe(1);
    expect(h.winRate).toBeCloseTo(0.667, 2);
  });

  test('identifies largest win + largest loss', () => {
    const h = _buildHeadline([
      closed({ symbol: 'TSLA', pnl: 340 }),
      closed({ symbol: 'AMD', pnl: -782 }),
      closed({ symbol: 'MSFT', pnl: 50 }),
    ], [], null);
    expect(h.largestWin.symbol).toBe('TSLA');
    expect(h.largestWin.pnl).toBe(340);
    expect(h.largestLoss.symbol).toBe('AMD');
    expect(h.largestLoss.pnl).toBe(-782);
  });

  test('selects best setup by average P&L (with n ≥ 2 floor)', () => {
    const h = _buildHeadline([
      closed({ strategy_pool: 'equity', pnl: 100 }),
      closed({ strategy_pool: 'equity', pnl: 200 }),
      closed({ strategy_pool: 'momentum', pnl: -50 }),
      closed({ strategy_pool: 'momentum', pnl: -100 }),
      // single-trade pool should be ignored
      closed({ strategy_pool: 'lone', pnl: 1000 }),
    ], [], null);
    expect(h.bestSetup.pool).toBe('equity');
    expect(h.bestSetup.evPerTrade).toBe(150);
    expect(h.bestSetup.n).toBe(2);
  });

  test('portfolio delta from start + end values', () => {
    const h = _buildHeadline([], [], { startValue: 100000, endValue: 99500 });
    expect(h.portfolioDelta).toBe(-500);
    expect(h.portfolioPct).toBeCloseTo(-0.5, 1);
  });

  test('empty closes returns zero net', () => {
    const h = _buildHeadline([], [], null);
    expect(h.netPnl).toBe(0);
    expect(h.nClosed).toBe(0);
    expect(h.winRate).toBe(0);
    expect(h.largestWin).toBeNull();
    expect(h.largestLoss).toBeNull();
  });
});

describe('_buildInvestigationNotes', () => {
  const honestStatsLib = require('../src/lib/honest-stats');
  const closedRow = (over) => ({
    symbol: 'AAPL', pnl: 0, exit_reason: 'stop_loss', status: 'closed', pnlPct: 0, entry: 200, ...over,
  });

  test('fires red carry-trade note when one trade carries the book', () => {
    const stats = honestStatsLib.analyze([
      honestStatsLib.adaptDbRow({ symbol: 'BMNG', pnl: 165000, entry_price: 0.45, exit_reason: 'take_profit', status: 'closed' }),
      ...Array.from({ length: 6 }, (_, i) =>
        honestStatsLib.adaptDbRow({ symbol: `S${i}`, pnl: -300, entry_price: 100, exit_reason: 'stop_loss', status: 'closed' })),
    ]);
    const notes = _buildInvestigationNotes({
      stats,
      closedTradesRows: [],
      sectorBreakdownRows: [],
      skipReasonsRows: {},
      range: {},
    });
    expect(notes.some((n) => n.severity === 'red' && /carrying the book/i.test(n.text))).toBe(true);
  });

  test('fires red stops-too-tight when ≥50% of closes are stop_loss', () => {
    const closedRows = Array.from({ length: 8 }, () => closedRow({ exit_reason: 'stop_loss' }));
    const notes = _buildInvestigationNotes({
      stats: honestStatsLib.analyze([]),
      closedTradesRows: closedRows,
      sectorBreakdownRows: [],
      skipReasonsRows: {},
      range: {},
    });
    expect(notes.some((n) => n.severity === 'red' && /stop_loss/i.test(n.text))).toBe(true);
  });

  test('fires amber sector-bleed when a sector loses ≥ $500', () => {
    const notes = _buildInvestigationNotes({
      stats: honestStatsLib.analyze([]),
      closedTradesRows: [],
      sectorBreakdownRows: [{ sector: 'Semiconductors', n: 3, totalPnl: -2400 }],
      skipReasonsRows: {},
      range: {},
    });
    expect(notes.some((n) => n.severity === 'amber' && /Semiconductors/.test(n.text))).toBe(true);
  });

  test('fires green validation when win rate ≥ 55% with no carry', () => {
    const trades = Array.from({ length: 10 }, (_, i) => honestStatsLib.adaptDbRow({
      symbol: `S${i}`,
      pnl: i < 6 ? 200 : -150,
      entry_price: 100,
      exit_reason: i < 6 ? 'take_profit' : 'stop_loss',
      status: 'closed',
    }));
    const stats = honestStatsLib.analyze(trades);
    const notes = _buildInvestigationNotes({
      stats,
      closedTradesRows: [],
      sectorBreakdownRows: [],
      skipReasonsRows: {},
      range: {},
    });
    expect(notes.some((n) => n.severity === 'green')).toBe(true);
  });

  test('falls back to amber empty-data note when no trades closed', () => {
    const notes = _buildInvestigationNotes({
      stats: honestStatsLib.analyze([]),
      closedTradesRows: [],
      sectorBreakdownRows: [],
      skipReasonsRows: {},
      range: {},
    });
    expect(notes).toHaveLength(1);
    expect(notes[0].severity).toBe('amber');
    expect(notes[0].text).toMatch(/no closed trades/i);
  });
});

describe('generateRecap — DB-driven smoke', () => {
  // Tiny mock db that returns synthetic rows. We don't exercise every query
  // (the lib gracefully handles missing tables), just enough to walk the
  // happy path and confirm the shape.
  function fakeDb() {
    return {
      query: jest.fn(async (sql, params) => {
        if (/FROM trades[\s\S]*status = 'closed'/i.test(sql)) {
          // status='closed' is the WHERE filter; the rows still need it for the
          // analyze() pass which re-filters defensively.
          return {
            rows: [
              {
                id: 1, symbol: 'AAPL', side: 'buy', qty: 10, entry_price: '200', exit_price: '210',
                pnl: '100', pnl_pct: '5', exit_reason: 'take_profit', status: 'closed',
                created_at: '2026-06-04T13:30:00Z', closed_at: '2026-06-04T14:00:00Z',
                strategy_pool: 'equity', option_type: null, risk_dollars: '35',
                decision_reasoning: 'EMA crossover + volume', confidence: '0.78',
              },
              {
                id: 2, symbol: 'AMD', side: 'buy', qty: 30, entry_price: '150', exit_price: '145',
                pnl: '-150', pnl_pct: '-3.33', exit_reason: 'stop_loss', status: 'closed',
                created_at: '2026-06-04T13:35:00Z', closed_at: '2026-06-04T14:30:00Z',
                strategy_pool: 'equity', option_type: null, risk_dollars: '157',
                decision_reasoning: null, confidence: '0.72',
              },
            ],
          };
        }
        if (/FROM trades[\s\S]*created_at::date/i.test(sql)) {
          return { rows: [] }; // no new opens
        }
        if (/SELECT data[\s\S]*FROM agent_reports/i.test(sql)) {
          return { rows: [{ data: { regime: 'range_bound' }, created_at: '2026-06-04T20:00:00Z' }] };
        }
        if (/FROM daily_performance/i.test(sql)) {
          return { rows: [{ portfolio_value: '273000' }] };
        }
        // Anything else (cycle stats, llm_usage, etc.) — graceful failure.
        throw new Error('table not found');
      }),
    };
  }

  test('returns the full ReportObject shape on the happy path', async () => {
    const db = fakeDb();
    const r = await generateRecap({ from: '2026-06-04', to: '2026-06-04', db });

    expect(r.meta.type).toBe('daily');
    expect(r.meta.period.from).toBe('2026-06-04');
    expect(r.headline.netPnl).toBe(-50); // 100 + -150
    expect(r.headline.nClosed).toBe(2);
    expect(r.headline.largestWin.symbol).toBe('AAPL');
    expect(r.headline.largestLoss.symbol).toBe('AMD');
    expect(r.honestStats.raw.n).toBe(2);
    expect(r.marketSummary.regime).toBe('range_bound');
    expect(r.trades.closes).toHaveLength(2);
    expect(r.trades.opens).toHaveLength(0);
    expect(Array.isArray(r.notesToInvestigate)).toBe(true);
  });

  test('rejects when db handle missing', async () => {
    await expect(generateRecap({ from: '2026-06-04', to: '2026-06-04' })).rejects.toThrow(/db/);
  });
});

describe('formatAsMarkdown', () => {
  // Use a small structured fixture to assert headers + tables are present.
  const synthetic = {
    meta: {
      type: 'daily',
      period: { from: '2026-06-04', to: '2026-06-04', label: 'Today (2026-06-04)' },
      generatedAt: '2026-06-04T20:00:00Z',
      portfolioValue: 273000,
      portfolioStartValue: 274000,
    },
    headline: {
      netPnl: -1000, nClosed: 3, nOpened: 2, winRate: 0.333, nWins: 1, nLosses: 2,
      portfolioDelta: -1000, portfolioPct: -0.36,
      largestWin: { symbol: 'TSLA', pnl: 300, exitReason: 'take_profit', holdMin: 65 },
      largestLoss: { symbol: 'AMD', pnl: -800, exitReason: 'stop_loss', holdMin: 30 },
      bestSetup: { pool: 'equity', evPerTrade: -100, n: 3 },
    },
    honestStats: {
      raw: { n: 3, winRate: 0.333, net: -1000, profitFactor: 0.27, expectancy: -333 },
      robust: { n: 3, winRate: 0.333, net: -1000, profitFactor: 0.27, expectancy: -333 },
      outliers: [],
      largestWin: 300,
      largestWinPctOfGrossProfit: 1.0,
      netExcludingLargestWin: -1300,
      oneTradeCarriesBook: false,
      byClass: {},
      byExitReason: {},
    },
    marketSummary: { indexes: [], regime: 'range_bound' },
    trades: {
      opens: [
        { id: 1, symbol: 'NVDA', qty: 10, entryPrice: 800, riskDollars: 100, createdAt: '2026-06-04T13:30:00Z', strategyPool: 'equity', confidence: 0.78, reasoning: 'Test reasoning', optionType: null },
      ],
      closes: [
        { id: 2, symbol: 'TSLA', qty: 5, entryPrice: 200, exitPrice: 260, pnl: 300, pnlPct: 30, exitReason: 'take_profit', holdMinutes: 65, closedAt: '2026-06-04T14:35:00Z', strategyPool: 'equity', optionType: null },
      ],
    },
    agentActivity: { cyclesRun: 78, decisionsRaw: 12, decisionsExecuted: 3, llmCost: 1.42, skipReasons: { position_already_open: 4 } },
    sectorBreakdown: [{ sector: 'Technology', n: 2, totalPnl: -800 }],
    news: { headlines: [] },
    notesToInvestigate: [
      { severity: 'red', text: '3/3 closes were stop_loss' },
      { severity: 'green', text: 'Win-rate validation' },
    ],
  };

  test('includes core sections in order', () => {
    const md = formatAsMarkdown(synthetic);
    expect(md).toMatch(/^# Daily Recap/);
    expect(md.indexOf('## Headline')).toBeGreaterThan(0);
    expect(md.indexOf('## Honest P&L')).toBeGreaterThan(md.indexOf('## Headline'));
    expect(md.indexOf('## Trades Opened')).toBeGreaterThan(md.indexOf('## Honest P&L'));
    expect(md.indexOf('## Trades Closed')).toBeGreaterThan(md.indexOf('## Trades Opened'));
    expect(md.indexOf('## Agent Activity')).toBeGreaterThan(md.indexOf('## Trades Closed'));
    expect(md.indexOf('## What to Investigate Next')).toBeGreaterThan(md.indexOf('## Agent Activity'));
  });

  test('renders the carry warning when oneTradeCarriesBook fires', () => {
    const carried = { ...synthetic, honestStats: { ...synthetic.honestStats, oneTradeCarriesBook: true } };
    expect(formatAsMarkdown(carried)).toMatch(/One trade carries the book/);
  });

  test('omits empty sections gracefully', () => {
    const empty = {
      ...synthetic,
      trades: { opens: [], closes: [] },
      sectorBreakdown: [],
      news: { headlines: [] },
    };
    const md = formatAsMarkdown(empty);
    expect(md).not.toMatch(/## Trades Opened/);
    expect(md).not.toMatch(/## Trades Closed/);
    expect(md).not.toMatch(/## Sector P&L/);
    expect(md).not.toMatch(/## News Highlights/);
  });

  test('range report uses "Trading Report Card" title', () => {
    const range = { ...synthetic, meta: { ...synthetic.meta, type: 'range', period: { from: '2026-06-01', to: '2026-06-04', label: '2026-06-01 → 2026-06-04' } } };
    expect(formatAsMarkdown(range)).toMatch(/^# Trading Report Card/);
  });
});

describe('formatAsHtml', () => {
  const synthetic = require('./fixtures/recap-synthetic.js');

  test('returns a full HTML document', () => {
    const html = formatAsHtml(synthetic);
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toMatch(/<title>Daily Recap/);
    expect(html).toMatch(/<\/html>$/);
  });

  test('escapes < > & in body text', () => {
    const hostile = { ...synthetic, notesToInvestigate: [{ severity: 'red', text: '<script>alert(1)</script> & more' }] };
    const html = formatAsHtml(hostile);
    expect(html).not.toMatch(/<script>alert/);
    expect(html).toMatch(/&lt;script&gt;/);
    expect(html).toMatch(/&amp;/);
  });

  test('renders bold and code spans', () => {
    const html = formatAsHtml(synthetic);
    expect(html).toMatch(/<strong>/);
    expect(html).toMatch(/<code/);
  });
});
