const BaseAgent = require('./base-agent');
const { messageBus } = require('./message-bus');
const riskAgent = require('./risk-agent');
const regimeAgent = require('./regime-agent');
const newsAgent = require('./news-agent');
const technicalAgent = require('./technical-agent');
const config = require('../config');
const db = require('../db');
const alpaca = require('../alpaca');
const indicators = require('../indicators');
const { log, error } = require('../logger');

/**
 * Compute ema9/ema21/rsi/volumeRatio for a symbol.
 * Prefers cached technical agent report; falls back to computing
 * from daily bars fetched on-demand so signal rows always have
 * populated indicators.
 */
async function computeIndicators(symbol) {
  // Try cached technical report first (zero API cost) — but we always need ATR,
  // so if cache is missing ATR we still fall through to fetching bars.
  const techReport = technicalAgent.getSymbolReport?.(symbol);
  const tf5 = techReport?.data?.timeframes?.['5min'] || techReport?.data?.timeframes?.['5Min'];
  const tfDaily = techReport?.data?.timeframes?.daily;
  const src = tf5?.available ? tf5 : tfDaily;
  const cachedAtr = tfDaily?.atr ?? null;
  if (src?.ema9 != null && src?.rsi != null && cachedAtr != null) {
    return {
      ema9: +src.ema9.toFixed(4),
      ema21: src.ema21 != null ? +src.ema21.toFixed(4) : null,
      rsi: +src.rsi.toFixed(2),
      volumeRatio: src.volumeRatio != null ? +src.volumeRatio.toFixed(2) : null,
      atr: +cachedAtr.toFixed(4),
    };
  }

  // Fallback: fetch daily bars and compute everything we need (including ATR)
  try {
    const bars = await alpaca.getDailyBars(symbol, 30);
    if (!bars || bars.length < 21) {
      return { ema9: null, ema21: null, rsi: null, volumeRatio: null, atr: null };
    }
    const closes = bars.map(b => b.c);
    const volumes = bars.map(b => b.v);
    const ema9Arr = indicators.emaArray(closes, 9);
    const ema21Arr = indicators.emaArray(closes, 21);
    const rsi = indicators.calcRsi(closes, 14);
    const volRatio = indicators.volumeRatio(volumes, 20);
    const atr = indicators.calcAtr(bars, 14);
    return {
      ema9: ema9Arr[ema9Arr.length - 1] != null ? +ema9Arr[ema9Arr.length - 1].toFixed(4) : null,
      ema21: ema21Arr[ema21Arr.length - 1] != null ? +ema21Arr[ema21Arr.length - 1].toFixed(4) : null,
      rsi: rsi != null ? +rsi.toFixed(2) : null,
      volumeRatio: volRatio != null ? +volRatio.toFixed(2) : null,
      atr: atr != null ? +atr.toFixed(4) : null,
    };
  } catch (err) {
    error(`Failed to compute indicators for ${symbol}`, err);
    return { ema9: null, ema21: null, rsi: null, volumeRatio: null, atr: null };
  }
}

/**
 * Derive the stop-% to use for an initial position.
 * Priority: ATR-based → regime override → fixed config.STOP_PCT.
 * Clamped to [ATR_STOP_MIN_PCT, ATR_STOP_MAX_PCT].
 */
function deriveStopPct({ atr, entryPrice, regime }) {
  const config = require('../config');
  if (atr != null && atr > 0 && entryPrice > 0) {
    const mult = regime?.atr_stop_mult ?? config.ATR_STOP_MULT;
    const atrStopPct = (atr * mult) / entryPrice;
    const clamped = Math.max(config.ATR_STOP_MIN_PCT, Math.min(config.ATR_STOP_MAX_PCT, atrStopPct));
    return { stopPct: clamped, source: 'atr', raw: atrStopPct, atr, mult };
  }
  if (regime?.stop_pct) return { stopPct: regime.stop_pct, source: 'regime' };
  return { stopPct: config.STOP_PCT, source: 'fixed' };
}

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
    const startTime = Date.now();

    try {
      const result = await this._dispatch(decision);
      this._recordCycle(decision, result, Date.now() - startTime);
      return result;
    } catch (err) {
      const result = { executed: false, reason: err.message, error: true };
      this._recordCycle(decision, result, Date.now() - startTime, err);
      throw err;
    }
  }

  _recordCycle(decision, result, durationMs, err = null) {
    this._runCount++;
    this._lastRunAt = new Date().toISOString();
    this._lastDurationMs = durationMs;
    this._lastReport = {
      agent: this.name,
      symbol: decision.symbol,
      signal: result.executed ? decision.action : 'SKIP',
      confidence: decision.confidence,
      reasoning: result.reason || (result.executed ? `Executed ${decision.action} ${decision.symbol}` : 'Skipped'),
      durationMs,
      timestamp: this._lastRunAt,
    };
    this._lastError = err ? err.message : null;

    // Push to live activity feed
    try {
      const { events } = require('../socket');
      events.agentReport(this.name, {
        signal: result.executed ? decision.action : (err ? 'ERROR' : 'SKIP'),
        confidence: decision.confidence,
        reasoning: result.reason || (result.executed ? `${decision.action} ${decision.symbol} filled` : 'Skipped'),
        symbol: decision.symbol,
        durationMs,
        llmCalls: 0,
        llmCostUsd: 0,
        timestamp: this._lastRunAt,
        error: err?.message,
      });
    } catch {}
  }

  async _dispatch(decision) {
    const { symbol, action, confidence, size_adjustment = 1.0 } = decision;

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

      // Compute indicators BEFORE sizing so ATR is available for the stop.
      // This also pre-warms data we need to write to the signals row later.
      const ind = await computeIndicators(symbol);

      // Derive stop-% — ATR-based when available, otherwise regime/fixed fallback.
      // Risk-agent adjustments still win (they may clamp for high-heat portfolios).
      const stopPctInfo = deriveStopPct({ atr: ind.atr, entryPrice, regime });
      const stopPct = riskResult.adjustments?.stop_pct || stopPctInfo.stopPct;
      // Target follows the same 2:1 R:R relationship when not explicitly set
      const derivedTargetPct = stopPct * config.REWARD_RATIO;
      const targetPct = riskResult.adjustments?.target_pct || regime.target_pct || derivedTargetPct;

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

      log(`Sizing ${symbol}: entry=$${entryPrice.toFixed(2)} atr=${ind.atr ?? 'n/a'} stopPct=${(stopPct * 100).toFixed(2)}% source=${stopPctInfo.source} stop=$${stopLoss} target=$${takeProfit} qty=${qty}`);

      // Place order
      const orderStart = Date.now();
      const order = await alpaca.placeOrder(symbol, qty, 'buy');
      const fillTimeMs = Date.now() - orderStart;

      // Atomically insert signal + trade + link decision. Alpaca order stays OUTSIDE:
      // a DB rollback cannot unplace an order. Log orphan for reconciliation.
      let signalId = null;
      try {
        await db.withTransaction(async (client) => {
          const signalResult = await client.query(
            `INSERT INTO signals (symbol, signal, reason, close, ema9, ema21, rsi, volume_ratio, acted_on)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
             RETURNING id`,
            [symbol, 'BUY', `Agency: ${decision.reasoning?.slice(0, 200) || 'Orchestrator decision'}`, entryPrice, ind.ema9, ind.ema21, ind.rsi, ind.volumeRatio]
          );
          signalId = signalResult.rows[0]?.id || null;

          await client.query(
            `INSERT INTO trades (symbol, alpaca_order_id, side, qty, entry_price, current_price, stop_loss, take_profit, order_value, risk_dollars, status, signal_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [symbol, order.id, 'buy', qty, entryPrice, entryPrice, stopLoss, takeProfit, orderValue, riskDollars, 'open', signalId]
          );

          if (signalId) {
            await client.query(
              `UPDATE agent_decisions SET signal_id = $1 WHERE symbol = $2 AND action = 'BUY'
               AND created_at > NOW() - INTERVAL '10 minutes' AND signal_id IS NULL
               AND id = (
                 SELECT id FROM agent_decisions WHERE symbol = $2 AND action = 'BUY'
                 AND created_at > NOW() - INTERVAL '10 minutes' AND signal_id IS NULL
                 ORDER BY created_at DESC LIMIT 1
               )`,
              [signalId, symbol]
            );
          }
        });
      } catch (txErr) {
        error(`ORPHAN ALPACA ORDER — DB rollback for ${symbol} buy (alpaca_order_id=${order.id}). Requires reconciliation.`, txErr);
        throw txErr;
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

    await alpaca.closePosition(symbol);  // outside txn — rollback can't unclose

    const pnl = +((currentPrice - parseFloat(trade.entry_price)) * trade.qty).toFixed(2);
    const pnlPct = +(((currentPrice - parseFloat(trade.entry_price)) / parseFloat(trade.entry_price)) * 100).toFixed(4);

    // Compute indicators outside transaction (read-only network call)
    const sellInd = await computeIndicators(symbol);

    try {
      await db.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO signals (symbol, signal, reason, close, ema9, ema21, rsi, volume_ratio, acted_on)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
          [symbol, 'SELL', `Agency: ${decision.reasoning?.slice(0, 200) || 'Orchestrator sell decision'}`, currentPrice, sellInd.ema9, sellInd.ema21, sellInd.rsi, sellInd.volumeRatio]
        );
        await client.query(
          `UPDATE trades
           SET status = 'closed', exit_price = $1, pnl = $2, pnl_pct = $3,
               exit_reason = $4, closed_at = NOW(), current_price = $1
           WHERE id = $5`,
          [currentPrice, pnl, pnlPct, 'orchestrator_sell', trade.id]
        );
      });
    } catch (txErr) {
      error(`ORPHAN SELL — DB rollback after closing ${symbol} on Alpaca (trade_id=${trade.id}). Position is closed but DB still shows 'open'. Requires reconciliation.`, txErr);
      throw txErr;
    }

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
