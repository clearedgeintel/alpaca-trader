const BaseAgent = require('./base-agent');
const { messageBus } = require('./message-bus');
const riskAgent = require('./risk-agent');
const regimeAgent = require('./regime-agent');
const newsAgent = require('./news-agent');
const technicalAgent = require('./technical-agent');
const config = require('../config');
const runtimeConfig = require('../runtime-config');
const db = require('../db');

// Read a runtime-overridable risk param, falling back to static config.
function rc(key) {
  return runtimeConfig.get(key) ?? config[key];
}
const alpaca = require('../alpaca');
const datasources = require('../datasources');
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
    const closes = bars.map((b) => b.c);
    const volumes = bars.map((b) => b.v);
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
 * Derive the "strategy pool" for a trade from the orchestrator's
 * decision. The pool tags trades so per-strategy P&L can be
 * attributed downstream. Priority: use the first supporting agent
 * we recognize; fall back to 'technical' for general setups and
 * 'fallback' when the LLM was unavailable.
 */
function deriveStrategyPool(decision) {
  const supporters = decision?.supporting_agents || [];
  // Momentum-hunter wins the priority — it has its own risk model in
  // execution-agent and must not be confused with a regular technical
  // entry. Explicit strategy_pool on the decision also wins.
  if (decision?.strategy_pool === 'momentum') return 'momentum';
  if (supporters.includes('momentum-hunter')) return 'momentum';
  if (supporters.includes('breakout-agent')) return 'breakout';
  if (supporters.includes('mean-reversion')) return 'mean_reversion';
  if (supporters.includes('news-sentinel')) return 'news';
  if (supporters.includes('technical-analysis')) return 'technical';
  // Fallback decisions have reasoning starting with 'Fallback:'
  if (typeof decision?.reasoning === 'string' && /^Fallback:/i.test(decision.reasoning)) return 'fallback';
  return 'technical';
}

/**
 * Detect whether a decision should route through the momentum risk model.
 * Same predicate used to pre-check the MAX_OPEN cap and to swap the
 * sizing params before placing the order.
 */
function isMomentumDecision(decision) {
  return deriveStrategyPool(decision) === 'momentum';
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
  return { stopPct: rc('STOP_PCT'), source: 'fixed' };
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
        signal: result.executed ? decision.action : err ? 'ERROR' : 'SKIP',
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

    // Pre-execution sanity layer — applies independently of any
    // upstream filter (orchestrator-side or otherwise). Catches:
    //   - low-confidence decisions that bypass the orchestrator filter
    //     (manual trades, chat-driven, fallback path)
    //   - explicit risk veto attached to the decision
    // EXECUTION_MIN_CONFIDENCE is independent from ORCHESTRATOR_MIN_CONFIDENCE
    // so the floors can be tuned at different layers.
    if (action === 'BUY' || action === 'SELL') {
      const minConf = runtimeConfig.get('EXECUTION_MIN_CONFIDENCE') ?? config.EXECUTION_MIN_CONFIDENCE;
      if (typeof confidence === 'number' && confidence < minConf) {
        try {
          require('../metrics').executionSanityBlocksTotal?.inc({ reason: 'low_confidence' });
        } catch {
          /* metrics optional */
        }
        return {
          executed: false,
          reason: `confidence ${confidence.toFixed(2)} < floor ${minConf}`,
        };
      }
      if (decision.risk_veto || decision.veto) {
        try {
          require('../metrics').executionSanityBlocksTotal?.inc({ reason: 'risk_veto' });
        } catch {
          /* metrics optional */
        }
        return {
          executed: false,
          reason: `risk veto: ${decision.veto_reason || decision.risk_veto_reason || 'risk-agent rejected'}`,
        };
      }
    }

    // Unscannable asset-class veto (BUY only). When an asset class is
    // turned off via `scannable: false` in src/asset-classes.js, new
    // entries are blocked but existing positions can still SELL/close
    // — same semantics as halt-tracker. Catches all autonomous BUYs;
    // legacy executor + screener-agent have parallel gates so a symbol
    // whose class is off can't enter via any path.
    if (action === 'BUY') {
      const { isScannable, getAssetClass } = require('../asset-classes');
      if (!isScannable(symbol)) {
        try {
          require('../metrics').executionSanityBlocksTotal?.inc({ reason: 'unscannable_class' });
        } catch { /* metrics optional */ }
        return {
          executed: false,
          reason: `Asset class "${getAssetClass(symbol)}" is currently unscannable (BUY blocked)`,
        };
      }
    }

    // Options branch — single-leg long calls/puts (Phase 1 MVP). Routes
    // BUY through _executeOption() and SELL through _closeOptionPosition().
    // Equity flow continues unchanged below.
    const { isOptionSymbol } = require('../asset-classes');
    if (isOptionSymbol(symbol)) {
      if (!runtimeConfig.get('OPTIONS_ENABLED')) {
        return { executed: false, reason: 'Options trading disabled (OPTIONS_ENABLED=false)' };
      }
      if (action === 'SELL') return await this._closeOptionPosition(decision);
      if (action !== 'BUY') return { executed: false, reason: `No action for ${action}` };
      return await this._executeOption(decision);
    }

    if (action === 'SELL') {
      return await this._executeSell(decision);
    }

    if (action !== 'BUY') {
      return { executed: false, reason: `No action for ${action}` };
    }

    // Check for existing open position
    const existing = await db.query('SELECT id FROM trades WHERE symbol = $1 AND status = $2', [symbol, 'open']);
    if (existing.rows.length > 0) {
      return { executed: false, reason: `Position already open for ${symbol}` };
    }

    // Momentum-hunter: enforce MAX_OPEN cap on concurrent momentum positions
    // BEFORE the expensive snapshot/sizing path. If we're already at the cap,
    // skip cheaply. Each position uses MOMENTUM_RISK_PCT instead of RISK_PCT.
    const isMomentum = isMomentumDecision(decision);
    if (isMomentum) {
      const maxOpen = Number(rc('MOMENTUM_MAX_OPEN')) || 3;
      const openMom = await db.query(
        "SELECT COUNT(*)::int AS n FROM trades WHERE status = 'open' AND strategy_pool = 'momentum'",
      );
      const count = openMom.rows[0]?.n || 0;
      if (count >= maxOpen) {
        return { executed: false, reason: `Momentum cap reached (${count}/${maxOpen} open)` };
      }
    }

    // Get current price (Alpaca) + ex-dividend calendar (Polygon, optional)
    const [account, snapshot, dividends] = await Promise.all([
      alpaca.getAccount(),
      alpaca.getSnapshot(symbol),
      datasources.getDividends(symbol),
    ]);
    const entryPrice = snapshot?.latestTrade?.p || snapshot?.minuteBar?.c;

    if (!entryPrice) {
      return { executed: false, reason: `Could not get current price for ${symbol}` };
    }

    // Price floor — block sub-$MIN_PRICE penny names. Their spread +
    // slippage at the share counts we trade destroyed the edge in the
    // May blotter (every large loss was a sub-$1 stock). Crypto is
    // exempt (sub-$1 tokens are legitimately tradeable with tight spreads).
    const minPrice = Number(rc('MIN_PRICE')) || 0;
    const { isCrypto: _isCrypto } = require('../asset-classes');
    if (minPrice > 0 && !_isCrypto(symbol) && entryPrice < minPrice) {
      try {
        require('../metrics').executionSanityBlocksTotal?.inc({ reason: 'below_min_price' });
      } catch {
        /* metrics optional */
      }
      return { executed: false, reason: `Price $${entryPrice.toFixed(2)} below floor $${minPrice.toFixed(2)}` };
    }

    // Halt check — never enter a name currently halted. The IEX status
    // stream feeds halt-tracker; we read its in-memory state synchronously.
    // Phase 1 safety prereq for the path-to-live roadmap.
    try {
      const haltTracker = require('../halt-tracker');
      if (haltTracker.isHalted(symbol)) {
        const status = haltTracker.getStatus(symbol);
        try {
          require('../metrics').executionSanityBlocksTotal?.inc({ reason: 'symbol_halted' });
        } catch { /* metrics optional */ }
        return {
          executed: false,
          reason: `${symbol} is halted (code ${status?.code || '?'} — ${status?.reason || 'unknown'})`,
        };
      }
    } catch { /* halt-tracker optional in test envs */ }

    // Broker-health check — refuse new BUYs while Alpaca is in outage or
    // recovery. Open positions stay open (monitor's stop/target logic
    // tolerates failed fetches). Phase 1 safety prereq.
    try {
      const brokerHealth = require('../broker-health');
      if (!brokerHealth.isHealthy()) {
        const status = brokerHealth.getStatus();
        try {
          require('../metrics').executionSanityBlocksTotal?.inc({ reason: 'broker_unhealthy' });
        } catch { /* metrics optional */ }
        return {
          executed: false,
          reason: `Broker ${status.state.toLowerCase()} — ${status.failures} recent failures (last: ${status.lastFailure?.error || 'unknown'})`,
        };
      }
    } catch { /* broker-health optional */ }

    // Ex-dividend warning — price drops by dividend amount on ex-date. Surface
    // for the decision log; orchestrator already weighed the risk upstream.
    if (Array.isArray(dividends) && dividends.length > 0) {
      const now = Date.now();
      const upcoming = dividends.find((d) => {
        if (!d.ex_dividend_date) return false;
        const ex = Date.parse(d.ex_dividend_date);
        const days = (ex - now) / 86400000;
        return days >= 0 && days <= 2;
      });
      if (upcoming) {
        log(`💰 ${symbol} ex-div in <=2 days (${upcoming.ex_dividend_date}, $${upcoming.cash_amount})`);
      }
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

    // Per-symbol guards — block fresh BUYs after day-loss cap or
    // consecutive-loss streak is breached on this ticker.
    const symbolGuard = require('../symbol-blacklist');
    const guardResult = await symbolGuard.checkSymbolGuards(symbol, account.portfolio_value);
    if (guardResult.blocked) {
      return { executed: false, reason: `Symbol guard: ${guardResult.reason}` };
    }

    // Earnings event filter — avoid taking fresh long positions into a
    // binary earnings event. Mode is configurable: block (skip), reduce
    // (halve size), or ignore.
    const earnings = require('../earnings');
    const recentNews = newsAgent.getReport?.()?.data?.recentNews || [];
    const earningsCheck = earnings.isNearEarnings(symbol, { withinDays: 2, recentNews });
    let earningsSizeFactor = 1.0;
    if (earningsCheck.near) {
      const mode = earnings.getMode();
      if (mode === 'block') {
        log(
          `📅 EARNINGS BLOCK: ${symbol} — near earnings (${earningsCheck.source}${earningsCheck.days != null ? `, ${earningsCheck.days}d` : ''})`,
        );
        return {
          executed: false,
          reason: `Earnings window (${earningsCheck.source}${earningsCheck.days != null ? `, ${earningsCheck.days}d` : ''})`,
        };
      }
      if (mode === 'reduce') {
        earningsSizeFactor = 0.5;
        log(
          `📅 Earnings near (${earningsCheck.source}${earningsCheck.days != null ? `, ${earningsCheck.days}d` : ''}) — reducing ${symbol} size by 50%`,
        );
      }
    }

    // Compute indicators BEFORE sizing so ATR is available for the stop.
    // This also pre-warms data we need to write to the signals row later.
    const ind = await computeIndicators(symbol);

    // -------- Sizing --------
    // Momentum trades use their own risk model: flat % stop, flat % target,
    // dedicated MOMENTUM_RISK_PCT, no ATR / vol-target / kelly downsize.
    // Those scalers would shrink an already-tiny 0.5% bet further, defeating
    // the lottery-ticket sizing the strategy depends on.
    let stopPct, targetPct, stopPctInfo, riskPct, volScale, kellyScale, rampMultiplier;
    if (isMomentum) {
      stopPct = Number(rc('MOMENTUM_STOP_PCT')) || 0.15;
      targetPct = Number(rc('MOMENTUM_TARGET_PCT')) || 0.50;
      stopPctInfo = { stopPct, source: 'momentum_flat' };
      riskPct = Number(rc('MOMENTUM_RISK_PCT')) || 0.005;
      volScale = 1.0;
      kellyScale = 1.0;
      rampMultiplier = 1.0;
      log(`Momentum sizing for ${symbol}: risk=${(riskPct * 100).toFixed(2)}%, stop=${(stopPct * 100).toFixed(0)}%, target=${(targetPct * 100).toFixed(0)}% (flat — ATR / Kelly / vol-target bypassed)`);
    } else {
      // Derive stop-% — ATR-based when available, otherwise regime/fixed fallback.
      // Risk-agent adjustments still win (they may clamp for high-heat portfolios).
      stopPctInfo = deriveStopPct({ atr: ind.atr, entryPrice, regime });
      stopPct = riskResult.adjustments?.stop_pct || stopPctInfo.stopPct;
      // Target follows the same 2:1 R:R relationship when not explicitly set
      const derivedTargetPct = stopPct * config.REWARD_RATIO;
      // User-set runtime TARGET_PCT (if explicitly overridden) wins over derived
      const userTargetPct = runtimeConfig.getAll().TARGET_PCT;
      targetPct = riskResult.adjustments?.target_pct || regime.target_pct || userTargetPct || derivedTargetPct;

      // Volatility targeting: scale risk by targetVol / realizedVol so a
      // sleepy ETF (ATR/price ~ 0.8%) gets an upsize and a meme stock
      // (ATR/price ~ 6%) gets a downsize. Clamped to avoid pathological
      // extremes. Disabled if VOL_TARGET_ENABLED=false or ATR missing.
      volScale = 1.0;
      if (config.VOL_TARGET_ENABLED && ind.atr && entryPrice > 0) {
        const realizedVol = ind.atr / entryPrice;
        const raw = config.VOL_TARGET_ATR_PCT / realizedVol;
        volScale = Math.max(config.VOL_TARGET_MIN_SCALE, Math.min(config.VOL_TARGET_MAX_SCALE, raw));
      }

      // Kelly multiplier — scales risk by historical win-rate & win/loss ratio.
      // Honors KELLY_ENABLED runtime flag (default off). Cold-start symbols
      // return 1.0 so this is a no-op until 20+ closed trades accumulate.
      const kelly = require('../kelly');
      kellyScale = await kelly.kellyMultiplier(symbol);

      // Gradual live deployment ramp — final top-line multiplier, clamps
      // all the above scaling inside the currently-earned capital tier.
      const liveRamp = require('../live-ramp');
      rampMultiplier = liveRamp.getMultiplier();

      const baseRiskPct = (riskResult.adjustments?.risk_pct || rc('RISK_PCT')) * (regime.position_scale || 1.0);
      // orchestrator confidence * earnings dampener * volatility target * kelly * ramp
      riskPct = baseRiskPct * size_adjustment * earningsSizeFactor * volScale * kellyScale * rampMultiplier;
    }

    const portfolioValue = account.portfolio_value;
    const buyingPower = account.buying_power;

    const stopLoss = +(entryPrice * (1 - stopPct)).toFixed(4);
    const takeProfit = +(entryPrice * (1 + targetPct)).toFixed(4);
    const intendedRiskDollars = portfolioValue * riskPct;
    const stopDist = entryPrice - stopLoss;

    const { roundQty, getRiskParams: getAssetRisk } = require('../asset-classes');
    const minQty = getAssetRisk(symbol).minQty ?? 1;
    let qty = roundQty(intendedRiskDollars / stopDist, symbol);
    const maxQty = roundQty((portfolioValue * rc('MAX_POS_PCT')) / entryPrice, symbol);
    qty = Math.min(qty, maxQty);
    if (qty < minQty) qty = minQty;

    const orderValue = qty * entryPrice;
    // Persist the ACTUAL at-risk dollars based on the capped qty — not
    // the pre-cap intent. When MAX_POS_PCT clamps qty (it usually does
    // on >$200 stocks at 2% risk + 3.5% stop), actual risk = qty *
    // stopDist << portfolioValue * riskPct. The prior code persisted
    // the intended value, which inflated portfolio_heat by 3-5× and
    // could falsely trip the 20% heat cap while the actual at-risk
    // was nowhere near it. risk-agent._calcPortfolioHeat sums this
    // column directly so the cap is only honest with the capped value.
    const riskDollars = +(qty * stopDist).toFixed(2);

    // Funds check
    if (orderValue > buyingPower * 0.95) {
      return {
        executed: false,
        reason: `Insufficient funds: need ${orderValue.toFixed(2)}, have ${buyingPower.toFixed(2)}`,
      };
    }

    // ----- Ladder mode -----
    // Split the position into N rungs at decreasing limit prices so a
    // lower-conviction signal becomes many small bets. Rung 1 fills at
    // market (via SOR); rungs 2..N are day-limit orders that auto-cancel
    // at close. Total risk is unchanged — qty is split, not multiplied.
    // P&L tracking reflects rung 1 only when later rungs partially fill;
    // the close path uses Alpaca's position state so cash accounting is
    // always correct (trade.qty under-reports if all rungs filled).
    // Momentum trades bypass ladder mode — splitting a 0.5% bet into 3
    // rungs of 0.17% each would hit minQty=1 immediately and the entry
    // would not be "spread" in any meaningful way. The wide flat stop
    // already does the analogous risk-management job.
    const ladderEnabled = !isMomentum && runtimeConfig.get('LADDER_MODE_ENABLED') === true;
    const ladderRungsRaw = parseInt(runtimeConfig.get('LADDER_RUNGS') ?? 3, 10);
    const ladderStepRaw = parseFloat(runtimeConfig.get('LADDER_STEP_PCT') ?? 0.005);
    const ladderRungs = Math.max(2, Math.min(5, Number.isFinite(ladderRungsRaw) ? ladderRungsRaw : 3));
    const ladderStep = Math.max(0.001, Math.min(0.05, Number.isFinite(ladderStepRaw) ? ladderStepRaw : 0.005));
    // Ladder only kicks in when qty supports it — if qty < ladderRungs we
    // can't split meaningfully, so fall back to a single market rung.
    const effectiveRungs = ladderEnabled && qty >= ladderRungs * minQty ? ladderRungs : 1;
    const baseRungQty = Math.floor(qty / effectiveRungs);
    const rungQtys = Array(effectiveRungs).fill(baseRungQty);
    rungQtys[effectiveRungs - 1] += qty - baseRungQty * effectiveRungs;
    const rung1Qty = rungQtys[0];

    log(
      `Sizing ${symbol}: entry=$${entryPrice.toFixed(2)} atr=${ind.atr ?? 'n/a'} stopPct=${(stopPct * 100).toFixed(2)}% source=${stopPctInfo.source} stop=$${stopLoss} target=$${takeProfit} qty=${qty}${effectiveRungs > 1 ? ` (ladder ${effectiveRungs} rungs ${ladderStep * 100}% apart, rung1=${rung1Qty})` : ''} scales={conf:${size_adjustment.toFixed(2)},earn:${earningsSizeFactor.toFixed(2)},vol:${volScale.toFixed(2)},kelly:${kellyScale.toFixed(2)}}`,
    );

    // Place rung 1 via Smart Order Router (limit at mid + small offset,
    // market fallback on timeout). Transparently routes to plain market
    // when SMART_ORDER_ROUTING_ENABLED is false.
    const sor = require('../smart-order-router');
    const metrics = (() => {
      try {
        return require('../metrics');
      } catch {
        return null;
      }
    })();
    const orderStart = Date.now();
    const sorResult = await sor.placeSmartOrder({ symbol, qty: rung1Qty, side: 'buy', snapshot });
    const order = sorResult.order;
    const fillTimeMs = Date.now() - orderStart;
    if (metrics) {
      metrics.smartOrdersTotal.inc({ strategy: sorResult.strategy });
      if (sorResult.strategy === 'limit' && Number.isFinite(sorResult.savingsBps)) {
        metrics.smartOrderSavingsBps.observe(sorResult.savingsBps);
      }
      try {
        metrics.ladderRungsPlacedTotal?.inc({ rung: '1' });
      } catch {
        /* metrics optional */
      }
    }

    // Fire rungs 2..N as day-limit orders below entry. Errors on individual
    // rungs are logged but never block — rung 1 already filled, and
    // un-placed rungs simply mean fewer chances to add. Awaited here so
    // ladder placement is complete before we publish the SIGNAL event.
    const ladderRungOrders = [];
    if (effectiveRungs > 1) {
      for (let i = 1; i < effectiveRungs; i++) {
        const rungPrice = +(entryPrice * (1 - ladderStep * i)).toFixed(4);
        const rungQty = rungQtys[i];
        try {
          const rungOrder = await alpaca.placeLimitOrder(symbol, rungQty, 'buy', rungPrice);
          ladderRungOrders.push({ rung: i + 1, qty: rungQty, limitPrice: rungPrice, orderId: rungOrder.id });
          log(`  ↳ ladder rung ${i + 1}: ${rungQty} @ $${rungPrice} (limit, day TIF) order=${rungOrder.id}`);
          if (metrics) {
            try {
              metrics.ladderRungsPlacedTotal?.inc({ rung: String(i + 1) });
            } catch {
              /* metrics optional */
            }
          }
        } catch (rungErr) {
          error(`Ladder rung ${i + 1} failed for ${symbol} @ $${rungPrice}`, rungErr);
        }
      }
    }

    // Atomically insert signal + trade + link decision. Alpaca order stays OUTSIDE:
    // a DB rollback cannot unplace an order. Log orphan for reconciliation.
    let signalId = null;
    try {
      await db.withTransaction(async (client) => {
        const signalResult = await client.query(
          `INSERT INTO signals (symbol, signal, reason, close, ema9, ema21, rsi, volume_ratio, acted_on)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
             RETURNING id`,
          [
            symbol,
            'BUY',
            `Agency: ${decision.reasoning?.slice(0, 200) || 'Orchestrator decision'}`,
            entryPrice,
            ind.ema9,
            ind.ema21,
            ind.rsi,
            ind.volumeRatio,
          ],
        );
        signalId = signalResult.rows[0]?.id || null;

        // Derive the strategy pool from the decision's supporters so we
        // can track per-strategy P&L downstream.
        const strategyPool = deriveStrategyPool(decision);

        // In ladder mode, the trade row records ONLY rung 1's qty/value — what
        // is actually filled now. If ladder rungs 2..N fill later, Alpaca's
        // position grows but trade.qty stays at rung1Qty. The close path uses
        // Alpaca's actual position to compute realized P&L, so accounting is
        // still correct even though trade.qty under-reports.
        const rung1OrderValue = +(rung1Qty * entryPrice).toFixed(2);
        await client.query(
          `INSERT INTO trades (symbol, alpaca_order_id, side, qty, entry_price, current_price, stop_loss, take_profit, order_value, risk_dollars, status, signal_id, strategy_pool)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            symbol,
            order.id,
            'buy',
            rung1Qty,
            entryPrice,
            entryPrice,
            stopLoss,
            takeProfit,
            rung1OrderValue,
            riskDollars,
            'open',
            signalId,
            strategyPool,
          ],
        );
        try {
          require('../metrics').tradesOpenedTotal.inc();
        } catch {
          /* skip */
        }

        if (signalId) {
          await client.query(
            `UPDATE agent_decisions SET signal_id = $1 WHERE symbol = $2 AND action = 'BUY'
               AND created_at > NOW() - INTERVAL '10 minutes' AND signal_id IS NULL
               AND id = (
                 SELECT id FROM agent_decisions WHERE symbol = $2 AND action = 'BUY'
                 AND created_at > NOW() - INTERVAL '10 minutes' AND signal_id IS NULL
                 ORDER BY created_at DESC LIMIT 1
               )`,
            [signalId, symbol],
          );
        }
      });
    } catch (txErr) {
      error(
        `ORPHAN ALPACA ORDER — DB rollback for ${symbol} buy (alpaca_order_id=${order.id}). Requires reconciliation.`,
        txErr,
      );
      require('../alerting').critical(
        `Orphan Alpaca order: ${symbol}`,
        `BUY for ${symbol} succeeded on Alpaca (order_id=${order.id}) but DB write rolled back. The position is live; reconciler will pick it up, but manual verification is advised.`,
        { symbol, alpacaOrderId: order.id, error: txErr.message },
      );
      throw txErr;
    }

    const fillReport = {
      symbol,
      action: 'BUY',
      qty: rung1Qty,
      plannedQty: qty,
      entryPrice,
      stopLoss,
      takeProfit,
      orderValue: +(rung1Qty * entryPrice).toFixed(2),
      riskDollars,
      riskPct,
      regime: regime.regime,
      confidence: confidence,
      sizeAdjustment: size_adjustment,
      fillTimeMs,
      orderId: order.id,
      ladder: effectiveRungs > 1
        ? { rungs: effectiveRungs, stepPct: ladderStep, additionalRungs: ladderRungOrders }
        : null,
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

    log(
      `✅ ORDER PLACED: ${symbol} qty=${rung1Qty}${effectiveRungs > 1 ? `/${qty} (rung 1 of ${effectiveRungs})` : ''} entry=${entryPrice} stop=${stopLoss} target=${takeProfit} (fill: ${fillTimeMs}ms, confidence: ${confidence})`,
    );

    return { executed: true, ...fillReport };
  }

  /**
   * Execute a SELL decision — close an existing position.
   */
  async _executeSell(decision) {
    const { symbol } = decision;

    const existing = await db.query('SELECT * FROM trades WHERE symbol = $1 AND status = $2', [symbol, 'open']);

    if (existing.rows.length === 0) {
      return { executed: false, reason: `No open position for ${symbol}` };
    }

    const trade = existing.rows[0];
    const position = await alpaca.getPosition(symbol);
    const currentPrice = position ? parseFloat(position.current_price) : parseFloat(trade.current_price);

    await alpaca.closePosition(symbol); // outside txn — rollback can't unclose

    const pnl = +((currentPrice - parseFloat(trade.entry_price)) * trade.qty).toFixed(2);
    const pnlPct = +(((currentPrice - parseFloat(trade.entry_price)) / parseFloat(trade.entry_price)) * 100).toFixed(4);

    // Compute indicators outside transaction (read-only network call)
    const sellInd = await computeIndicators(symbol);

    try {
      await db.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO signals (symbol, signal, reason, close, ema9, ema21, rsi, volume_ratio, acted_on)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
          [
            symbol,
            'SELL',
            `Agency: ${decision.reasoning?.slice(0, 200) || 'Orchestrator sell decision'}`,
            currentPrice,
            sellInd.ema9,
            sellInd.ema21,
            sellInd.rsi,
            sellInd.volumeRatio,
          ],
        );
        await client.query(
          `UPDATE trades
           SET status = 'closed', exit_price = $1, pnl = $2, pnl_pct = $3,
               exit_reason = $4, closed_at = NOW(), current_price = $1
           WHERE id = $5`,
          [currentPrice, pnl, pnlPct, 'orchestrator_sell', trade.id],
        );
      });
    } catch (txErr) {
      error(
        `ORPHAN SELL — DB rollback after closing ${symbol} on Alpaca (trade_id=${trade.id}). Position is closed but DB still shows 'open'. Requires reconciliation.`,
        txErr,
      );
      require('../alerting').critical(
        `Orphan sell: ${symbol}`,
        `Alpaca close succeeded but DB update rolled back. Trade ${trade.id} still shows 'open'; reconciler will fix it but manual verification is advised.`,
        { symbol, tradeId: trade.id, error: txErr.message },
      );
      throw txErr;
    }

    log(`POSITION CLOSED: ${symbol} pnl=${pnl} reason=orchestrator_sell`);

    // Notify on large winners/losers so you don't have to watch the dashboard.
    // Absolute threshold: any single close whose pnl exceeds 1% of initial capital.
    const pnlAbs = Math.abs(pnl);
    if (pnlAbs >= 1000) {
      // $1k on the default $100k paper account = 1%
      require('../alerting').warn(
        `${pnl >= 0 ? 'Big win' : 'Big loss'} on ${symbol}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%)`,
        `${decision.reasoning?.slice(0, 200) || 'Orchestrator sell'}`,
        { symbol, pnl, pnlPct, exitReason: 'orchestrator_sell' },
      );
    }

    await messageBus.publish('SIGNAL', this.name, {
      symbol,
      action: 'SELL_FILLED',
      pnl,
      pnlPct,
      exitReason: 'orchestrator_sell',
    });

    return { executed: true, symbol, action: 'SELL', pnl, pnlPct };
  }

  // ===========================================================================
  // Options branch (Phase 1 MVP) — single-leg long calls/puts.
  // Gated by OPTIONS_ENABLED upstream in _dispatch. The two methods below
  // are deliberately self-contained and do NOT call _executeSell or the
  // equity-sizing helpers — option premium curves don't translate.
  // ===========================================================================

  /**
   * Execute a BUY on an option contract:
   *   - Fetch snapshot for premium + Greeks
   *   - Days-to-expiry gate (THETA_DECAY_DAYS_THRESHOLD)
   *   - Delta-adjusted exposure cap (MAX_DELTA_EXPOSURE_PCT vs portfolio)
   *   - Premium-paid risk sizing (MAX_OPTION_RISK_PCT × portfolio)
   *   - Place market order via placeOptionOrder (no bracket)
   *   - Persist signals + trades rows with option_type/strike/Greeks
   */
  async _executeOption(decision) {
    const { symbol, confidence, size_adjustment = 1.0 } = decision;
    const { parseOptionSymbol, daysToExpiry } = require('../asset-classes');

    const parsed = parseOptionSymbol(symbol);
    if (!parsed) {
      return { executed: false, reason: `Invalid OCC symbol: ${symbol}` };
    }

    // No duplicate position guard
    const existing = await db.query('SELECT id FROM trades WHERE symbol = $1 AND status = $2', [symbol, 'open']);
    if (existing.rows.length > 0) {
      return { executed: false, reason: `Position already open for ${symbol}` };
    }

    // Pull snapshot — we need premium AND Greeks. Bail if Alpaca has no data
    // (newly listed contract, weekend, etc.).
    const snap = await alpaca.getOptionSnapshot(symbol);
    if (!snap) return { executed: false, reason: `No option snapshot for ${symbol}` };
    const premium = Number.isFinite(snap.last) && snap.last > 0
      ? snap.last
      : Number.isFinite(snap.ask) && Number.isFinite(snap.bid)
        ? (snap.ask + snap.bid) / 2
        : null;
    if (!premium || !(premium > 0)) {
      return { executed: false, reason: `No tradeable premium for ${symbol}` };
    }

    // Days-to-expiry gate — block opens too close to expiration.
    const dte = daysToExpiry(symbol);
    const dteThreshold = runtimeConfig.get('THETA_DECAY_DAYS_THRESHOLD') ?? config.THETA_DECAY_DAYS_THRESHOLD;
    if (dte != null && dte <= dteThreshold) {
      log(`📅 OPTION DTE BLOCK: ${symbol} expires in ${dte}d (threshold=${dteThreshold})`);
      return { executed: false, reason: `Within ${dteThreshold}d of expiry (${dte}d to expiry)` };
    }

    // Risk-agent veto (delta-aware path is in risk-agent.js evaluate())
    const riskResult = await riskAgent.evaluate({ symbol, close: premium });
    if (!riskResult.approved) {
      log(`🛡️ RISK VETO (option): ${symbol} — ${riskResult.reason}`);
      return { executed: false, reason: `Risk veto: ${riskResult.reason}` };
    }

    const account = await alpaca.getAccount();
    const portfolioValue = account.portfolio_value;
    const buyingPower = account.buying_power;

    // Sizing: MAX_OPTION_RISK_PCT of portfolio paid in premium, ÷ contract cost.
    // contractCost = premium × multiplier (100 for standard equity options).
    const optionRiskPct = runtimeConfig.get('MAX_OPTION_RISK_PCT') ?? config.MAX_OPTION_RISK_PCT;
    const riskDollars = portfolioValue * optionRiskPct * size_adjustment;
    const contractCost = premium * (parsed.contractMultiplier || 100);
    let qty = Math.floor(riskDollars / contractCost);

    // Delta-adjusted exposure cap. Underlying notional = qty × |delta| × spotPx × multiplier.
    // Use snap.underlyingPrice if Alpaca provides it; else best-effort via getSnapshot.
    let underlyingPx = null;
    try {
      const underlyingSnap = await alpaca.getSnapshot(parsed.underlying);
      underlyingPx = underlyingSnap?.latestTrade?.p || underlyingSnap?.minuteBar?.c || null;
    } catch (e) {
      // Non-fatal — delta cap will fall back to qty=1 if we can't price the underlying
    }
    const deltaCap = runtimeConfig.get('MAX_DELTA_EXPOSURE_PCT') ?? config.MAX_DELTA_EXPOSURE_PCT;
    if (snap.delta != null && underlyingPx) {
      const perContractDeltaNotional = Math.abs(snap.delta) * underlyingPx * (parsed.contractMultiplier || 100);
      const maxDeltaNotional = portfolioValue * deltaCap;
      const qtyFromDelta = Math.floor(maxDeltaNotional / Math.max(perContractDeltaNotional, 1));
      if (qty > qtyFromDelta) {
        log(
          `Option sizing trimmed by delta cap: ${qty} → ${qtyFromDelta} ` +
            `(δ=${snap.delta.toFixed(3)}, underlying=$${underlyingPx.toFixed(2)}, cap=${(deltaCap * 100).toFixed(1)}%)`,
        );
        qty = qtyFromDelta;
      }
    }

    // Final sizing guards
    if (qty < 1) {
      return {
        executed: false,
        reason: `Option size <1 contract after risk caps (premium=$${premium.toFixed(2)}, riskCap=$${riskDollars.toFixed(2)})`,
      };
    }
    const orderValue = qty * contractCost;
    if (orderValue > buyingPower * 0.95) {
      return {
        executed: false,
        reason: `Insufficient funds for ${qty}× ${symbol}: need $${orderValue.toFixed(2)}, have $${buyingPower.toFixed(2)}`,
      };
    }

    log(
      `Option sizing ${symbol}: prem=$${premium.toFixed(2)} δ=${snap.delta ?? 'n/a'} θ=${snap.theta ?? 'n/a'} ` +
        `iv=${snap.impliedVolatility ?? 'n/a'} dte=${dte}d qty=${qty} cost=$${orderValue.toFixed(2)}`,
    );

    // Place market order. Bracket orders aren't reliably available for options
    // in Alpaca paper, so monitor.js handles stop/target on premium curve.
    const order = await alpaca.placeOptionOrder(symbol, qty, 'buy', { orderType: 'market' });

    // Persist signal + trade. The trades row carries all option columns from
    // migration 014 so the monitor + dashboards can render them without a join.
    let signalId = null;
    try {
      await db.withTransaction(async (client) => {
        const sig = await client.query(
          `INSERT INTO signals
             (symbol, signal, reason, close, acted_on,
              option_type, expiration_date, strike, underlying, delta, iv)
           VALUES ($1, 'BUY', $2, $3, true, $4, $5, $6, $7, $8, $9)
           RETURNING id`,
          [
            symbol,
            `Agency option: ${decision.reasoning?.slice(0, 200) || 'Orchestrator option decision'}`,
            premium,
            parsed.type,
            parsed.expiration,
            parsed.strike,
            parsed.underlying,
            snap.delta,
            snap.impliedVolatility,
          ],
        );
        signalId = sig.rows[0]?.id || null;

        await client.query(
          `INSERT INTO trades
             (symbol, alpaca_order_id, side, qty, entry_price, current_price,
              order_value, risk_dollars, status, signal_id, strategy_pool,
              option_type, expiration_date, strike, contract_multiplier,
              underlying, delta, gamma, theta, vega, rho, iv)
           VALUES ($1, $2, 'buy', $3, $4, $4, $5, $6, 'open', $7, 'option_long',
                   $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
          [
            symbol,
            order.id,
            qty,
            premium,
            orderValue,
            riskDollars,
            signalId,
            parsed.type,
            parsed.expiration,
            parsed.strike,
            parsed.contractMultiplier || 100,
            parsed.underlying,
            snap.delta,
            snap.gamma,
            snap.theta,
            snap.vega,
            snap.rho,
            snap.impliedVolatility,
          ],
        );
      });
      try { require('../metrics').tradesOpenedTotal.inc(); } catch {}
    } catch (dbErr) {
      error(
        `ORPHAN OPTION ORDER — DB rollback after placing ${symbol} on Alpaca (order=${order.id}). Reconciler will fix.`,
        dbErr,
      );
      throw dbErr;
    }

    return {
      executed: true,
      symbol,
      action: 'BUY',
      qty,
      entryPrice: premium,
      orderValue,
      orderId: order.id,
      meta: { dte, delta: snap.delta, iv: snap.impliedVolatility, optionType: parsed.type },
    };
  }

  /**
   * Close an open option position. Mirrors _executeSell but uses the
   * option contract symbol and reads current premium from the snapshot.
   */
  async _closeOptionPosition(decision) {
    const { symbol } = decision;

    const existing = await db.query('SELECT * FROM trades WHERE symbol = $1 AND status = $2', [symbol, 'open']);
    if (existing.rows.length === 0) {
      return { executed: false, reason: `No open option position for ${symbol}` };
    }
    const trade = existing.rows[0];
    const qty = trade.qty;

    // Read current premium for P&L. Fall back to entry price if snapshot fails
    // (rare, but better than failing the close).
    let exitPremium = parseFloat(trade.current_price);
    try {
      const snap = await alpaca.getOptionSnapshot(symbol);
      const fresh = snap?.last ?? (snap?.ask != null && snap?.bid != null ? (snap.ask + snap.bid) / 2 : null);
      if (fresh && fresh > 0) exitPremium = fresh;
    } catch (e) { /* fall back to last cached price */ }

    // Place sell-to-close at market — no bracket
    await alpaca.placeOptionOrder(symbol, qty, 'sell', { orderType: 'market' });

    const mult = trade.contract_multiplier || 100;
    const entry = parseFloat(trade.entry_price);
    const pnl = +((exitPremium - entry) * qty * mult).toFixed(2);
    const pnlPct = entry > 0 ? +(((exitPremium - entry) / entry) * 100).toFixed(4) : 0;

    try {
      await db.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO signals (symbol, signal, reason, close, acted_on, option_type, underlying)
           VALUES ($1, 'SELL', $2, $3, true, $4, $5)`,
          [
            symbol,
            `Agency option close: ${decision.reasoning?.slice(0, 200) || 'Orchestrator close'}`,
            exitPremium,
            trade.option_type,
            trade.underlying,
          ],
        );
        await client.query(
          `UPDATE trades
              SET status = 'closed', exit_price = $1, pnl = $2, pnl_pct = $3,
                  exit_reason = 'orchestrator_sell', closed_at = NOW(), current_price = $1
            WHERE id = $4`,
          [exitPremium, pnl, pnlPct, trade.id],
        );
      });
      try { require('../metrics').tradesClosedTotal.inc({ reason: 'orchestrator_sell' }); } catch {}
    } catch (txErr) {
      error(`ORPHAN OPTION SELL — close placed but DB rollback for ${symbol} (trade ${trade.id})`, txErr);
      throw txErr;
    }

    log(`OPTION CLOSED: ${symbol} qty=${qty} exit=$${exitPremium} pnl=${pnl}`);
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
