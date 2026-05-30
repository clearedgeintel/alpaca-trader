#!/usr/bin/env node
/**
 * Phase 2 fidelity-audit follow-up. Pulls raw DB rows for the trades
 * that produced the largest simulator divergences and prints the
 * stop_loss / take_profit / strategy_pool actually stored, so we can
 * see whether the simulator is reading what production wrote.
 *
 * Hypothesis from the iter-2 divergence pattern: simulator predicts
 * a stop firing at ~5% below entry on trades where actual production
 * never hit a stop — suggesting either (a) trade.stop_loss in the DB
 * doesn't match what production actually enforced, or (b) the
 * simulator's logic is wrong.
 *
 * Read-only. No mutations.
 */

require('dotenv').config();
const db = require('../src/db');

const SUSPECT_SYMBOLS = ['TSLA', 'RGTI', 'POET', 'BITO', 'SLXN', 'INFQ', 'TE', 'SBFM', 'AMD'];

async function main() {
  const { rows } = await db.query(
    `SELECT id, symbol, side, qty, entry_price, exit_price, stop_loss, take_profit,
            pnl, pnl_pct, strategy_pool, exit_reason, created_at, closed_at,
            mae_pct, mfe_pct
       FROM trades
      WHERE status = 'closed'
        AND option_type IS NULL
        AND symbol = ANY($1::text[])
        AND closed_at >= NOW() - INTERVAL '30 days'
      ORDER BY closed_at DESC`,
    [SUSPECT_SYMBOLS],
  );

  console.log(`\nFound ${rows.length} rows for suspect symbols.\n`);
  console.log(
    'symbol'.padEnd(7) +
    'strategy'.padEnd(12) +
    'reason'.padEnd(22) +
    'entry'.padStart(10) +
    'stop'.padStart(10) +
    'stop%'.padStart(8) +
    'target'.padStart(10) +
    'tgt%'.padStart(8) +
    'exit'.padStart(10) +
    'pnl%'.padStart(8),
  );
  console.log('-'.repeat(105));

  for (const t of rows) {
    const entry = Number(t.entry_price);
    const stop = Number(t.stop_loss);
    const target = Number(t.take_profit);
    const exit = Number(t.exit_price);
    const stopPct = entry > 0 ? ((stop - entry) / entry) * 100 : 0;
    const targetPct = entry > 0 ? ((target - entry) / entry) * 100 : 0;
    const pnlPct = Number(t.pnl_pct) || 0;
    console.log(
      (t.symbol || '').padEnd(7) +
      (t.strategy_pool || '').padEnd(12) +
      (t.exit_reason || '').padEnd(22) +
      `$${entry.toFixed(2)}`.padStart(10) +
      `$${stop.toFixed(2)}`.padStart(10) +
      `${stopPct.toFixed(1)}%`.padStart(8) +
      `$${target.toFixed(2)}`.padStart(10) +
      `${targetPct.toFixed(1)}%`.padStart(8) +
      `$${exit.toFixed(2)}`.padStart(10) +
      `${pnlPct.toFixed(2)}%`.padStart(8),
    );
  }

  // Aggregate stop_pct by strategy_pool — what stop did production
  // actually use, on average, for each strategy?
  console.log('\n=== Stop% by strategy pool ===\n');
  const { rows: aggs } = await db.query(
    `SELECT strategy_pool,
            COUNT(*) AS n,
            AVG((stop_loss - entry_price) / entry_price * 100) AS avg_stop_pct,
            MIN((stop_loss - entry_price) / entry_price * 100) AS min_stop_pct,
            MAX((stop_loss - entry_price) / entry_price * 100) AS max_stop_pct
       FROM trades
      WHERE status = 'closed'
        AND option_type IS NULL
        AND closed_at >= NOW() - INTERVAL '30 days'
      GROUP BY strategy_pool
      ORDER BY n DESC`,
  );
  for (const a of aggs) {
    console.log(
      `${(a.strategy_pool || 'untagged').padEnd(12)} n=${String(a.n).padStart(3)}  ` +
      `avg=${Number(a.avg_stop_pct).toFixed(1)}%  ` +
      `min=${Number(a.min_stop_pct).toFixed(1)}%  ` +
      `max=${Number(a.max_stop_pct).toFixed(1)}%`,
    );
  }
  console.log('');
  console.log('Hypothesis check: momentum strategy default is MOMENTUM_STOP_PCT = 15%');
  console.log('  → momentum rows above should show avg ≈ -15%');
  console.log('  → if they show ≈ -5%, production was writing technical-style stops to momentum rows');
  console.log('  → if they show ≈ -15%, the simulator bug is elsewhere\n');
}

main()
  .catch((err) => {
    console.error('inspect-trade-stops failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await db.close(); } catch { /* ignore */ }
  });
