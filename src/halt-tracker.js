/**
 * In-memory tracker for trading halts. Fed by the IEX `statuses` stream
 * (alpaca-stream subscribes; pushes status events here). Two consumers:
 *
 *   - execution-agent calls isHalted(symbol) before placing new BUYs
 *   - monitor calls isHalted(symbol) before firing exit logic on opens
 *
 * Halt status codes from the Alpaca / IEX feed are documented at
 * https://docs.alpaca.markets/docs/real-time-stock-pricing-data.
 * We translate the codes to a single boolean (halted vs not) plus
 * keep the latest event for dashboard display. Subset that matters
 * for trade-path decisions:
 *
 *   HALTED:    B, C, D, E, H, J, K, M, P
 *              (any halt — news pending, LULD, SEC, corporate action,
 *              new IPO/issue, other)
 *   RESUMED:   Q, R, T, O (operational/normal trading resumption)
 *              and "Resume" string in sm
 *
 * Unknown codes default to NOT halted (don't accidentally block trading
 * on a feed quirk we haven't seen before — explicit allow-list is
 * safer than implicit deny).
 */

const HALT_CODES = new Set([
  'B', // Buy-side trading halt
  'C', // Trading halt - news pending
  'D', // Trading halt - news disseminated, awaiting clearance
  'E', // Trading halt - SEC suspension
  'H', // Trading halt - other
  'J', // LULD volatility pause
  'K', // LULD straddle condition
  'M', // Trading halt - corporate action
  'P', // Trading halt - new IPO / secondary offering
]);

const RESUME_CODES = new Set([
  'Q', // Quotation resumption
  'R', // Resume - other
  'T', // Trading resumption
  'O', // Operational state - back to normal
]);

// symbol → { halted: bool, code, reason, since: Date, lastEventAt: Date }
const state = new Map();

function _normalize(symbol) {
  return String(symbol || '').toUpperCase().trim();
}

/**
 * Apply a status message from the IEX stream.
 *   msg.S  = symbol
 *   msg.sc = status code
 *   msg.sm = status message (string)
 *   msg.rc = reason code (optional)
 *   msg.rm = reason message (optional)
 *   msg.t  = timestamp
 */
function applyStatusEvent(msg) {
  if (!msg || !msg.S) return null;
  const symbol = _normalize(msg.S);
  const code = String(msg.sc || '').toUpperCase();

  let halted;
  if (HALT_CODES.has(code)) halted = true;
  else if (RESUME_CODES.has(code)) halted = false;
  else {
    // Unknown code — leave state unchanged but record for telemetry.
    const existing = state.get(symbol);
    state.set(symbol, {
      halted: existing?.halted ?? false,
      code,
      reason: msg.sm || msg.rm || 'unknown status',
      since: existing?.since ?? new Date(),
      lastEventAt: new Date(),
    });
    return { symbol, halted: existing?.halted ?? false, code, transition: 'unknown' };
  }

  const prev = state.get(symbol);
  const transition = prev?.halted === halted ? 'unchanged' : halted ? 'halted' : 'resumed';
  state.set(symbol, {
    halted,
    code,
    reason: msg.sm || msg.rm || code,
    since: transition === 'unchanged' ? prev.since : new Date(),
    lastEventAt: new Date(),
  });
  return { symbol, halted, code, transition };
}

function isHalted(symbol) {
  const s = _normalize(symbol);
  return state.get(s)?.halted === true;
}

function getStatus(symbol) {
  return state.get(_normalize(symbol)) || null;
}

function getHaltedSymbols() {
  const out = [];
  for (const [symbol, s] of state.entries()) {
    if (s.halted) out.push({ symbol, ...s });
  }
  return out;
}

function reset() {
  state.clear();
}

module.exports = {
  applyStatusEvent,
  isHalted,
  getStatus,
  getHaltedSymbols,
  reset,
  // exposed for tests
  HALT_CODES,
  RESUME_CODES,
};
