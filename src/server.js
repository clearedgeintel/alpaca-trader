const path = require('path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const alpaca = require('./alpaca');
const { log, error } = require('./logger');
const riskAgent = require('./agents/risk-agent');
const regimeAgent = require('./agents/regime-agent');
const technicalAgent = require('./agents/technical-agent');
const newsAgent = require('./agents/news-agent');
const screenerAgent = require('./agents/screener-agent');
const orchestrator = require('./agents/orchestrator');
const executionAgent = require('./agents/execution-agent');
const { getUsage } = require('./agents/llm');

const app = express();
let lastScanTime = null;

function setLastScanTime(time) {
  lastScanTime = time;
}

// Middleware
app.use(express.json());

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

// Single trade
app.get('/api/trades/:id', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM trades WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Trade not found' });
    }
    res.json({ success: true, data: result.rows[0] });
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

// Client-side routing fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(clientBuildPath, 'index.html'));
});

function start() {
  app.listen(config.PORT, () => {
    log(`API server running on port ${config.PORT}`);
  });
}

module.exports = { start, setLastScanTime };
