const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const db = require('./db');
const alpaca = require('./alpaca');
const { log, error, runWithContext, newCorrelationId } = require('./logger');
const scanner = require('./scanner');
const apiKeyAuth = require('./middleware/auth');
const { validateBody, schemas } = require('./middleware/validate');
const riskAgent = require('./agents/risk-agent');
const regimeAgent = require('./agents/regime-agent');
const technicalAgent = require('./agents/technical-agent');
const newsAgent = require('./agents/news-agent');
const screenerAgent = require('./agents/screener-agent');
const breakoutAgent = require('./agents/breakout-agent');
const meanReversionAgent = require('./agents/mean-reversion-agent');
const orchestrator = require('./agents/orchestrator');
const executionAgent = require('./agents/execution-agent');
const { getUsage, getDebugLog } = require('./agents/llm');
const runtimeConfig = require('./runtime-config');
const { chat } = require('./chat');
const { getMostActivePennyStocks } = require('./yahoo');
const { runBacktest, runWalkForward, runMonteCarlo } = require('./backtest');
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

// Exposed for monitoring-alerts to check staleness
function _getLastScanTime() {
  return lastScanTime;
}

// Middleware
app.use(express.json());

// Correlation ID per request — every log line in the handler chain
// (and downstream DB/Alpaca/LLM calls) gets tagged with this ID.
app.use((req, res, next) => {
  const requestId = req.headers['x-request-id'] || newCorrelationId('req');
  res.setHeader('x-request-id', requestId);
  runWithContext({ requestId, method: req.method, path: req.path }, next);
});

// Rate limiting — 60 requests per minute per IP
app.use(
  '/api/',
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: 'Too many requests, slow down' },
  }),
);

// Prometheus scrape endpoint — mounted BEFORE /api/ auth so Prom can
// scrape without knowing an API key (scraping convention). No PII: only
// counters + histograms, no trade details or symbols in labels.
app.get('/metrics', async (req, res) => {
  try {
    const metrics = require('./metrics');
    res.set('Content-Type', metrics._contentType());
    res.send(await metrics._metrics());
  } catch (err) {
    res.status(500).send(`# metrics failed: ${err.message}`);
  }
});

// API key authentication (skipped if API_KEY not set in .env)
app.use('/api/', apiKeyAuth);

// Swagger API docs
const { setupSwagger } = require('./swagger');
setupSwagger(app);

// Serve built React frontend
const clientBuildPath = path.join(__dirname, '..', 'trader-ui', 'dist');
app.use(express.static(clientBuildPath));

// Alerts — channel state, history, manual test send, and force-digest
app.get('/api/alerts/channels', (req, res) => {
  const alerting = require('./alerting');
  res.json({ success: true, data: alerting.getChannels() });
});

app.get('/api/alerts/history', (req, res) => {
  const alerting = require('./alerting');
  const limit = parseInt(req.query.limit) || 50;
  res.json({ success: true, data: alerting.getHistory(limit) });
});

app.post('/api/alerts/test', async (req, res) => {
  try {
    const alerting = require('./alerting');
    const channelName = req.body?.channel || null;
    const result = await alerting.testSend(channelName);
    res.json({ success: true, data: result });
  } catch (err) {
    error('API /alerts/test failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/alerts/digest', async (req, res) => {
  try {
    const { sendDigest } = require('./daily-digest');
    await sendDigest();
    res.json({ success: true });
  } catch (err) {
    error('API /alerts/digest failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reconciliation — compare Alpaca positions/orders vs DB trades and
// (optionally) resolve orphans. Safe to call manually or from a cron.
// Pass ?dryRun=true to get the diff without writing.
app.get('/api/reconcile', async (req, res) => {
  try {
    const { runReconciliation } = require('./reconciler');
    const dryRun = req.query.dryRun === 'true';
    const result = await runReconciliation({ dryRun });
    res.json({ success: true, data: result });
  } catch (err) {
    error('API /reconcile failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Deep health check — used by uptime monitors + container liveness probes.
// Returns 200 when everything healthy; 503 when any critical check fails.
// Lightweight enough to call every few seconds.
app.get('/api/health', async (req, res) => {
  const start = Date.now();
  const checks = {
    db: { ok: false, latencyMs: null, error: null },
    alpaca: { ok: false, latencyMs: null, error: null },
    llm: { ok: false, available: null, unavailableReason: null, costUsd: null, tokensUsed: null },
    lastScan: { ageSeconds: null, stale: null },
    agents: { heartbeats: {}, anyStalled: false },
    envFile: { ageDays: null, stale: null },
  };

  // .env staleness — mtime-based rotation reminder. See docs/SECRETS.md.
  try {
    const fs = require('fs');
    const path = require('path');
    const envPath = path.join(__dirname, '..', '.env');
    const stat = fs.statSync(envPath);
    const ageMs = Date.now() - stat.mtime.getTime();
    const ageDays = Math.floor(ageMs / 86400000);
    checks.envFile.ageDays = ageDays;
    checks.envFile.stale = ageDays > 90;
  } catch {
    // .env missing is fine — env vars may come from the deploy platform
  }

  // DB ping
  try {
    const t0 = Date.now();
    await db.query('SELECT 1');
    checks.db.ok = true;
    checks.db.latencyMs = Date.now() - t0;
  } catch (err) {
    checks.db.error = err.message;
  }

  // Alpaca ping (getAccount is cheapest paper-safe call)
  try {
    const t0 = Date.now();
    await alpaca.getAccount();
    checks.alpaca.ok = true;
    checks.alpaca.latencyMs = Date.now() - t0;
  } catch (err) {
    checks.alpaca.error = err.message;
  }

  // LLM budget + availability
  try {
    const usage = getUsage();
    checks.llm.available = usage.available !== false;
    checks.llm.unavailableReason = usage.unavailableReason || null;
    checks.llm.costUsd = +(usage.estimatedCostUsd || 0).toFixed(4);
    checks.llm.tokensUsed = (usage.totalInputTokens || 0) + (usage.totalOutputTokens || 0);
    checks.llm.ok = true;
  } catch (err) {
    checks.llm.error = err.message;
  }

  // Last scan age
  if (lastScanTime) {
    const age = Math.floor((Date.now() - new Date(lastScanTime).getTime()) / 1000);
    checks.lastScan.ageSeconds = age;
    // Stale if > 3x the scan interval AND market is open
    const intervalSec = Math.floor(config.SCAN_INTERVAL_MS / 1000);
    checks.lastScan.stale = age > intervalSec * 3;
  }

  // Agent heartbeats — stale if no cycle in the last 30 min (6x normal interval)
  const agents = [
    screenerAgent,
    riskAgent,
    regimeAgent,
    technicalAgent,
    newsAgent,
    breakoutAgent,
    meanReversionAgent,
    orchestrator,
    executionAgent,
  ];
  for (const agent of agents) {
    try {
      const status = agent.getStatus();
      const lastRunAgeSec = status.lastRunAt
        ? Math.floor((Date.now() - new Date(status.lastRunAt).getTime()) / 1000)
        : null;
      const stalled = status.enabled && lastRunAgeSec != null && lastRunAgeSec > 30 * 60;
      checks.agents.heartbeats[status.name] = {
        enabled: status.enabled,
        running: status.running,
        runCount: status.runCount,
        lastRunAgeSec,
        stalled,
        lastError: status.lastError || null,
      };
      if (stalled) checks.agents.anyStalled = true;
    } catch {}
  }

  // Overall health — DB and Alpaca are critical; LLM + scan-staleness are degraded
  const critical = checks.db.ok && checks.alpaca.ok;
  const degraded = !checks.llm.available || checks.lastScan.stale || checks.agents.anyStalled;
  const statusLabel = !critical ? 'unhealthy' : degraded ? 'degraded' : 'healthy';
  const httpStatus = !critical ? 503 : 200;

  res.status(httpStatus).json({
    success: critical,
    status: statusLabel,
    checkDurationMs: Date.now() - start,
    uptimeSeconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
    checks,
  });
});

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
    const results = watchlist.map((sym) => {
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
        signalsFound: results.filter((r) => r.signal && r.signal !== 'HOLD').length,
        scanned: results.filter((r) => r.status === 'scanned').length,
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

// Symbol universe — show all sources currently being monitored
app.get('/api/market/universe', async (req, res) => {
  try {
    const screenerAgent = require('./agents/screener-agent');
    const runtimeConfig = require('./runtime-config');
    const userWatchlist = runtimeConfig.get('WATCHLIST') || config.WATCHLIST;

    const report = screenerAgent.getReport?.() || null;
    const data = report?.data || {};
    const breakdown = data.sourceBreakdown || {};
    const candidates = screenerAgent.getCandidates?.() || [];
    const dynamicWl = screenerAgent.getWatchlist?.() || [];
    const discoveryPool = screenerAgent.DISCOVERY_POOL || [];

    res.json({
      success: true,
      data: {
        userWatchlist,
        dynamicWatchlist: dynamicWl,
        candidates: candidates.slice(0, 100),
        discoveryPool,
        marketTheme: data.marketTheme || null,
        lastUpdate: report?.timestamp || null,
        sources: {
          userWatchlist: {
            count: userWatchlist.length,
            description: 'Your tracked symbols (config + runtime overrides)',
          },
          alpacaMostActive: { count: breakdown.mostActive || 0, description: 'Alpaca most-active by volume' },
          alpacaGainers: { count: breakdown.gainers || 0, description: 'Alpaca top gainers today' },
          alpacaLosers: { count: breakdown.losers || 0, description: 'Alpaca top losers today (bounce candidates)' },
          pennyStocks: {
            count: breakdown.pennyStocks || 0,
            description: 'Active penny stocks (<$5) from curated list',
          },
          discoveryPool: {
            count: discoveryPool.length,
            description: 'Hardcoded fallback pool (mega/mid caps + ETFs) — supplements when screener APIs are thin',
          },
        },
      },
    });
  } catch (err) {
    error('API /market/universe failed', err);
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
    const [snapshot, dailyBars] = await Promise.all([alpaca.getSnapshot(symbol), alpaca.getDailyBars(symbol, 30)]);

    // Compute basic indicators from daily bars
    const closes = dailyBars.map((b) => b.c);
    let rsi = null,
      ema9 = null,
      ema21 = null,
      avgVolume = null;

    if (closes.length >= 14) {
      const { calcRsi, emaArray } = require('./indicators');
      rsi = calcRsi(closes, 14);
      if (closes.length >= 9) ema9 = emaArray(closes, 9).pop();
      if (closes.length >= 21) ema21 = emaArray(closes, 21).pop();
    }

    const volumes = dailyBars.map((b) => b.v);
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
    const snapshots = await alpaca.getMultiSnapshots(symbols.filter((s) => s !== 'VIX'));
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

// Symbol search — backs the autocomplete in MarketView's order panel.
// Loads the full Alpaca asset list (equity + crypto) on first call and
// caches for 6h; filters locally by prefix (preferred) then substring.
const ASSET_CACHE = { equity: null, crypto: null, loadedAt: 0 };
const ASSET_TTL_MS = 6 * 60 * 60 * 1000;
async function loadAssetsCached() {
  if (ASSET_CACHE.equity && Date.now() - ASSET_CACHE.loadedAt < ASSET_TTL_MS) return;
  const [equity, crypto] = await Promise.all([
    alpaca.getAssets('active', 'us_equity').catch(() => []),
    alpaca.getAssets('active', 'crypto').catch(() => []),
  ]);
  ASSET_CACHE.equity = (equity || []).filter((a) => a.tradable);
  ASSET_CACHE.crypto = (crypto || []).filter((a) => a.tradable);
  ASSET_CACHE.loadedAt = Date.now();
}
app.get('/api/market/search', async (req, res) => {
  try {
    const q = String(req.query.q || '')
      .trim()
      .toUpperCase();
    if (q.length < 1) return res.json({ success: true, data: [] });
    await loadAssetsCached();
    const all = [...(ASSET_CACHE.equity || []), ...(ASSET_CACHE.crypto || [])];
    const prefix = [];
    const contains = [];
    for (const a of all) {
      const sym = (a.symbol || '').toUpperCase();
      const name = (a.name || '').toUpperCase();
      if (sym === q) prefix.unshift(a);
      else if (sym.startsWith(q)) prefix.push(a);
      else if (sym.includes(q) || name.includes(q)) contains.push(a);
    }
    const results = [...prefix, ...contains].slice(0, 15).map((a) => ({
      symbol: a.symbol,
      name: a.name,
      class: a.class,
      exchange: a.exchange,
      fractionable: a.fractionable,
    }));
    res.json({ success: true, data: results });
  } catch (err) {
    error('API /market/search failed', err);
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
// Manual trade — user-initiated buy/sell from the Market view.
// Routes through Smart Order Router when SOR is enabled (or the
// caller explicitly requests it) for better fills; otherwise plain
// market order. Persists the trade + a synthetic signal so it shows
// up in dashboards and gets the same tracking as agent trades.
app.post('/api/trades/manual', validateBody(schemas.manualTrade), async (req, res) => {
  try {
    const { symbol: rawSymbol, qty: rawQty, side, useSor } = req.body;
    const symbol = rawSymbol.toUpperCase();
    const qty = typeof rawQty === 'string' ? parseFloat(rawQty) : rawQty;

    // Fetch snapshot for pricing context + SOR midpoint
    const snapshot = await alpaca.getSnapshot(symbol).catch(() => null);
    const entryPrice = snapshot?.latestTrade?.p || snapshot?.minuteBar?.c || snapshot?.dailyBar?.c || null;

    if (side === 'buy') {
      // Check for existing open position
      const existing = await db.query('SELECT id FROM trades WHERE symbol = $1 AND status = $2', [symbol, 'open']);
      if (existing.rows.length > 0) {
        return res.status(400).json({ success: false, error: `Position already open for ${symbol}` });
      }
    }

    // Route via SOR if requested; otherwise plain market order
    let order;
    let sorMeta = null;
    if (useSor) {
      const sor = require('./smart-order-router');
      const sorRes = await sor.placeSmartOrder({ symbol, qty, side, snapshot });
      order = sorRes.order;
      sorMeta = { strategy: sorRes.strategy, savingsBps: sorRes.savingsBps, limitPrice: sorRes.limitPrice };
      try {
        require('./metrics').smartOrdersTotal.inc({ strategy: sorRes.strategy });
        if (sorRes.strategy === 'limit' && Number.isFinite(sorRes.savingsBps)) {
          require('./metrics').smartOrderSavingsBps.observe(sorRes.savingsBps);
        }
      } catch {}
    } else {
      order = await alpaca.placeOrder(symbol, qty, side);
    }

    if (side === 'buy') {
      const orderValue = entryPrice ? qty * entryPrice : null;
      try {
        await db.withTransaction(async (client) => {
          const { rows } = await client.query(
            `INSERT INTO signals (symbol, signal, reason, close, acted_on)
             VALUES ($1, 'BUY', 'Manual buy from Market view', $2, true)
             RETURNING id`,
            [symbol, entryPrice],
          );
          const signalId = rows[0]?.id || null;
          await client.query(
            `INSERT INTO trades (symbol, alpaca_order_id, side, qty, entry_price, current_price,
                                  order_value, status, signal_id, strategy_pool, original_qty)
             VALUES ($1, $2, 'buy', $3, $4, $4, $5, 'open', $6, 'manual', $3)`,
            [symbol, order.id, qty, entryPrice, orderValue, signalId],
          );
        });
        try {
          require('./metrics').tradesOpenedTotal.inc();
        } catch {}
      } catch (dbErr) {
        error(`Manual BUY succeeded on Alpaca (order=${order.id}) but DB write failed`, dbErr);
      }
      return res.json({
        success: true,
        data: { order, symbol, qty, side, entryPrice, sor: sorMeta, strategyPool: 'manual' },
      });
    }

    // SELL — update any matching open trade
    try {
      const { rows } = await db.query(
        `UPDATE trades
            SET status = 'closed', exit_price = $1, closed_at = NOW(),
                exit_reason = 'manual_close', current_price = $1
          WHERE symbol = $2 AND status = 'open'
          RETURNING id, pnl`,
        [entryPrice, symbol],
      );
      try {
        require('./metrics').tradesClosedTotal.inc({ reason: 'manual_close' });
      } catch {}
      return res.json({
        success: true,
        data: { order, symbol, qty, side, exitPrice: entryPrice, closedTrades: rows.length, sor: sorMeta },
      });
    } catch (dbErr) {
      error(`Manual SELL order ${order.id} succeeded but DB update failed`, dbErr);
      return res.json({ success: true, data: { order, warning: 'DB update failed; reconciler will fix' } });
    }
  } catch (err) {
    error('Manual trade failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/trades', async (req, res) => {
  try {
    const { status } = req.query;
    let result;
    if (status) {
      result = await db.query('SELECT * FROM trades WHERE status = $1 ORDER BY created_at DESC', [status]);
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
         AND is_shadow = false
         AND created_at >= $2::timestamp - INTERVAL '10 minutes'
         AND created_at <= $3::timestamp + INTERVAL '10 minutes'
       ORDER BY created_at ASC`,
      [trade.symbol, openedAt, closedAt],
    );

    // All signals for this symbol in the trade window (entry BUY + any SELL)
    const signalsRes = await db.query(
      `SELECT id, symbol, signal, reason, close, acted_on, created_at
       FROM signals
       WHERE symbol = $1
         AND created_at >= $2::timestamp - INTERVAL '10 minutes'
         AND created_at <= $3::timestamp + INTERVAL '10 minutes'
       ORDER BY created_at ASC`,
      [trade.symbol, openedAt, closedAt],
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
    const result = await db.query('SELECT * FROM signals ORDER BY created_at DESC LIMIT $1', [limit]);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    error('API /signals failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Daily performance
app.get('/api/performance', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM daily_performance ORDER BY trade_date DESC');
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
    breakoutAgent.getStatus(),
    meanReversionAgent.getStatus(),
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

// Unified agent message feed — reports + decisions + debate rounds
// merged chronologically so the UI can render a Teams-style conversation.
app.get('/api/agents/messages', async (req, res) => {
  try {
    const limit = Math.max(10, Math.min(500, parseInt(req.query.limit) || 100));
    const agentFilter = req.query.agent;
    const symbolFilter = req.query.symbol;

    // Reports (raw per-agent analysis per cycle)
    const reportsQuery = agentFilter
      ? `SELECT id, agent_name, symbol, signal, confidence, reasoning, data, created_at
           FROM agent_reports WHERE agent_name = $1 ORDER BY created_at DESC LIMIT $2`
      : `SELECT id, agent_name, symbol, signal, confidence, reasoning, data, created_at
           FROM agent_reports ORDER BY created_at DESC LIMIT $1`;
    const reportsParams = agentFilter ? [agentFilter, limit] : [limit];
    const reportsRes = await db.query(reportsQuery, reportsParams);

    // Decisions (orchestrator synthesis) — exclude shadow rows
    const decisionsRes = await db.query(
      `SELECT id, symbol, action, confidence, reasoning, agent_inputs, created_at
         FROM agent_decisions
        WHERE is_shadow = false
          ${symbolFilter ? 'AND symbol = $2' : ''}
        ORDER BY created_at DESC LIMIT $1`,
      symbolFilter ? [limit, symbolFilter] : [limit],
    );

    // Flatten into a message list
    const messages = [];

    for (const r of reportsRes.rows) {
      if (symbolFilter && r.symbol && r.symbol !== symbolFilter) continue;
      messages.push({
        id: `report-${r.id}`,
        type: 'report',
        agent: r.agent_name,
        symbol: r.symbol,
        signal: r.signal,
        confidence: r.confidence != null ? Number(r.confidence) : null,
        reasoning: r.reasoning,
        data: r.data,
        at: r.created_at,
      });
    }

    for (const d of decisionsRes.rows) {
      const inputs = typeof d.agent_inputs === 'string' ? safeJsonParse(d.agent_inputs) : d.agent_inputs;
      // Main decision message
      messages.push({
        id: `decision-${d.id}`,
        type: 'decision',
        agent: 'orchestrator',
        symbol: d.symbol,
        signal: d.action,
        confidence: Number(d.confidence),
        reasoning: d.reasoning,
        supporting: inputs?.supporting || [],
        dissenting: inputs?.dissenting || [],
        at: d.created_at,
      });

      // Expand debate rounds as their own messages (thread parent = decision id)
      if (inputs?.debate?.debateRounds?.length) {
        for (let i = 0; i < inputs.debate.debateRounds.length; i++) {
          const round = inputs.debate.debateRounds[i];
          if (agentFilter && round.dissenter !== agentFilter && round.responder !== agentFilter) continue;
          if (round.challenge) {
            messages.push({
              id: `debate-${d.id}-${i}-challenge`,
              type: 'debate_challenge',
              agent: round.dissenter,
              symbol: d.symbol,
              signal: round.dissenterSignal,
              reasoning: round.challenge,
              threadId: `decision-${d.id}`,
              roundIndex: i,
              at: d.created_at,
            });
          }
          if (round.response) {
            messages.push({
              id: `debate-${d.id}-${i}-response`,
              type: 'debate_response',
              agent: round.responder,
              symbol: d.symbol,
              signal: round.responderSignal,
              reasoning: round.response,
              threadId: `decision-${d.id}`,
              roundIndex: i,
              at: d.created_at,
            });
          }
        }
      }
    }

    // Sort by created_at descending, cap to limit
    messages.sort((a, b) => new Date(b.at) - new Date(a.at));
    const trimmed = messages.slice(0, limit);

    res.json({ success: true, data: { messages: trimmed, total: trimmed.length } });
  } catch (err) {
    error('API /agents/messages failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// Orchestrator — latest decisions
app.get('/api/decisions', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const result = await db.query(
      'SELECT * FROM agent_decisions WHERE is_shadow = false ORDER BY created_at DESC LIMIT $1',
      [limit],
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
       WHERE d.is_shadow = false
       ORDER BY d.created_at DESC LIMIT $1`,
      [limit],
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
      [req.params.name, limit],
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    error('API /agents/:name/reports failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Backtest — run historical simulation
app.post('/api/backtest', validateBody(schemas.backtest), async (req, res) => {
  try {
    const result = await runBacktest(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    error('API /backtest failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Replay — runs the production strategy through historical bars in a sandbox
// (synthetic account + positions, never touches Alpaca or the production
// trades table). Returns full trades + signals + decisions + equity curve so
// the UI can render the same dashboards it shows for live trading.
app.post('/api/replay', validateBody(schemas.replay), async (req, res) => {
  try {
    const { runReplay } = require('./replay/replay-engine');
    const result = await runReplay(req.body);
    res.json({
      success: true,
      data: {
        summary: result.summary,
        trades: result.sandbox.trades,
        signals: result.sandbox.signals.slice(-200), // cap large logs for transport
        decisions: result.sandbox.decisions.slice(-200),
        equityCurve: result.sandbox.equityCurve,
      },
    });
  } catch (err) {
    error('API /replay failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Walk-forward — rolling out-of-sample windows over the historical period.
// Returns per-window results plus an aggregate robustness score so you can
// tell whether the strategy works in general or just on one lucky period.
app.post('/api/backtest/walk-forward', validateBody(schemas.walkForward), async (req, res) => {
  try {
    const result = await runWalkForward(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    error('API /backtest/walk-forward failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Monte Carlo — run the backtest N times with randomized slippage to produce
// a distribution of outcomes. Use to answer "what's the 5th-percentile
// outcome if fills go against us?" rather than a single point estimate.
app.post('/api/backtest/monte-carlo', validateBody(schemas.monteCarlo), async (req, res) => {
  try {
    const result = await runMonteCarlo(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    error('API /backtest/monte-carlo failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Performance attribution — breaks down closed-trade P&L by dimension so
// you can answer "where is my edge actually coming from?".
//   by regime           — P&L under each market regime that was active when the trade opened
//   byExitReason        — realized P&L per stop_loss / take_profit / trailing_stop / orchestrator_sell / ...
//   byDayOfWeek         — which weekdays make/lose money
//   byHoldDuration      — short-hold vs medium vs long positions
//   bySector            — which sectors contribute positive PnL
//
// Uses only `trades` + `agent_decisions` joins on `signal_id` so it stays
// cheap. Returns arrays pre-sorted by total PnL desc for easy rendering.
// Multi-strategy attribution — per-pool performance over a lookback window
app.get('/api/analytics/by-strategy', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.query.days) || 30));
    const { rows } = await db.query(
      `SELECT
         COALESCE(strategy_pool, 'unknown') AS pool,
         COUNT(*)::int                                          AS total_trades,
         COUNT(*) FILTER (WHERE status = 'closed')::int         AS closed_trades,
         COUNT(*) FILTER (WHERE status = 'open')::int           AS open_trades,
         COUNT(*) FILTER (WHERE status = 'closed' AND pnl > 0)::int AS wins,
         COUNT(*) FILTER (WHERE status = 'closed' AND pnl < 0)::int AS losses,
         COALESCE(SUM(pnl) FILTER (WHERE status = 'closed')::float, 0) AS total_pnl,
         COALESCE(AVG(pnl) FILTER (WHERE status = 'closed')::float, 0) AS avg_pnl,
         COALESCE(AVG(pnl) FILTER (WHERE status = 'closed' AND pnl > 0)::float, 0) AS avg_win,
         COALESCE(AVG(pnl) FILTER (WHERE status = 'closed' AND pnl < 0)::float, 0) AS avg_loss
       FROM trades
       WHERE created_at >= NOW() - ($1 || ' days')::interval
       GROUP BY pool
       ORDER BY total_pnl DESC`,
      [String(days)],
    );
    const summary = rows.map((r) => ({
      ...r,
      win_rate: r.closed_trades > 0 ? r.wins / r.closed_trades : null,
    }));
    res.json({ success: true, data: { days, pools: summary } });
  } catch (err) {
    error('API /analytics/by-strategy failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/analytics/attribution', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 90;

    // Static sector map — duplicate of risk-agent's SECTOR_MAP for now;
    // collapse when sector data moves to its own table.
    const SECTOR = {
      AAPL: 'Technology',
      MSFT: 'Technology',
      GOOGL: 'Technology',
      META: 'Technology',
      NVDA: 'Semiconductors',
      AMD: 'Semiconductors',
      INTC: 'Semiconductors',
      MU: 'Semiconductors',
      TSLA: 'Automotive',
      AMZN: 'Consumer',
      WMT: 'Consumer',
      COST: 'Consumer',
      JPM: 'Financials',
      GS: 'Financials',
      BAC: 'Financials',
      XOM: 'Energy',
      CVX: 'Energy',
      UNH: 'Healthcare',
      JNJ: 'Healthcare',
      LLY: 'Healthcare',
      SPY: 'ETF',
      QQQ: 'ETF',
      IWM: 'ETF',
      SOXL: 'ETF',
      SOXS: 'ETF',
      TQQQ: 'ETF',
    };

    // Pull closed trades + optionally the orchestrator decision that drove them
    const closed = await db.query(
      `SELECT t.id, t.symbol, t.side, t.qty, t.entry_price, t.exit_price, t.pnl,
              t.exit_reason, t.created_at, t.closed_at, t.signal_id,
              d.reasoning AS decision_reasoning
         FROM trades t
         LEFT JOIN agent_decisions d ON d.signal_id = t.signal_id
        WHERE t.status = 'closed'
          AND t.closed_at >= NOW() - ($1::int || ' days')::interval
        ORDER BY t.closed_at ASC`,
      [days],
    );

    const trades = closed.rows;

    // --- Regime attribution ---
    // Pull the regime that was active when each trade opened by joining to
    // the most recent regime-agent report persisted before the trade's open.
    const regimeRows = await db.query(
      `SELECT reasoning, data, created_at
         FROM agent_reports
        WHERE agent_name = 'market-regime'
          AND created_at >= NOW() - ($1::int || ' days')::interval - INTERVAL '1 day'
        ORDER BY created_at ASC`,
      [days],
    );
    const regimeTimeline = regimeRows.rows.map((r) => ({
      ts: r.created_at,
      regime: r.data?.regime || r.data?.params?.regime || 'unknown',
    }));
    const regimeAt = (ts) => {
      // Binary search would be nicer for large timelines; linear is fine here
      let active = 'unknown';
      for (const r of regimeTimeline) {
        if (r.ts <= ts) active = r.regime;
        else break;
      }
      return active;
    };

    // --- Aggregate by dimension ---
    const by = (keyFn) => {
      const map = new Map();
      for (const t of trades) {
        const k = keyFn(t) || 'unknown';
        const prev = map.get(k) || { key: k, count: 0, wins: 0, losses: 0, pnl: 0 };
        prev.count++;
        prev.pnl += Number(t.pnl || 0);
        if (Number(t.pnl) > 0) prev.wins++;
        else prev.losses++;
        map.set(k, prev);
      }
      return Array.from(map.values())
        .map((r) => ({
          ...r,
          pnl: +r.pnl.toFixed(2),
          winRate: r.count ? +((r.wins / r.count) * 100).toFixed(1) : 0,
          avgPnl: r.count ? +(r.pnl / r.count).toFixed(2) : 0,
        }))
        .sort((a, b) => b.pnl - a.pnl);
    };

    const holdBucket = (t) => {
      if (!t.closed_at || !t.created_at) return 'unknown';
      const days = (new Date(t.closed_at) - new Date(t.created_at)) / 86400000;
      if (days < 0.5) return 'intraday';
      if (days < 2) return 'swing_1-2d';
      if (days < 7) return 'swing_3-7d';
      return 'position_7d+';
    };

    const attribution = {
      windowDays: days,
      totalTrades: trades.length,
      totalPnl: +trades.reduce((s, t) => s + Number(t.pnl || 0), 0).toFixed(2),
      byRegime: by((t) => regimeAt(t.created_at)),
      byExitReason: by((t) => t.exit_reason),
      byDayOfWeek: by((t) => {
        if (!t.created_at) return 'unknown';
        return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(t.created_at).getUTCDay()];
      }),
      byHoldDuration: by(holdBucket),
      bySector: by((t) => SECTOR[t.symbol] || 'Other'),
      bySymbol: by((t) => t.symbol).slice(0, 20),
    };

    res.json({ success: true, data: attribution });
  } catch (err) {
    error('API /analytics/attribution failed', err);
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
    const equityCurve = perf.map((p) => {
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
    const closedTrades = trades.map((t) => ({
      pnl: Number(t.pnl || 0),
      pnlPct: Number(t.pnl_pct || 0),
      date: t.closed_at,
      symbol: t.symbol,
      exitReason: t.exit_reason,
    }));

    const wins = closedTrades.filter((t) => t.pnl > 0);
    const losses = closedTrades.filter((t) => t.pnl <= 0);
    const totalPnl = closedTrades.reduce((s, t) => s + t.pnl, 0);
    const winRate = closedTrades.length > 0 ? (wins.length / closedTrades.length) * 100 : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
    const profitFactor = Math.abs(avgLoss) > 0 ? avgWin / Math.abs(avgLoss) : 0;

    // Max drawdown
    const maxDrawdown = equityCurve.reduce((max, p) => Math.max(max, p.drawdown), 0);

    // Sharpe ratio from daily P&L
    const dailyReturns = equityCurve
      .filter((p) => p.equity > 0)
      .map((p, i, arr) => (i === 0 ? 0 : (p.equity - arr[i - 1].equity) / arr[i - 1].equity));
    const meanReturn = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
    const stdReturn =
      dailyReturns.length > 1
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

    const headers = [
      'date',
      'symbol',
      'side',
      'qty',
      'entry_price',
      'exit_price',
      'stop_loss',
      'take_profit',
      'pnl',
      'pnl_pct',
      'exit_reason',
      'status',
      'order_type',
      'order_value',
      'risk_dollars',
    ];
    const rows = trades.map((t) =>
      [
        t.created_at,
        t.symbol,
        t.side,
        t.qty,
        t.entry_price,
        t.exit_price || '',
        t.stop_loss,
        t.take_profit,
        t.pnl || '',
        t.pnl_pct || '',
        t.exit_reason || '',
        t.status,
        t.order_type || 'market',
        t.order_value,
        t.risk_dollars,
      ].join(','),
    );

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

    const headers = [
      'date_acquired',
      'date_sold',
      'symbol',
      'qty',
      'cost_basis',
      'proceeds',
      'gain_loss',
      'hold_period',
      'wash_sale',
    ];
    const rows = trades.map((t) => {
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
    const symbols = result.rows.map((r) => r.symbol);
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

app.put('/api/strategies/:symbol', validateBody(schemas.strategyForSymbol), async (req, res) => {
  try {
    const { mode } = req.body;
    await strategy.setStrategy(req.params.symbol.toUpperCase(), mode);
    res.json({ success: true, data: { symbol: req.params.symbol.toUpperCase(), mode } });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.put('/api/strategies', validateBody(schemas.defaultStrategy), async (req, res) => {
  try {
    const { default: mode } = req.body;
    await strategy.setDefaultStrategy(mode);
    res.json({ success: true, data: { default: mode } });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/strategies/:symbol', async (req, res) => {
  await strategy.clearStrategy(req.params.symbol.toUpperCase());
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
  res.setHeader(
    'Content-Disposition',
    `attachment; filename=strategy-config_${new Date().toISOString().slice(0, 10)}.json`,
  );
  res.json({ success: true, data: exportData });
});

app.post('/api/config/import', validateBody(schemas.configImport), async (req, res) => {
  try {
    const { strategies: imported } = req.body;
    if (!imported) {
      return res.status(400).json({ success: false, error: 'No strategies in import payload' });
    }

    let count = 0;
    if (imported.default) {
      await strategy.setDefaultStrategy(imported.default);
      count++;
    }
    if (imported.overrides) {
      for (const [sym, mode] of Object.entries(imported.overrides)) {
        await strategy.setStrategy(sym, mode);
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
app.post('/api/chat', validateBody(schemas.chat), async (req, res) => {
  try {
    const { question, sessionId } = req.body;
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

// Prompt versioning — list versions, show active, activate a version.
// Useful for runtime rollback without a code deploy.
app.get('/api/prompts', async (req, res) => {
  try {
    const promptRegistry = require('./agents/prompt-registry');
    const rows = await promptRegistry.list(req.query.agent);
    res.json({ success: true, data: rows });
  } catch (err) {
    error('API /prompts failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post(
  '/api/prompts/:agent/activate',
  validateBody(
    require('zod').z.object({
      version: require('zod').z.string().min(1),
      prompt: require('zod').z.string().min(32).optional(),
      notes: require('zod').z.string().optional(),
    }),
  ),
  async (req, res) => {
    try {
      const promptRegistry = require('./agents/prompt-registry');
      const { version, prompt, notes } = req.body;
      if (prompt) {
        await promptRegistry.activate(req.params.agent, version, prompt, notes);
      } else {
        // No prompt body: assume version exists and just switch active
        const existing = await promptRegistry.list(req.params.agent);
        const row = existing.find((r) => r.version === version);
        if (!row) return res.status(404).json({ success: false, error: `version not found` });
        // Reactivate by reading the existing row back
        const full = await db.query(`SELECT prompt FROM prompt_versions WHERE id = $1`, [row.id]);
        await promptRegistry.activate(req.params.agent, version, full.rows[0].prompt, row.notes);
      }
      res.json({ success: true, data: { agent: req.params.agent, activeVersion: version } });
    } catch (err) {
      error(`API /prompts/${req.params.agent}/activate failed`, err);
      res.status(500).json({ success: false, error: err.message });
    }
  },
);

// Prompt A/B shadow mode — designate a candidate version as the shadow
// for this agent. The orchestrator will run it in parallel with the
// active version on every cycle (doubles LLM cost while active) but
// never acts on its output. See /api/prompts/:agent/shadow-comparison.
app.post(
  '/api/prompts/:agent/set-shadow',
  validateBody(require('zod').z.object({ version: require('zod').z.string().min(1) })),
  async (req, res) => {
    try {
      const promptRegistry = require('./agents/prompt-registry');
      const existing = await promptRegistry.list(req.params.agent);
      const row = existing.find((r) => r.version === req.body.version);
      if (!row) return res.status(404).json({ success: false, error: 'version not found' });
      if (row.is_active) {
        return res.status(400).json({ success: false, error: 'cannot shadow the currently active version' });
      }
      await promptRegistry.setShadow(req.params.agent, req.body.version);
      res.json({ success: true, data: { agent: req.params.agent, shadowVersion: req.body.version } });
    } catch (err) {
      error(`API /prompts/${req.params.agent}/set-shadow failed`, err);
      res.status(500).json({ success: false, error: err.message });
    }
  },
);

app.post('/api/prompts/:agent/clear-shadow', async (req, res) => {
  try {
    const promptRegistry = require('./agents/prompt-registry');
    await promptRegistry.clearShadow(req.params.agent);
    res.json({ success: true, data: { agent: req.params.agent } });
  } catch (err) {
    error(`API /prompts/${req.params.agent}/clear-shadow failed`, err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Shadow comparison — agreement rate + confidence delta between live
// and shadow prompt decisions. Joins paired rows via shadow_of.
app.get('/api/prompts/:agent/shadow-comparison', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(180, parseInt(req.query.days) || 7));
    const agent = req.params.agent;
    // All shadow rows in the window; LEFT JOIN to the live row via shadow_of
    const { rows } = await db.query(
      `SELECT
         s.id            AS shadow_id,
         s.symbol        AS symbol,
         s.action        AS shadow_action,
         s.confidence    AS shadow_confidence,
         s.created_at    AS shadow_created_at,
         sv.version      AS shadow_version,
         l.id            AS live_id,
         l.action        AS live_action,
         l.confidence    AS live_confidence,
         lv.version      AS live_version
       FROM agent_decisions s
       JOIN prompt_versions sv ON sv.id = s.prompt_version_id
       LEFT JOIN agent_decisions l ON l.id = s.shadow_of
       LEFT JOIN prompt_versions lv ON lv.id = l.prompt_version_id
       WHERE s.is_shadow = true
         AND sv.agent_name = $1
         AND s.created_at >= NOW() - ($2 || ' days')::interval
       ORDER BY s.created_at DESC`,
      [agent, String(days)],
    );

    const paired = rows.filter((r) => r.live_id);
    const total = paired.length;
    const agreements = paired.filter((r) => r.live_action === r.shadow_action).length;
    const avgLiveConfidence = total > 0 ? paired.reduce((a, r) => a + Number(r.live_confidence || 0), 0) / total : 0;
    const avgShadowConfidence =
      total > 0 ? paired.reduce((a, r) => a + Number(r.shadow_confidence || 0), 0) / total : 0;

    res.json({
      success: true,
      data: {
        agent,
        days,
        totalShadowDecisions: rows.length,
        pairedDecisions: total,
        shadowOnlyDecisions: rows.length - total,
        agreements,
        agreementRate: total > 0 ? agreements / total : null,
        avgLiveConfidence,
        avgShadowConfidence,
        confidenceDelta: avgShadowConfidence - avgLiveConfidence,
        pairs: rows.slice(0, 50),
      },
    });
  } catch (err) {
    error(`API /prompts/${req.params.agent}/shadow-comparison failed`, err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Prompt A/B performance — per-version decision stats and closed-trade win rate
app.get('/api/prompts/:agent/performance', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(180, parseInt(req.query.days) || 30));
    const agent = req.params.agent;
    const { rows } = await db.query(
      `SELECT
         v.id                AS version_id,
         v.version           AS version,
         v.is_active         AS is_active,
         v.notes             AS notes,
         v.created_at        AS version_created_at,
         COUNT(d.id)::int    AS total_decisions,
         COUNT(*) FILTER (WHERE d.action = 'BUY')::int  AS buys,
         COUNT(*) FILTER (WHERE d.action = 'SELL')::int AS sells,
         COUNT(*) FILTER (WHERE d.action = 'HOLD')::int AS holds,
         COALESCE(AVG(d.confidence)::float, 0)         AS avg_confidence,
         COUNT(t.id) FILTER (WHERE t.status = 'closed')::int AS closed_trades,
         COUNT(t.id) FILTER (WHERE t.status = 'closed' AND t.pnl > 0)::int AS wins,
         COALESCE(SUM(t.pnl) FILTER (WHERE t.status = 'closed')::float, 0) AS total_pnl,
         COALESCE(AVG(t.pnl) FILTER (WHERE t.status = 'closed')::float, 0) AS avg_pnl
       FROM prompt_versions v
       LEFT JOIN agent_decisions d
         ON d.prompt_version_id = v.id
        AND d.is_shadow = false
        AND d.created_at >= NOW() - ($2 || ' days')::interval
       LEFT JOIN trades t
         ON t.signal_id = d.signal_id
       WHERE v.agent_name = $1
       GROUP BY v.id, v.version, v.is_active, v.notes, v.created_at
       ORDER BY v.is_active DESC, v.created_at DESC`,
      [agent, String(days)],
    );

    // Add an "unversioned" bucket for decisions with null prompt_version_id
    // (hardcoded fallback or pre-migration). Useful baseline against which
    // to compare DB-tracked versions.
    const { rows: unversioned } = await db.query(
      `SELECT
         COUNT(d.id)::int AS total_decisions,
         COUNT(*) FILTER (WHERE d.action = 'BUY')::int  AS buys,
         COUNT(*) FILTER (WHERE d.action = 'SELL')::int AS sells,
         COUNT(*) FILTER (WHERE d.action = 'HOLD')::int AS holds,
         COALESCE(AVG(d.confidence)::float, 0) AS avg_confidence,
         COUNT(t.id) FILTER (WHERE t.status = 'closed')::int AS closed_trades,
         COUNT(t.id) FILTER (WHERE t.status = 'closed' AND t.pnl > 0)::int AS wins,
         COALESCE(SUM(t.pnl) FILTER (WHERE t.status = 'closed')::float, 0) AS total_pnl,
         COALESCE(AVG(t.pnl) FILTER (WHERE t.status = 'closed')::float, 0) AS avg_pnl
       FROM agent_decisions d
       LEFT JOIN trades t ON t.signal_id = d.signal_id
       WHERE d.prompt_version_id IS NULL
         AND d.is_shadow = false
         AND d.created_at >= NOW() - ($1 || ' days')::interval`,
      [String(days)],
    );

    const versions = rows.map((r) => ({
      ...r,
      win_rate: r.closed_trades > 0 ? r.wins / r.closed_trades : null,
    }));
    const baseline =
      unversioned[0] && unversioned[0].total_decisions > 0
        ? {
            ...unversioned[0],
            win_rate: unversioned[0].closed_trades > 0 ? unversioned[0].wins / unversioned[0].closed_trades : null,
          }
        : null;

    res.json({ success: true, data: { agent, days, versions, baseline } });
  } catch (err) {
    error(`API /prompts/${req.params.agent}/performance failed`, err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Agent calibration — 30-day win rates per agent used by orchestrator weighting
app.get('/api/agents/calibration', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const data = await orchestrator.getAgentCalibration(days);
    res.json({ success: true, data });
  } catch (err) {
    error('API /agents/calibration failed', err);
    res.status(500).json({ success: false, error: err.message });
  }
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
      [limit],
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
      ? req.query.symbols.split(',').map((s) => s.trim().toUpperCase())
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

// Datasource stats — Polygon usage + rate-limit status
app.get('/api/datasources/stats', async (req, res) => {
  const { _providers } = require('./datasources');
  res.json({ success: true, data: { polygon: _providers.polygon.getStats() } });
});

// Archiver — recent runs + active retention config + manual trigger
app.get('/api/archiver/status', async (req, res) => {
  try {
    const archiver = require('./archiver');
    const data = await archiver.getArchiveStatus(parseInt(req.query.limit) || 20);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/archiver/run', async (req, res) => {
  try {
    const archiver = require('./archiver');
    const data = await archiver.runArchiver();
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sentiment trend — chronological per-symbol snapshots
app.get('/api/sentiment/trend/:symbol', async (req, res) => {
  try {
    const days = Math.max(1, Math.min(90, parseInt(req.query.days) || 7));
    const symbol = req.params.symbol.toUpperCase();
    const { getTrend } = require('./sentiment-trends');
    const points = await getTrend(symbol, days);
    res.json({ success: true, data: { symbol, days, points } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sentiment shifts — symbols with a large inflection in the lookback window
app.get('/api/sentiment/shifts', async (req, res) => {
  try {
    const hours = Math.max(1, Math.min(168, parseInt(req.query.hours) || 24));
    const threshold = Math.max(0.1, Math.min(2, parseFloat(req.query.threshold) || 0.4));
    const { getShifts } = require('./sentiment-trends');
    const shifts = await getShifts({ hours, threshold });
    res.json({ success: true, data: { hours, threshold, shifts } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ML fallback model — status + live accuracy + walk-forward validation
app.get('/api/ml/status', async (req, res) => {
  try {
    const mlModel = require('./ml-model');
    const days = Math.max(1, Math.min(180, parseInt(req.query.days) || 30));
    const [status, liveAccuracy] = await Promise.all([
      Promise.resolve(mlModel.getStatus()),
      mlModel.getLiveAccuracy(days),
    ]);
    res.json({ success: true, data: { ...status, liveAccuracy, days } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/ml/walk-forward', async (req, res) => {
  try {
    const mlModel = require('./ml-model');
    const folds = Math.max(2, Math.min(10, parseInt(req.query.folds) || 3));
    const result = await mlModel.validateWalkForward(folds);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/ml/score-pending', async (req, res) => {
  try {
    const mlModel = require('./ml-model');
    const count = await mlModel.scorePendingPredictions();
    res.json({ success: true, data: { scored: count } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Monitoring alerts — on-demand threshold evaluation
app.get('/api/monitoring/check', async (req, res) => {
  try {
    const monitoring = require('./monitoring-alerts');
    const result = await monitoring.runAlertChecks();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Live ramp status — current tier, gates, advancement progress
app.get('/api/live-ramp/status', async (req, res) => {
  try {
    const liveRamp = require('./live-ramp');
    const status = await liveRamp.getStatus();
    res.json({ success: true, data: status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/live-ramp/check', async (req, res) => {
  try {
    const liveRamp = require('./live-ramp');
    const result = await liveRamp.checkAndAdvance();
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Kelly sizing — per-symbol recommendation from closed-trade history
app.get('/api/kelly', async (req, res) => {
  try {
    const kelly = require('./kelly');
    const days = Math.max(7, Math.min(365, parseInt(req.query.days) || 60));
    const minSampleSize = Math.max(5, Math.min(200, parseInt(req.query.minSampleSize) || 20));
    const watchlist = runtimeConfig.get('WATCHLIST') || config.WATCHLIST;
    const symbols = (req.query.symbols ? String(req.query.symbols).split(',') : watchlist).map((s) =>
      s.trim().toUpperCase(),
    );
    const results = await kelly.computeForSymbols(symbols, { lookbackDays: days, minSampleSize });
    res.json({ success: true, data: { enabled: kelly.enabled(), days, minSampleSize, results } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/kelly/:symbol', async (req, res) => {
  try {
    const kelly = require('./kelly');
    const days = Math.max(7, Math.min(365, parseInt(req.query.days) || 60));
    const minSampleSize = Math.max(5, Math.min(200, parseInt(req.query.minSampleSize) || 20));
    const r = await kelly.computeKellyFraction(req.params.symbol.toUpperCase(), {
      lookbackDays: days,
      minSampleSize,
    });
    res.json({ success: true, data: { enabled: kelly.enabled(), ...r } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Sector rotation — N-day momentum grouped by Polygon sic_description
app.get('/api/sectors/rotation', async (req, res) => {
  try {
    const days = Math.max(2, Math.min(30, parseInt(req.query.days) || 5));
    const sectorRotation = require('./sector-rotation');
    const symbols = runtimeConfig.get('WATCHLIST') || config.WATCHLIST;
    const data = await sectorRotation.computeRotation({ symbols, days });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Runtime config — hot-reloadable settings
app.get('/api/runtime-config', async (req, res) => {
  res.json({ success: true, data: { overrides: runtimeConfig.getAll(), effective: runtimeConfig.getEffective() } });
});

app.put('/api/runtime-config/:key', validateBody(schemas.runtimeConfigSet), async (req, res) => {
  try {
    const { value } = req.body;
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

app.post('/api/watchlist', validateBody(schemas.watchlistAdd), async (req, res) => {
  try {
    const sym = req.body.symbol; // already trimmed + uppercased by the schema
    const current = runtimeConfig.get('WATCHLIST') || [...config.WATCHLIST];
    if (current.includes(sym))
      return res.json({ success: true, data: { symbols: current, message: 'Already in watchlist' } });
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
    const filtered = current.filter((s) => s !== sym);
    if (filtered.length === current.length)
      return res.status(404).json({ success: false, error: `${sym} not in watchlist` });
    await runtimeConfig.set('WATCHLIST', filtered);
    res.json({ success: true, data: { symbols: filtered, removed: sym } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Config — runtime-effective values (overrides merged over static defaults)
app.get('/api/config', (req, res) => {
  const effective = runtimeConfig.getEffective();
  const overrides = runtimeConfig.getAll();
  res.json({
    success: true,
    data: {
      watchlist: effective.WATCHLIST || config.WATCHLIST,
      cryptoWatchlist: config.CRYPTO_WATCHLIST,
      riskPct: effective.RISK_PCT ?? config.RISK_PCT,
      stopPct: effective.STOP_PCT ?? config.STOP_PCT,
      targetPct: effective.TARGET_PCT ?? config.TARGET_PCT,
      maxPosPct: effective.MAX_POS_PCT ?? config.MAX_POS_PCT,
      trailingAtrMult: effective.TRAILING_ATR_MULT ?? config.TRAILING_ATR_MULT,
      maxDrawdownPct: effective.MAX_DRAWDOWN_PCT ?? config.MAX_DRAWDOWN_PCT,
      correlationThreshold: effective.CORRELATION_THRESHOLD ?? config.CORRELATION_THRESHOLD,
      partialExitPct: effective.PARTIAL_EXIT_PCT ?? config.PARTIAL_EXIT_PCT,
      partialExitTrigger: effective.PARTIAL_EXIT_TRIGGER ?? config.PARTIAL_EXIT_TRIGGER,
      llmDailyCostCapUsd: effective.LLM_DAILY_COST_CAP_USD ?? config.LLM_DAILY_COST_CAP_USD,
      llmDailyTokenCap: effective.LLM_DAILY_TOKEN_CAP ?? config.LLM_DAILY_TOKEN_CAP,
      llmCircuitBreakerFailures: effective.LLM_CIRCUIT_BREAKER_FAILURES ?? config.LLM_CIRCUIT_BREAKER_FAILURES,
      // Signal tuning — loosen to trade more aggressively
      scanIntervalMs: effective.SCAN_INTERVAL_MS ?? config.SCAN_INTERVAL_MS,
      orchestratorMinConfidence: effective.ORCHESTRATOR_MIN_CONFIDENCE ?? config.ORCHESTRATOR_MIN_CONFIDENCE,
      volumeSpikeRatio: effective.VOLUME_SPIKE_RATIO ?? config.VOLUME_SPIKE_RATIO,
      overriddenKeys: Object.keys(overrides),
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
      [days],
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
       WHERE d.is_shadow = false
         AND d.created_at > now() - interval '1 day' * $1`,
      [days],
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
    const leaderboard = Object.entries(agentStats)
      .map(([agent, stats]) => ({
        agent,
        decisions: stats.decisions,
        correct: stats.correct,
        wrong: stats.wrong,
        winRate:
          stats.correct + stats.wrong > 0 ? +((stats.correct / (stats.correct + stats.wrong)) * 100).toFixed(1) : null,
        totalPnl: +stats.totalPnl.toFixed(2),
        avgConfidence: stats.decisions > 0 ? +(stats.confidenceSum / stats.decisions).toFixed(3) : 0,
      }))
      .sort((a, b) => (b.winRate || 0) - (a.winRate || 0));

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
      [hours],
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

  return httpServer;
}

module.exports = { start, setLastScanTime, _getLastScanTime, app };
