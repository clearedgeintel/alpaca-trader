const config = require('./config');
const db = require('./db');
const alpaca = require('./alpaca');
const { calcAtr } = require('./indicators');
const { getRiskParams } = require('./asset-classes');
const riskAgent = require('./agents/risk-agent');
const regimeAgent = require('./agents/regime-agent');
const { log, error } = require('./logger');

async function executeSignal(signal, txClient = null) {
  const { symbol, id: signalId } = signal;
  const qry = txClient
    ? (text, params) => txClient.query(text, params)
    : (text, params) => db.query(text, params);

  try {
    // Only act on BUY signals
    if (signal.signal !== 'BUY') {
      log(`Skipping non-BUY signal for ${symbol}`);
      return;
    }

    // Check for existing open position in DB
    const existing = await qry(
      'SELECT id FROM trades WHERE symbol = $1 AND status = $2',
      [symbol, 'open']
    );

    if (existing.rows.length > 0) {
      log(`Skipping ${symbol}, position already open`);
      return;
    }

    // Risk Manager evaluation — veto is absolute
    const riskResult = await riskAgent.evaluate({ symbol, close: signal.close });
    if (!riskResult.approved) {
      log(`RISK VETO: ${symbol} — ${riskResult.reason}`);
      return;
    }

    // Layer adjustments: asset class defaults → regime overrides → risk agent overrides
    const assetParams = getRiskParams(symbol);
    const regime = regimeAgent.getParams();

    log(`Regime: ${regime.regime}, bias: ${regime.bias}, scale: ${regime.position_scale}x`);

    // Skip if regime bias is defensive/avoid
    if (regime.bias === 'avoid') {
      log(`REGIME SKIP: ${symbol} — market regime is ${regime.regime} (bias: avoid)`);
      return;
    }

    // Get account info
    const account = await alpaca.getAccount();
    const { buying_power, portfolio_value } = account;

    // Pre-compute ATR so we can use it for BOTH the initial stop and the trailing stop
    // (previously only trailing used ATR; initial stop was fixed %)
    let atr = null;
    let atrBars = null;
    try {
      atrBars = await alpaca.getBars(symbol, config.BAR_TIMEFRAME, config.ATR_PERIOD + 5);
      atr = calcAtr(atrBars, config.ATR_PERIOD);
    } catch (atrErr) {
      error(`ATR fetch failed for ${symbol}, will use fixed stop`, atrErr);
    }

    // Derive stopPct — ATR → regime → risk override → asset default
    const entry_price = signal.close;
    let atrStopPct = null;
    if (atr && atr > 0 && entry_price > 0) {
      const rawAtrStopPct = (atr * (regime.atr_stop_mult ?? config.ATR_STOP_MULT)) / entry_price;
      atrStopPct = Math.max(config.ATR_STOP_MIN_PCT, Math.min(config.ATR_STOP_MAX_PCT, rawAtrStopPct));
    }
    const stopPct = riskResult.adjustments?.stop_pct || atrStopPct || regime.stop_pct || assetParams.stopPct;
    const derivedTargetPct = stopPct * config.REWARD_RATIO;
    const targetPct = riskResult.adjustments?.target_pct || regime.target_pct || derivedTargetPct || assetParams.targetPct;
    const riskPct = (riskResult.adjustments?.risk_pct || assetParams.riskPct) * (regime.position_scale || 1.0);

    // Size the order (using risk-adjusted params)
    const stop_loss = +(entry_price * (1 - stopPct)).toFixed(4);
    const take_profit = +(entry_price * (1 + targetPct)).toFixed(4);
    const risk_dollars = portfolio_value * riskPct;
    const stop_dist = entry_price - stop_loss;

    let qty = Math.floor(risk_dollars / stop_dist);
    const maxQty = Math.floor((portfolio_value * assetParams.maxPosPct) / entry_price);
    qty = Math.min(qty, maxQty);
    qty = Math.max(1, qty);

    const order_value = qty * entry_price;

    // Funds check
    if (order_value > buying_power * 0.95) {
      log(`Insufficient funds for ${symbol}: order=${order_value.toFixed(2)} buying_power=${buying_power.toFixed(2)}`);
      return;
    }

    // Compute ATR-based trailing stop (reuses ATR already fetched above for initial stop)
    let trailing_stop = stop_loss;
    if (atr) {
      trailing_stop = +(entry_price - atr * assetParams.trailingAtrMult).toFixed(4);
      // Use the tighter of fixed stop and ATR trailing stop
      trailing_stop = Math.max(trailing_stop, stop_loss);
    }

    log(`Sizing ${symbol}: entry=$${entry_price.toFixed(2)} atr=${atr ?? 'n/a'} stopPct=${(stopPct * 100).toFixed(2)}% stop=$${stop_loss} target=$${take_profit} trailing=$${trailing_stop} qty=${qty}`);

    // Place bracket order (market entry + stop loss + take profit)
    let order;
    try {
      order = await alpaca.placeBracketOrder(symbol, qty, 'buy', stop_loss, take_profit);
    } catch (bracketErr) {
      // Fallback to simple market order if bracket fails
      log(`Bracket order failed for ${symbol}, falling back to market order`);
      order = await alpaca.placeOrder(symbol, qty, 'buy');
    }

    // Verify order status — wait briefly for fill
    let filledQty = qty;
    let filledPrice = entry_price;
    let orderStatus = order.status;

    try {
      // Poll order status (market orders usually fill instantly)
      for (let attempt = 0; attempt < 3; attempt++) {
        if (['filled', 'partially_filled'].includes(orderStatus)) break;
        await new Promise(r => setTimeout(r, 1000));
        const updated = await alpaca.getOrder(order.id);
        orderStatus = updated.status;
        if (updated.filled_qty) filledQty = parseInt(updated.filled_qty);
        if (updated.filled_avg_price) filledPrice = parseFloat(updated.filled_avg_price);
      }
    } catch (pollErr) {
      error(`Order status check failed for ${symbol}`, pollErr);
    }

    // Handle rejected or cancelled orders
    if (['rejected', 'cancelled', 'expired', 'suspended'].includes(orderStatus)) {
      log(`ORDER REJECTED: ${symbol} status=${orderStatus}`);
      await qry('UPDATE signals SET acted_on = false WHERE id = $1', [signalId]);
      return;
    }

    // Handle partial fills — use actual filled quantity
    if (orderStatus === 'partially_filled' && filledQty < qty) {
      log(`PARTIAL FILL: ${symbol} filled=${filledQty}/${qty}`);
    }

    // Recalculate stops based on actual fill price
    const actualEntry = filledPrice;
    const actualStop = +(actualEntry * (1 - stopPct)).toFixed(4);
    const actualTarget = +(actualEntry * (1 + targetPct)).toFixed(4);
    const actualTrailing = Math.max(+(actualEntry - (trailing_stop > 0 ? (entry_price - trailing_stop) : actualEntry * stopPct)).toFixed(4), actualStop);
    const actualOrderValue = filledQty * actualEntry;

    // Save trade to DB
    await qry(
      `INSERT INTO trades (symbol, alpaca_order_id, side, qty, entry_price, current_price, stop_loss, take_profit, trailing_stop, highest_price, order_type, order_value, risk_dollars, status, signal_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [symbol, order.id, 'buy', filledQty, actualEntry, actualEntry, actualStop, actualTarget, actualTrailing, actualEntry, order.order_class || 'market', actualOrderValue, risk_dollars, 'open', signalId]
    );

    // Mark signal as acted on
    await qry('UPDATE signals SET acted_on = true WHERE id = $1', [signalId]);

    log(`ORDER FILLED: ${symbol} qty=${filledQty} entry=${actualEntry} stop=${actualStop} target=${actualTarget} trailing=${actualTrailing}`);
  } catch (err) {
    error(`Failed to execute signal for ${symbol}`, err);
  }
}

module.exports = { executeSignal };
