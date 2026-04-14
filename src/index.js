require('dotenv').config();

const config = require('./config');
const db = require('./db');
const scanner = require('./scanner');
const monitor = require('./monitor');
const server = require('./server');
const { startTradeStream } = require('./webhooks');
const { log, error } = require('./logger');
const { DateTime } = require('luxon');

// Validate required env vars
const required = ['ALPACA_API_KEY', 'ALPACA_API_SECRET', 'DATABASE_URL'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

function isMarketOpen() {
  const now = DateTime.now().setZone('America/New_York');
  const day = now.weekday; // 1=Mon, 7=Sun
  if (day > 5) return false;

  const minutes = now.hour * 60 + now.minute;
  const openMin = config.MARKET_OPEN_HOUR * 60 + config.MARKET_OPEN_MIN;
  const closeMin = config.MARKET_CLOSE_HOUR * 60 + config.MARKET_CLOSE_MIN;

  return minutes >= openMin && minutes <= closeMin;
}

// =============================================================================
// Agency Mode — multi-agent orchestration
// =============================================================================

async function startAgency() {
  const { riskAgent, regimeAgent, technicalAgent, newsAgent } = require('./agents');
  const screenerAgent = require('./agents/screener-agent');
  const orchestrator = require('./agents/orchestrator');
  const executionAgent = require('./agents/execution-agent');

  // Register all agents with the orchestrator
  orchestrator.registerAgent(screenerAgent);
  orchestrator.registerAgent(riskAgent);
  orchestrator.registerAgent(regimeAgent);
  orchestrator.registerAgent(technicalAgent);
  orchestrator.registerAgent(newsAgent);

  log('🤖 Agency mode enabled — all agents registered with orchestrator (incl. screener)');

  async function runAgencyCycle() {
    if (!isMarketOpen()) return;

    log('--- Agency cycle starting ---');
    const cycleStart = Date.now();

    try {
      // Phase 0: Screener discovers dynamic watchlist + regime assesses market
      const [screenerResult, regimeResult] = await Promise.allSettled([
        screenerAgent.run(),
        regimeAgent.run(),
      ]);

      if (screenerResult.status === 'rejected') {
        error('Screener failed in cycle', screenerResult.reason);
      }
      if (regimeResult.status === 'rejected') {
        error('Regime agent failed in cycle', regimeResult.reason);
      }

      // Get dynamic watchlist from screener (falls back to static watchlist)
      const dynamicWatchlist = screenerAgent.getWatchlist();
      log(`Dynamic watchlist: [${dynamicWatchlist.join(', ')}]`);

      // Phase 1: Run analysis agents in parallel with dynamic symbols
      const context = { symbols: dynamicWatchlist };
      const [riskReport, taReport, newsReport] = await Promise.allSettled([
        riskAgent.run(context),
        technicalAgent.run(context),
        newsAgent.run(context),
      ]);

      // Log any agent failures
      for (const [name, result] of [['risk', riskReport], ['technical', taReport], ['news', newsReport]]) {
        if (result.status === 'rejected') {
          error(`Agent ${name} failed in cycle`, result.reason);
        }
      }

      // Phase 2: Orchestrator synthesizes all reports into decisions
      const orchReport = await orchestrator.run();
      const decisions = orchestrator.getDecisions();

      // Phase 3: Execution agent processes each decision
      for (const decision of decisions) {
        const result = await executionAgent.execute(decision);
        if (result.executed) {
          log(`Agency executed: ${decision.action} ${decision.symbol} (confidence: ${decision.confidence})`);
        } else {
          log(`Agency skipped: ${decision.action} ${decision.symbol} — ${result.reason}`);
        }
      }

      // Phase 4: Monitor still runs for stop-loss/take-profit on existing positions
      await monitor.runMonitor();

      const elapsed = Date.now() - cycleStart;
      log(`--- Agency cycle complete in ${elapsed}ms (${decisions.length} decisions, ${dynamicWatchlist.length} symbols screened) ---`);
      server.setLastScanTime(new Date().toISOString());
    } catch (err) {
      error('Agency cycle failed', err);
    }
  }

  // Run immediately if market is open
  if (isMarketOpen()) {
    log('Market is open — running initial agency cycle...');
    await runAgencyCycle();
  } else {
    log('Market is closed — waiting for market hours');
  }

  // Schedule recurring cycles
  return [setInterval(runAgencyCycle, config.SCAN_INTERVAL_MS)];
}

// =============================================================================
// Legacy Mode — original scanner/executor/monitor flow
// =============================================================================

async function startLegacy() {
  log('📊 Legacy mode — using original scanner/executor/monitor flow');

  if (isMarketOpen()) {
    log('Market is open — running initial scan and monitor...');
    try {
      await scanner.runScan();
      server.setLastScanTime(new Date().toISOString());
    } catch (err) {
      error('Initial scan failed', err);
    }
    try {
      await monitor.runMonitor();
    } catch (err) {
      error('Initial monitor failed', err);
    }
  } else {
    log('Market is closed — waiting for market hours to begin scanning');
  }

  const scanInterval = setInterval(async () => {
    if (!isMarketOpen()) return;
    try {
      await scanner.runScan();
      server.setLastScanTime(new Date().toISOString());
    } catch (err) {
      error('Scheduled scan failed', err);
    }
  }, config.SCAN_INTERVAL_MS);

  const monitorInterval = setInterval(async () => {
    if (!isMarketOpen()) return;
    try {
      await monitor.runMonitor();
    } catch (err) {
      error('Scheduled monitor failed', err);
    }
  }, config.MONITOR_INTERVAL_MS);

  return [scanInterval, monitorInterval];
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  await db.initSchema();
  log('Database ready');

  // Load runtime config overrides from DB
  const runtimeConfig = require('./runtime-config');
  await runtimeConfig.init();

  const httpServer = server.start();

  // Start real-time trade update stream (works alongside polling monitor)
  startTradeStream();

  // Start Alpaca websocket streams (market data + order updates)
  const { startStreaming, stopStreaming } = require('./alpaca-stream');
  startStreaming();

  // Start the daily reconciler — catches orphan orders logged during the day
  const { startReconciler } = require('./reconciler');
  const reconcilerInterval = startReconciler({ immediate: false });

  // Start the end-of-day digest scheduler (fires once per trading day at
  // configured ET time, default 16:05 — just after market close)
  const { startDigestScheduler } = require('./daily-digest');
  const digestInterval = startDigestScheduler();

  // Train ML fallback model in background (non-blocking)
  const mlModel = require('./ml-model');
  mlModel.trainModel().catch(err => error('Background ML training failed', err));

  let intervals = [reconcilerInterval, digestInterval];
  if (config.USE_AGENCY) {
    intervals = intervals.concat((await startAgency()) || []);
  } else {
    intervals = intervals.concat((await startLegacy()) || []);
  }

  log(`Alpaca Auto Trader running (mode: ${config.USE_AGENCY ? 'AGENCY' : 'LEGACY'})`);

  // --- Graceful shutdown ---
  // On SIGTERM/SIGINT: stop scheduling new work, let in-flight cycles finish,
  // close websockets + HTTP server + DB pool, then exit. Hard-exit after 20s
  // so a stuck operation can't indefinitely block deploys.
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Received ${signal}, shutting down gracefully (20s hard-exit timer)...`);

    const hardExit = setTimeout(() => {
      error(`Graceful shutdown timed out after 20s, forcing exit`);
      process.exit(1);
    }, 20000);
    hardExit.unref();

    try {
      // 1. Stop scheduling new cycles
      for (const h of intervals) clearInterval(h);
      log('Cleared scheduled intervals');

      // 2. Close Alpaca websocket streams (also halts their reconnect timers)
      try { stopStreaming(); } catch {}
      log('Closed Alpaca websocket streams');

      // 3. Stop accepting new HTTP connections and wait for in-flight requests
      if (httpServer) {
        await new Promise((resolve) => httpServer.close(() => resolve()));
        log('HTTP server closed');
      }

      // 4. Give any in-flight agent cycle up to 10s to complete
      //    (cycles check their own _running flag; we just wait for the
      //    event loop to drain naturally by sleeping)
      await new Promise(r => setTimeout(r, 2000));

      // 5. Close the DB pool last — everything upstream should be done
      try { await db.close(); } catch {}
      log('Database pool closed');

      clearTimeout(hardExit);
      log('Shutdown complete');
      process.exit(0);
    } catch (err) {
      error('Error during shutdown', err);
      process.exit(1);
    }
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => {
  error('Fatal startup error', err);
  process.exit(1);
});
