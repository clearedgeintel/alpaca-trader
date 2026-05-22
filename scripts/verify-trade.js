#!/usr/bin/env node
/**
 * Reconcile a recorded trade against Alpaca's authoritative records.
 *
 * Born from the BMNG +1,978% trade ($1.51 -> $31.39, +$176K) that looked
 * like a data artifact (a reverse-split or bad fill record can inflate a
 * P&L number without any real money changing hands). This script answers
 * one question: did that exit price actually trade?
 *
 * For each matching trade row it cross-checks three sources:
 *   1. The trades table  — what we recorded (entry/exit/qty/pnl)
 *   2. Alpaca orders     — the order's filled_avg_price + filled_qty
 *   3. Alpaca FILL acts  — every executed fill for the symbol
 *   4. Daily bars        — was the recorded exit price inside the actual
 *                          traded high/low range? (the smoking gun)
 *
 * Usage:
 *   tsx scripts/verify-trade.js [SYMBOL] [--days N]
 *   tsx scripts/verify-trade.js BMNG
 *   tsx scripts/verify-trade.js              # defaults to BMNG, 60 days
 *
 * Read-only. Touches no orders, writes nothing to the DB.
 */

require('dotenv').config();
const db = require('../src/db');
const alpaca = require('../src/alpaca');

const args = process.argv.slice(2);
const symbol = (args.find((a) => !a.startsWith('--')) || 'BMNG').toUpperCase();
const daysArg = args.indexOf('--days');
const lookbackDays = daysArg >= 0 && args[daysArg + 1] ? parseInt(args[daysArg + 1], 10) : 60;

const f = (n, d = 2) => (n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toFixed(d));
const money = (n) => (n == null ? '—' : `${Number(n) >= 0 ? '+' : '−'}$${Math.abs(Number(n)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

async function main() {
  console.log(`\n=== Trade verification: ${symbol} (lookback ${lookbackDays}d) ===\n`);

  // 1. Recorded trades
  const { rows: trades } = await db.query(
    `SELECT id, symbol, alpaca_order_id, side, qty, entry_price, exit_price,
            pnl, pnl_pct, status, exit_reason, strategy_pool, created_at, closed_at
       FROM trades WHERE symbol = $1 ORDER BY created_at DESC`,
    [symbol],
  );
  if (trades.length === 0) {
    console.log(`No trades recorded for ${symbol}. Nothing to verify.`);
    return;
  }
  console.log(`Found ${trades.length} recorded trade(s) for ${symbol}.\n`);

  // 2. Daily bars — the price reality check
  let bars = [];
  try {
    bars = await alpaca.getDailyBars(symbol, lookbackDays);
  } catch (err) {
    console.log(`⚠ Could not fetch daily bars for ${symbol}: ${err.message}`);
  }
  const periodHigh = bars.length ? Math.max(...bars.map((b) => b.h)) : null;
  const periodLow = bars.length ? Math.min(...bars.map((b) => b.l)) : null;
  if (bars.length) {
    console.log(`Daily price range over ${bars.length} bars: low $${f(periodLow)} … high $${f(periodHigh)}`);
    const first = bars[0];
    const last = bars[bars.length - 1];
    console.log(`  first bar ${first.t?.slice(0, 10)} close $${f(first.c)} · last bar ${last.t?.slice(0, 10)} close $${f(last.c)}\n`);
  }

  // 3. FILL activities for this symbol (authoritative executions)
  let fills = [];
  try {
    const acts = await alpaca.getAccountActivities('FILL', { pageSize: 100 });
    fills = (Array.isArray(acts) ? acts : []).filter((a) => a.symbol === symbol);
  } catch (err) {
    console.log(`⚠ Could not fetch FILL activities: ${err.message}`);
  }
  if (fills.length) {
    console.log(`Alpaca FILL activities for ${symbol} (${fills.length}):`);
    for (const fl of fills) {
      console.log(`  ${fl.transaction_time?.slice(0, 19)}  ${fl.side?.padEnd(9)} ${f(fl.qty, 0)} @ $${f(fl.price)}  (${fl.type})`);
    }
    console.log('');
  } else {
    console.log(`No FILL activities returned for ${symbol} (may have aged past the activities window).\n`);
  }

  // 4. Per-trade reconciliation
  for (const t of trades) {
    console.log(`── Trade #${t.id} (${t.strategy_pool || 'n/a'} · ${t.status}) ─────────────`);
    console.log(`  Recorded: ${t.side} ${f(t.qty, 0)} @ entry $${f(t.entry_price)} → exit $${f(t.exit_price)}  ${money(t.pnl)} (${f(t.pnl_pct)}%)  [${t.exit_reason || 'open'}]`);

    // Cross-check the order
    if (t.alpaca_order_id) {
      try {
        const order = await alpaca.getOrder(t.alpaca_order_id);
        console.log(`  Alpaca order ${t.alpaca_order_id.slice(0, 8)}…: status=${order.status} filled_qty=${order.filled_qty} filled_avg=$${f(order.filled_avg_price)}`);
        if (order.filled_avg_price && Math.abs(Number(order.filled_avg_price) - Number(t.entry_price)) / Number(t.entry_price) > 0.02) {
          console.log(`    ⚠ entry price mismatch: recorded $${f(t.entry_price)} vs filled $${f(order.filled_avg_price)}`);
        }
      } catch (err) {
        console.log(`  ⚠ Order ${t.alpaca_order_id} not retrievable: ${err.message}`);
      }
    } else {
      console.log(`  (no alpaca_order_id recorded)`);
    }

    // The smoking-gun check: was the recorded exit price ever achievable?
    if (t.exit_price != null && periodHigh != null) {
      const exit = Number(t.exit_price);
      const buffer = periodHigh * 1.02; // allow 2% for intraday wicks beyond daily high
      if (exit > buffer) {
        console.log(`  ❌ SUSPECT: recorded exit $${f(exit)} is ABOVE the ${lookbackDays}d high $${f(periodHigh)}.`);
        console.log(`     The stock never traded near this price — the P&L of ${money(t.pnl)} is almost certainly`);
        console.log(`     a data artifact (reverse split, ticker reuse, or corrupt fill). Recommend correcting`);
        console.log(`     this row so the equity curve + retro card stop counting phantom profit.`);
      } else if (exit < periodLow * 0.98) {
        console.log(`  ❌ SUSPECT: recorded exit $${f(exit)} is BELOW the ${lookbackDays}d low $${f(periodLow)}.`);
      } else {
        console.log(`  ✅ Exit $${f(exit)} is within the traded range [$${f(periodLow)}, $${f(periodHigh)}] — plausible.`);
      }
    }
    console.log('');
  }

  // Headline verdict for the flagged BMNG-style case
  const suspect = trades.find(
    (t) => t.exit_price != null && periodHigh != null && Number(t.exit_price) > periodHigh * 1.02,
  );
  if (suspect) {
    console.log('VERDICT: at least one trade has an exit price the stock never traded at.');
    console.log(`Phantom P&L to back out: ${money(suspect.pnl)}.`);
    console.log('Fix options: (a) UPDATE the row to the real exit, or (b) mark it excluded from analytics.');
  } else {
    console.log('VERDICT: all recorded exits are within the actual traded range. P&L looks real.');
  }
}

main()
  .catch((err) => {
    console.error('verify-trade failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await db.close();
    } catch {
      /* ignore */
    }
  });
