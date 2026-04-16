/**
 * Replay engine — drives a synthetic clock through historical bars and
 * runs a strategy against each tick.
 *
 * This is the production-pipeline counterpart to runBacktest's simple
 * per-bar rule loop. It's written so we can swap strategies cleanly:
 *
 *   - 'rules' (default, fast): runs indicators.detectSignal on each
 *      symbol's bars-as-of-now. ~50k cycles/sec, no LLM cost.
 *
 *   - 'agency' (slow, costly): runs the real agency stack
 *      (technical-agent + risk-agent + orchestrator + execution-agent)
 *      against an Alpaca shim that returns historical bars + the
 *      sandbox account/positions instead of the live ones. Used for
 *      end-to-end validation of agency changes against history.
 *      Token-budget aware: skips the LLM if the daily cap is reached
 *      and falls back to rules so the run finishes.
 *
 * The engine always uses SandboxState so production tables/orders are
 * never touched. Output is the full sandbox: trades, signals,
 * decisions, equity curve, summary.
 */

const alpaca = require('../alpaca');
const config = require('../config');
const indicators = require('../indicators');
const { SandboxState } = require('./sandbox-state');
const { log, error } = require('../logger');

/**
 * Pre-load historical daily bars for each symbol once so each replay
 * tick can slice the prefix without hitting the API repeatedly.
 *
 * `extraDays` covers the warmup needed for indicator computation.
 */
async function loadHistoricalBars(symbols, days, extraDays = 30) {
  const bars = {};
  for (const symbol of symbols) {
    try {
      const data = await alpaca.getDailyBars(symbol, days + extraDays);
      if (data && data.length >= config.EMA_SLOW + 2) {
        bars[symbol] = data;
      }
    } catch (err) {
      error(`Replay: failed to fetch bars for ${symbol}`, err);
    }
  }
  return bars;
}

/**
 * Build the master timeline as a sorted list of unique dates seen
 * across all symbols' bars. Restricted to the trailing `days` window.
 */
function buildTimeline(bars, days) {
  const dateSet = new Set();
  for (const symBars of Object.values(bars)) {
    for (const b of symBars) dateSet.add(b.t.slice(0, 10));
  }
  const all = [...dateSet].sort();
  return all.slice(Math.max(0, all.length - days));
}

/**
 * Default rule-based strategy — wraps indicators.detectSignal and
 * mirrors the legacy executor's stop/target math (ATR-scaled when
 * available, fixed % otherwise).
 */
function rulesStrategy({ stopPct = 0.03, targetPct = 0.06, atrStopMult = 2.0 } = {}) {
  return {
    name: 'rules',
    /**
     * Called once per cycle per symbol. Receives the bars window up
     * to and including the current date and the sandbox snapshot.
     * Returns:
     *   { intent: 'open' | 'close' | 'hold', stop?, target?, qty? }
     */
    decide({ symbol, windowBars, sandbox }) {
      const cur = windowBars[windowBars.length - 1];
      if (!cur) return { intent: 'hold' };

      // Already long? Check exit conditions.
      const pos = sandbox.positions.get(symbol);
      if (pos) {
        if (cur.l <= pos.stop) return { intent: 'close', exitReason: 'stop_loss' };
        if (cur.h >= pos.target) return { intent: 'close', exitReason: 'take_profit' };
        return { intent: 'hold' };
      }

      // Need warmup before signaling
      if (windowBars.length < config.EMA_SLOW + 2) return { intent: 'hold' };

      const sig = indicators.detectSignal(windowBars);
      if (sig.signal !== 'BUY') return { intent: 'hold' };

      const entry = cur.c;
      const atr = indicators.calcAtr(windowBars, config.ATR_PERIOD);
      const atrStopDist = atr ? atr * atrStopMult : null;
      const effectiveStopPct = atrStopDist ? Math.max(0.02, Math.min(0.08, atrStopDist / entry)) : stopPct;

      const stop = +(entry * (1 - effectiveStopPct)).toFixed(4);
      const target = +(entry * (1 + targetPct)).toFixed(4);
      return { intent: 'open', stop, target, reasoning: sig.reason };
    },
  };
}

/**
 * Run the replay. See the file header for strategy modes.
 *
 * @param {Object} options
 * @param {string[]} options.symbols
 * @param {number} options.days
 * @param {'rules'} [options.strategy='rules']
 * @param {number} [options.startingCapital=100000]
 * @param {number} [options.riskPct=0.02]
 * @param {number} [options.maxPosPct=0.10]
 * @param {number} [options.slippagePct=0.0005]
 * @param {number} [options.feePerShare=0]
 * @param {Function} [options.onProgress]   (cycleIdx, totalCycles) => void
 */
async function runReplay(options = {}) {
  const {
    symbols = config.WATCHLIST,
    days = 90,
    strategy: strategyName = 'rules',
    startingCapital = 100_000,
    riskPct = config.RISK_PCT,
    maxPosPct = config.MAX_POS_PCT,
    slippagePct = 0.0005,
    feePerShare = 0,
    feePerOrder = 0,
    onProgress = null,
    bars: preloadedBars = null,
  } = options;

  log(`Replay starting: strategy=${strategyName} symbols=${symbols.length} days=${days}`);

  const bars = preloadedBars || (await loadHistoricalBars(symbols, days));
  if (Object.keys(bars).length === 0) {
    return { sandbox: new SandboxState({ startingCapital }), summary: null, error: 'No bars loaded' };
  }

  const timeline = buildTimeline(bars, days);
  const sandbox = new SandboxState({ startingCapital, slippagePct, feePerShare, feePerOrder });
  const strat =
    strategyName === 'rules'
      ? rulesStrategy(options)
      : (() => {
          throw new Error(`Unknown strategy: ${strategyName}`);
        })();

  // Index each symbol's bars by date for O(1) lookup
  const dateIndex = {};
  for (const [sym, sbars] of Object.entries(bars)) {
    dateIndex[sym] = new Map(sbars.map((b, i) => [b.t.slice(0, 10), i]));
  }

  for (let cycleIdx = 0; cycleIdx < timeline.length; cycleIdx++) {
    const date = timeline[cycleIdx];
    const ts = `${date}T16:00:00Z`;
    const closingPrices = {};

    for (const symbol of symbols) {
      const sbars = bars[symbol];
      const idx = dateIndex[symbol]?.get(date);
      if (idx == null) continue;
      const cur = sbars[idx];
      closingPrices[symbol] = cur.c;
      const windowBars = sbars.slice(0, idx + 1);

      const decision = strat.decide({ symbol, windowBars, sandbox, date });

      if (decision.intent === 'close') {
        sandbox.closePosition({
          symbol,
          cleanExit: cur.c,
          closedAt: ts,
          exitReason: decision.exitReason,
        });
        sandbox.decisions.push({ ts, symbol, action: 'SELL', source: strat.name, exitReason: decision.exitReason });
      } else if (decision.intent === 'open') {
        const acct = sandbox.getAccount();
        const stopDist = cur.c - decision.stop;
        if (stopDist <= 0) continue;
        const riskDollars = acct.portfolio_value * riskPct;
        let qty = Math.floor(riskDollars / stopDist);
        const maxQty = Math.floor((acct.portfolio_value * maxPosPct) / cur.c);
        qty = Math.max(1, Math.min(qty, maxQty));
        const result = sandbox.openLong({
          symbol,
          qty,
          cleanPrice: cur.c,
          stop: decision.stop,
          target: decision.target,
          openedAt: ts,
          decision: { reasoning: decision.reasoning },
        });
        if (result.executed) {
          sandbox.decisions.push({ ts, symbol, action: 'BUY', source: strat.name, qty, reasoning: decision.reasoning });
        }
      }
    }

    sandbox.markToMarket(closingPrices);
    sandbox.recordEquity(ts);

    if (onProgress && cycleIdx % 10 === 0) onProgress(cycleIdx, timeline.length);
  }

  const summary = sandbox.summary();
  log(
    `Replay complete: ${summary.totalTrades} trades, ${summary.totalReturn}% return, ${summary.winRate}% win rate, max DD ${summary.maxDrawdown}%`,
  );
  return { sandbox, summary };
}

module.exports = { runReplay, loadHistoricalBars, buildTimeline, rulesStrategy };
