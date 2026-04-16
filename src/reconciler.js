/**
 * Trade reconciliation — compares Alpaca's ground truth (open positions +
 * recent orders) with the DB `trades` table and surfaces/auto-resolves
 * the orphan scenarios we log during the BUY/SELL critical paths.
 *
 * Scenarios handled:
 *
 * 1. ALPACA_HAS_POSITION_DB_MISSING — Alpaca reports an open position but
 *    no matching open trade row. Almost always caused by placeOrder
 *    succeeding followed by a DB rollback. We can auto-insert the trade
 *    row using the live position data.
 *
 * 2. DB_OPEN_ALPACA_FLAT — DB shows an open trade but Alpaca has no
 *    matching position (user closed it manually, or SELL landed on Alpaca
 *    but DB update failed). We can auto-close the DB row at the last
 *    known current_price.
 *
 * 3. QTY_MISMATCH — Both sides have the position but qty differs
 *    (partial fill not yet persisted). We sync DB qty to Alpaca.
 *
 * Safety: this module is read-heavy and UPDATE/INSERT-only — it never
 * places or cancels orders on Alpaca. Auto-resolve is opt-in per-call so
 * tests and manual tooling can dry-run the diff first.
 */

const db = require('./db');
const alpaca = require('./alpaca');
const { log, warn, error, runWithContext, newCorrelationId } = require('./logger');

/**
 * Compute the diff between Alpaca positions and DB open trades.
 * Returns { orphanPositions, orphanTrades, qtyMismatches }.
 * Pure data-gathering; no writes.
 */
async function computeDiff() {
  const [alpacaPositions, dbResult] = await Promise.all([
    alpaca.getPositions().catch(() => []),
    db.query(`SELECT id, symbol, qty, entry_price, current_price, status FROM trades WHERE status = 'open'`),
  ]);

  const alpacaBySymbol = new Map();
  for (const pos of alpacaPositions) {
    alpacaBySymbol.set(pos.symbol, pos);
  }

  const dbBySymbol = new Map();
  for (const row of dbResult.rows) {
    dbBySymbol.set(row.symbol, row);
  }

  const orphanPositions = []; // Alpaca has; DB missing
  const orphanTrades = []; // DB has; Alpaca flat
  const qtyMismatches = []; // Both have; qty differs

  for (const [symbol, pos] of alpacaBySymbol) {
    const dbRow = dbBySymbol.get(symbol);
    if (!dbRow) {
      orphanPositions.push({
        symbol,
        alpacaQty: parseFloat(pos.qty),
        avgEntryPrice: parseFloat(pos.avg_entry_price),
        currentPrice: parseFloat(pos.current_price),
        marketValue: parseFloat(pos.market_value),
      });
    } else {
      const alpacaQty = parseFloat(pos.qty);
      const dbQty = parseFloat(dbRow.qty);
      if (Math.abs(alpacaQty - dbQty) >= 1) {
        qtyMismatches.push({
          symbol,
          tradeId: dbRow.id,
          dbQty,
          alpacaQty,
          delta: alpacaQty - dbQty,
          currentPrice: parseFloat(pos.current_price),
        });
      }
    }
  }

  for (const [symbol, dbRow] of dbBySymbol) {
    if (!alpacaBySymbol.has(symbol)) {
      orphanTrades.push({
        symbol,
        tradeId: dbRow.id,
        dbQty: parseFloat(dbRow.qty),
        entryPrice: parseFloat(dbRow.entry_price),
        lastKnownPrice: parseFloat(dbRow.current_price),
      });
    }
  }

  return { orphanPositions, orphanTrades, qtyMismatches };
}

/**
 * Run the reconciler. Returns the diff + what was resolved.
 * Pass { dryRun: true } to see the diff without writing.
 */
async function runReconciliation({ dryRun = false } = {}) {
  return runWithContext({ reconcileId: newCorrelationId('rec') }, async () => {
    const diff = await computeDiff();
    const totalDiscrepancies = diff.orphanPositions.length + diff.orphanTrades.length + diff.qtyMismatches.length;

    if (totalDiscrepancies === 0) {
      log('Reconciler: Alpaca and DB in sync, no discrepancies');
      return { diff, resolved: { orphanPositions: 0, orphanTrades: 0, qtyMismatches: 0 }, dryRun };
    }

    warn(
      `Reconciler: found ${totalDiscrepancies} discrepancies — orphanPositions=${diff.orphanPositions.length}, orphanTrades=${diff.orphanTrades.length}, qtyMismatches=${diff.qtyMismatches.length}`,
    );

    const resolved = { orphanPositions: 0, orphanTrades: 0, qtyMismatches: 0 };
    if (dryRun) return { diff, resolved, dryRun };

    // 1. Insert trade rows for Alpaca-only positions
    for (const op of diff.orphanPositions) {
      try {
        await db.query(
          `INSERT INTO trades (symbol, side, qty, entry_price, current_price, order_value, status, exit_reason)
           VALUES ($1, 'buy', $2, $3, $4, $5, 'open', NULL)`,
          [op.symbol, op.alpacaQty, op.avgEntryPrice, op.currentPrice, op.marketValue],
        );
        resolved.orphanPositions++;
        log(`Reconciler: inserted orphan position ${op.symbol} qty=${op.alpacaQty} @ $${op.avgEntryPrice}`);
      } catch (err) {
        error(`Reconciler: failed to insert orphan position ${op.symbol}`, err);
      }
    }

    // 2. Close DB-only trades at last known price (exit_reason=reconciler_close)
    for (const ot of diff.orphanTrades) {
      try {
        const pnl = +((ot.lastKnownPrice - ot.entryPrice) * ot.dbQty).toFixed(2);
        const pnlPct =
          ot.entryPrice > 0 ? +(((ot.lastKnownPrice - ot.entryPrice) / ot.entryPrice) * 100).toFixed(4) : 0;
        await db.query(
          `UPDATE trades
             SET status = 'closed', exit_price = $1, pnl = $2, pnl_pct = $3,
                 exit_reason = 'reconciler_close', closed_at = NOW()
           WHERE id = $4`,
          [ot.lastKnownPrice, pnl, pnlPct, ot.tradeId],
        );
        resolved.orphanTrades++;
        log(`Reconciler: closed orphan trade ${ot.symbol} (id=${ot.tradeId}) @ $${ot.lastKnownPrice}, pnl=${pnl}`);
      } catch (err) {
        error(`Reconciler: failed to close orphan trade ${ot.symbol}`, err);
      }
    }

    // 3. Sync qty mismatches
    for (const qm of diff.qtyMismatches) {
      try {
        await db.query(
          `UPDATE trades
             SET qty = $1, current_price = $2, order_value = $1 * $2
           WHERE id = $3`,
          [qm.alpacaQty, qm.currentPrice, qm.tradeId],
        );
        resolved.qtyMismatches++;
        log(`Reconciler: synced qty for ${qm.symbol} (trade ${qm.tradeId}): ${qm.dbQty} -> ${qm.alpacaQty}`);
      } catch (err) {
        error(`Reconciler: failed to sync qty for ${qm.symbol}`, err);
      }
    }

    return { diff, resolved, dryRun };
  });
}

/**
 * Start the nightly reconciler — runs once at startup and then at midnight ET.
 * Returns the interval handle so main() can clear it on shutdown.
 */
function startReconciler({ immediate = true } = {}) {
  if (immediate) {
    runReconciliation().catch((err) => error('Initial reconciliation failed', err));
  }
  // Run every 24h. We don't need exact midnight — any quiet hour works
  // since reconciliation is idempotent.
  const DAY_MS = 24 * 60 * 60 * 1000;
  return setInterval(() => {
    runReconciliation().catch((err) => error('Scheduled reconciliation failed', err));
  }, DAY_MS);
}

module.exports = { computeDiff, runReconciliation, startReconciler };
