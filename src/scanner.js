const config = require('./config');
const db = require('./db');
const alpaca = require('./alpaca');
const { detectSignal } = require('./indicators');
const executor = require('./executor');
const { log, error } = require('./logger');

async function runScan() {
  log(`Starting scan for ${config.WATCHLIST.length} symbols...`);

  for (const symbol of config.WATCHLIST) {
    try {
      const bars = await alpaca.getBars(symbol, config.BAR_TIMEFRAME, config.BAR_LIMIT);

      if (!bars || bars.length < config.EMA_SLOW + 2) {
        log(`Not enough bars for ${symbol} (got ${bars?.length || 0})`);
        continue;
      }

      const result = detectSignal(bars);

      if (result.signal === 'NONE') {
        log(`No signal for ${symbol}`);
        continue;
      }

      log(`${result.signal} signal for ${symbol}: ${result.reason}`);

      // Insert signal into DB
      const insertResult = await db.query(
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
        ]
      );

      const signalId = insertResult.rows[0].id;

      // Execute immediately
      await executor.executeSignal({ ...result, symbol, id: signalId });
    } catch (err) {
      error(`Scan failed for ${symbol}`, err);
    }
  }

  log('Scan complete');
}

module.exports = { runScan };
