require('dotenv').config();

const config = require('./config');
const db = require('./db');
const scanner = require('./scanner');
const monitor = require('./monitor');
const server = require('./server');
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

async function main() {
  // 1. Init DB schema
  await db.initSchema();
  log('✅ Database ready');

  // 2. Start Express API server
  server.start();

  // 3. Run scan + monitor immediately on start
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

  // 4. Schedule recurring jobs
  setInterval(async () => {
    if (!isMarketOpen()) return;
    try {
      await scanner.runScan();
      server.setLastScanTime(new Date().toISOString());
    } catch (err) {
      error('Scheduled scan failed', err);
    }
  }, config.SCAN_INTERVAL_MS);

  setInterval(async () => {
    if (!isMarketOpen()) return;
    try {
      await monitor.runMonitor();
    } catch (err) {
      error('Scheduled monitor failed', err);
    }
  }, config.MONITOR_INTERVAL_MS);

  log('🚀 Alpaca Auto Trader running');
}

main().catch(err => {
  error('Fatal startup error', err);
  process.exit(1);
});
