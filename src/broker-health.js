/**
 * Broker-health tracker. Phase 1 safety prereq for path-to-live.
 *
 * Detects sustained Alpaca outages (not transient retries) and exposes
 * isHealthy() for the execution path. Three states:
 *
 *   HEALTHY    — < FAILURE_THRESHOLD outage-signal failures in window
 *   OUTAGE     — ≥ FAILURE_THRESHOLD failures spread > FAILURE_SPACING_MS
 *                apart in the WINDOW_MS rolling window, no success since
 *   RECOVERING — had a success after the last failure, but < GRACE_MS
 *                ago; we hold off new BUYs during the grace period to
 *                avoid placing an order during an intermittent flap
 *
 * Failure throttling: failures less than FAILURE_SPACING_MS after the
 * previous counted failure DO NOT count separately. This filters out
 * the "3 quick retries to the same endpoint" pattern (which is a single
 * incident) from the "3 separate calls failed over a minute" pattern
 * (which is sustained outage).
 *
 * Outage signals (counted): network errors (TypeError, ECONNRESET,
 * ETIMEDOUT), HTTP 5xx. Legitimate 4xx (404 on position lookup, etc.)
 * are NOT outage signals.
 *
 * Open positions during outage: stay open. Monitor's stop/target logic
 * tolerates failed fetches gracefully. Panic-exiting on outage is worse
 * than holding through — the panic exits often fill at the bottom of
 * the volatility wave the outage caused.
 */

const WINDOW_MS = 5 * 60 * 1000; // failures older than 5 min age out
const FAILURE_THRESHOLD = 3;
const FAILURE_SPACING_MS = 30 * 1000; // failures must be > 30s apart to count
const GRACE_MS = 60 * 1000; // 60s grace after first success before HEALTHY

const failures = []; // [{ at: number (ms), error: string }]
let lastSuccessAt = null;
let outageStartedAt = null;
let lastAlertedState = 'HEALTHY';

function isOutageSignal(err) {
  if (!err) return false;
  if (err.name === 'TypeError') return true; // fetch network error
  if (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') return true;
  if (err.status && err.status >= 500) return true;
  if (err.message && /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(err.message)) return true;
  return false;
}

function _pruneOldFailures(now) {
  while (failures.length > 0 && now - failures[0].at > WINDOW_MS) {
    failures.shift();
  }
}

function recordSuccess() {
  lastSuccessAt = Date.now();
}

function recordFailure(err) {
  if (!isOutageSignal(err)) return;
  const now = Date.now();
  // Throttle: failures less than FAILURE_SPACING_MS after the previous
  // counted failure DO NOT count separately (retry burst, not outage).
  const lastFail = failures[failures.length - 1];
  if (lastFail && now - lastFail.at < FAILURE_SPACING_MS) {
    return;
  }
  failures.push({ at: now, error: err.message || String(err) });
  _pruneOldFailures(now);
  if (failures.length >= FAILURE_THRESHOLD && !outageStartedAt) {
    outageStartedAt = now;
    _maybeAlert('OUTAGE');
  }
}

function getState() {
  const now = Date.now();
  _pruneOldFailures(now);
  if (failures.length < FAILURE_THRESHOLD) {
    if (outageStartedAt) {
      // Failures aged out of window — clear outage
      outageStartedAt = null;
      _maybeAlert('HEALTHY');
    }
    return 'HEALTHY';
  }
  const lastFail = failures[failures.length - 1].at;
  if (lastSuccessAt && lastSuccessAt > lastFail) {
    if (now - lastFail > GRACE_MS) {
      outageStartedAt = null;
      _maybeAlert('HEALTHY');
      return 'HEALTHY';
    }
    return 'RECOVERING';
  }
  return 'OUTAGE';
}

function isHealthy() {
  return getState() === 'HEALTHY';
}

function getStatus() {
  const state = getState();
  return {
    state,
    failures: failures.length,
    outageStartedAt: outageStartedAt ? new Date(outageStartedAt).toISOString() : null,
    lastSuccessAt: lastSuccessAt ? new Date(lastSuccessAt).toISOString() : null,
    lastFailure: failures.length > 0 ? failures[failures.length - 1] : null,
  };
}

function _maybeAlert(newState) {
  if (newState === lastAlertedState) return;
  lastAlertedState = newState;
  try {
    const { warn, log } = require('./logger');
    if (newState === 'OUTAGE') {
      warn(`🚨 BROKER OUTAGE detected — ${failures.length} sustained failures, new BUYs blocked until recovery`);
      try {
        require('./alerting').warn(
          'Broker outage detected',
          `${failures.length} consecutive Alpaca failures spread > 30s apart in last 5 min. New BUYs blocked until a successful call clears the grace period.`,
          getStatus(),
        );
      } catch { /* alerting optional */ }
    } else if (newState === 'HEALTHY') {
      log(`✅ BROKER recovered — accepting new BUYs again`);
    }
  } catch { /* logger optional in tests */ }
}

function _resetForTests() {
  failures.length = 0;
  lastSuccessAt = null;
  outageStartedAt = null;
  lastAlertedState = 'HEALTHY';
}

module.exports = {
  recordSuccess,
  recordFailure,
  getState,
  isHealthy,
  getStatus,
  isOutageSignal,
  _resetForTests,
  // tunable for tests
  _config: { WINDOW_MS, FAILURE_THRESHOLD, FAILURE_SPACING_MS, GRACE_MS },
};
