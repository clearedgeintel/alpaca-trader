/**
 * External trigger for the agency cycle.
 *
 * Lets other modules (e.g. realtime-scanner) kick off an out-of-cycle
 * agency run when they detect something worth acting on, instead of
 * waiting for the next scheduled 5-min tick.
 *
 * index.js calls `register(runner)` once at startup to provide the
 * actual `runAgencyCycle` function. Until then, triggers are no-ops.
 *
 * Debounced: a successful trigger blocks further triggers for
 * MIN_INTERVAL_MS so a burst of simultaneous crossovers collapses
 * to one cycle instead of queuing dozens.
 */

const { log } = require('./logger');

const MIN_INTERVAL_MS = 60 * 1000; // 60s between triggered runs

let runner = null;
let lastTriggeredAt = 0;
let inFlight = null;

function register(fn) {
  runner = fn;
}

/**
 * Request an out-of-cycle agency run. Returns true if a run was
 * triggered (or is already in flight), false if the debounce window
 * suppressed it.
 */
async function trigger(reason = 'external') {
  if (!runner) return false;
  const now = Date.now();
  if (inFlight) return true;
  if (now - lastTriggeredAt < MIN_INTERVAL_MS) {
    log(`Agency trigger suppressed (${reason}) — last ran ${Math.round((now - lastTriggeredAt) / 1000)}s ago`);
    return false;
  }
  lastTriggeredAt = now;
  log(`Agency trigger fired: ${reason}`);
  inFlight = runner({ force: true, reason })
    .catch((err) => log(`Triggered cycle error: ${err?.message || err}`))
    .finally(() => { inFlight = null; });
  return true;
}

function getStats() {
  return {
    registered: !!runner,
    lastTriggeredAt: lastTriggeredAt > 0 ? new Date(lastTriggeredAt).toISOString() : null,
    minIntervalMs: MIN_INTERVAL_MS,
    inFlight: !!inFlight,
  };
}

module.exports = { register, trigger, getStats };
