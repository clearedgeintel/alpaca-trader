/**
 * Smart Order Router — places a limit order at (or near) the midpoint,
 * polls briefly for fill, and falls back to a market order on timeout.
 *
 * Rationale: market orders cross the bid-ask spread in full. For liquid
 * names the spread is narrow but non-zero; for less-liquid names or
 * crypto pairs it can be material. Placing a limit at mid + small
 * offset (2 bps default) usually fills on or near the ask, capturing
 * most of the spread as price improvement while still filling quickly.
 *
 * Opt-in via SMART_ORDER_ROUTING_ENABLED (default false) so operators
 * can observe savings before activating. When disabled, `placeSmartOrder`
 * transparently routes to a plain market order — callers need no
 * branching logic.
 */

const alpaca = require('./alpaca');
const runtimeConfig = require('./runtime-config');
const { log, error } = require('./logger');

// Defaults — overridable via runtime-config
const DEFAULT_OFFSET_BPS = 2; // 0.02% = 2 basis points over/under mid
const DEFAULT_TIMEOUT_MS = 30_000; // cancel + market-fallback after 30s
const DEFAULT_POLL_MS = 2_000; // poll order status every 2s

function enabled() {
  const v = runtimeConfig.get('SMART_ORDER_ROUTING_ENABLED');
  return v === true || v === 'true';
}

function getConfig() {
  return {
    offsetBps: parseFloat(runtimeConfig.get('SOR_OFFSET_BPS') ?? DEFAULT_OFFSET_BPS),
    timeoutMs: parseInt(runtimeConfig.get('SOR_TIMEOUT_MS') ?? DEFAULT_TIMEOUT_MS, 10),
    pollMs: parseInt(runtimeConfig.get('SOR_POLL_MS') ?? DEFAULT_POLL_MS, 10),
  };
}

/**
 * Compute the midpoint from an Alpaca snapshot. Returns null if bid/ask
 * is missing or zero (some symbols, especially outside trading hours).
 */
function computeMidPrice(snapshot) {
  const bid = snapshot?.latestQuote?.bp ?? 0;
  const ask = snapshot?.latestQuote?.ap ?? 0;
  if (!bid || !ask || bid >= ask) return null;
  return (bid + ask) / 2;
}

/**
 * Given a snapshot and side, compute the limit price.
 * BUY: mid + offsetBps → more aggressive, likely to fill on ask
 * SELL: mid - offsetBps → more aggressive, likely to fill on bid
 *
 * Returns null if no usable quote is available.
 */
function computeLimitPrice(snapshot, side, offsetBps = DEFAULT_OFFSET_BPS) {
  const mid = computeMidPrice(snapshot);
  if (mid == null) return null;
  const offset = mid * (offsetBps / 10000);
  const limit = side === 'buy' ? mid + offset : mid - offset;
  return +limit.toFixed(4);
}

/**
 * Compute savings in basis points vs a market-order reference price.
 * Positive = we got a better fill than crossing the full spread.
 *
 * For BUY: reference = ask (would have paid this as market). savings
 *   in bps = (ask - filled) / ask × 10000. Positive when filled < ask.
 * For SELL: reference = bid. savings = (filled - bid) / bid × 10000.
 *   Positive when filled > bid.
 */
function computeSavingsBps(side, filledPrice, snap) {
  const bid = snap?.latestQuote?.bp ?? 0;
  const ask = snap?.latestQuote?.ap ?? 0;
  if (!bid || !ask || !filledPrice) return 0;
  const ref = side === 'buy' ? ask : bid;
  if (!ref) return 0;
  const delta = side === 'buy' ? ref - filledPrice : filledPrice - bid;
  return +((delta / ref) * 10000).toFixed(2);
}

/**
 * Place an order using the smart router. Returns the filled order plus
 * metadata about strategy used (limit vs market_fallback) and estimated
 * price improvement in basis points.
 *
 * When SMART_ORDER_ROUTING_ENABLED is false, placement is identical to
 * `alpaca.placeOrder` — the router adds no latency or cost.
 */
async function placeSmartOrder({ symbol, qty, side, snapshot }) {
  if (!enabled()) {
    const order = await alpaca.placeOrder(symbol, qty, side);
    return { order, strategy: 'market', midPrice: null, savingsBps: 0, limitPrice: null };
  }

  const cfg = getConfig();
  // Fetch a fresh snapshot if the caller didn't supply one
  let snap = snapshot;
  if (!snap) {
    try {
      snap = await alpaca.getSnapshot(symbol);
    } catch {
      /* fall through to market */
    }
  }
  const mid = computeMidPrice(snap);
  const limitPrice = computeLimitPrice(snap, side, cfg.offsetBps);

  // No usable quote → fall back to market immediately
  if (!mid || !limitPrice) {
    const order = await alpaca.placeOrder(symbol, qty, side);
    return { order, strategy: 'market_fallback', reason: 'no_quote', midPrice: null, savingsBps: 0, limitPrice: null };
  }

  // Submit limit order
  let limitOrder;
  try {
    limitOrder = await alpaca.placeLimitOrder(symbol, qty, side, limitPrice);
  } catch (err) {
    error(`SOR: limit order submit failed for ${symbol}, falling back to market`, err);
    const order = await alpaca.placeOrder(symbol, qty, side);
    return {
      order,
      strategy: 'market_fallback',
      reason: 'limit_submit_failed',
      midPrice: mid,
      savingsBps: 0,
      limitPrice,
    };
  }

  // Poll for fill
  const deadline = Date.now() + cfg.timeoutMs;
  let status = limitOrder.status;
  let filledQty = 0;
  let filledPrice = 0;

  while (Date.now() < deadline && !['filled', 'partially_filled'].includes(status)) {
    if (['rejected', 'cancelled', 'expired'].includes(status)) break;
    await new Promise((r) => setTimeout(r, cfg.pollMs));
    try {
      const updated = await alpaca.getOrder(limitOrder.id);
      status = updated.status;
      filledQty = parseFloat(updated.filled_qty || '0');
      filledPrice = parseFloat(updated.filled_avg_price || '0');
    } catch (pollErr) {
      error(`SOR: poll failed for ${limitOrder.id}`, pollErr);
    }
  }

  // Fully filled on limit → we're done
  if (status === 'filled' && filledPrice > 0) {
    const savingsBps = computeSavingsBps(side, filledPrice, snap);
    log(
      `SOR fill: ${symbol} ${side} ${filledQty} @ $${filledPrice} (mid=$${mid.toFixed(4)}, savings=${savingsBps}bps)`,
    );
    return { order: limitOrder, strategy: 'limit', midPrice: mid, limitPrice, filledPrice, savingsBps };
  }

  // Partial fill → keep the filled portion, cancel the rest, and
  // market-fallback for the remainder. Alpaca's cancel is idempotent.
  const remainingQty = parseFloat(qty) - filledQty;
  try {
    await alpaca.cancelOrder(limitOrder.id);
  } catch {
    // Order may have just filled while we were deciding; non-fatal
  }

  if (remainingQty > 0) {
    const fallbackOrder = await alpaca.placeOrder(symbol, remainingQty, side);
    const partialSavingsBps =
      filledQty > 0 ? computeSavingsBps(side, filledPrice, snap) * (filledQty / parseFloat(qty)) : 0;
    const reason = filledQty > 0 ? 'timeout_partial' : 'timeout_nofill';
    log(
      `SOR market-fallback: ${symbol} ${side} — ${filledQty > 0 ? `partial ${filledQty}/${qty} on limit, ` : 'no fill on limit, '}remainder ${remainingQty} on market`,
    );
    return {
      order: fallbackOrder,
      strategy: 'market_fallback',
      reason,
      midPrice: mid,
      limitPrice,
      savingsBps: +partialSavingsBps.toFixed(2),
    };
  }

  // Fully filled after the loop exited (rare edge)
  return { order: limitOrder, strategy: 'limit', midPrice: mid, limitPrice, filledPrice, savingsBps: 0 };
}

module.exports = {
  enabled,
  getConfig,
  computeMidPrice,
  computeLimitPrice,
  computeSavingsBps,
  placeSmartOrder,
};
