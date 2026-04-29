/**
 * In-memory ring buffer of agency cycle outcomes.
 *
 * Captures everything needed to answer "why didn't I trade today?"
 * without tailing Railway logs:
 *   - When each cycle started + completed
 *   - Whether the cycle-guard skipped it (and why)
 *   - How many decisions the orchestrator produced
 *   - For each decision: executed or skipped + reason
 *
 * 200 events kept; oldest evicted as new ones arrive.
 */

const MAX_EVENTS = 200;
const events = [];

function record(event) {
  events.push({ ...event, ts: new Date().toISOString() });
  if (events.length > MAX_EVENTS) events.shift();
}

function cycleStarted({ cycleNumber, force, reason, marketOpen, watchlist }) {
  record({
    type: 'cycle_started',
    cycleNumber,
    force: !!force,
    reason: reason || (force ? 'forced' : 'scheduled'),
    marketOpen: !!marketOpen,
    watchlistSize: watchlist?.length || 0,
  });
}

function cycleSkipped({ cycleNumber, reason }) {
  record({ type: 'cycle_skipped', cycleNumber, reason });
}

function cycleCompleted({ cycleNumber, decisionCount, durationMs }) {
  record({ type: 'cycle_completed', cycleNumber, decisionCount, durationMs });
}

function decisionOutcome({ cycleNumber, symbol, action, confidence, executed, reason }) {
  record({
    type: executed ? 'order_placed' : 'order_skipped',
    cycleNumber,
    symbol,
    action,
    confidence,
    reason: reason || null,
  });
}

/**
 * Orchestrator-side events — surface what's happening inside synthesis
 * so we can answer "cycles run but produce 0 decisions" without log diving.
 */
function orchestratorSignals({ cycleNumber, buyCount, sellCount, holdCount, taBuySymbols, taSellSymbols }) {
  record({
    type: 'orchestrator_signals',
    cycleNumber,
    buyCount,
    sellCount,
    holdCount,
    taBuySymbols: taBuySymbols || [],
    taSellSymbols: taSellSymbols || [],
  });
}

function orchestratorShortCircuit({ cycleNumber, reason }) {
  record({ type: 'orchestrator_short_circuit', cycleNumber, reason });
}

function orchestratorSynthesis({ cycleNumber, rawDecisions, finalDecisions, minConfidence, droppedByConfidence }) {
  record({
    type: 'orchestrator_synthesis',
    cycleNumber,
    rawDecisions,
    finalDecisions,
    minConfidence,
    droppedByConfidence,
  });
}

function getRecent(limit = 50) {
  return events.slice(-limit).reverse();
}

/**
 * Aggregate outcomes over the last N cycles. Returns:
 *   { cycles: <count>, decisions: <count>, executed: <count>,
 *     skipReasons: { '<reason>': <count>, ... } }
 */
function summarize(lastN = 20) {
  const recentCycles = events
    .filter((e) => e.type === 'cycle_started')
    .slice(-lastN)
    .map((e) => e.cycleNumber);
  const set = new Set(recentCycles);

  let decisions = 0;
  let executed = 0;
  const skipReasons = {};
  for (const e of events) {
    if (!set.has(e.cycleNumber)) continue;
    if (e.type === 'order_placed') {
      decisions++;
      executed++;
    } else if (e.type === 'order_skipped') {
      decisions++;
      const r = e.reason || 'unknown';
      skipReasons[r] = (skipReasons[r] || 0) + 1;
    }
  }

  return {
    cycles: recentCycles.length,
    decisions,
    executed,
    skipReasons,
  };
}

function reset() {
  events.length = 0;
}

module.exports = {
  cycleStarted,
  cycleSkipped,
  cycleCompleted,
  decisionOutcome,
  orchestratorSignals,
  orchestratorShortCircuit,
  orchestratorSynthesis,
  getRecent,
  summarize,
  reset,
};
