/**
 * Smart position scaling — pure-function decision module.
 * Mutually exclusive with partial-exit (order_type guard).
 */

export {};
/* eslint-disable @typescript-eslint/no-var-requires */
const config = require('./config');
const runtimeConfig = require('./runtime-config');

interface ScaleInConfig {
  triggerAtr: number;
  sizePct: number;
  maxCount: number;
  maxPosPct: number;
}

interface Trade {
  id: string;
  qty: number;
  entry_price: number;
  stop_loss: number;
  order_type: string | null;
  scale_ins_count: number;
  last_scale_in_price: number | null;
  original_qty: number | null;
}

interface ScaleInDecision {
  scaleIn: boolean;
  reason?: string;
  addQty?: number;
  triggerPrice?: number;
  newBlendedEntry?: number;
  newStop?: number;
  newTotalQty?: number;
  scaleInsCount?: number;
}

function enabled(): boolean {
  const v = runtimeConfig.get('SCALE_IN_ENABLED');
  return v === true || v === 'true';
}

function getConfig(): ScaleInConfig {
  return {
    triggerAtr: parseFloat(runtimeConfig.get('SCALE_IN_TRIGGER_ATR') ?? 1.5),
    sizePct: parseFloat(runtimeConfig.get('SCALE_IN_SIZE_PCT') ?? 0.5),
    maxCount: parseInt(runtimeConfig.get('SCALE_IN_MAX_COUNT') ?? 2, 10),
    maxPosPct: runtimeConfig.get('MAX_POS_PCT') ?? config.MAX_POS_PCT,
  };
}

function shouldScaleIn(
  trade: Trade,
  currentPrice: number,
  atr: number | null,
  portfolioValue: number,
): ScaleInDecision {
  if (!enabled()) return { scaleIn: false, reason: 'disabled' };
  if (!atr || atr <= 0) return { scaleIn: false, reason: 'no_atr' };

  const cfg = getConfig();
  const qty = Number(trade.qty);
  const entryPrice = Number(trade.entry_price);
  const originalQty = Number(trade.original_qty || trade.qty);
  const scaleInsCount = Number(trade.scale_ins_count || 0);

  if (trade.order_type === 'scaled_out') {
    return { scaleIn: false, reason: 'already_scaled_out' };
  }

  if (scaleInsCount >= cfg.maxCount) {
    return { scaleIn: false, reason: 'max_count_reached' };
  }

  const triggerPrice = entryPrice + (scaleInsCount + 1) * cfg.triggerAtr * atr;
  if (currentPrice < triggerPrice) {
    return { scaleIn: false, reason: 'below_trigger', triggerPrice };
  }

  if (trade.last_scale_in_price && currentPrice <= Number(trade.last_scale_in_price)) {
    return { scaleIn: false, reason: 'below_last_scale_in' };
  }

  let addQty = Math.floor(originalQty * cfg.sizePct);
  if (addQty < 1) return { scaleIn: false, reason: 'add_qty_too_small' };

  const combinedQty = qty + addQty;
  const combinedValue = combinedQty * currentPrice;
  const maxValue = portfolioValue * cfg.maxPosPct;
  if (combinedValue > maxValue) {
    addQty = Math.floor(maxValue / currentPrice - qty);
    if (addQty < 1) return { scaleIn: false, reason: 'position_cap' };
  }

  const newTotalQty = qty + addQty;
  const newBlendedEntry = +((entryPrice * qty + currentPrice * addQty) / newTotalQty).toFixed(4);

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
