/**
 * market-recap.js
 * -----------------------------------------------------------------------------
 * Daily + range trading recap with the same honest-stats discipline as the
 * Honest P&L card: no flattering, surface carry trades, flag what to investigate.
 *
 * Lives next to honest-stats so the two share the same vocabulary of "raw vs
 * robust" and "one trade carries the book." The recap is the daily/range
 * narrative wrapper; honest-stats is the per-window math.
 *
 * Pure data assembly + formatters. No I/O beyond the db handle passed in,
 * so the server endpoint can swap test fixtures via a mock handle.
 *
 * Outputs three shapes:
 *   - structured ReportObject (for JSON API + UI render)
 *   - markdown string (for download + scheduled file drop)
 *   - HTML string (for email delivery + printable view)
 */

const honestStats = require('./honest-stats');
const { DateTime } = require('luxon');

// -- ReportObject shape ----------------------------------------------------
//
// {
//   meta: { type, period:{from,to,label}, generatedAt, portfolioValue },
//   headline: { netPnl, netPnlPct, nClosed, nOpened, winRate, largestWin{Symbol,Pnl},
//               largestLoss{Symbol,Pnl}, bestSetup },
//   honestStats: { raw, robust, outliers, largestWin, oneTradeCarriesBook, byClass, byExitReason },
//   marketSummary: { indexes:[{symbol,close,changePct,prevClose}], regime },
//   trades: { opens:[…], closes:[…] },
//   agentActivity: { cyclesRun, decisionsRaw, decisionsExecuted, skipReasons, llmCost, blocksByReason },
//   news: { headlines:[…] },
//   notesToInvestigate: [string]
// }

/**
 * Build a recap for either a single day ({date}) or a range ({from, to}).
 * Returns a structured ReportObject.
 */
async function generateRecap({ from, to, db }) {
  if (!db) throw new Error('generateRecap: db handle is required');
  const range = normalizeRange({ from, to });

  const [
    closedTradesRows,
    openedTradesRows,
    cycleStatsRows,
    skipReasonsRows,
    llmCostRows,
    regimeRows,
    portfolioRow,
    blockReasonsRows,
    sectorBreakdownRows,
  ] = await Promise.all([
    fetchClosedTrades(db, range),
    fetchOpenedTrades(db, range),
    fetchCycleStats(db, range),
    fetchSkipReasons(db, range),
    fetchLlmCost(db, range),
    fetchRegimeAtClose(db, range),
    fetchPortfolioValueAtRangeEdges(db, range),
    fetchExecutionBlockReasons(db, range),
    fetchSectorBreakdown(db, range),
  ]);

  // Convert closed trades through the honest-stats lib so we share carry-trade
  // detection + outlier flagging with the Honest P&L card.
  const tradeAdapters = closedTradesRows.map(honestStats.adaptDbRow);
  const stats = honestStats.analyze(tradeAdapters);

  const headline = buildHeadline(closedTradesRows, openedTradesRows, portfolioRow);
  const notes = buildInvestigationNotes({
    stats,
    closedTradesRows,
    sectorBreakdownRows,
    skipReasonsRows,
    range,
  });

  return {
    meta: {
      type: range.isSingleDay ? 'daily' : 'range',
      period: { from: range.from, to: range.to, label: range.label },
      generatedAt: new Date().toISOString(),
      portfolioValue: portfolioRow?.endValue ?? null,
      portfolioStartValue: portfolioRow?.startValue ?? null,
    },
    headline,
    honestStats: stats,
    marketSummary: {
      indexes: [], // populated upstream from market data; server endpoint joins live tickers
      regime: regimeRows?.regime || null,
      regimeAt: regimeRows?.at || null,
    },
    trades: {
      opens: openedTradesRows.map(serializeOpenTrade),
      closes: closedTradesRows.map(serializeClosedTrade),
    },
    agentActivity: {
      cyclesRun: cycleStatsRows.cyclesRun || 0,
      decisionsRaw: cycleStatsRows.decisionsRaw || 0,
      decisionsExecuted: cycleStatsRows.decisionsExecuted || 0,
      skipReasons: skipReasonsRows,
      blocksByReason: blockReasonsRows,
      llmCost: llmCostRows?.totalCostUsd || 0,
    },
    sectorBreakdown: sectorBreakdownRows,
    news: { headlines: [] }, // populated upstream by server (Alpaca News API)
    notesToInvestigate: notes,
  };
}

// -- range helper ----------------------------------------------------------

function normalizeRange({ from, to }) {
  // All dates are ET market days. Default to today in ET.
  const nowEt = DateTime.now().setZone('America/New_York');
  const toDate = to ? DateTime.fromISO(to, { zone: 'America/New_York' }) : nowEt;
  const fromDate = from ? DateTime.fromISO(from, { zone: 'America/New_York' }) : toDate;
  if (!fromDate.isValid || !toDate.isValid) throw new Error('Invalid date in range');
  if (fromDate > toDate) throw new Error('from is after to');

  const fromIso = fromDate.toFormat('yyyy-MM-dd');
  const toIso = toDate.toFormat('yyyy-MM-dd');
  const isSingleDay = fromIso === toIso;
  const label = isSingleDay
    ? fromIso === nowEt.toFormat('yyyy-MM-dd') ? `Today (${fromIso})` : fromIso
    : `${fromIso} → ${toIso}`;
  return { from: fromIso, to: toIso, isSingleDay, label };
}

// -- DB fetchers ----------------------------------------------------------

async function fetchClosedTrades(db, range) {
  const { rows } = await db.query(
    `SELECT t.id, t.symbol, t.side, t.qty, t.entry_price, t.exit_price, t.pnl, t.pnl_pct,
            t.exit_reason, t.created_at, t.closed_at, t.signal_id, t.strategy_pool,
            t.option_type, t.risk_dollars, t.status,
            d.reasoning AS decision_reasoning, d.confidence
       FROM trades t
       LEFT JOIN agent_decisions d ON d.signal_id = t.signal_id
      WHERE t.status = 'closed'
        AND t.closed_at::date >= $1::date
        AND t.closed_at::date <= $2::date
      ORDER BY t.closed_at ASC`,
    [range.from, range.to],
  );
  return rows;
}

async function fetchOpenedTrades(db, range) {
  const { rows } = await db.query(
    `SELECT t.id, t.symbol, t.side, t.qty, t.entry_price, t.stop_loss, t.take_profit,
            t.risk_dollars, t.created_at, t.signal_id, t.strategy_pool, t.option_type,
            t.status, t.pnl,
            d.reasoning AS decision_reasoning, d.confidence
       FROM trades t
       LEFT JOIN agent_decisions d ON d.signal_id = t.signal_id
      WHERE t.created_at::date >= $1::date
        AND t.created_at::date <= $2::date
      ORDER BY t.created_at ASC`,
    [range.from, range.to],
  );
  return rows;
}

async function fetchCycleStats(db, range) {
  // agent_metrics has per-cycle telemetry; fall back to trades count if the
  // table is missing in older deployments.
  try {
    const { rows } = await db.query(
      `SELECT
         COUNT(DISTINCT cycle_id)::int AS cycles_run,
         COALESCE(SUM(decisions_raw)::int, 0) AS decisions_raw,
         COALESCE(SUM(decisions_executed)::int, 0) AS decisions_executed
       FROM agent_metrics
       WHERE created_at::date >= $1::date AND created_at::date <= $2::date`,
      [range.from, range.to],
    );
    return rows[0] || {};
  } catch {
    return { cyclesRun: 0, decisionsRaw: 0, decisionsExecuted: 0 };
  }
}

async function fetchSkipReasons(db, range) {
  // signals.reason text starts with "skipped:" for skips; aggregate by the
  // first comma-delimited tag. Falls back to {} when there's no schema match.
  try {
    const { rows } = await db.query(
      `SELECT lower(split_part(reason, ':', 2)) AS bucket, COUNT(*)::int AS n
         FROM signals
        WHERE acted_on = false
          AND created_at::date >= $1::date
          AND created_at::date <= $2::date
          AND reason ILIKE 'skipped%'
        GROUP BY 1
        ORDER BY n DESC
        LIMIT 12`,
      [range.from, range.to],
    );
    const out = {};
    for (const r of rows) out[(r.bucket || 'unknown').trim()] = r.n;
    return out;
  } catch {
    return {};
  }
}

async function fetchLlmCost(db, range) {
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(cost_usd)::float, 0) AS total_cost_usd
         FROM llm_usage
        WHERE created_at::date >= $1::date AND created_at::date <= $2::date`,
      [range.from, range.to],
    );
    return { totalCostUsd: rows[0]?.total_cost_usd || 0 };
  } catch {
    return { totalCostUsd: 0 };
  }
}

async function fetchRegimeAtClose(db, range) {
  // Atlas's last report on the most recent day in range.
  try {
    const { rows } = await db.query(
      `SELECT data, created_at
         FROM agent_reports
        WHERE agent_name = 'market-regime'
          AND created_at::date <= $1::date
        ORDER BY created_at DESC
        LIMIT 1`,
      [range.to],
    );
    if (!rows[0]) return null;
    const regime = rows[0].data?.regime || rows[0].data?.params?.regime || null;
    return regime ? { regime, at: rows[0].created_at } : null;
  } catch {
    return null;
  }
}

async function fetchPortfolioValueAtRangeEdges(db, range) {
  // daily_performance is the canonical equity-curve source; pick the row
  // just before from-date as the start, and on or just before to-date as end.
  try {
    const startRow = await db.query(
      `SELECT portfolio_value FROM daily_performance
        WHERE trade_date <= $1::date
        ORDER BY trade_date DESC LIMIT 1`,
      [range.from],
    );
    const endRow = await db.query(
      `SELECT portfolio_value FROM daily_performance
        WHERE trade_date <= $1::date
        ORDER BY trade_date DESC LIMIT 1`,
      [range.to],
    );
    return {
      startValue: startRow.rows[0] ? parseFloat(startRow.rows[0].portfolio_value) : null,
      endValue: endRow.rows[0] ? parseFloat(endRow.rows[0].portfolio_value) : null,
    };
  } catch {
    return { startValue: null, endValue: null };
  }
}

async function fetchExecutionBlockReasons(db, range) {
  // Execution-agent sanity blocks were instrumented via metrics; if not in
  // the DB, count from the signals.reason text (skipped: ...).
  try {
    const { rows } = await db.query(
      `SELECT lower(reason) AS reason, COUNT(*)::int AS n
         FROM signals
        WHERE created_at::date >= $1::date
          AND created_at::date <= $2::date
          AND reason ILIKE 'execution-block%'
        GROUP BY 1
        ORDER BY n DESC
        LIMIT 10`,
      [range.from, range.to],
    );
    const out = {};
    for (const r of rows) out[r.reason || 'unknown'] = r.n;
    return out;
  } catch {
    return {};
  }
}

async function fetchSectorBreakdown(db, range) {
  // Map symbols → sector via the same SECTOR_MAP used elsewhere in the
  // codebase. We import it inline so the lib stays standalone.
  // Returns rows of { sector, n, totalPnl } sorted by absolute impact.
  try {
    const { rows } = await db.query(
      `SELECT symbol, pnl
         FROM trades
        WHERE status = 'closed'
          AND closed_at::date >= $1::date
          AND closed_at::date <= $2::date`,
      [range.from, range.to],
    );
    const SECTOR = {
      AAPL: 'Technology', MSFT: 'Technology', GOOGL: 'Technology', META: 'Technology',
      NVDA: 'Semiconductors', AMD: 'Semiconductors', INTC: 'Semiconductors', MU: 'Semiconductors',
      TSLA: 'Automotive', AMZN: 'Consumer', WMT: 'Consumer', COST: 'Consumer',
      JPM: 'Financials', GS: 'Financials', BAC: 'Financials',
      XOM: 'Energy', CVX: 'Energy',
      UNH: 'Healthcare', JNJ: 'Healthcare', LLY: 'Healthcare',
      SPY: 'ETF', QQQ: 'ETF', IWM: 'ETF',
    };
    const map = new Map();
    for (const r of rows) {
      const sec = SECTOR[(r.symbol || '').toUpperCase()] || 'Other';
      const prev = map.get(sec) || { sector: sec, n: 0, totalPnl: 0 };
      prev.n++;
      prev.totalPnl += Number(r.pnl) || 0;
      map.set(sec, prev);
    }
    return Array.from(map.values()).sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl));
  } catch {
    return [];
  }
}

// -- headline builder -----------------------------------------------------

function buildHeadline(closedRows, openedRows, portfolioRow) {
  const closes = closedRows.map((r) => ({
    symbol: r.symbol,
    pnl: Number(r.pnl) || 0,
    pnlPct: Number(r.pnl_pct) || 0,
    exitReason: r.exit_reason || 'unknown',
    holdMin: r.closed_at && r.created_at
      ? Math.round((new Date(r.closed_at) - new Date(r.created_at)) / 60000)
      : null,
  }));

  const netPnl = closes.reduce((s, c) => s + c.pnl, 0);
  const wins = closes.filter((c) => c.pnl > 0);
  const losses = closes.filter((c) => c.pnl < 0);
  const winRate = closes.length ? wins.length / closes.length : 0;

  const startValue = portfolioRow?.startValue;
  const endValue = portfolioRow?.endValue;
  const portfolioDelta = startValue && endValue ? endValue - startValue : null;
  const portfolioPct = startValue ? (portfolioDelta || 0) / startValue : null;

  const largestWin = closes.reduce((max, c) => (c.pnl > (max?.pnl ?? -Infinity) ? c : max), null);
  const largestLoss = closes.reduce((min, c) => (c.pnl < (min?.pnl ?? Infinity) ? c : min), null);

  // Best setup: per strategy_pool avg P&L over the window.
  const byPool = new Map();
  for (const r of closedRows) {
    const k = r.strategy_pool || 'untagged';
    const prev = byPool.get(k) || { pool: k, n: 0, total: 0 };
    prev.n++;
    prev.total += Number(r.pnl) || 0;
    byPool.set(k, prev);
  }
  const bestSetup = Array.from(byPool.values())
    .filter((p) => p.n >= 2)
    .sort((a, b) => (b.total / b.n) - (a.total / a.n))[0] || null;

  return {
    netPnl: +netPnl.toFixed(2),
    portfolioStartValue: startValue,
    portfolioEndValue: endValue,
    portfolioDelta: portfolioDelta != null ? +portfolioDelta.toFixed(2) : null,
    portfolioPct: portfolioPct != null ? +(portfolioPct * 100).toFixed(2) : null,
    nClosed: closes.length,
    nOpened: openedRows.length,
    winRate: +winRate.toFixed(3),
    nWins: wins.length,
    nLosses: losses.length,
    largestWin: largestWin ? { symbol: largestWin.symbol, pnl: +largestWin.pnl.toFixed(2), exitReason: largestWin.exitReason, holdMin: largestWin.holdMin } : null,
    largestLoss: largestLoss ? { symbol: largestLoss.symbol, pnl: +largestLoss.pnl.toFixed(2), exitReason: largestLoss.exitReason, holdMin: largestLoss.holdMin } : null,
    bestSetup: bestSetup ? { pool: bestSetup.pool, evPerTrade: +(bestSetup.total / bestSetup.n).toFixed(2), n: bestSetup.n } : null,
  };
}

// -- "what to investigate" generator --------------------------------------
// Rule-based — fires findings when the data exceeds an honest-threshold.
// Mirrors the trade-retro card's voice: red findings should make the operator
// act; amber surface things worth checking; green validates an approach.

function buildInvestigationNotes({ stats, closedTradesRows, sectorBreakdownRows, skipReasonsRows }) {
  const notes = [];

  // One-trade-carries-book — the marquee finding from Honest Stats.
  if (stats.oneTradeCarriesBook && stats.largestWin > 0) {
    notes.push({
      severity: 'red',
      text: `One trade (${(stats.largestWinPctOfGrossProfit * 100).toFixed(0)}% of gross profit) is carrying the book. Net excluding the largest win: ${formatMoney(stats.netExcludingLargestWin)}. Treat the headline as unrepeatable.`,
    });
  }

  // Stop-loss firing on a high fraction of closed trades = stops too tight.
  const stopHits = closedTradesRows.filter((r) => r.exit_reason === 'stop_loss').length;
  if (closedTradesRows.length >= 5 && stopHits / closedTradesRows.length >= 0.5) {
    notes.push({
      severity: 'red',
      text: `${stopHits}/${closedTradesRows.length} closes were stop_loss — stops may be too tight for the current volatility regime. Compare avg MAE in Trade Retro vs typical stop_pct.`,
    });
  }

  // Sector concentration in losses.
  const losingSectors = sectorBreakdownRows.filter((s) => s.totalPnl < -500);
  for (const s of losingSectors.slice(0, 2)) {
    notes.push({
      severity: 'amber',
      text: `${s.sector} bled ${formatMoney(s.totalPnl)} across ${s.n} closed trades — review sector exposure cap or correlation guard.`,
    });
  }

  // Skip-reason hot spots.
  const totalSkips = Object.values(skipReasonsRows).reduce((s, n) => s + n, 0);
  for (const [reason, n] of Object.entries(skipReasonsRows)) {
    if (n >= 5 && n / Math.max(totalSkips, 1) >= 0.3 && reason !== 'position_already_open') {
      notes.push({
        severity: 'amber',
        text: `${n} signals skipped with "${reason}" — frequent enough to be a tuning signal (see Settings → Risk Parameters).`,
      });
    }
  }

  // Validations (greens) — celebrate honest wins.
  if (stats.raw.n >= 8 && stats.raw.winRate >= 0.55 && stats.raw.net > 0 && !stats.oneTradeCarriesBook) {
    notes.push({
      severity: 'green',
      text: `${(stats.raw.winRate * 100).toFixed(0)}% win rate on ${stats.raw.n} closes with no carry trade — the edge is broad-based for this window.`,
    });
  }

  // Diagnostics fallback.
  if (notes.length === 0 && stats.raw.n === 0) {
    notes.push({ severity: 'amber', text: 'No closed trades in this window. Open Activity tab to see what cycles produced (decisions, skips).' });
  }

  return notes;
}

// -- per-trade serializers ------------------------------------------------

function serializeOpenTrade(r) {
  return {
    id: r.id,
    symbol: r.symbol,
    side: r.side,
    qty: Number(r.qty),
    entryPrice: Number(r.entry_price),
    stopLoss: r.stop_loss != null ? Number(r.stop_loss) : null,
    takeProfit: r.take_profit != null ? Number(r.take_profit) : null,
    riskDollars: r.risk_dollars != null ? Number(r.risk_dollars) : null,
    strategyPool: r.strategy_pool || null,
    optionType: r.option_type || null,
    createdAt: r.created_at,
    confidence: r.confidence != null ? Number(r.confidence) : null,
    reasoning: (r.decision_reasoning || '').slice(0, 200),
    status: r.status,
    currentPnl: r.pnl != null ? Number(r.pnl) : null,
  };
}

function serializeClosedTrade(r) {
  const holdMin = r.closed_at && r.created_at
    ? Math.round((new Date(r.closed_at) - new Date(r.created_at)) / 60000)
    : null;
  return {
    id: r.id,
    symbol: r.symbol,
    side: r.side,
    qty: Number(r.qty),
    entryPrice: Number(r.entry_price),
    exitPrice: r.exit_price != null ? Number(r.exit_price) : null,
    pnl: Number(r.pnl) || 0,
    pnlPct: r.pnl_pct != null ? Number(r.pnl_pct) : null,
    exitReason: r.exit_reason || 'unknown',
    strategyPool: r.strategy_pool || null,
    optionType: r.option_type || null,
    riskDollars: r.risk_dollars != null ? Number(r.risk_dollars) : null,
    createdAt: r.created_at,
    closedAt: r.closed_at,
    holdMinutes: holdMin,
    confidence: r.confidence != null ? Number(r.confidence) : null,
    reasoning: (r.decision_reasoning || '').slice(0, 200),
  };
}

// -- formatters -----------------------------------------------------------

function formatMoney(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  return (n < 0 ? '−$' : '$') + abs.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function formatPct(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return '—';
  return (n >= 0 ? '+' : '') + n.toFixed(digits) + '%';
}

function formatTime(iso) {
  if (!iso) return '—';
  return DateTime.fromJSDate(new Date(iso)).setZone('America/New_York').toFormat('HH:mm');
}

function formatDate(iso) {
  if (!iso) return '—';
  return DateTime.fromJSDate(new Date(iso)).setZone('America/New_York').toFormat('yyyy-MM-dd');
}

function severityGlyph(sev) {
  return sev === 'red' ? '🔴' : sev === 'amber' ? '🟡' : sev === 'green' ? '🟢' : '•';
}

/**
 * Render the report as markdown. Designed for both file-drop and embedding in
 * email. Renders without emoji except severity glyphs (so it's readable in
 * plain-text mail clients too).
 */
function formatAsMarkdown(report) {
  const out = [];
  const { meta, headline, honestStats, marketSummary, trades, agentActivity, sectorBreakdown, notesToInvestigate, news } = report;

  // Title
  const title = meta.type === 'daily'
    ? `# Daily Recap — ${meta.period.label}`
    : `# Trading Report Card — ${meta.period.label}`;
  out.push(title);
  out.push('');
  out.push(`*Generated ${formatDate(meta.generatedAt)} ${formatTime(meta.generatedAt)} ET. Honest-stats discipline: numbers as observed, not flattered.*`);
  out.push('');

  // Portfolio + headline block
  out.push('## Headline');
  out.push('');
  if (meta.portfolioStartValue != null && meta.portfolioValue != null) {
    out.push(`> **Portfolio:** ${formatMoney(meta.portfolioStartValue)} → ${formatMoney(meta.portfolioValue)} (${formatMoney(headline.portfolioDelta)} / ${formatPct(headline.portfolioPct)})`);
  } else if (meta.portfolioValue != null) {
    out.push(`> **Portfolio:** ${formatMoney(meta.portfolioValue)}`);
  }
  out.push(`> **Net P&L:** ${formatMoney(headline.netPnl)}  •  **Closed:** ${headline.nClosed}  •  **Opened:** ${headline.nOpened}  •  **Win rate:** ${(headline.winRate * 100).toFixed(0)}% (${headline.nWins}W / ${headline.nLosses}L)`);
  out.push('');

  if (headline.largestWin || headline.largestLoss) {
    out.push('| | Symbol | P&L | Exit | Hold |');
    out.push('|---|---|---|---|---|');
    if (headline.largestWin) {
      out.push(`| Largest win | **${headline.largestWin.symbol}** | ${formatMoney(headline.largestWin.pnl)} | ${headline.largestWin.exitReason} | ${headline.largestWin.holdMin != null ? headline.largestWin.holdMin + 'm' : '—'} |`);
    }
    if (headline.largestLoss) {
      out.push(`| Largest loss | **${headline.largestLoss.symbol}** | ${formatMoney(headline.largestLoss.pnl)} | ${headline.largestLoss.exitReason} | ${headline.largestLoss.holdMin != null ? headline.largestLoss.holdMin + 'm' : '—'} |`);
    }
    out.push('');
  }

  if (headline.bestSetup) {
    out.push(`**Best setup:** \`${headline.bestSetup.pool}\` at ${formatMoney(headline.bestSetup.evPerTrade)} EV/trade over ${headline.bestSetup.n} closes.`);
    out.push('');
  }

  // Honest Stats — raw vs robust
  out.push('## Honest P&L');
  out.push('');
  out.push('| | n | Win % | Net | Profit Factor |');
  out.push('|---|---|---|---|---|');
  out.push(`| Raw | ${honestStats.raw.n} | ${(honestStats.raw.winRate * 100).toFixed(0)}% | ${formatMoney(honestStats.raw.net)} | ${honestStats.raw.profitFactor != null ? honestStats.raw.profitFactor.toFixed(2) : 'inf'} |`);
  out.push(`| Robust | ${honestStats.robust.n} | ${(honestStats.robust.winRate * 100).toFixed(0)}% | ${formatMoney(honestStats.robust.net)} | ${honestStats.robust.profitFactor != null ? honestStats.robust.profitFactor.toFixed(2) : 'inf'} |`);
  out.push('');
  if (honestStats.outliers.length > 0) {
    out.push(`**Outliers stripped:** ${honestStats.outliers.map((o) => `${o.symbol} ${formatMoney(o.pnl)}`).join(', ')}`);
    out.push('');
  }
  if (honestStats.oneTradeCarriesBook) {
    out.push(`> ⚠ **One trade carries the book.** Largest win = ${(honestStats.largestWinPctOfGrossProfit * 100).toFixed(0)}% of all gross profit. Net excluding it: ${formatMoney(honestStats.netExcludingLargestWin)}.`);
    out.push('');
  }

  // By asset class + exit reason
  const byClassRows = Object.entries(honestStats.byClass).filter(([, s]) => s.n >= 2).sort(([, a], [, b]) => b.net - a.net);
  if (byClassRows.length > 0) {
    out.push('### By asset class');
    out.push('');
    out.push('| Class | n | Win % | Net | EV/trade |');
    out.push('|---|---|---|---|---|');
    for (const [k, s] of byClassRows) {
      out.push(`| ${k} | ${s.n} | ${(s.winRate * 100).toFixed(0)}% | ${formatMoney(s.net)} | ${formatMoney(s.expectancy)} |`);
    }
    out.push('');
  }

  const byExitRows = Object.entries(honestStats.byExitReason).filter(([, s]) => s.n >= 2).sort(([, a], [, b]) => b.net - a.net);
  if (byExitRows.length > 0) {
    out.push('### By exit reason');
    out.push('');
    out.push('| Reason | n | Win % | Net | EV/trade |');
    out.push('|---|---|---|---|---|');
    for (const [k, s] of byExitRows) {
      out.push(`| ${k} | ${s.n} | ${(s.winRate * 100).toFixed(0)}% | ${formatMoney(s.net)} | ${formatMoney(s.expectancy)} |`);
    }
    out.push('');
  }

  // Market summary (populated by server endpoint)
  if (marketSummary.indexes && marketSummary.indexes.length > 0) {
    out.push('## Market Summary');
    out.push('');
    out.push('| Index | Close | Change |');
    out.push('|---|---|---|');
    for (const ix of marketSummary.indexes) {
      const arrow = ix.changePct >= 0 ? '▲' : '▼';
      out.push(`| ${ix.symbol} | $${Number(ix.close).toFixed(2)} | ${arrow} ${formatPct(Number(ix.changePct))} |`);
    }
    out.push('');
    if (marketSummary.regime) {
      out.push(`Regime at close (Atlas): **${marketSummary.regime}**`);
      out.push('');
    }
  }

  // Sector breakdown
  if (sectorBreakdown && sectorBreakdown.length > 0) {
    out.push('## Sector P&L');
    out.push('');
    out.push('| Sector | n | Net |');
    out.push('|---|---|---|');
    for (const s of sectorBreakdown) {
      out.push(`| ${s.sector} | ${s.n} | ${formatMoney(s.totalPnl)} |`);
    }
    out.push('');
  }

  // Trades opened
  if (trades.opens.length > 0) {
    out.push(`## Trades Opened (${trades.opens.length})`);
    out.push('');
    for (const t of trades.opens) {
      const opt = t.optionType ? ` ${t.optionType.toUpperCase()}` : '';
      const conf = t.confidence != null ? ` @ ${(t.confidence * 100).toFixed(0)}% conf` : '';
      out.push(`- **${formatTime(t.createdAt)} ET** — BUY ${t.qty}${opt} ${t.symbol} @ $${t.entryPrice.toFixed(2)} (risk ${formatMoney(t.riskDollars)}${conf}, pool: \`${t.strategyPool || 'default'}\`)`);
      if (t.reasoning) out.push(`  *${t.reasoning}*`);
    }
    out.push('');
  }

  // Trades closed
  if (trades.closes.length > 0) {
    out.push(`## Trades Closed (${trades.closes.length})`);
    out.push('');
    for (const t of trades.closes) {
      const opt = t.optionType ? ` ${t.optionType.toUpperCase()}` : '';
      const hold = t.holdMinutes != null
        ? (t.holdMinutes >= 60 ? `${(t.holdMinutes / 60).toFixed(1)}h` : `${t.holdMinutes}m`)
        : '?';
      const pnlMark = t.pnl > 0 ? '🟢' : t.pnl < 0 ? '🔴' : '⚪';
      out.push(`- ${pnlMark} **${formatTime(t.closedAt)} ET** — SOLD ${t.qty}${opt} ${t.symbol} @ $${(t.exitPrice ?? 0).toFixed(2)} → ${formatMoney(t.pnl)} (${formatPct(t.pnlPct)}, held ${hold}, exit: \`${t.exitReason}\`)`);
    }
    out.push('');
  }

  // Agent activity
  out.push('## Agent Activity');
  out.push('');
  out.push(`- Cycles run: **${agentActivity.cyclesRun}**`);
  out.push(`- Raw decisions: **${agentActivity.decisionsRaw}** → Executed: **${agentActivity.decisionsExecuted}**`);
  if (agentActivity.llmCost > 0) {
    out.push(`- LLM cost: **${formatMoney(agentActivity.llmCost)}**`);
  }
  const skipPairs = Object.entries(agentActivity.skipReasons || {}).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (skipPairs.length > 0) {
    out.push('- Skip reasons:');
    for (const [reason, n] of skipPairs) out.push(`  - \`${reason}\` × ${n}`);
  }
  out.push('');

  // News (populated by server)
  if (news.headlines && news.headlines.length > 0) {
    out.push('## News Highlights');
    out.push('');
    for (const h of news.headlines.slice(0, 6)) {
      out.push(`- **${h.source}** — ${h.headline}${h.symbols?.length ? ` _[${h.symbols.slice(0, 4).join(', ')}]_` : ''}`);
    }
    out.push('');
  }

  // Investigate next
  if (notesToInvestigate.length > 0) {
    out.push('## What to Investigate Next');
    out.push('');
    for (const n of notesToInvestigate) {
      out.push(`- ${severityGlyph(n.severity)} ${n.text}`);
    }
    out.push('');
  }

  out.push('---');
  out.push('');
  out.push('*This recap is generated by the ClearEdge bot using the honest-stats discipline. Findings flagged 🔴 should be acted on; 🟡 surface things worth checking; 🟢 validate an approach that\'s working.*');

  return out.join('\n');
}

/**
 * Render the report as standalone HTML. Used for the printable dashboard view
 * and for emailed recaps. Inline styles only — no external CSS, no JS — so
 * mail clients (Gmail, Outlook) render it consistently.
 */
function formatAsHtml(report) {
  const md = formatAsMarkdown(report);
  // Minimal markdown→HTML — we don't pull in marked/markdown-it just for this.
  // Handles: # H1, ## H2, ### H3, **bold**, *italic*, `code`, bullets, tables,
  // > blockquotes, --- hr. Pre-escapes < > & in raw text so symbols + JSON
  // fragments render as text.
  const lines = md.split('\n');
  const html = [];
  let inTable = false;
  let inList = false;
  function flushList() { if (inList) { html.push('</ul>'); inList = false; } }
  function flushTable() { if (inTable) { html.push('</tbody></table>'); inTable = false; } }
  function inline(s) {
    return s
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/`([^`]+)`/g, '<code style="background:#f4f4f4;padding:2px 4px;border-radius:3px;font-family:monospace;font-size:0.9em">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
  }

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('# ')) { flushList(); flushTable(); html.push(`<h1 style="font-family:system-ui,sans-serif;color:#101318;border-bottom:2px solid #4f8cff;padding-bottom:6px;margin-top:32px">${inline(l.slice(2))}</h1>`); continue; }
    if (l.startsWith('## ')) { flushList(); flushTable(); html.push(`<h2 style="font-family:system-ui,sans-serif;color:#101318;margin-top:28px;border-bottom:1px solid #e5e7eb;padding-bottom:4px">${inline(l.slice(3))}</h2>`); continue; }
    if (l.startsWith('### ')) { flushList(); flushTable(); html.push(`<h3 style="font-family:system-ui,sans-serif;color:#252b35;margin-top:20px">${inline(l.slice(4))}</h3>`); continue; }
    if (l.startsWith('> ')) { flushList(); flushTable(); html.push(`<blockquote style="border-left:4px solid #4f8cff;background:#f0f5ff;margin:12px 0;padding:8px 14px;font-family:system-ui,sans-serif;color:#252b35">${inline(l.slice(2))}</blockquote>`); continue; }
    if (l.startsWith('---')) { flushList(); flushTable(); html.push('<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0">'); continue; }
    if (l.startsWith('- ')) {
      flushTable();
      if (!inList) { html.push('<ul style="font-family:system-ui,sans-serif;color:#252b35;line-height:1.6">'); inList = true; }
      const indent = l.match(/^( +)/);
      const text = l.replace(/^- /, '').replace(/^ +/, '');
      html.push(`<li style="${indent ? 'margin-left:20px;list-style:circle' : ''}">${inline(text)}</li>`);
      continue;
    }
    if (l.startsWith('|')) {
      flushList();
      const cells = l.split('|').slice(1, -1).map((c) => c.trim());
      // Separator row (| --- | --- |) toggles header→body
      if (cells.every((c) => /^[:\- ]+$/.test(c))) {
        html.push('</thead><tbody>');
        continue;
      }
      if (!inTable) {
        html.push('<table style="border-collapse:collapse;margin:12px 0;font-family:system-ui,sans-serif;color:#252b35;font-size:14px;width:100%"><thead style="background:#f9fafb">');
        inTable = true;
      }
      const tag = inTable ? 'td' : 'th';
      html.push(`<tr>${cells.map((c) => `<${tag} style="padding:8px 12px;border:1px solid #e5e7eb;text-align:left">${inline(c)}</${tag}>`).join('')}</tr>`);
      continue;
    }
    flushList();
    flushTable();
    if (l.trim()) html.push(`<p style="font-family:system-ui,sans-serif;color:#252b35;line-height:1.6;margin:8px 0">${inline(l)}</p>`);
  }
  flushList();
  flushTable();

  const title = report.meta.type === 'daily'
    ? `Daily Recap — ${report.meta.period.label}`
    : `Trading Report Card — ${report.meta.period.label}`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title.replace(/</g, '&lt;')}</title>
</head>
<body style="margin:0;padding:24px 16px;background:#ffffff;color:#252b35">
<div style="max-width:780px;margin:0 auto">
${html.join('\n')}
</div>
</body>
</html>`;
}

// -- public API -----------------------------------------------------------

module.exports = {
  generateRecap,
  formatAsMarkdown,
  formatAsHtml,
  // exposed for tests + ad-hoc callers
  _normalizeRange: normalizeRange,
  _buildHeadline: buildHeadline,
  _buildInvestigationNotes: buildInvestigationNotes,
};
