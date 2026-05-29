/**
 * Gap-risk handler. Phase 1 safety prereq for path-to-live.
 *
 * The 5-min monitor cycle has a fatal blind spot at market open: a
 * position with a 5% stop that gaps down 12% premarket has already
 * blown through the stop by the time the first cycle wakes up. The
 * trailing-stop check fires, alpaca.closePosition() runs, but the fill
 * happens 5-15 min after open at whatever the post-open price is —
 * often *worse* than the gap close because of the volatility wave that
 * follows.
 *
 * Right answer: detect the gap risk at/just-before open and exit at
 * the very first available price. We accept the gap loss because we
 * can't undo it — but we cap it instead of letting it widen further.
 *
 * Logic per open position (long only — short support not in v2):
 *   1. Compute premarket gap %: (latest_price - prev_close) / prev_close
 *   2. Compute the trade's stop distance %: (entry - stop) / entry
 *   3. If gap < -(GAP_EXIT_THRESHOLD_MULT * stop_pct), exit at market
 *
 * GAP_EXIT_THRESHOLD_MULT default 1.5 — a position with a 5% stop
 * triggers gap-exit at -7.5% premarket gap. Tighter than that and we
 * exit on noise; wider and we get stops blown past anyway.
 *
 * Runs ONCE per trading day, on the first monitor cycle after 9:30 ET.
 * Module-level `_lastGapCheckDate` provides the once-per-day guarantee.
 */

const { DateTime } = require('luxon');

/**
 * Pure function — given a trade row + snapshot, decide whether the
 * gap-exit should fire. Isolated so we can unit-test the decision
 * without touching alpaca/db. Returns null when no action, or an
 * object describing the exit.
 */
function evaluateGap(trade, snapshot, opts = {}) {
  if (!trade || !snapshot) return null;
  if (trade.option_type) return null; // options use their own premium curves
  if (trade.side && trade.side === 'sell') return null; // short — not supported

  const prevClose = Number(snapshot.prevDailyBar?.c);
  const currentPrice = Number(
    snapshot.latestTrade?.p ||
    snapshot.minuteBar?.c ||
    snapshot.dailyBar?.c,
  );
  if (!prevClose || !currentPrice) return null;

  const entry = Number(trade.entry_price);
  const stop = Number(trade.stop_loss);
  if (!entry || !stop || stop >= entry) return null; // bad data / inverted

  const gapPct = (currentPrice - prevClose) / prevClose;
  const stopPct = (entry - stop) / entry;
  const threshold = (opts.thresholdMult || 1.5) * stopPct;

  // Long-position gap risk = gap DOWN beyond threshold
  if (gapPct < -threshold) {
    return {
      symbol: trade.symbol,
      gapPct,
      stopPct,
      threshold,
      currentPrice,
      prevClose,
      reason: `gap_risk_exit (gap ${(gapPct * 100).toFixed(2)}% < threshold -${(threshold * 100).toFixed(2)}%)`,
    };
  }
  return null;
}

let _lastGapCheckDate = null;

function _today() {
  return DateTime.now().setZone('America/New_York').toISODate();
}

/**
 * Run the once-per-day gap check at/after market open. Idempotent
 * within a calendar day (NY tz) via `_lastGapCheckDate`. Returns the
 * count of positions exited.
 */
async function maybeRunGapCheck(deps) {
  const now = DateTime.now().setZone('America/New_York');
  const today = now.toISODate();
  if (_lastGapCheckDate === today) return { ran: false, reason: 'already ran today' };
  // Only fire after 9:30 ET (regular market open). Premarket gap is
  // most extreme at the open auction, so we wait for the actual print.
  if (now.hour < 9 || (now.hour === 9 && now.minute < 30)) {
    return { ran: false, reason: `pre-open (${now.toFormat('HH:mm')} ET)` };
  }
  _lastGapCheckDate = today;
  return await runGapCheck(deps);
}

async function runGapCheck(deps) {
  const { db, alpaca, config, log, error } = deps;
  const exits = [];
  let openTrades;
  try {
    const result = await db.query(
      "SELECT * FROM trades WHERE status = 'open' AND option_type IS NULL",
    );
    openTrades = result.rows;
  } catch (err) {
    error('gap-risk: failed to fetch open trades', err);
    return { ran: true, exits: 0, error: err.message };
  }
  if (openTrades.length === 0) {
    log('gap-risk: 0 open equity positions to check');
    return { ran: true, exits: 0 };
  }

  const thresholdMult = Number(config.GAP_EXIT_THRESHOLD_MULT) || 1.5;
  for (const trade of openTrades) {
    let snapshot;
    try {
      snapshot = await alpaca.getSnapshot(trade.symbol);
    } catch (err) {
      error(`gap-risk: snapshot fetch failed for ${trade.symbol}`, err);
      continue;
    }
    const decision = evaluateGap(trade, snapshot, { thresholdMult });
    if (!decision) continue;

    log(`🚨 GAP RISK EXIT: ${decision.symbol} ${decision.reason}`);
    try {
      require('./alerting').warn(
        `Gap-risk exit: ${decision.symbol}`,
        `${decision.symbol} opened ${(decision.gapPct * 100).toFixed(2)}% (prev close $${decision.prevClose.toFixed(2)} → current $${decision.currentPrice.toFixed(2)}), exceeded ${thresholdMult}× stop-pct threshold. Closing position at market.`,
        decision,
      );
    } catch { /* alerting optional */ }

    try {
      await alpaca.closePosition(trade.symbol);
      await db.query(
        "UPDATE trades SET exit_reason = 'gap_risk_exit', current_price = $1 WHERE id = $2 AND status = 'open'",
        [decision.currentPrice, trade.id],
      );
      try {
        require('./metrics').executionSanityBlocksTotal?.inc({ reason: 'gap_risk_exit' });
      } catch { /* metrics optional */ }
      exits.push(decision);
    } catch (err) {
      error(`gap-risk: failed to close ${trade.symbol}`, err);
    }
  }
  log(`gap-risk: checked ${openTrades.length} positions, exited ${exits.length}`);
  return { ran: true, exits: exits.length, details: exits };
}

function _resetForTests() {
  _lastGapCheckDate = null;
}

module.exports = {
  evaluateGap,
  maybeRunGapCheck,
  runGapCheck,
  _resetForTests,
};
