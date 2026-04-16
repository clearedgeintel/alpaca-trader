/**
 * End-of-day digest — single info-severity alert summarizing today's
 * activity. Designed for low-noise channels (Slack/Discord at min=info)
 * so you get one digest per trading day without manual checking.
 *
 * Triggered by `setInterval` from index.js: checks every 5 minutes
 * and fires once when the time crosses a configured digest hour
 * (default 16:05 ET, just after market close). Idempotent within
 * the same day — won't fire twice.
 *
 * Pulls:
 *   - Today's P&L from `daily_performance` (and falls back to closed
 *     trades if today's row hasn't been written yet)
 *   - Win rate today from closed trades
 *   - Open positions and their unrealized P&L
 *   - LLM cost today
 *
 * Output: a single multi-line message body so it renders cleanly in
 * Slack / Discord / Telegram without extra plumbing.
 */

const db = require('./db');
const alerting = require('./alerting');
const alpaca = require('./alpaca');
const llm = require('./agents/llm');
const { log, error } = require('./logger');
const { DateTime } = require('luxon');

let lastSentDate = null;

function configuredHourMinute() {
  // Format: "HH:MM" in America/New_York (default 16:05).
  const raw = process.env.DAILY_DIGEST_TIME_ET || '16:05';
  const [h, m] = raw.split(':').map(Number);
  return {
    hour: Number.isFinite(h) ? h : 16,
    minute: Number.isFinite(m) ? m : 5,
  };
}

/**
 * Compose and send the digest. Safe to call manually (e.g. from a UI
 * "send digest now" button); records lastSentDate so the scheduler
 * won't double-fire on the same day.
 */
async function sendDigest() {
  try {
    const now = DateTime.now().setZone('America/New_York');
    const todayET = now.toFormat('yyyy-MM-dd');

    // Today's P&L — prefer daily_performance; fall back to summing closed trades
    const perfRow = await db
      .query(
        `SELECT total_pnl, total_trades, win_rate, portfolio_value
         FROM daily_performance
        WHERE trade_date = $1`,
        [todayET],
      )
      .catch(() => ({ rows: [] }));

    let totalPnl = 0;
    let totalTrades = 0;
    let winRate = null;
    let portfolioValue = null;

    if (perfRow.rows.length > 0) {
      totalPnl = parseFloat(perfRow.rows[0].total_pnl || 0);
      totalTrades = parseInt(perfRow.rows[0].total_trades || 0);
      winRate = perfRow.rows[0].win_rate != null ? parseFloat(perfRow.rows[0].win_rate) : null;
      portfolioValue = parseFloat(perfRow.rows[0].portfolio_value || 0);
    } else {
      // Fallback: aggregate closed trades from today directly
      const tradesRow = await db
        .query(
          `SELECT COUNT(*) AS n, COALESCE(SUM(pnl), 0) AS total_pnl,
                COUNT(*) FILTER (WHERE pnl > 0) AS wins
           FROM trades
          WHERE status = 'closed' AND closed_at::date = CURRENT_DATE`,
        )
        .catch(() => ({ rows: [{ n: 0, total_pnl: 0, wins: 0 }] }));
      const r = tradesRow.rows[0] || { n: 0, total_pnl: 0, wins: 0 };
      totalTrades = parseInt(r.n);
      totalPnl = parseFloat(r.total_pnl);
      winRate = totalTrades > 0 ? +((parseInt(r.wins) / totalTrades) * 100).toFixed(1) : null;
    }

    // Pull current account snapshot for portfolio value if not in perf row
    if (!portfolioValue) {
      try {
        const acct = await alpaca.getAccount();
        portfolioValue = parseFloat(acct.portfolio_value);
      } catch {}
    }

    // Open positions + unrealized P&L
    let positions = [];
    try {
      positions = await alpaca.getPositions();
    } catch {}

    const unrealizedPnl = positions.reduce((sum, p) => sum + parseFloat(p.unrealized_pl || 0), 0);

    // LLM spend today
    const llmUsage = llm.getUsage();
    const llmCost = llmUsage.estimatedCostUsd || 0;
    const llmCalls = llmUsage.callCount || 0;
    const cacheReadsPct =
      llmUsage.totalInputTokens + llmUsage.cacheReadTokens > 0
        ? (llmUsage.cacheReadTokens / (llmUsage.totalInputTokens + llmUsage.cacheReadTokens)) * 100
        : 0;

    const lines = [
      `📊 Daily digest — ${todayET}`,
      ``,
      `Realized P&L:    ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} (${totalTrades} trade${totalTrades === 1 ? '' : 's'}${winRate != null ? `, ${winRate}% win` : ''})`,
      `Unrealized P&L:  ${unrealizedPnl >= 0 ? '+' : ''}$${unrealizedPnl.toFixed(2)} (${positions.length} open position${positions.length === 1 ? '' : 's'})`,
      portfolioValue ? `Portfolio value: $${portfolioValue.toFixed(2)}` : null,
      ``,
      `LLM today:       ${llmCalls} calls, $${llmCost.toFixed(4)} (cache hit ${cacheReadsPct.toFixed(0)}%)`,
    ].filter(Boolean);

    if (positions.length > 0) {
      lines.push('', 'Open positions:');
      for (const p of positions.slice(0, 10)) {
        const pnl = parseFloat(p.unrealized_pl || 0);
        const pnlPct = parseFloat(p.unrealized_plpc || 0) * 100;
        lines.push(
          `  • ${p.symbol.padEnd(6)} ${parseFloat(p.qty)} @ $${parseFloat(p.avg_entry_price).toFixed(2)}  ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`,
        );
      }
      if (positions.length > 10) lines.push(`  ... and ${positions.length - 10} more`);
    }

    await alerting.alert({
      severity: 'info',
      title: `Daily digest — ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)} on ${totalTrades} trades`,
      message: lines.join('\n'),
      metadata: { date: todayET, totalPnl, totalTrades, winRate, openPositions: positions.length, llmCost },
    });

    lastSentDate = todayET;
    log(`Daily digest sent for ${todayET}`);
  } catch (err) {
    error('Failed to send daily digest', err);
  }
}

/**
 * Returns true when the current ET time has just crossed the configured
 * digest hour and we haven't fired yet today.
 */
function shouldFireNow(now = DateTime.now().setZone('America/New_York')) {
  const todayET = now.toFormat('yyyy-MM-dd');
  if (lastSentDate === todayET) return false;

  const { hour, minute } = configuredHourMinute();
  const target = now.set({ hour, minute, second: 0, millisecond: 0 });

  // Fire when current ET >= target ET. Skip weekends.
  const day = now.weekday; // 1=Mon, 7=Sun
  if (day > 5) return false;
  return now >= target;
}

/**
 * Start the periodic checker. Returns the interval handle so the caller
 * can clear it on graceful shutdown.
 */
function startDigestScheduler(intervalMs = 5 * 60 * 1000) {
  return setInterval(() => {
    if (shouldFireNow()) {
      sendDigest().catch((err) => error('Digest scheduler tick failed', err));
    }
  }, intervalMs);
}

module.exports = {
  sendDigest,
  shouldFireNow,
  startDigestScheduler,
  _resetForTests: () => {
    lastSentDate = null;
  },
};
