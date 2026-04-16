/**
 * Threshold-based monitoring alerts. Runs every 5 minutes and fires
 * alerts through the existing alerting.js multi-channel dispatcher
 * (Slack/Telegram/Discord) when production SLOs are breached.
 *
 * Alerts are deduped in alerting.js's 5-min window so a sustained
 * breach produces one alert, not a storm.
 *
 * All thresholds are tunable via runtime-config so operators can
 * adjust noise without a deploy.
 */

const alerting = require('./alerting');
const runtimeConfig = require('./runtime-config');
const config = require('./config');
const { log, error } = require('./logger');

function threshold(key, defaultVal) {
  const v = runtimeConfig.get(key);
  return v == null ? defaultVal : parseFloat(v);
}

function enabled() {
  const v = runtimeConfig.get('MONITORING_ALERTS_ENABLED');
  return v !== false && v !== 'false'; // default ON
}

/**
 * Single pass — evaluate every alert rule, fire where breached.
 * Returns a report so a dashboard endpoint can show current state.
 */
async function runAlertChecks() {
  if (!enabled()) return { enabled: false, fired: [], checked: 0 };

  const fired = [];
  const checked = [];

  // --- LLM cost approaching cap ---
  try {
    const llm = require('./agents/llm').getUsage();
    const costPct = llm.dailyCostCapUsd > 0 ? llm.estimatedCostUsd / llm.dailyCostCapUsd : 0;
    const warnAt = threshold('ALERT_LLM_COST_WARN_PCT', 0.8);
    const critAt = threshold('ALERT_LLM_COST_CRIT_PCT', 0.95);
    checked.push('llm_cost');
    if (costPct >= critAt) {
      await alerting.critical(
        'LLM daily cost critical',
        `Spend at ${(costPct * 100).toFixed(0)}% of $${llm.dailyCostCapUsd} cap — agency will pause imminently.`,
        { costUsd: llm.estimatedCostUsd, capUsd: llm.dailyCostCapUsd },
      );
      fired.push({ rule: 'llm_cost_critical', pct: costPct });
    } else if (costPct >= warnAt) {
      await alerting.warn(
        'LLM daily cost elevated',
        `Spend at ${(costPct * 100).toFixed(0)}% of $${llm.dailyCostCapUsd} cap.`,
        { costUsd: llm.estimatedCostUsd },
      );
      fired.push({ rule: 'llm_cost_warn', pct: costPct });
    }
  } catch (err) {
    error('monitoring-alerts: llm_cost check failed', err);
  }

  // --- Circuit breaker stuck open ---
  try {
    const llm = require('./agents/llm').getUsage();
    if (llm.circuitBreakerOpen && llm.breakerOpenUntil) {
      const remainSec = Math.max(0, (new Date(llm.breakerOpenUntil).getTime() - Date.now()) / 1000);
      checked.push('circuit_breaker');
      // Only alert if breaker is open with significant remaining time; short blips
      // (<60s) will self-resolve before the next check.
      if (remainSec > 60) {
        await alerting.critical(
          'LLM circuit breaker open',
          `${Math.ceil(remainSec)}s remaining. Agency is in rule-based fallback. Check Anthropic status + API key.`,
          { remainSec, breakerOpenUntil: llm.breakerOpenUntil },
        );
        fired.push({ rule: 'circuit_breaker_open', remainSec });
      }
    }
  } catch (err) {
    error('monitoring-alerts: circuit_breaker check failed', err);
  }

  // --- Stale scan during market hours ---
  try {
    const { DateTime } = require('luxon');
    const now = DateTime.now().setZone('America/New_York');
    const hour = now.hour + now.minute / 60;
    const isMarketHour = now.weekday <= 5 && hour >= 9.5833 && hour <= 15.833;
    if (isMarketHour) {
      const lastScanTs = require('./server')._getLastScanTime?.();
      if (lastScanTs) {
        const ageSec = (Date.now() - new Date(lastScanTs).getTime()) / 1000;
        const maxAgeSec = threshold('ALERT_SCAN_STALE_SEC', 1800); // 30 min
        checked.push('scan_stale');
        if (ageSec > maxAgeSec) {
          await alerting.critical(
            'Scan cycle stale during market hours',
            `Last scan was ${Math.floor(ageSec / 60)} min ago (limit ${maxAgeSec / 60} min). Agents may be deadlocked.`,
            { ageSec, lastScanTs },
          );
          fired.push({ rule: 'scan_stale', ageSec });
        }
      }
    }
  } catch {
    // server module may not export _getLastScanTime; skip silently
  }

  // --- Daily drawdown breach ---
  try {
    const db = require('./db');
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(pnl), 0) AS day_pnl, COALESCE(MAX(portfolio_value), 0) AS peak
         FROM daily_performance WHERE trade_date >= CURRENT_DATE - INTERVAL '1 day'`,
    );
    const dayPnl = Number(rows[0]?.day_pnl || 0);
    const peak = Number(rows[0]?.peak || 0);
    const ddPct = peak > 0 && dayPnl < 0 ? Math.abs(dayPnl) / peak : 0;
    const maxDD = threshold('ALERT_DAILY_DD_PCT', 0.05);
    checked.push('daily_drawdown');
    if (ddPct > maxDD) {
      await alerting.critical(
        'Daily drawdown exceeded threshold',
        `Today's P&L $${dayPnl.toFixed(2)} vs $${peak.toFixed(2)} portfolio = ${(ddPct * 100).toFixed(1)}% drawdown (limit ${(maxDD * 100).toFixed(0)}%).`,
        { dayPnl, peak, ddPct },
      );
      fired.push({ rule: 'daily_drawdown', ddPct });
    }
  } catch (err) {
    error('monitoring-alerts: daily_drawdown check failed', err);
  }

  // --- Open positions count ---
  try {
    const db = require('./db');
    const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM trades WHERE status = 'open'`);
    const n = rows[0]?.n || 0;
    const maxPositions = threshold('ALERT_MAX_OPEN_POSITIONS', 20);
    checked.push('open_positions');
    if (n > maxPositions) {
      await alerting.warn(
        'Open positions above threshold',
        `${n} positions open (warn at ${maxPositions}). Either the strategy is over-trading or exits aren't firing.`,
        { openPositions: n },
      );
      fired.push({ rule: 'open_positions_high', count: n });
    }
  } catch (err) {
    error('monitoring-alerts: open_positions check failed', err);
  }

  // --- .env staleness (rotation reminder) ---
  try {
    const fs = require('fs');
    const path = require('path');
    const stat = fs.statSync(path.join(__dirname, '..', '.env'));
    const ageDays = Math.floor((Date.now() - stat.mtime.getTime()) / 86400000);
    const maxAge = threshold('ALERT_ENV_STALE_DAYS', 90);
    checked.push('env_staleness');
    if (ageDays > maxAge) {
      await alerting.warn(
        'Secrets rotation overdue',
        `.env last modified ${ageDays} days ago (limit ${maxAge}). See docs/SECRETS.md for rotation procedure.`,
        { ageDays },
      );
      fired.push({ rule: 'env_stale', ageDays });
    }
  } catch {
    // .env may not exist (deploy platform injects env directly); skip
  }

  return { enabled: true, fired, checked, checkedAt: new Date().toISOString() };
}

let schedulerHandle = null;

/**
 * Start the 5-minute periodic checker. Returns the interval handle.
 */
function startMonitoringScheduler(intervalMs = 5 * 60 * 1000) {
  if (schedulerHandle) return schedulerHandle;
  schedulerHandle = setInterval(() => {
    runAlertChecks().catch((err) => error('monitoring-alerts: scheduler tick failed', err));
  }, intervalMs);
  log(`Monitoring alerts scheduler started (every ${intervalMs / 1000}s)`);
  return schedulerHandle;
}

function stopMonitoringScheduler() {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
}

module.exports = { runAlertChecks, startMonitoringScheduler, stopMonitoringScheduler, enabled };

// Silence unused-variable lint for future scoped config use
void config;
