/**
 * Gradual live deployment ramp — auto-scales capital allocation from
 * 1% → 5% → 25% → 100% as closed-trade history proves the strategy.
 *
 * Each tier has two gates that must BOTH be passed before advancing:
 *   1. closed-trade count ≥ minTrades (statistical significance)
 *   2. rolling win rate ≥ minWinRate (edge is real)
 *   3. max drawdown ≤ maxDrawdown (risk is controlled)
 *
 * A drawdown breach demotes one tier automatically. The ramp multiplier
 * scales the risk dollars in the execution-agent sizing chain, so all
 * existing risk logic (Kelly, vol targeting, regime) still applies —
 * this just clamps the top-line capital exposure.
 *
 * Opt-in via LIVE_RAMP_ENABLED (default off). When off, multiplier is
 * 1.0 — the system behaves exactly as before.
 */

const db = require('./db');
const runtimeConfig = require('./runtime-config');
const { log, error } = require('./logger');

// Tier definitions. Each tier gates on closed-trade count, rolling
// win rate, and max drawdown over a lookback window.
const TIERS = [
  { tier: 0, capitalPct: 0.01, label: '1% (validation)', minTrades: 0, minWinRate: 0, maxDrawdown: 1.0 },
  { tier: 1, capitalPct: 0.05, label: '5% (proving)', minTrades: 20, minWinRate: 0.45, maxDrawdown: 0.08 },
  { tier: 2, capitalPct: 0.25, label: '25% (scaling)', minTrades: 50, minWinRate: 0.5, maxDrawdown: 0.1 },
  { tier: 3, capitalPct: 1.0, label: '100% (full)', minTrades: 100, minWinRate: 0.55, maxDrawdown: 0.12 },
];

function enabled() {
  const v = runtimeConfig.get('LIVE_RAMP_ENABLED');
  return v === true || v === 'true';
}

function autoAdvance() {
  const v = runtimeConfig.get('LIVE_RAMP_AUTO_ADVANCE');
  return v !== false && v !== 'false'; // default true
}

function currentTier() {
  const raw = runtimeConfig.get('LIVE_RAMP_TIER');
  const t = parseInt(raw ?? 0, 10);
  return Math.max(0, Math.min(TIERS.length - 1, Number.isFinite(t) ? t : 0));
}

/**
 * Capital multiplier to apply in the sizing chain.
 * Returns 1.0 when disabled so existing behavior is preserved.
 */
function getMultiplier() {
  if (!enabled()) return 1.0;
  return TIERS[currentTier()].capitalPct;
}

/**
 * Evaluate whether we can advance to the next tier based on the last
 * `lookbackTrades` closed trades. Also detects drawdown breaches that
 * trigger a demotion.
 */
async function evaluateGates(lookbackTrades = 50) {
  try {
    const { rows } = await db.query(
      `SELECT pnl, entry_price, qty, closed_at
         FROM trades
        WHERE status = 'closed' AND pnl IS NOT NULL
        ORDER BY closed_at DESC
        LIMIT $1`,
      [lookbackTrades],
    );

    if (rows.length === 0) {
      return { totalTrades: 0, winRate: 0, maxDrawdown: 0, canAdvance: false, shouldDemote: false };
    }

    const totalTrades = rows.length;
    const wins = rows.filter((r) => Number(r.pnl) > 0).length;
    const winRate = wins / totalTrades;

    // Compute max drawdown from running equity over the lookback.
    // Trades are ordered DESC by closed_at; reverse so we walk
    // chronologically. Normalize by either peak equity or the sum of
    // absolute P&L (turnover) so drawdown is meaningful even when the
    // window starts with losing trades.
    const ordered = rows.slice().reverse();
    let peak = 0;
    let running = 0;
    let maxDDDollars = 0;
    let turnover = 0;
    for (const r of ordered) {
      const pnl = Number(r.pnl);
      running += pnl;
      turnover += Math.abs(pnl);
      if (running > peak) peak = running;
      const ddDollars = peak - running;
      if (ddDollars > maxDDDollars) maxDDDollars = ddDollars;
    }
    const normalizer = Math.max(peak, turnover, 1);
    const maxDD = maxDDDollars / normalizer;

    const tier = currentTier();
    const nextTier = TIERS[tier + 1];
    const canAdvance =
      nextTier != null &&
      totalTrades >= nextTier.minTrades &&
      winRate >= nextTier.minWinRate &&
      maxDD <= nextTier.maxDrawdown;

    const currentRules = TIERS[tier];
    const shouldDemote = tier > 0 && maxDD > currentRules.maxDrawdown;

    return { totalTrades, winRate, maxDrawdown: maxDD, canAdvance, shouldDemote };
  } catch (err) {
    error('live-ramp: evaluateGates failed', err);
    return { totalTrades: 0, winRate: 0, maxDrawdown: 0, canAdvance: false, shouldDemote: false, error: err.message };
  }
}

/**
 * Check the gates and auto-advance/demote the tier if warranted.
 * Called by a periodic scheduler (daily). Emits an alert on any change.
 */
async function checkAndAdvance() {
  if (!enabled()) return { changed: false, reason: 'disabled' };
  if (!autoAdvance()) return { changed: false, reason: 'auto_advance_disabled' };

  const gates = await evaluateGates();
  const tier = currentTier();

  if (gates.shouldDemote && tier > 0) {
    const newTier = tier - 1;
    await runtimeConfig.set('LIVE_RAMP_TIER', newTier);
    log(`live-ramp: DEMOTED tier ${tier} → ${newTier} (drawdown ${(gates.maxDrawdown * 100).toFixed(1)}%)`);
    try {
      require('./alerting').critical(
        `Live ramp demoted to ${TIERS[newTier].label}`,
        `Max drawdown ${(gates.maxDrawdown * 100).toFixed(1)}% exceeded tier ${tier} limit of ${(TIERS[tier].maxDrawdown * 100).toFixed(0)}%. Capital multiplier dropped to ${TIERS[newTier].capitalPct * 100}%.`,
        { fromTier: tier, toTier: newTier, maxDrawdown: gates.maxDrawdown },
      );
    } catch {}
    return { changed: true, direction: 'demote', fromTier: tier, toTier: newTier, gates };
  }

  if (gates.canAdvance) {
    const newTier = tier + 1;
    await runtimeConfig.set('LIVE_RAMP_TIER', newTier);
    log(
      `live-ramp: ADVANCED tier ${tier} → ${newTier} (trades=${gates.totalTrades}, winRate=${(gates.winRate * 100).toFixed(0)}%)`,
    );
    try {
      require('./alerting').info(
        `Live ramp advanced to ${TIERS[newTier].label}`,
        `Gates passed: ${gates.totalTrades} trades, ${(gates.winRate * 100).toFixed(0)}% win rate, ${(gates.maxDrawdown * 100).toFixed(1)}% max DD. Capital multiplier now ${TIERS[newTier].capitalPct * 100}%.`,
        { fromTier: tier, toTier: newTier, ...gates },
      );
    } catch {}
    return { changed: true, direction: 'advance', fromTier: tier, toTier: newTier, gates };
  }

  return { changed: false, gates, tier };
}

/**
 * Status snapshot for `/api/live-ramp/status`.
 */
async function getStatus() {
  const tier = currentTier();
  const gates = await evaluateGates();
  const tierInfo = TIERS[tier];
  const nextTier = TIERS[tier + 1];
  return {
    enabled: enabled(),
    autoAdvance: autoAdvance(),
    tier,
    label: tierInfo.label,
    capitalPct: tierInfo.capitalPct,
    multiplier: getMultiplier(),
    gates,
    nextTier: nextTier
      ? {
          tier: nextTier.tier,
          label: nextTier.label,
          capitalPct: nextTier.capitalPct,
          minTrades: nextTier.minTrades,
          minWinRate: nextTier.minWinRate,
          maxDrawdown: nextTier.maxDrawdown,
          tradesRemaining: Math.max(0, nextTier.minTrades - gates.totalTrades),
          winRateGap: +(nextTier.minWinRate - gates.winRate).toFixed(3),
        }
      : null,
    allTiers: TIERS,
  };
}

module.exports = {
  enabled,
  getMultiplier,
  evaluateGates,
  checkAndAdvance,
  getStatus,
  currentTier,
  TIERS,
};
