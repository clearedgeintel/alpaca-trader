const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const db = require('./db');
const alpaca = require('./alpaca');
const { log, error } = require('./logger');
const scanner = require('./scanner');
const apiKeyAuth = require('./middleware/auth');
const riskAgent = require('./agents/risk-agent');
const regimeAgent = require('./agents/regime-agent');
const technicalAgent = require('./agents/technical-agent');
const newsAgent = require('./agents/news-agent');
const screenerAgent = require('./agents/screener-agent');
const orchestrator = require('./agents/orchestrator');
const executionAgent = require('./agents/execution-agent');
const { getUsage, getDebugLog } = require('./agents/llm');
const runtimeConfig = require('./runtime-config');
const { chat } = require('./chat');
const { getMostActivePennyStocks } = require('./yahoo');
const { runBacktest } = require('./backtest');
const { computeCorrelationMatrix } = require('./correlation');
const { getAllAssetClasses, getRiskParams } = require('./asset-classes');
const strategy = require('./strategy');
const { getRedditBuzz } = require('./reddit');
const mlModel = require('./ml-model');

const app = express();
let lastScanTime = null;

function setLastScanTime(time) {
  lastScanTime = time;
}

// Middleware
app.use(express.json());

// Rate limiting — 60 requests per minute per IP
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests, slow down' },
}));

// API key authentication (skipped if API_KEY not set in .env)
app.use('/api/', apiKeyAuth);

// Swagger API docs
const { setupSwagger } = require('./swagger');
setupSwagger(app);

// Serve built React frontend
const clientBuildPath = path.join(__dirname, '..', 'trader-ui', 'dist');
app.use(express.static(clientBuildPath));

// Health / status
app.get('/api/status', (req, res) => {
  const { DateTime } = require('luxon');
  const now = DateTime.now().setZone('America/New_York');
  const day = now.weekday; // 1=Mon, 7=Sun
  const isWeekday = day >= 1 && day <= 5;
  const minutes = now.hour * 60 + now.minute;
  const openMin = config.MARKET_OPEN_HOUR * 60 + config.MARKET_OPEN_MIN;
  const closeMin = config.MARKET_CLOSE_HOUR * 60 + config.MARKET_CLOSE_MIN;
  const marketOpen = isWeekday && minutes >= openMin && minutes <= closeMin;

  res.json({
    success: true,
    data: {
      status: 'running',
      market_open: marketOpen,
      last_scan: lastScanTime,
      uptime_seconds: Math.floor(process.uptime()),
    },
  });
});

// Last scan results — what symbols were evaluated and their indicator values
app.get('/api/scan', (req, res) => {
  if (config.USE_AGENCY) {
    // In agency mode, show screener watchlist + technical agent results
    const watchlist = screenerAgent.getWatchlist();
    const candidates = screenerAgent.getCandidates();
    const taReports = technicalAgent.getAllSymbolReports();
    const results = watchlist.map(sym => {
      const ta = taReports?.[sym];
      return {
        symbol: sym,
        status: ta ? 'scanned' : 'pending',
        signal: ta?.signal || null,
        confidence: ta?.confidence || null,
        close: ta?.data?.['5min']?.close || null,
        rsi: ta?.data?.['5min']?.rsi || null,
        volumeRatio: ta?.data?.['5min']?.volumeRatio || null,
        reasoning: ta?.reasoning || null,
      };
    });
    return res.json({
      success: true,
      data: {
        mode: 'agency',
        watchlist,
        symbolCount: watchlist.length,
        candidateCount: candidates?.length || 0,
        results,
        signalsFound: results.filter(r => r.signal && r.signal !== 'HOLD').length,
        scanned: results.filter(r => r.status === 'scanned').length,
      },
    });
  }
  res.json({ success: true, data: { mode: 'legacy', ...scanner.getLastScan() } });
});

// Live account from Alpaca
app.get('/api/account', async (req, res) => {
  try {
    const data = await alpaca.getAccount();
    res.json({ success: true, data });
  } catch (err) {
    error('API /account failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Market bars — OHLCV candle data for charting
app.get('/api/market/bars/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const timeframe = req.query.timeframe || '1Day';
    const limit = parseInt(req.query.limit) || 100;
    const bars = await alpaca.getBars(symbol.toUpperCase(), timeframe, limit);
    res.json({ success: true, data: bars });
  } catch (err) {
    error(`API /market/bars/${req.params.symbol} failed`, err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Market snapshot — current price + key data for a symbol
app.get('/api/market/snapshot/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const [snapshot, dailyBars] = await Promise.all([
      alpaca.getSnapshot(symbol),
      alpaca.getDailyBars(symbol, 30),
    ]);

    // Compute basic indicators from daily bars
    const closes = dailyBars.map(b => b.c);
    let rsi = null, ema9 = null, ema21 = null, avgVolume = null;

    if (closes.length >= 14) {
      const { calcRsi, emaArray } = require('./indicators');
      rsi = calcRsi(closes, 14);
      if (closes.length >= 9) ema9 = emaArray(closes, 9).pop();
      if (closes.length >= 21) ema21 = emaArray(closes, 21).pop();
    }

    const volumes = dailyBars.map(b => b.v);
    avgVolume = volumes.length > 0 ? Math.round(volumes.reduce((a, b) => a + b, 0) / volumes.length) : null;

    res.json({
      success: true,
      data: {
        symbol,
        snapshot,
        indicators: { rsi, ema9, ema21, avgVolume },
      },
    });
  } catch (err) {
    error(`API /market/snapshot/${req.params.symbol} failed`, err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Market tickers — live snapshots for key indices/ETFs
app.get('/api/market/tickers', async (req, res) => {
  try {
    const symbols = ['SPY', 'QQQ', 'IWM', 'DIA', 'VIX'];
    // VIX isn't a stock — get the rest via snapshots
    const snapshots = await alpaca.getMultiSnapshots(symbols.filter(s => s !== 'VIX'));
    const tickers = Object.entries(snapshots).map(([symbol, snap]) => ({
      symbol,
      price: snap.price,
      change: snap.changeFromPrevClose,
      volume: snap.volume,
      high: snap.high,
      low: snap.low,
      prevClose: snap.prevClose,
    }));
    res.json({ success: true, data: tickers });
  } catch (err) {
    error('API /market/tickers failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// News feed — latest market news from Alpaca
app.get('/api/market/news', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 15;
    const symbols = req.query.symbols ? req.query.symbols.split(',') : [];
    const data = await alpaca.getNews(symbols, limit);
    res.json({ success: true, data });
  } catch (err) {
    error('API /market/news failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Live positions from Alpaca
app.get('/api/positions', async (req, res) => {
  try {
    const data = await alpaca.getPositions();
    res.json({ success: true, data });
  } catch (err) {
    error('API /positions failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trades from DB
app.get('/api/trades', async (req, res) => {
  try {
    const { status } = req.query;
    let result;
    if (status) {
      result = await db.query(
        'SELECT * FROM trades WHERE status = $1 ORDER BY created_at DESC',
        [status]
      );
    } else {
      result = await db.query('SELECT * FROM trades ORDER BY created_at DESC');
    }
    res.json({ success: true, data: result.rows });
  } catch (err) {
    error('API /trades failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Single trade — enriched with signal + decision history
app.get('/api/trades/:id', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM trades WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Trade not found' });
    }
    const trade = result.rows[0];

    // Entry signal (the signal that caused this BUY)
    let entrySignal = null;
    if (trade.signal_id) {
      const sigRes = await db.query('SELECT * FROM signals WHERE id = $1', [trade.signal_id]);
      entrySignal = sigRes.rows[0] || null;
    }

    // All decisions about this symbol in the trade's window (open -> close or now)
    const closedAt = trade.closed_at || new Date();
    const openedAt = trade.created_at;
    const decisionsRes = await db.query(
      `SELECT id, symbol, action, confidence, reasoning, agent_inputs, duration_ms, created_at
       FROM agent_decisions
       WHERE symbol = $1
         AND created_at >= $2::timestamp - INTERVAL '10 minutes'
         AND created_at <= $3::timestamp + INTERVAL '10 minutes'
       ORDER BY created_at ASC`,
      [trade.symbol, openedAt, closedAt]
    );

    // All signals for this symbol in the trade window (entry BUY + any SELL)
    const signalsRes = await db.query(
      `SELECT id, symbol, signal, reason, close, acted_on, created_at
       FROM signals
       WHERE symbol = $1
         AND created_at >= $2::timestamp - INTERVAL '10 minutes'
         AND created_at <= $3::timestamp + INTERVAL '10 minutes'
       ORDER BY created_at ASC`,
      [trade.symbol, openedAt, closedAt]
    );

    res.json({
      success: true,
      data: {
        ...trade,
        entrySignal,
        signals: signalsRes.rows,
        decisions: decisionsRes.rows,
      },
    });
  } catch (err) {
    error('API /trades/:id failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Signals from DB
app.get('/api/signals', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const result = await db.query(
      'SELECT * FROM signals ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    error('API /signals failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Daily performance
app.get('/api/performance', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM daily_performance ORDER BY trade_date DESC'
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    error('API /performance failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Agent status — all registered agents
app.get('/api/agents', (req, res) => {
  const agents = [
    screenerAgent.getStatus(),
    riskAgent.getStatus(),
    regimeAgent.getStatus(),
    technicalAgent.getStatus(),
    newsAgent.getStatus(),
    orchestrator.getStatus(),
    executionAgent.getStatus(),
  ];
  res.json({ success: true, data: { agents, llmUsage: getUsage(), mode: config.USE_AGENCY ? 'agency' : 'legacy' } });
});

// Risk agent — last report
app.get('/api/agents/risk/report', (req, res) => {
  const report = riskAgent.getReport();
  res.json({ success: true, data: report });
});

// Risk agent — test evaluation
app.get('/api/agents/risk/evaluate', async (req, res) => {
  try {
    const { symbol, price } = req.query;
    if (!symbol || !price) {
      return res.status(400).json({ success: false, error: 'symbol and price query params required' });
    }
    const result = await riskAgent.evaluate({ symbol: symbol.toUpperCase(), close: parseFloat(price) });
    res.json({ success: true, data: result });
  } catch (err) {
    error('API /agents/risk/evaluate failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Regime agent — last report + current params
app.get('/api/agents/regime/report', (req, res) => {
  const report = regimeAgent.getReport();
  const params = regimeAgent.getParams();
  res.json({ success: true, data: { report, currentParams: params } });
});

// Technical agent — all symbol reports from last cycle
app.get('/api/agents/technical/report', (req, res) => {
  const { symbol } = req.query;
  if (symbol) {
    const report = technicalAgent.getSymbolReport(symbol.toUpperCase());
    return res.json({ success: true, data: report });
  }
  const reports = technicalAgent.getAllSymbolReports();
  res.json({ success: true, data: reports });
});

// News agent — sentiment report + alerts
app.get('/api/agents/news/report', (req, res) => {
  const report = newsAgent.getReport();
  const alerts = newsAgent.getAlerts();
  res.json({ success: true, data: { report, alerts } });
});

// News agent — sentiment for specific symbol
app.get('/api/agents/news/sentiment/:symbol', (req, res) => {
  const sentiment = newsAgent.getSymbolSentiment(req.params.symbol.toUpperCase());
  const alert = newsAgent.getCriticalAlert(req.params.symbol.toUpperCase());
  res.json({ success: true, data: { sentiment, criticalAlert: alert } });
});

// Screener agent — dynamic watchlist + candidates
app.get('/api/agents/screener/report', (req, res) => {
  const report = screenerAgent.getReport();
  const watchlist = screenerAgent.getWatchlist();
  const candidates = screenerAgent.getCandidates();
  const marketTheme = screenerAgent.getMarketTheme();
  res.json({ success: true, data: { report, watchlist, candidates, marketTheme } });
});

// Orchestrator — latest decisions
app.get('/api/decisions', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const result = await db.query(
      'SELECT * FROM agent_decisions ORDER BY created_at DESC LIMIT $1',
      [limit]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    error('API /decisions failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Agent decision timeline — decisions with linked trades and agent reports
app.get('/api/decisions/timeline', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const result = await db.query(
      `SELECT d.*, t.pnl, t.pnl_pct, t.status as trade_status, t.exit_reason
       FROM agent_decisions d
       LEFT JOIN trades t ON t.signal_id = d.signal_id
       ORDER BY d.created_at DESC LIMIT $1`,
      [limit]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    error('API /decisions/timeline failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Orchestrator — single decision detail
app.get('/api/decisions/:id', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM agent_decisions WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Decision not found' });
    }
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    error('API /decisions/:id failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Orchestrator — current cycle report + live decisions
app.get('/api/agents/orchestrator/report', (req, res) => {
  const report = orchestrator.getReport();
  const decisions = orchestrator.getDecisions();
  res.json({ success: true, data: { report, decisions } });
});

// Execution agent — fill history
app.get('/api/agents/execution/fills', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  const fills = executionAgent.getFillHistory(limit);
  res.json({ success: true, data: fills });
});

// Agent reports from DB
app.get('/api/agents/:name/reports', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const result = await db.query(
      'SELECT * FROM agent_reports WHERE agent_name = $1 ORDER BY created_at DESC LIMIT $2',
      [req.params.name, limit]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    error('API /agents/:name/reports failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Backtest — run historical simulation
app.post('/api/backtest', async (req, res) => {
  try {
    const { symbols, days, riskPct, stopPct, targetPct, trailingAtrMult, startingCapital } = req.body || {};
    const result = await runBacktest({
      symbols: symbols || undefined,
      days: days || undefined,
      riskPct: riskPct || undefined,
      stopPct: stopPct || undefined,
      targetPct: targetPct || undefined,
      trailingAtrMult: trailingAtrMult || undefined,
      startingCapital: startingCapital || undefined,
    });
    res.json({ success: true, data: result });
  } catch (err) {
    error('API /backtest failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Analytics — computed portfolio metrics from performance + trades data
app.get('/api/analytics', async (req, res) => {
  try {
    const perfResult = await db.query('SELECT * FROM daily_performance ORDER BY trade_date ASC');
    const tradeResult = await db.query("SELECT * FROM trades WHERE status = 'closed' ORDER BY closed_at ASC");

    const perf = perfResult.rows;
    const trades = tradeResult.rows;

    // Equity curve
    let peak = 0;
    const equityCurve = perf.map(p => {
      const val = Number(p.portfolio_value || 0);
      if (val > peak) peak = val;
      const drawdown = peak > 0 ? ((peak - val) / peak) * 100 : 0;
      return {
        date: p.trade_date,
        equity: val,
        pnl: Number(p.total_pnl || 0),
        drawdown: +drawdown.toFixed(2),
        winRate: Number(p.win_rate || 0),
        trades: Number(p.total_trades || 0),
      };
    });

    // Rolling stats
    const closedTrades = trades.map(t => ({
      pnl: Number(t.pnl || 0),
      pnlPct: Number(t.pnl_pct || 0),
      date: t.closed_at,
      symbol: t.symbol,
      exitReason: t.exit_reason,
    }));

    const wins = closedTrades.filter(t => t.pnl > 0);
    const losses = closedTrades.filter(t => t.pnl <= 0);
    const totalPnl = closedTrades.reduce((s, t) => s + t.pnl, 0);
    const winRate = closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
    const profitFactor = Math.abs(avgLoss) > 0 ? avgWin / Math.abs(avgLoss) : 0;

    // Max drawdown
    const maxDrawdown = equityCurve.reduce((max, p) => Math.max(max, p.drawdown), 0);

    // Sharpe ratio from daily P&L
    const dailyReturns = equityCurve
      .filter(p => p.equity > 0)
      .map((p, i, arr) => i === 0 ? 0 : (p.equity - arr[i - 1].equity) / arr[i - 1].equity);
    const meanReturn = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
    const stdReturn = dailyReturns.length > 1
      ? Math.sqrt(dailyReturns.reduce((sum, r) => sum + (r - meanReturn) ** 2, 0) / (dailyReturns.length - 1))
      : 0;
    const sharpeRatio = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(252) : 0;

    // Per-symbol breakdown
    const bySymbol = {};
    for (const t of closedTrades) {
      if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { trades: 0, wins: 0, pnl: 0 };
      bySymbol[t.symbol].trades++;
      if (t.pnl > 0) bySymbol[t.symbol].wins++;
      bySymbol[t.symbol].pnl += t.pnl;
    }
    for (const s of Object.values(bySymbol)) {
      s.winRate = s.trades > 0 ? +((s.wins / s.trades) * 100).toFixed(1) : 0;
      s.pnl = +s.pnl.toFixed(2);
    }

    // Exit reason breakdown
    const byExitReason = {};
    for (const t of closedTrades) {
      const reason = t.exitReason || 'unknown';
      if (!byExitReason[reason]) byExitReason[reason] = { count: 0, pnl: 0 };
      byExitReason[reason].count++;
      byExitReason[reason].pnl += t.pnl;
    }
    for (const r of Object.values(byExitReason)) r.pnl = +r.pnl.toFixed(2);

    res.json({
      success: true,
      data: {
        equityCurve,
        summary: {
          totalTrades: closedTrades.length,
          winRate: +winRate.toFixed(1),
          wins: wins.length,
          losses: losses.length,
          totalPnl: +totalPnl.toFixed(2),
          avgWin: +avgWin.toFixed(2),
          avgLoss: +avgLoss.toFixed(2),
          profitFactor: +profitFactor.toFixed(2),
          maxDrawdown: +maxDrawdown.toFixed(2),
          sharpeRatio: +sharpeRatio.toFixed(2),
        },
        bySymbol,
        byExitReason,
      },
    });
  } catch (err) {
    error('API /analytics failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Export trades as CSV
app.get('/api/export/trades', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM trades ORDER BY created_at ASC');
    const trades = result.rows;

    const headers = ['date', 'symbol', 'side', 'qty', 'entry_price', 'exit_price', 'stop_loss', 'take_profit',
      'pnl', 'pnl_pct', 'exit_reason', 'status', 'order_type', 'order_value', 'risk_dollars'];
    const rows = trades.map(t => [
      t.created_at, t.symbol, t.side, t.qty, t.entry_price, t.exit_price || '',
      t.stop_loss, t.take_profit, t.pnl || '', t.pnl_pct || '', t.exit_reason || '',
      t.status, t.order_type || 'market', t.order_value, t.risk_dollars,
    ].join(','));

    const csv = [headers.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=trades_${new Date().toISOString().slice(0, 10)}.csv`);
    res.send(csv);
  } catch (err) {
    error('API /export/trades failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Export tax lots (FIFO) as CSV
app.get('/api/export/taxlots', async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM trades WHERE status = 'closed' ORDER BY created_at ASC");
    const trades = result.rows;

    const headers = ['date_acquired', 'date_sold', 'symbol', 'qty', 'cost_basis', 'proceeds', 'gain_loss', 'hold_period', 'wash_sale'];
    const rows = trades.map(t => {
      const entry = Number(t.entry_price);
      const exit = Number(t.exit_price || 0);
      const qty = t.qty;
      const costBasis = +(entry * qty).toFixed(2);
      const proceeds = +(exit * qty).toFixed(2);
      const gainLoss = +(proceeds - costBasis).toFixed(2);
      const acquired = t.created_at ? new Date(t.created_at).toISOString().slice(0, 10) : '';
      const sold = t.closed_at ? new Date(t.closed_at).toISOString().slice(0, 10) : '';
      const holdMs = t.closed_at && t.created_at ? new Date(t.closed_at) - new Date(t.created_at) : 0;
      const holdPeriod = holdMs > 365 * 86400000 ? 'long-term' : 'short-term';
      return [acquired, sold, t.symbol, qty, costBasis, proceeds, gainLoss, holdPeriod, 'N'].join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=taxlots_${new Date().toISOString().slice(0, 10)}.csv`);
    res.send(csv);
  } catch (err) {
    error('API /export/taxlots failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Correlation matrix for open positions
app.get('/api/correlation', async (req, res) => {
  try {
    const result = await db.query("SELECT DISTINCT symbol FROM trades WHERE status = 'open'");
    const symbols = result.rows.map(r => r.symbol);
    if (symbols.length < 2) {
      return res.json({ success: true, data: { matrix: {}, highCorrelations: [], symbols } });
    }
    const data = await computeCorrelationMatrix(symbols);
    res.json({ success: true, data: { ...data, symbols } });
  } catch (err) {
    error('API /correlation failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Asset class configuration
app.get('/api/asset-classes', (req, res) => {
  const classes = getAllAssetClasses();
  res.json({ success: true, data: classes });
});

// Asset class risk params for a specific symbol
app.get('/api/asset-classes/:symbol', (req, res) => {
  const params = getRiskParams(req.params.symbol.toUpperCase());
  res.json({ success: true, data: params });
});

// Strategy management
app.get('/api/strategies', (req, res) => {
  res.json({ success: true, data: strategy.getAllStrategies() });
});

app.put('/api/strategies/:symbol', (req, res) => {
  try {
    const { mode } = req.body || {};
    if (!mode) return res.status(400).json({ success: false, error: 'mode is required (rules, llm, hybrid)' });
    strategy.setStrategy(req.params.symbol.toUpperCase(), mode);
    res.json({ success: true, data: { symbol: req.params.symbol.toUpperCase(), mode } });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.put('/api/strategies', (req, res) => {
  try {
    const { default: mode } = req.body || {};
    if (!mode) return res.status(400).json({ success: false, error: 'default mode is required' });
    strategy.setDefaultStrategy(mode);
    res.json({ success: true, data: { default: mode } });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/strategies/:symbol', (req, res) => {
  strategy.clearStrategy(req.params.symbol.toUpperCase());
  res.json({ success: true });
});

// Strategy config export/import (community sharing)
app.get('/api/config/export', (req, res) => {
  const exportData = {
    version: '2.0.0',
    exportedAt: new Date().toISOString(),
    strategies: strategy.getAllStrategies(),
    watchlist: config.WATCHLIST,
    riskParams: {
      riskPct: config.RISK_PCT,
      stopPct: config.STOP_PCT,
      targetPct: config.TARGET_PCT,
      maxPosPct: config.MAX_POS_PCT,
      trailingAtrMult: config.TRAILING_ATR_MULT,
      maxDrawdownPct: config.MAX_DRAWDOWN_PCT,
    },
    assetClasses: getAllAssetClasses(),
  };
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename=strategy-config_${new Date().toISOString().slice(0, 10)}.json`);
  res.json({ success: true, data: exportData });
});

app.post('/api/config/import', (req, res) => {
  try {
    const { strategies: imported } = req.body || {};
    if (!imported) {
      return res.status(400).json({ success: false, error: 'No strategies in import payload' });
    }

    let count = 0;
    if (imported.default) {
      strategy.setDefaultStrategy(imported.default);
      count++;
    }
    if (imported.overrides) {
      for (const [sym, mode] of Object.entries(imported.overrides)) {
        strategy.setStrategy(sym, mode);
        count++;
      }
    }

    res.json({ success: true, data: { imported: count, strategies: strategy.getAllStrategies() } });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Yahoo penny stocks — see what's being discovered
app.get('/api/penny-stocks', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 15;
    const data = await getMostActivePennyStocks(limit);
    res.json({ success: true, data });
  } catch (err) {
    error('API /penny-stocks failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// LLM Chat — ask questions about portfolio, trades, strategy
app.post('/api/chat', async (req, res) => {
  try {
    const { question, sessionId } = req.body || {};
    if (!question) return res.status(400).json({ success: false, error: 'question is required' });
    const sid = sessionId || 'default';
    const result = await chat(question, sid);
    res.json({ success: true, data: result });
  } catch (err) {
    error('API /chat failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// LLM debug log — recent prompts/responses for agent debugging
app.get('/api/agents/debug', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json({ success: true, data: getDebugLog(limit) });
});

// Recent agent errors with messages
app.get('/api/agents/errors', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const result = await db.query(
      `SELECT agent_name, cycle_duration_ms, llm_calls, errors, metadata, created_at
       FROM agent_metrics
       WHERE errors > 0
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    error('API /agents/errors failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ML model status and training
app.get('/api/ml/status', (req, res) => {
  res.json({ success: true, data: mlModel.getStatus() });
});

app.post('/api/ml/train', async (req, res) => {
  try {
    await mlModel.trainModel();
    res.json({ success: true, data: mlModel.getStatus() });
  } catch (err) {
    error('API /ml/train failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reddit social sentiment
app.get('/api/reddit/buzz', async (req, res) => {
  try {
    const symbols = req.query.symbols
      ? req.query.symbols.split(',').map(s => s.trim().toUpperCase())
      : config.WATCHLIST;
    const data = await getRedditBuzz(symbols);
    res.json({ success: true, data });
  } catch (err) {
    error('API /reddit/buzz failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trading mode — check paper vs live
app.get('/api/trading-mode', (req, res) => {
  const baseUrl = process.env.ALPACA_BASE_URL || '';
  const isPaper = baseUrl.includes('paper');
  res.json({
    success: true,
    data: {
      mode: isPaper ? 'paper' : 'live',
      baseUrl: baseUrl.replace(/\/v2$/, ''),
      warning: isPaper ? null : 'LIVE TRADING — real money at risk',
    },
  });
});

// Runtime config — hot-reloadable settings
app.get('/api/runtime-config', async (req, res) => {
  res.json({ success: true, data: { overrides: runtimeConfig.getAll(), effective: runtimeConfig.getEffective() } });
});

app.put('/api/runtime-config/:key', async (req, res) => {
  try {
    const { value } = req.body || {};
    if (value == null) return res.status(400).json({ success: false, error: 'value is required' });
    await runtimeConfig.set(req.params.key, value);
    res.json({ success: true, data: { key: req.params.key, value, effective: runtimeConfig.getEffective() } });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/runtime-config/:key', async (req, res) => {
  try {
    await runtimeConfig.remove(req.params.key);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Watchlist CRUD — add/remove symbols at runtime
app.get('/api/watchlist', async (req, res) => {
  const dynamicWl = runtimeConfig.get('WATCHLIST');
  const watchlist = dynamicWl || config.WATCHLIST;
  res.json({ success: true, data: { symbols: watchlist, source: dynamicWl ? 'runtime' : 'static' } });
});

app.post('/api/watchlist', async (req, res) => {
  try {
    const { symbol } = req.body || {};
    if (!symbol) return res.status(400).json({ success: false, error: 'symbol is required' });
    const sym = symbol.trim().toUpperCase();
    const current = runtimeConfig.get('WATCHLIST') || [...config.WATCHLIST];
    if (current.includes(sym)) return res.json({ success: true, data: { symbols: current, message: 'Already in watchlist' } });
    current.push(sym);
    await runtimeConfig.set('WATCHLIST', current);
    res.json({ success: true, data: { symbols: current, added: sym } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/watchlist/:symbol', async (req, res) => {
  try {
    const sym = req.params.symbol.toUpperCase();
    const current = runtimeConfig.get('WATCHLIST') || [...config.WATCHLIST];
    const filtered = current.filter(s => s !== sym);
    if (filtered.length === current.length) return res.status(404).json({ success: false, error: `${sym} not in watchlist` });
    await runtimeConfig.set('WATCHLIST', filtered);
    res.json({ success: true, data: { symbols: filtered, removed: sym } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Static config — read current settings
app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    data: {
      watchlist: config.WATCHLIST,
      riskPct: config.RISK_PCT,
      stopPct: config.STOP_PCT,
      targetPct: config.TARGET_PCT,
      maxPosPct: config.MAX_POS_PCT,
      trailingAtrMult: config.TRAILING_ATR_MULT,
      maxDrawdownPct: config.MAX_DRAWDOWN_PCT,
      useAgency: config.USE_AGENCY,
      mode: config.USE_AGENCY ? 'agency' : 'legacy',
      strategies: strategy.getAllStrategies(),
      assetClasses: getAllAssetClasses(),
    },
  });
});

// Agent metrics — recent per-cycle telemetry
app.get('/api/metrics', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const agent = req.query.agent;
    let sql = 'SELECT * FROM agent_metrics';
    const params = [];
    if (agent) {
      sql += ' WHERE agent_name = $1';
      params.push(agent);
    }
    sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);
    const result = await db.query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    error('API /metrics failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Agent metrics — aggregate stats (avg latency, total cost, call counts) per agent
app.get('/api/metrics/summary', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const result = await db.query(
      `SELECT
         agent_name,
         COUNT(*) as total_cycles,
         ROUND(AVG(cycle_duration_ms)) as avg_latency_ms,
         MIN(cycle_duration_ms) as min_latency_ms,
         MAX(cycle_duration_ms) as max_latency_ms,
         SUM(llm_calls) as total_llm_calls,
         SUM(llm_input_tokens) as total_input_tokens,
         SUM(llm_output_tokens) as total_output_tokens,
         ROUND(SUM(llm_cost_usd)::numeric, 4) as total_cost_usd,
         SUM(signals_produced) as total_signals,
         SUM(errors) as total_errors
       FROM agent_metrics
       WHERE created_at > now() - interval '1 day' * $1
       GROUP BY agent_name
       ORDER BY total_cost_usd DESC`,
      [days]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    error('API /metrics/summary failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Agent performance leaderboard — decision accuracy + P&L by agent
app.get('/api/metrics/leaderboard', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;

    // Get decisions linked to closed trades to measure accuracy
    const result = await db.query(
      `SELECT
         d.agent_inputs,
         d.action,
         d.confidence,
         d.symbol,
         t.pnl,
         t.pnl_pct,
         t.status as trade_status
       FROM agent_decisions d
       LEFT JOIN trades t ON t.signal_id = d.signal_id
       WHERE d.created_at > now() - interval '1 day' * $1`,
      [days]
    );

    // Build per-agent leaderboard from supporting_agents in decisions
    const agentStats = {};
    for (const row of result.rows) {
      const inputs = row.agent_inputs || {};
      const supporting = inputs.supporting || [];
      const dissenting = inputs.dissenting || [];
      const allAgents = [...new Set([...supporting, ...dissenting])];

      for (const agent of allAgents) {
        if (!agentStats[agent]) {
          agentStats[agent] = { decisions: 0, correct: 0, wrong: 0, totalPnl: 0, avgConfidence: 0, confidenceSum: 0 };
        }
        const stats = agentStats[agent];
        stats.decisions++;

        const agreed = supporting.includes(agent);
        const tradeClosed = row.trade_status === 'closed';
        const profitable = Number(row.pnl || 0) > 0;

        if (tradeClosed) {
          if ((agreed && profitable) || (!agreed && !profitable)) {
            stats.correct++;
          } else {
            stats.wrong++;
          }
          stats.totalPnl += Number(row.pnl || 0);
        }
        stats.confidenceSum += Number(row.confidence || 0);
      }
    }

    // Calculate derived stats
    const leaderboard = Object.entries(agentStats).map(([agent, stats]) => ({
      agent,
      decisions: stats.decisions,
      correct: stats.correct,
      wrong: stats.wrong,
      winRate: stats.correct + stats.wrong > 0
        ? +((stats.correct / (stats.correct + stats.wrong)) * 100).toFixed(1) : null,
      totalPnl: +stats.totalPnl.toFixed(2),
      avgConfidence: stats.decisions > 0
        ? +(stats.confidenceSum / stats.decisions).toFixed(3) : 0,
    })).sort((a, b) => (b.winRate || 0) - (a.winRate || 0));

    res.json({ success: true, data: leaderboard });
  } catch (err) {
    error('API /metrics/leaderboard failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Agent metrics — latency time series for charting
app.get('/api/metrics/latency', async (req, res) => {
  try {
    const hours = parseInt(req.query.hours) || 24;
    const result = await db.query(
      `SELECT agent_name, cycle_duration_ms, llm_cost_usd, created_at
       FROM agent_metrics
       WHERE created_at > now() - interval '1 hour' * $1
       ORDER BY created_at ASC`,
      [hours]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    error('API /metrics/latency failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Client-side routing fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(clientBuildPath, 'index.html'));
});

function start() {
  const http = require('http');
  const { initSocket } = require('./socket');

  const httpServer = http.createServer(app);
  initSocket(httpServer);

  httpServer.listen(config.PORT, () => {
    log(`API server running on port ${config.PORT} (WebSocket enabled)`);
  });
}

module.exports = { start, setLastScanTime, app };
