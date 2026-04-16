const config = require('./config');
const db = require('./db');
const alpaca = require('./alpaca');
const { detectSignal } = require('./indicators');
const executor = require('./executor');
const { usesRules } = require('./strategy');
const { log, error } = require('./logger');

// Batch size for parallel bar fetches (avoid hammering Alpaca)
const PARALLEL_BATCH_SIZE = 6;

// Track last scan results for API visibility
let lastWatchlist = [];
let lastScanResults = [];

/**
 * Build a dynamic watchlist by merging the static list with Alpaca screener data.
 * Falls back to static watchlist on failure.
 */
async function buildWatchlist() {
  try {
    const [mostActive, movers] = await Promise.all([alpaca.getMostActive(30), alpaca.getTopMovers('stocks', 20)]);

    const dynamic = new Set(config.WATCHLIST);
    const sources = { static: config.WATCHLIST.length, active: 0, gainers: 0, losers: 0 };

    // Add top active symbols that meet basic criteria
    for (const s of mostActive) {
      if (s.volume > 500000 && !dynamic.has(s.symbol)) {
        dynamic.add(s.symbol);
        sources.active++;
      }
    }

    // Add top gainers with meaningful moves
    for (const g of movers.gainers) {
      if (Math.abs(g.percent_change) > 1 && g.price >= 10 && g.price <= 500 && !dynamic.has(g.symbol)) {
        dynamic.add(g.symbol);
        sources.gainers++;
      }
    }

    // Add top losers with meaningful moves (potential reversal plays)
    for (const l of movers.losers || []) {
      if (Math.abs(l.percent_change) > 2 && l.price >= 10 && l.price <= 500 && !dynamic.has(l.symbol)) {
        dynamic.add(l.symbol);
        sources.losers++;
      }
    }

    const maxSymbols = parseInt(process.env.MAX_SCAN_SYMBOLS) || 40;
    const watchlist = [...dynamic].slice(0, maxSymbols);
    log(
      `Dynamic watchlist: ${watchlist.length} symbols (static: ${sources.static}, active: ${sources.active}, gainers: ${sources.gainers}, losers: ${sources.losers})`,
    );
    log(`Scanning: [${watchlist.join(', ')}]`);
    return watchlist;
  } catch (err) {
    error('Failed to build dynamic watchlist, using static', err);
    return [...config.WATCHLIST];
  }
}

/**
 * Process a single symbol: fetch bars, detect signal, insert + execute if actionable.
 */
async function scanSymbol(symbol) {
  // Skip rule-based scanning if symbol is LLM-only
  if (!usesRules(symbol)) {
    lastScanResults.push({ symbol, status: 'skipped', reason: 'llm-only strategy' });
    return;
  }

  const bars = await alpaca.getBars(symbol, config.BAR_TIMEFRAME, config.BAR_LIMIT);

  if (!bars || bars.length < config.EMA_SLOW + 2) {
    lastScanResults.push({ symbol, status: 'skipped', reason: `insufficient bars (${bars?.length || 0})` });
    return;
  }

  const result = detectSignal(bars);

  lastScanResults.push({
    symbol,
    status: 'scanned',
    signal: result.signal,
    close: result.close,
    ema9: result.ema9,
    ema21: result.ema21,
    rsi: result.rsi,
    volumeRatio: result.volume_ratio,
  });

  if (result.signal === 'NONE') {
    return;
  }

  log(`${result.signal} signal for ${symbol}: ${result.reason}`);

  // Wrap signal insert + execution in a transaction
  await db.withTransaction(async (client) => {
    const insertResult = await client.query(
      `INSERT INTO signals (symbol, signal, reason, close, ema9, ema21, rsi, volume, avg_volume, volume_ratio)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        symbol,
        result.signal,
        result.reason,
        result.close,
        result.ema9,
        result.ema21,
        result.rsi,
        result.volume,
        result.avg_volume,
        result.volume_ratio,
      ],
    );

    const signalId = insertResult.rows[0].id;
    await executor.executeSignal({ ...result, symbol, id: signalId }, client);
  });
}

async function runScan() {
  const watchlist = await buildWatchlist();
  lastWatchlist = watchlist;
  lastScanResults = [];
  log(`Starting scan for ${watchlist.length} symbols...`);

  // Process in parallel batches to stay within rate limits
  for (let i = 0; i < watchlist.length; i += PARALLEL_BATCH_SIZE) {
    const batch = watchlist.slice(i, i + PARALLEL_BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((symbol) => scanSymbol(symbol)));

    for (let j = 0; j < results.length; j++) {
      if (results[j].status === 'rejected') {
        error(`Scan failed for ${batch[j]}`, results[j].reason);
      }
    }
  }

  log('Scan complete');
}

function getLastScan() {
  return {
    watchlist: lastWatchlist,
    symbolCount: lastWatchlist.length,
    results: lastScanResults,
    signalsFound: lastScanResults.filter((r) => r.signal && r.signal !== 'NONE').length,
    scanned: lastScanResults.filter((r) => r.status === 'scanned').length,
    skipped: lastScanResults.filter((r) => r.status === 'skipped').length,
  };
}

module.exports = { runScan, getLastScan };
