/**
 * Intraday P&L limits + per-symbol auto-blacklist.
 *
 * Two related guards that complement the portfolio-level drawdown breaker:
 *
 *   1. Per-symbol day loss cap: if a symbol has lost more than
 *      SYMBOL_DAY_LOSS_LIMIT_PCT of portfolio value in closed trades today,
 *      block further BUYs on that symbol until tomorrow. Stops revenge
 *      trading on a hostile single name.
 *
 *   2. Consecutive-loss blacklist: if a symbol has N consecutive losing
 *      closed trades, blacklist it for the rest of the day. Handles the
 *      case where the LLM keeps reading the setup the same wrong way.
 *
 * Both checks are async reads against the trades table (indexed on
 * symbol + created_at). Cheap enough to call in the execution-agent
 * BUY hot path before the order is placed.
 *
 * Returns a decision object with .blocked boolean and .reason string so
 * the execution-agent can surface the reason in its skip log.
 */

const db = require('./db');
const { log } = require('./logger');

// Defaults — can be overridden via env or runtime_config.
const DEFAULT_DAY_LOSS_LIMIT_PCT = 0.015; // 1.5% of portfolio in one symbol in one day
const DEFAULT_MAX_CONSECUTIVE_LOSSES = 3; // blacklist after 3 losers in a row

function limits() {
  return {
    dayLossLimitPct: parseFloat(process.env.SYMBOL_DAY_LOSS_LIMIT_PCT) || DEFAULT_DAY_LOSS_LIMIT_PCT,
    maxConsecutiveLosses: parseInt(process.env.MAX_CONSECUTIVE_LOSSES) || DEFAULT_MAX_CONSECUTIVE_LOSSES,
  };
}

/**
 * Check whether a symbol should be blocked from fresh BUYs.
 *
 * @param {string} symbol
 * @param {number} portfolioValue  — current portfolio value for the % check
 * @returns {Promise<{ blocked: boolean, reason?: string, dayPnl?: number, streak?: number }>}
 */
async function checkSymbolGuards(symbol, portfolioValue) {
  const { dayLossLimitPct, maxConsecutiveLosses } = limits();
  const sym = symbol.toUpperCase();

  try {
    // --- 1. Today's realized P&L on this symbol (closed trades only) ---
    // Uses calendar date in server's local timezone, which matches how the
    // rest of the app writes closed_at.
    const dayRes = await db.query(
      `SELECT COALESCE(SUM(pnl), 0) AS day_pnl
         FROM trades
        WHERE symbol = $1
          AND status = 'closed'
          AND closed_at::date = CURRENT_DATE`,
      [sym],
    );
    const dayPnl = parseFloat(dayRes.rows[0]?.day_pnl || 0);

    if (portfolioValue > 0 && dayPnl < 0) {
      const lossPct = Math.abs(dayPnl) / portfolioValue;
      if (lossPct >= dayLossLimitPct) {
        const msg = `symbol day-loss cap (-$${Math.abs(dayPnl).toFixed(2)}, ${(lossPct * 100).toFixed(2)}% of portfolio)`;
        log(`🚫 ${sym}: ${msg}`);
        return { blocked: true, reason: msg, dayPnl };
      }
    }

    // --- 2. Consecutive losses in the most recent closed trades ---
    const recentRes = await db.query(
      `SELECT pnl FROM trades
        WHERE symbol = $1 AND status = 'closed' AND pnl IS NOT NULL
        ORDER BY closed_at DESC
        LIMIT $2`,
      [sym, maxConsecutiveLosses],
    );
    let streak = 0;
    for (const row of recentRes.rows) {
      if (parseFloat(row.pnl) < 0) streak++;
      else break;
    }
    if (streak >= maxConsecutiveLosses) {
      const msg = `${streak} consecutive losses on ${sym}`;
      log(`🚫 ${sym}: ${msg}`);
      return { blocked: true, reason: msg, streak };
    }

    return { blocked: false, dayPnl, streak };
  } catch (err) {
    // DB failure should not block trading — fail open with a warning.
    log(`Symbol guard check failed for ${sym}, allowing trade: ${err.message}`);
    return { blocked: false };
  }
}

module.exports = { checkSymbolGuards, limits };
