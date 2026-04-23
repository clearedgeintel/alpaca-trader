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
  const { riskAgent, regimeAgent, technicalAgent, newsAgent, breakoutAgent, meanReversionAgent } = require('./agents');
  const screenerAgent = require('./agents/screener-agent');
  const orchestrator = require('./agents/orchestrator');
  const executionAgent = require('./agents/execution-agent');
  const cycleGuard = require('./cycle-guard');

  // Register all agents with the orchestrator
  orchestrator.registerAgent(screenerAgent);
  orchestrator.registerAgent(riskAgent);
  orchestrator.registerAgent(regimeAgent);
  orchestrator.registerAgent(technicalAgent);
  orchestrator.registerAgent(newsAgent);
  orchestrator.registerAgent(breakoutAgent);
  orchestrator.registerAgent(meanReversionAgent);

  log('🤖 Agency mode enabled — 7 agents registered with orchestrator');

  // Tiered activation counters
  let cycleNumber = 0;
  const REGIME_EVERY_N = 3; // Regime runs every 3rd cycle (~15 min at 5-min intervals)

  async function runAgencyCycle() {
    const hasCrypto = config.CRYPTO_WATCHLIST.length > 0;
    const marketOpen = isMarketOpen();
    if (!marketOpen && !hasCrypto) return;

    cycleNumber++;
    const cycleStart = Date.now();

    // Crypto-only throttle: when equity market is closed, only run every
    // 3rd cycle (~15 min at 5-min intervals). Crypto doesn't need 5-min
    // granularity and this cuts off-hours spend by ~66%.
    if (!marketOpen && hasCrypto && cycleNumber % 3 !== 1) {
      log(`Crypto throttle: skipping cycle ${cycleNumber} (runs every 3rd off-hours)`);
      await monitor.runMonitor();
      server.setLastScanTime(new Date().toISOString());
      return;
    }

    try {
      // Phase 0: Screener discovers dynamic watchlist
      const screenerResult = await screenerAgent.run().catch((err) => {
        error('Screener failed in cycle', err);
        return null;
      });

      const dynamicWatchlist = screenerAgent.getWatchlist();

      // ----- CYCLE GUARD: skip full LLM chain if indicators unchanged -----
      const skip = await cycleGuard.shouldSkipCycle(dynamicWatchlist);
      if (skip) {
        // Still run monitor for stop-loss/take-profit on open positions
        await monitor.runMonitor();
        server.setLastScanTime(new Date().toISOString());
        return;
      }

      log('--- Agency cycle starting (indicators changed) ---');
      log(`Dynamic watchlist: [${dynamicWatchlist.join(', ')}]`);

      // ----- TIERED ACTIVATION: only run agents when they add value -----
      // Regime: every Nth cycle (regime doesn't flip in 5 min windows)
      const runRegime = cycleNumber % REGIME_EVERY_N === 1;
      if (runRegime) {
        const regimeResult = await regimeAgent.run().catch((err) => {
          error('Regime agent failed in cycle', err);
          return null;
        });
      } else {
        log(`Regime agent: reusing cached report (runs every ${REGIME_EVERY_N} cycles)`);
      }

      // Phase 1: Run analysis agents in parallel with dynamic symbols
      const context = { symbols: dynamicWatchlist };
      const [riskReport, taReport, newsReport, breakoutReport, meanRevReport] = await Promise.allSettled([
        riskAgent.run(context),
        technicalAgent.run(context),
        newsAgent.run(context),
        breakoutAgent.run(context),
        meanReversionAgent.run(context),
      ]);

      // Log any agent failures
      for (const [name, result] of [
        ['risk', riskReport],
        ['technical', taReport],
        ['news', newsReport],
        ['breakout', breakoutReport],
        ['mean-reversion', meanRevReport],
      ]) {
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
      const guardStats = cycleGuard.getStats();
      log(
        `--- Agency cycle complete in ${elapsed}ms (${decisions.length} decisions, ${dynamicWatchlist.length} symbols, guard skip rate: ${guardStats.hitRate}) ---`,
      );
      try {
        require('./metrics').agencyCycleDuration.observe(elapsed / 1000);
      } catch {
        /* skip */
      }
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

  // Load persisted strategy assignments (default + per-symbol) from DB
  const strategy = require('./strategy');
  await strategy.init();

  const httpServer = server.start();

  // Start real-time trade update stream (works alongside polling monitor)
  startTradeStream();

  // Start Alpaca websocket streams (market data + order updates) —
  // subscribe the full watchlist to 1-min bars so the realtime scanner
  // can detect EMA crossovers as they happen (vs. the 3-5min REST lag).
  const { startStreaming, stopStreaming, setStreamingWatchlist } = require('./alpaca-stream');
  const realtimeScanner = require('./realtime-scanner');
  setStreamingWatchlist(config.WATCHLIST);
  // Backfill buffers in the background — don't block startup
  realtimeScanner.backfill(config.WATCHLIST).catch((e) => error('realtime-scanner backfill failed', e));
  startStreaming();

  // Start the daily reconciler — catches orphan orders logged during the day
  const { startReconciler } = require('./reconciler');
  const reconcilerInterval = startReconciler({ immediate: false });

  // Start the end-of-day digest scheduler (fires once per trading day at
  // configured ET time, default 16:05 — just after market close)
  const { startDigestScheduler } = require('./daily-digest');
  const digestInterval = startDigestScheduler();

  // Nightly DB archiver — prunes old signals/agent_reports/agent_metrics/
  // sentiment_snapshots on configurable retention so tables don't grow
  // unbounded. Default fire time: 02:30 ET (deep off-hours).
  const { startArchiverScheduler } = require('./archiver');
  const archiverInterval = startArchiverScheduler();

  // Monitoring alert scheduler — checks thresholds every 5 minutes and
  // fires through the existing alerting.js channels on breach.
  const { startMonitoringScheduler } = require('./monitoring-alerts');
  const monitoringInterval = startMonitoringScheduler();

  // Train ML fallback model in background (non-blocking)
  const mlModel = require('./ml-model');
  mlModel.trainModel().catch((err) => error('Background ML training failed', err));

  let intervals = [reconcilerInterval, digestInterval, archiverInterval, monitoringInterval];
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
      try {
        stopStreaming();
      } catch {}
      log('Closed Alpaca websocket streams');

      // 3. Stop accepting new HTTP connections and wait for in-flight requests
      if (httpServer) {
        await new Promise((resolve) => httpServer.close(() => resolve()));
        log('HTTP server closed');
      }

      // 4. Give any in-flight agent cycle up to 10s to complete
      //    (cycles check their own _running flag; we just wait for the
      //    event loop to drain naturally by sleeping)
      await new Promise((r) => setTimeout(r, 2000));

      // 5. Close the DB pool last — everything upstream should be done
      try {
        await db.close();
      } catch {}
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

main().catch((err) => {
  error('Fatal startup error', err);
  process.exit(1);
});
