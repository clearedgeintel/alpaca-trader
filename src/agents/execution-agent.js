const BaseAgent = require('./base-agent');
const { messageBus } = require('./message-bus');
const riskAgent = require('./risk-agent');
const regimeAgent = require('./regime-agent');
const newsAgent = require('./news-agent');
const technicalAgent = require('./technical-agent');
const config = require('../config');
const db = require('../db');
const alpaca = require('../alpaca');
const { log, error } = require('../logger');

class ExecutionAgent extends BaseAgent {
  constructor() {
    super('execution', { intervalMs: null }); // Event-driven, not interval-based
    this._fillHistory = [];
  }

  /**
   * Execute a decision from the orchestrator.
   * Handles risk checks, sizing, order placement, and fill reporting.
   *
   * @param {Object} decision - { symbol, action, confidence, reasoning, size_adjustment }
   * @returns {Object} execution result
   */
  async execute(decision) {
    const { symbol, action, confidence, size_adjustment = 1.0 } = decision;

    try {
      if (action === 'SELL') {
        return await this._executeSell(decision);
      }

      if (action !== 'BUY') {
        return { executed: false, reason: `No action for ${action}` };
      }

      // Check for existing open position
      const existing = await db.query(
        'SELECT id FROM trades WHERE symbol = $1 AND status = $2',
        [symbol, 'open']
      );
      if (existing.rows.length > 0) {
        return { executed: false, reason: `Position already open for ${symbol}` };
      }

      // Get current price
      const account = await alpaca.getAccount();
      const snapshot = await alpaca.getSnapshot(symbol);
      const entryPrice = snapshot?.latestTrade?.p || snapshot?.minuteBar?.c;

      if (!entryPrice) {
        return { executed: false, reason: `Could not get current price for ${symbol}` };
      }

      // News critical alert check — final safety gate
      const criticalAlert = newsAgent.getCriticalAlert(symbol);
      if (criticalAlert && criticalAlert.impact === 'very_bearish') {
        log(`🚨 EXECUTION BLOCKED: ${symbol} — critical bearish news: ${criticalAlert.headline}`);
        return { executed: false, reason: `Critical bearish news: ${criticalAlert.headline}` };
      }

      // Risk Manager evaluation — absolute veto
      const riskResult = await riskAgent.evaluate({ symbol, close: entryPrice });
      if (!riskResult.approved) {
        log(`🛡️ RISK VETO: ${symbol} — ${riskResult.reason}`);
        return { executed: false, reason: `Risk veto: ${riskResult.reason}` };
      }

      // Regime-adjusted parameters
      const regime = regimeAgent.getParams();
      if (regime.bias === 'avoid') {
        log(`🌧️ REGIME BLOCK: ${symbol} — bias is "avoid"`);
        return { executed: false, reason: `Regime bias is "avoid"` };
      }

      // Calculate position size
      const stopPct = riskResult.adjustments?.stop_pct || regime.stop_pct || config.STOP_PCT;
      const targetPct = riskResult.adjustments?.target_pct || regime.target_pct || config.TARGET_PCT;
      const baseRiskPct = (riskResult.adjustments?.risk_pct || config.RISK_PCT) * (regime.position_scale || 1.0);
      const riskPct = baseRiskPct * size_adjustment; // Orchestrator confidence scaling

      const portfolioValue = account.portfolio_value;
      const buyingPower = account.buying_power;

      const stopLoss = +(entryPrice * (1 - stopPct)).toFixed(4);
      const takeProfit = +(entryPrice * (1 + targetPct)).toFixed(4);
      const riskDollars = portfolioValue * riskPct;
      const stopDist = entryPrice - stopLoss;

      let qty = Math.floor(riskDollars / stopDist);
      const maxQty = Math.floor((portfolioValue * config.MAX_POS_PCT) / entryPrice);
      qty = Math.min(qty, maxQty);
      qty = Math.max(1, qty);

      const orderValue = qty * entryPrice;

      // Funds check
      if (orderValue > buyingPower * 0.95) {
        return { executed: false, reason: `Insufficient funds: need ${orderValue.toFixed(2)}, have ${buyingPower.toFixed(2)}` };
      }

      // Place order
      const orderStart = Date.now();
      const order = await alpaca.placeOrder(symbol, qty, 'buy');
      const fillTimeMs = Date.now() - orderStart;

      // Pull indicators from the technical agent's last report for this symbol
      const techReport = technicalAgent.getSymbolReport?.(symbol);
      const tf5 = techReport?.data?.timeframes?.['5min'] || techReport?.data?.timeframes?.['5Min'];
      const tfDaily = techReport?.data?.timeframes?.daily;
      const src = tf5?.available ? tf5 : tfDaily;
      const ema9 = src?.ema9 != null ? +src.ema9.toFixed(4) : null;
      const ema21 = src?.ema21 != null ? +src.ema21.toFixed(4) : null;
      const rsi = src?.rsi != null ? +src.rsi.toFixed(2) : null;
      const volRatio = src?.volumeRatio != null ? +src.volumeRatio.toFixed(2) : null;

      // Record signal in signals table (so Signals page shows agency-mode activity)
      const signalResult = await db.query(
        `INSERT INTO signals (symbol, signal, reason, close, ema9, ema21, rsi, volume_ratio, acted_on)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
         RETURNING id`,
        [symbol, 'BUY', `Agency: ${decision.reasoning?.slice(0, 200) || 'Orchestrator decision'}`, entryPrice, ema9, ema21, rsi, volRatio]
      );
      const signalId = signalResult.rows[0]?.id || null;

      // Save trade to DB (linked to signal)
      await db.query(
        `INSERT INTO trades (symbol, alpaca_order_id, side, qty, entry_price, current_price, stop_loss, take_profit, order_value, risk_dollars, status, signal_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [symbol, order.id, 'buy', qty, entryPrice, entryPrice, stopLoss, takeProfit, orderValue, riskDollars, 'open', signalId]
      );

      // Link decision to signal for timeline view
      if (signalId) {
        await db.query(
          `UPDATE agent_decisions SET signal_id = $1 WHERE symbol = $2 AND action = 'BUY'
           AND created_at > NOW() - INTERVAL '10 minutes' AND signal_id IS NULL
           ORDER BY created_at DESC LIMIT 1`,
          [signalId, symbol]
        ).catch(() => {}); // Best-effort linkage
      }

      const fillReport = {
        symbol,
        action: 'BUY',
        qty,
        entryPrice,
        stopLoss,
        takeProfit,
        orderValue,
        riskDollars,
        riskPct,
        regime: regime.regime,
        confidence: confidence,
        sizeAdjustment: size_adjustment,
        fillTimeMs,
        orderId: order.id,
      };

      this._fillHistory.push(fillReport);
      if (this._fillHistory.length > 100) {
        this._fillHistory = this._fillHistory.slice(-100);
      }

      await messageBus.publish('SIGNAL', this.name, {
        symbol,
        action: 'BUY_FILLED',
        ...fillReport,
      });

      log(`✅ ORDER PLACED: ${symbol} qty=${qty} entry=${entryPrice} stop=${stopLoss} target=${takeProfit} (fill: ${fillTimeMs}ms, confidence: ${confidence})`);

      return { executed: true, ...fillReport };
    } catch (err) {
      error(`Execution failed for ${symbol}`, err);
      return { executed: false, reason: err.message };
    }
  }

  /**
   * Execute a SELL decision — close an existing position.
   */
  async _executeSell(decision) {
    const { symbol } = decision;

    const existing = await db.query(
      'SELECT * FROM trades WHERE symbol = $1 AND status = $2',
      [symbol, 'open']
    );

    if (existing.rows.length === 0) {
      return { executed: false, reason: `No open position for ${symbol}` };
    }

    const trade = existing.rows[0];
    const position = await alpaca.getPosition(symbol);
    const currentPrice = position ? parseFloat(position.current_price) : parseFloat(trade.current_price);

    await alpaca.closePosition(symbol);

    const pnl = +((currentPrice - parseFloat(trade.entry_price)) * trade.qty).toFixed(2);
    const pnlPct = +(((currentPrice - parseFloat(trade.entry_price)) / parseFloat(trade.entry_price)) * 100).toFixed(4);

    // Record SELL signal
    await db.query(
      `INSERT INTO signals (symbol, signal, reason, close, acted_on)
       VALUES ($1, $2, $3, $4, true)`,
      [symbol, 'SELL', `Agency: ${decision.reasoning?.slice(0, 200) || 'Orchestrator sell decision'}`, currentPrice]
    );

    await db.query(
      `UPDATE trades
       SET status = 'closed', exit_price = $1, pnl = $2, pnl_pct = $3,
           exit_reason = $4, closed_at = NOW(), current_price = $1
       WHERE id = $5`,
      [currentPrice, pnl, pnlPct, 'orchestrator_sell', trade.id]
    );

    log(`POSITION CLOSED: ${symbol} pnl=${pnl} reason=orchestrator_sell`);

    await messageBus.publish('SIGNAL', this.name, {
      symbol,
      action: 'SELL_FILLED',
      pnl,
      pnlPct,
      exitReason: 'orchestrator_sell',
    });

    return { executed: true, symbol, action: 'SELL', pnl, pnlPct };
  }

  /**
   * Not interval-driven — analyze() is a no-op.
   */
  async analyze() {
    return {
      symbol: null,
      signal: 'HOLD',
      confidence: 1.0,
      reasoning: `Execution agent is event-driven. ${this._fillHistory.length} fills in history.`,
      data: { recentFills: this._fillHistory.slice(-10) },
    };
  }

  /**
   * Get recent fill history for dashboard.
   */
  getFillHistory(limit = 20) {
    return this._fillHistory.slice(-limit);
  }
}

// Singleton
const executionAgent = new ExecutionAgent();

module.exports = executionAgent;
