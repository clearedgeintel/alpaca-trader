const config = require('./config');
const db = require('./db');
const alpaca = require('./alpaca');
const riskAgent = require('./agents/risk-agent');
const regimeAgent = require('./agents/regime-agent');
const { log, error } = require('./logger');

async function executeSignal(signal) {
  const { symbol, id: signalId } = signal;

  try {
    // Only act on BUY signals
    if (signal.signal !== 'BUY') {
      log(`Skipping non-BUY signal for ${symbol}`);
      return;
    }

    // Check for existing open position in DB
    const existing = await db.query(
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
      log(`🛡️ RISK VETO: ${symbol} — ${riskResult.reason}`);
      return;
    }

    // Layer adjustments: regime params as base, risk agent overrides on top
    const regime = regimeAgent.getParams();
    const stopPct = riskResult.adjustments?.stop_pct || regime.stop_pct || config.STOP_PCT;
    const targetPct = riskResult.adjustments?.target_pct || regime.target_pct || config.TARGET_PCT;
    const riskPct = (riskResult.adjustments?.risk_pct || config.RISK_PCT) * (regime.position_scale || 1.0);

    log(`Regime: ${regime.regime}, bias: ${regime.bias}, scale: ${regime.position_scale}x`);

    // Skip if regime bias is defensive/avoid
    if (regime.bias === 'avoid') {
      log(`🌧️ REGIME SKIP: ${symbol} — market regime is ${regime.regime} (bias: avoid)`);
      return;
    }

    // Get account info
    const account = await alpaca.getAccount();
    const { buying_power, portfolio_value } = account;

    // Size the order (using risk-adjusted params)
    const entry_price = signal.close;
    const stop_loss = +(entry_price * (1 - stopPct)).toFixed(4);
    const take_profit = +(entry_price * (1 + targetPct)).toFixed(4);
    const risk_dollars = portfolio_value * riskPct;
    const stop_dist = entry_price - stop_loss;

    let qty = Math.floor(risk_dollars / stop_dist);
    const maxQty = Math.floor((portfolio_value * config.MAX_POS_PCT) / entry_price);
    qty = Math.min(qty, maxQty);
    qty = Math.max(1, qty);

    const order_value = qty * entry_price;

    // Funds check
    if (order_value > buying_power * 0.95) {
      log(`Insufficient funds for ${symbol}: order=${order_value.toFixed(2)} buying_power=${buying_power.toFixed(2)}`);
      return;
    }

    // Place order
    const order = await alpaca.placeOrder(symbol, qty, 'buy');

    // Save trade to DB
    await db.query(
      `INSERT INTO trades (symbol, alpaca_order_id, side, qty, entry_price, current_price, stop_loss, take_profit, order_value, risk_dollars, status, signal_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [symbol, order.id, 'buy', qty, entry_price, entry_price, stop_loss, take_profit, order_value, risk_dollars, 'open', signalId]
    );

    // Mark signal as acted on
    await db.query('UPDATE signals SET acted_on = true WHERE id = $1', [signalId]);

    log(`✅ ORDER PLACED: ${symbol} qty=${qty} entry=${entry_price} stop=${stop_loss} target=${take_profit}`);
  } catch (err) {
    error(`Failed to execute signal for ${symbol}`, err);
  }
}

module.exports = { executeSignal };
