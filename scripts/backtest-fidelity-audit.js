#!/usr/bin/env node
/**
 * Backtest fidelity audit. Phase 2 measurement prereq for path-to-live.
 *
 * Replays closed trades from the DB against a backtest-equivalent simulator
 * using the same slippage + cost model the backtest uses. Compares predicted
 * P&L per trade vs the actual recorded P&L. Reports:
 *
 *   - N trades replayed (skipped if missing data)
 *   - Median absolute error (% of trade pnl)
 *   - 90th percentile error
 *   - Per-strategy breakdown
 *   - Top 10 biggest divergences (where to look for model bugs)
 *   - PASS/FAIL vs 15% (target) / 25% (no-go) thresholds per the v2 roadmap
 *
 * Usage:
 *   tsx scripts/backtest-fidelity-audit.js [--days N] [--slippage-bps N]
 *
 * Read-only. No DB writes. No order placement. Safe to run anytime.
 *
 * Methodology note: this is a SIMPLIFIED simulator. It uses daily bars to
 * approximate intraday exit prices. The whole point of the audit is to
 * measure how much that approximation hurts. If median error > 15%, the
 * fix is one of:
 *   - Increase the slippage bps (real-world fills worse than modeled)
 *   - Add intraday bar fetching to the backtest itself (bigger surgery)
 *   - Stop trusting the backtest for sizing decisions (worst case)
 */

require('dotenv').config();
const db = require('../src/db');
const alpaca = require('../src/alpaca');
const { calcAtr } = require('../src/indicators');
const config = require('../src/config');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const days = parseInt(opt('--days', '30'), 10);
const slippagePct = parseFloat(opt('--slippage-bps', '5')) / 10000;
const trailingAtrMult = config.TRAILING_ATR_MULT || 2.5;
const trailingMinPct = config.TRAILING_MIN_PCT || 0.02;

// Momentum-strategy time-exit parameters — must mirror src/monitor.js
// and src/config.js defaults. Used by the simulator's same-day-fizzle
// approximation for momentum positions.
const momentumActivatePct = config.MOMENTUM_TRAIL_ACTIVATE_PCT || 0.10;
const momentumMinGain = config.MOMENTUM_MIN_GAIN_AT_EXIT || 0.20;

const f = (n, d = 2) => (n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toFixed(d));
const pct = (n, d = 1) => (n == null ? '—' : `${(Number(n) * 100).toFixed(d)}%`);

// Bars timeframe — intraday for accurate momentum-time-exit modeling.
// Daily bars couldn't represent "30 min after entry" so the daily-close
// proxy was always badly off the actual fill price. 5-min bars get us
// to ~78 bars/day, enough granularity for both the 30-min momentum
// exit and tight stop/target intra-bar checks.
const BARS_TIMEFRAME = '5Min';
const BARS_PER_DAY = 78;

// MOMENTUM_TIME_EXIT_MIN in production (30 min default) = 6 bars at 5Min.
const momentumTimeExitMin = config.MOMENTUM_TIME_EXIT_MIN || 30;
const momentumTimeExitBars = Math.ceil(momentumTimeExitMin / 5);

/**
 * Replay a single trade against historical bars. Returns the predicted
 * exit price + reason using the same stop/target/trailing/time-exit
 * logic the monitor uses, with slippage applied at fills.
 */
function simulateExit(trade, bars) {
  if (!bars || bars.length < 2) return null;
  const entryPrice = Number(trade.entry_price);
  const stopLoss = Number(trade.stop_loss);
  const takeProfit = Number(trade.take_profit);
  const qty = Number(trade.qty);
  if (!entryPrice || !stopLoss || !takeProfit) return null;

  // Find the bar containing entry (closest at-or-after created_at)
  const entryDate = new Date(trade.created_at);
  let entryIdx = bars.findIndex((b) => new Date(b.t) >= entryDate);
  if (entryIdx === -1) entryIdx = 0;
  if (entryIdx >= bars.length - 1) return null;

  // Buy-side slippage already baked into trade.entry_price (it's what
  // actually filled). Sell-side slippage applied at our predicted exit.
  let trailingStop = stopLoss;
  let highestPrice = entryPrice;

  // ATR-based trailing uses *daily* ATR in production — we don't have
  // 14 days of daily bars here, so estimate from intraday range.
  // Compute once at entry; in production this updates on new daily highs.
  let atrEstimate = null;
  const lookback = Math.min(BARS_PER_DAY * 2, entryIdx);
  if (lookback > 0) {
    const recent = bars.slice(entryIdx - lookback, entryIdx);
    const ranges = recent.map((b) => b.h - b.l);
    atrEstimate = ranges.reduce((s, r) => s + r, 0) / ranges.length * 13; // ~daily proxy
  }

  for (let i = entryIdx; i < bars.length; i++) {
    const bar = bars[i];

    // Update trailing stop on new highs (per-bar approximation of the
    // production rule that fires on new highs at any cycle).
    if (atrEstimate && bar.h > highestPrice) {
      highestPrice = bar.h;
      const atrTrail = bar.h - atrEstimate * trailingAtrMult;
      const minTrail = bar.h * (1 - trailingMinPct);
      const newTrail = Math.min(atrTrail, minTrail);
      if (newTrail > trailingStop) trailingStop = newTrail;
    }

    // Check exits — asymmetric model that matches production reality:
    //   - Stop: fire only when bar CLOSE is at/below stop. Production
    //     monitor sees current price (≈ end-of-bar last trade), not
    //     intra-bar wicks. A 1-second wick that fills nothing didn't
    //     trigger production's stop, so it shouldn't trigger ours.
    //   - Target: fire when bar HIGH reaches target. A limit-style
    //     target order DOES fill on the way up — production places
    //     bracket orders on entry so the target hits intra-bar.
    const effectiveStop = Math.max(stopLoss, trailingStop);
    if (bar.c <= effectiveStop) {
      const exitPrice = effectiveStop * (1 - slippagePct);
      return {
        exitPrice: +exitPrice.toFixed(4),
        exitDate: bar.t,
        reason: trailingStop > stopLoss ? 'trailing_stop' : 'stop_loss',
        predictedPnl: +((exitPrice - entryPrice) * qty).toFixed(2),
      };
    }
    if (bar.h >= takeProfit) {
      const exitPrice = takeProfit * (1 - slippagePct);
      return {
        exitPrice: +exitPrice.toFixed(4),
        exitDate: bar.t,
        reason: 'take_profit',
        predictedPnl: +((exitPrice - entryPrice) * qty).toFixed(2),
      };
    }

    // Momentum time-exit (Phase 2 simulator, intraday-accurate version).
    // Production rule: at MOMENTUM_TIME_EXIT_MIN held, if gain <
    // activate_pct AND gain < min_gain_at_exit, force close at current
    // price. With 5-min bars we fire at the actual time-exit bar
    // (= entry bar + momentumTimeExitBars) rather than guessing at
    // daily close.
    if (trade.strategy_pool === 'momentum' && i === entryIdx + momentumTimeExitBars) {
      const closeGain = (bar.c - entryPrice) / entryPrice;
      // Check the running high from entry through now — if it cleared
      // activate, the trailing-stop took over and time-exit suppressed.
      const runHigh = Math.max(...bars.slice(entryIdx, i + 1).map((b) => b.h));
      const runHighGain = (runHigh - entryPrice) / entryPrice;
      if (runHighGain < momentumActivatePct && closeGain < momentumMinGain) {
        const exitPrice = bar.c * (1 - slippagePct);
        return {
          exitPrice: +exitPrice.toFixed(4),
          exitDate: bar.t,
          reason: 'momentum_time_exit',
          predictedPnl: +((exitPrice - entryPrice) * qty).toFixed(2),
        };
      }
    }
  }

  // Ran off the end of bars — close at last available bar
  const last = bars[bars.length - 1];
  const exitPrice = last.c * (1 - slippagePct);
  return {
    exitPrice: +exitPrice.toFixed(4),
    exitDate: last.t,
    reason: 'eof',
    predictedPnl: +((exitPrice - entryPrice) * qty).toFixed(2),
  };
}

function median(arr) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

async function main() {
  console.log(`\n=== Backtest fidelity audit (last ${days}d, slippage ${(slippagePct * 10000).toFixed(1)}bps) ===\n`);

  // Exit reasons the simulator CAN model. Trades exiting via paths the
  // simulator doesn't replay (orchestrator_sell, manual_close, etc.)
  // would always show high "error" because the simulator predicts a
  // path that wouldn't have fired at the same time as the actual.
  // We report fidelity on the modelable subset + a separate stat
  // showing how representative the audit is.
  const MODELABLE_REASONS = new Set([
    'stop_loss',
    'take_profit',
    'trailing_stop',
    'momentum_time_exit',
  ]);

  const { rows: trades } = await db.query(
    `SELECT id, symbol, side, qty, entry_price, exit_price, stop_loss, take_profit,
            pnl, strategy_pool, exit_reason, created_at, closed_at
       FROM trades
      WHERE status = 'closed'
        AND option_type IS NULL
        AND closed_at >= NOW() - INTERVAL '${days} days'
        AND pnl IS NOT NULL
      ORDER BY closed_at ASC`,
  );
  console.log(`Loaded ${trades.length} closed equity trades.\n`);
  if (trades.length === 0) {
    console.log('Nothing to audit. Exiting.');
    return;
  }

  const modelable = trades.filter((t) => MODELABLE_REASONS.has(t.exit_reason));
  const unmodeled = trades.filter((t) => !MODELABLE_REASONS.has(t.exit_reason));
  console.log(`Modelable exits: ${modelable.length}  (${trades.length === 0 ? 0 : ((modelable.length / trades.length) * 100).toFixed(0)}% of total)`);
  console.log(`Unmodeled exits: ${unmodeled.length}  — by reason:`);
  const byReason = new Map();
  for (const t of unmodeled) {
    byReason.set(t.exit_reason || 'unknown', (byReason.get(t.exit_reason || 'unknown') || 0) + 1);
  }
  for (const [reason, n] of byReason.entries()) {
    console.log(`  ${reason.padEnd(20)} n=${n}`);
  }
  console.log('');

  const results = [];
  for (const trade of modelable) {
    let bars;
    try {
      // 5-min bars covering entry + ~30 trading days (the typical max
      // hold window for our strategies). 78 bars/day × 30 = 2340 bars.
      bars = await alpaca.getBars(trade.symbol, BARS_TIMEFRAME, 2340);
    } catch {
      continue;
    }
    if (!bars || bars.length < 2) continue;

    // Bound the simulation to the actual hold window — the simulator
    // can't predict trade outcomes AFTER the position was closed.
    // Include a small buffer (4 bars = 20 min) past close to allow
    // for minor clock alignment.
    if (trade.closed_at) {
      const closeMs = new Date(trade.closed_at).getTime() + 20 * 60 * 1000;
      bars = bars.filter((b) => new Date(b.t).getTime() <= closeMs);
      if (bars.length < 2) continue;
    }

    const sim = simulateExit(trade, bars);
    if (!sim) continue;

    const actualPnl = Number(trade.pnl);
    const predicted = sim.predictedPnl;
    // Error as % of the absolute actual pnl (avoid div-by-zero on
    // near-breakeven trades by using min denominator)
    const denom = Math.max(Math.abs(actualPnl), 1);
    const errorPct = Math.abs(predicted - actualPnl) / denom;

    results.push({
      id: trade.id,
      symbol: trade.symbol,
      strategy: trade.strategy_pool || 'untagged',
      actualPnl,
      predictedPnl: predicted,
      actualReason: trade.exit_reason,
      predictedReason: sim.reason,
      errorPct,
    });
  }

  console.log(`Replayed ${results.length} of ${trades.length} trades (others skipped — no bars / missing prices).\n`);
  if (results.length === 0) {
    console.log('No trades replayed. Cannot audit.');
    return;
  }

  const errors = results.map((r) => r.errorPct);
  const medErr = median(errors);
  const p90Err = percentile(errors, 0.9);
  const meanErr = errors.reduce((s, x) => s + x, 0) / errors.length;

  console.log(`Median absolute error: ${(medErr * 100).toFixed(1)}%`);
  console.log(`90th percentile:       ${(p90Err * 100).toFixed(1)}%`);
  console.log(`Mean error:            ${(meanErr * 100).toFixed(1)}%\n`);

  // Per-strategy breakdown
  const byStrat = new Map();
  for (const r of results) {
    if (!byStrat.has(r.strategy)) byStrat.set(r.strategy, []);
    byStrat.get(r.strategy).push(r.errorPct);
  }
  console.log('Per-strategy median error:');
  for (const [strat, errs] of byStrat.entries()) {
    console.log(`  ${strat.padEnd(20)} n=${String(errs.length).padStart(4)} median=${(median(errs) * 100).toFixed(1)}%`);
  }
  console.log('');

  // Top 10 worst divergences
  const worst = [...results].sort((a, b) => b.errorPct - a.errorPct).slice(0, 10);
  console.log('Top 10 worst divergences (where to look for model bugs):');
  for (const r of worst) {
    console.log(
      `  ${r.symbol.padEnd(8)} actual=$${f(r.actualPnl).padStart(8)} predicted=$${f(r.predictedPnl).padStart(8)} ` +
      `err=${(r.errorPct * 100).toFixed(0).padStart(4)}%  actual_reason=${r.actualReason || '—'}  predicted=${r.predictedReason}`,
    );
  }
  console.log('');

  // PASS/FAIL per the v2 roadmap thresholds
  if (medErr <= 0.15) {
    console.log(`✅ PASS: median error ${(medErr * 100).toFixed(1)}% ≤ 15% target.`);
    console.log('   Backtest is reliable enough for sizing decisions.');
  } else if (medErr <= 0.25) {
    console.log(`⚠️  AMBER: median error ${(medErr * 100).toFixed(1)}% above 15% target but below 25% no-go.`);
    console.log('   Iterate on slippage / cost model before Phase 3+. Possible fixes:');
    console.log('     - --slippage-bps higher (try 10, 15, 20)');
    console.log('     - Investigate top divergences above for systemic issues');
  } else {
    console.log(`❌ FAIL: median error ${(medErr * 100).toFixed(1)}% > 25% — backtest is NOT trustworthy.`);
    console.log('   Path-to-live blocked per v2 roadmap Phase 2 no-go criterion.');
    console.log('   Required next steps:');
    console.log('     1. Investigate divergences above for systemic model bugs');
    console.log('     2. Consider intraday bars (daily-bar approximation may be the cause)');
    console.log('     3. Retest after each fix');
  }
}

main()
  .catch((err) => {
    console.error('backtest-fidelity-audit failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await db.close(); } catch { /* ignore */ }
  });
