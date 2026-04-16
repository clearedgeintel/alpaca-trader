/**
 * Smart position scaling — pure-function decision module.
 *
 * The monitor calls `shouldScaleIn()` on each open position; if it
 * returns a decision object (`{ scaleIn: true, addQty, ... }`), the
 * monitor places the order and updates the trade row.
 *
 * The decision is entirely price + ATR driven (v1). A future version
 * could require orchestrator/technical confirmation before triggering.
 *
 * Mutual exclusion: a trade that has already partially exited
 * (`order_type === 'scaled_out'`) is never a scale-in candidate;
 * a trade that has scaled in (`order_type === 'scaled_in'`) is never
 * a partial-exit candidate. First event that fires wins.
 */

const config = require('./config');
const runtimeConfig = require('./runtime-config');

function enabled() {
  const v = runtimeConfig.get('SCALE_IN_ENABLED');
  return v === true || v === 'true';
}

function getConfig() {
  return {
    triggerAtr: parseFloat(runtimeConfig.get('SCALE_IN_TRIGGER_ATR') ?? 1.5),
    sizePct: parseFloat(runtimeConfig.get('SCALE_IN_SIZE_PCT') ?? 0.5),
    maxCount: parseInt(runtimeConfig.get('SCALE_IN_MAX_COUNT') ?? 2, 10),
    maxPosPct: runtimeConfig.get('MAX_POS_PCT') ?? config.MAX_POS_PCT,
  };
}

/**
 * Decide whether to scale into a winning position.
 *
 * Returns `{ scaleIn: false, reason }` or `{ scaleIn: true, addQty,
 * triggerPrice, newBlendedEntry, newStop }`. The caller (monitor)
 * places the order and writes the DB updates.
 *
 * @param {object} trade — the DB trade row (with qty, entry_price, stop_loss, etc.)
 * @param {number} currentPrice
 * @param {number|null} atr — daily ATR for the symbol
 * @param {number} portfolioValue — current account portfolio_value
 */
function shouldScaleIn(trade, currentPrice, atr, portfolioValue) {
  if (!enabled()) return { scaleIn: false, reason: 'disabled' };
  if (!atr || atr <= 0) return { scaleIn: false, reason: 'no_atr' };

  const cfg = getConfig();
  const qty = Number(trade.qty);
  const entryPrice = Number(trade.entry_price);
  const originalQty = Number(trade.original_qty || trade.qty);
  const scaleInsCount = Number(trade.scale_ins_count || 0);

  // Mutual exclusion — already took partial profits → don't add back
  if (trade.order_type === 'scaled_out') {
    return { scaleIn: false, reason: 'already_scaled_out' };
  }

  // Max scale-ins cap
  if (scaleInsCount >= cfg.maxCount) {
    return { scaleIn: false, reason: 'max_count_reached' };
  }

  // Stepwise trigger: each successive scale-in requires an additional
  // triggerAtr × ATR of profit above entry. So scale-in #1 triggers at
  // entry + 1 × triggerAtr × ATR, #2 at entry + 2 × triggerAtr × ATR, etc.
  const triggerPrice = entryPrice + (scaleInsCount + 1) * cfg.triggerAtr * atr;
  if (currentPrice < triggerPrice) {
    return { scaleIn: false, reason: 'below_trigger', triggerPrice };
  }

  // Guard against re-firing at the same price level within a cycle
  if (trade.last_scale_in_price && currentPrice <= Number(trade.last_scale_in_price)) {
    return { scaleIn: false, reason: 'below_last_scale_in' };
  }

  // Compute add-on quantity (fraction of original entry size)
  let addQty = Math.floor(originalQty * cfg.sizePct);
  if (addQty < 1) return { scaleIn: false, reason: 'add_qty_too_small' };

  // Position-cap check: combined position must not exceed MAX_POS_PCT
  const combinedQty = qty + addQty;
  const combinedValue = combinedQty * currentPrice;
  const maxValue = portfolioValue * cfg.maxPosPct;
  if (combinedValue > maxValue) {
    addQty = Math.floor(maxValue / currentPrice - qty);
    if (addQty < 1) return { scaleIn: false, reason: 'position_cap' };
  }

  // Blended entry: weighted average of old entry + new entry
  const newTotalQty = qty + addQty;
  const newBlendedEntry = +((entryPrice * qty + currentPrice * addQty) / newTotalQty).toFixed(4);

  // Move stop to breakeven on the original entry when scaling in for
  // the first time; subsequent scale-ins keep the existing (tighter)
  // trailing stop or breakeven.
  const breakeven = +entryPrice.toFixed(4);
  const newStop = scaleInsCount === 0 ? Math.max(breakeven, Number(trade.stop_loss)) : Number(trade.stop_loss);

  return {
    scaleIn: true,
    addQty,
    triggerPrice,
    newBlendedEntry,
    newStop,
    newTotalQty,
    scaleInsCount: scaleInsCount + 1,
  };
}

module.exports = { enabled, getConfig, shouldScaleIn };
