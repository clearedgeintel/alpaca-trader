// Shared synthetic ReportObject for recap formatter tests. Mirrors the shape
// the lib emits so the markdown/html tests don't have to re-build it inline.
module.exports = {
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
  news: { headlines: [{ source: 'Reuters', headline: 'Fed minutes preview', symbols: ['SPY'] }] },
  notesToInvestigate: [
    { severity: 'red', text: '3/3 closes were stop_loss' },
    { severity: 'green', text: 'Win-rate validation' },
  ],
};
