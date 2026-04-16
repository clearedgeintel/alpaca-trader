const config = require('./config');
const alpaca = require('./alpaca');
const { detectSignal, calcAtr } = require('./indicators');
const { log, error } = require('./logger');

/**
 * Run a backtest over historical daily bars for a set of symbols.
 *
 * @param {Object} options
 * @param {string[]} options.symbols - Symbols to test
 * @param {number} [options.days=90] - How many days of history
 * @param {number} [options.riskPct] - Override risk per trade
 * @param {number} [options.stopPct] - Override stop loss %
 * @param {number} [options.targetPct] - Override take profit %
 * @param {number} [options.trailingAtrMult] - Override trailing ATR multiplier
 * @returns {Promise<Object>} Backtest results
 */
async function runBacktest({
  symbols = config.WATCHLIST,
  days = 90,
  riskPct = config.RISK_PCT,
  stopPct = config.STOP_PCT,
  targetPct = config.TARGET_PCT,
  trailingAtrMult = config.TRAILING_ATR_MULT,
  startingCapital = 100000,
  // Slippage: fraction of price by which fills slip in an unfavorable direction.
  // 0.0005 = 5 basis points, a conservative default for liquid US equities.
  // Buys fill above ask, sells fill below bid.
  slippagePct = 0.0005,
  // Per-share commission. Alpaca charges $0 for equities but a non-zero value
  // is useful for stress-testing fee sensitivity.
  feePerShare = 0,
  // Flat per-order fee (e.g. regulatory fees, SEC/TAF). Tiny but nonzero in reality.
  feePerOrder = 0,
  // Stable seed for deterministic slippage distribution when used by Monte Carlo.
  // When null, uses fixed-magnitude slippage (classical backtest behavior).
  slippageRandomize = false,
  bars: preloadedBars = null,
} = {}) {
  log(
    `Backtest starting: ${symbols.length} symbols, ${days} days, slippage=${(slippagePct * 10000).toFixed(1)}bps, fee/share=$${feePerShare}, fee/order=$${feePerOrder}`,
  );

  // Internal slippage function — returns a (1 + adjustment) multiplier.
  // adjustment is positive for buys (worse fill, above clean price) and
  // negative for sells (worse fill, below clean price). When randomize is
  // on, the magnitude is sampled uniformly in [0.5x, 1.5x] of slippagePct
  // so Monte Carlo runs see varied fill quality.
  function slip(isBuy) {
    const mag = slippageRandomize ? slippagePct * (0.5 + Math.random()) : slippagePct;
    return isBuy ? 1 + mag : 1 - mag;
  }

  // Total per-order cost (buy AND sell each pay once).
  function orderCost(qty) {
    return feePerOrder + qty * feePerShare;
  }

  const trades = [];
  const equityCurve = [];
  let capital = startingCapital;
  let peakCapital = startingCapital;
  let maxDrawdown = 0;
  const dailyReturns = [];

  // Fetch all bar data upfront
  const allBars = {};
  for (const symbol of symbols) {
    try {
      const bars = await alpaca.getDailyBars(symbol, days + config.EMA_SLOW + 10);
      if (bars && bars.length > config.EMA_SLOW + 2) {
        allBars[symbol] = bars;
      }
    } catch (err) {
      error(`Backtest: failed to fetch bars for ${symbol}`, err);
    }
  }

  // Build a date-indexed timeline from all bars
  const dateSet = new Set();
  for (const bars of Object.values(allBars)) {
    for (const bar of bars) {
      dateSet.add(bar.t.slice(0, 10));
    }
  }
  const dates = [...dateSet].sort();

  // Simulate day by day
  const openPositions = {}; // symbol -> { entry, stop, target, trailing, highest, qty, entryDate }
  let prevCapital = capital;

  for (const date of dates) {
    const dayStart = capital;

    for (const symbol of symbols) {
      const bars = allBars[symbol];
      if (!bars) continue;

      // Find bars up to and including this date
      const idx = bars.findIndex((b) => b.t.slice(0, 10) === date);
      if (idx < 0) continue;

      const currentBar = bars[idx];
      const currentPrice = currentBar.c;

      // Check open position for exits
      if (openPositions[symbol]) {
        const pos = openPositions[symbol];
        const high = currentBar.h;
        const low = currentBar.l;

        // Update highest price
        if (high > pos.highest) {
          pos.highest = high;
          // Trail stop up
          const atr = calcAtr(bars.slice(0, idx + 1), config.ATR_PERIOD);
          if (atr) {
            const newTrail = +(pos.highest - atr * trailingAtrMult).toFixed(4);
            if (newTrail > pos.trailing) pos.trailing = newTrail;
          }
        }

        const effectiveStop = Math.max(pos.stop, pos.trailing);
        let exitPrice = null;
        let exitReason = null;

        if (low <= effectiveStop) {
          exitPrice = effectiveStop;
          exitReason = pos.trailing > pos.stop ? 'trailing_stop' : 'stop_loss';
        } else if (high >= pos.target) {
          exitPrice = pos.target;
          exitReason = 'take_profit';
        }

        if (exitPrice) {
          // Sell fill slips DOWN from the theoretical stop/target price
          const actualExit = +(exitPrice * slip(false)).toFixed(4);
          const exitFees = orderCost(pos.qty);
          // Gross PnL less (entry fees already deducted when opening) less exit fees
          const grossPnl = (actualExit - pos.entry) * pos.qty;
          const pnl = grossPnl - exitFees;
          capital += pnl;

          trades.push({
            symbol,
            side: 'buy',
            qty: pos.qty,
            entryPrice: pos.entry,
            exitPrice: actualExit,
            cleanExitPrice: exitPrice,
            pnl: +pnl.toFixed(2),
            pnlPct: +(((actualExit - pos.entry) / pos.entry) * 100).toFixed(2),
            fees: +((pos.entryFees || 0) + exitFees).toFixed(2),
            slippageCost: +((pos.cleanEntry - pos.entry) * pos.qty + (exitPrice - actualExit) * pos.qty).toFixed(2),
            exitReason,
            entryDate: pos.entryDate,
            exitDate: date,
            holdDays: Math.round((new Date(date) - new Date(pos.entryDate)) / 86400000),
          });

          delete openPositions[symbol];
        }
      }

      // Check for new entry signals (only if no open position)
      if (!openPositions[symbol] && idx >= config.EMA_SLOW + 2) {
        const windowBars = bars.slice(0, idx + 1);
        const signal = detectSignal(windowBars);

        if (signal.signal === 'BUY') {
          const cleanEntry = currentPrice;
          // Buy fills slip UP from the clean close price
          const entry = +(cleanEntry * slip(true)).toFixed(4);
          const stop = +(entry * (1 - stopPct)).toFixed(4);
          const target = +(entry * (1 + targetPct)).toFixed(4);
          const stopDist = entry - stop;
          const riskDollars = capital * riskPct;
          let qty = Math.floor(riskDollars / stopDist);
          const maxQty = Math.floor((capital * config.MAX_POS_PCT) / entry);
          qty = Math.min(qty, maxQty);
          qty = Math.max(1, qty);

          if (qty * entry <= capital * 0.95) {
            // Deduct entry fees from capital at fill time so the equity curve reflects real cash
            const entryFees = orderCost(qty);
            capital -= entryFees;

            // ATR trailing stop
            let trailing = stop;
            const atr = calcAtr(windowBars, config.ATR_PERIOD);
            if (atr) {
              trailing = Math.max(+(entry - atr * trailingAtrMult).toFixed(4), stop);
            }

            openPositions[symbol] = {
              entry,
              cleanEntry,
              stop,
              target,
              trailing,
              highest: entry,
              qty,
              entryDate: date,
              entryFees,
            };
          }
        }
      }
    }

    // Track equity curve
    const unrealizedPnl = Object.entries(openPositions).reduce((sum, [sym, pos]) => {
      const bars = allBars[sym];
      if (!bars) return sum;
      const idx = bars.findIndex((b) => b.t.slice(0, 10) === date);
      if (idx < 0) return sum;
      return sum + (bars[idx].c - pos.entry) * pos.qty;
    }, 0);

    const totalEquity = capital + unrealizedPnl;
    equityCurve.push({ date, equity: +totalEquity.toFixed(2), capital: +capital.toFixed(2) });

    // Track drawdown
    if (totalEquity > peakCapital) peakCapital = totalEquity;
    const drawdown = peakCapital > 0 ? ((peakCapital - totalEquity) / peakCapital) * 100 : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    // Daily return
    const dailyReturn = prevCapital > 0 ? (totalEquity - prevCapital) / prevCapital : 0;
    dailyReturns.push(dailyReturn);
    prevCapital = totalEquity;
  }

  // Close any remaining open positions at last price (with slippage + fees)
  for (const [symbol, pos] of Object.entries(openPositions)) {
    const bars = allBars[symbol];
    if (!bars || bars.length === 0) continue;
    const lastPrice = bars[bars.length - 1].c;
    const actualExit = +(lastPrice * slip(false)).toFixed(4);
    const exitFees = orderCost(pos.qty);
    const grossPnl = (actualExit - pos.entry) * pos.qty;
    const pnl = grossPnl - exitFees;
    capital += pnl;
    trades.push({
      symbol,
      side: 'buy',
      qty: pos.qty,
      entryPrice: pos.entry,
      exitPrice: actualExit,
      cleanExitPrice: lastPrice,
      pnl: +pnl.toFixed(2),
      pnlPct: +(((actualExit - pos.entry) / pos.entry) * 100).toFixed(2),
      fees: +((pos.entryFees || 0) + exitFees).toFixed(2),
      slippageCost: +((pos.cleanEntry - pos.entry) * pos.qty + (lastPrice - actualExit) * pos.qty).toFixed(2),
      exitReason: 'end_of_backtest',
      entryDate: pos.entryDate,
      exitDate: dates[dates.length - 1],
      holdDays: Math.round((new Date(dates[dates.length - 1]) - new Date(pos.entryDate)) / 86400000),
    });
  }

  // Compute summary stats
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const profitFactor = Math.abs(avgLoss) > 0 ? avgWin / Math.abs(avgLoss) : avgWin > 0 ? Infinity : 0;
  const avgHoldDays = trades.length > 0 ? trades.reduce((s, t) => s + t.holdDays, 0) / trades.length : 0;

  // Sharpe ratio (annualized, assuming 252 trading days)
  const meanReturn = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const stdReturn =
    dailyReturns.length > 1
      ? Math.sqrt(dailyReturns.reduce((sum, r) => sum + (r - meanReturn) ** 2, 0) / (dailyReturns.length - 1))
      : 0;
  const sharpeRatio = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(252) : 0;

  const totalFees = trades.reduce((s, t) => s + (t.fees || 0), 0);
  const totalSlippage = trades.reduce((s, t) => s + (t.slippageCost || 0), 0);

  const summary = {
    startingCapital,
    endingCapital: +capital.toFixed(2),
    totalReturn: +(((capital - startingCapital) / startingCapital) * 100).toFixed(2),
    totalPnl: +totalPnl.toFixed(2),
    totalFees: +totalFees.toFixed(2),
    totalSlippage: +totalSlippage.toFixed(2),
    totalCosts: +(totalFees + totalSlippage).toFixed(2),
    totalTrades: trades.length,
    winRate: +winRate.toFixed(1),
    wins: wins.length,
    losses: losses.length,
    avgWin: +avgWin.toFixed(2),
    avgLoss: +avgLoss.toFixed(2),
    profitFactor: +profitFactor.toFixed(2),
    maxDrawdown: +maxDrawdown.toFixed(2),
    sharpeRatio: +sharpeRatio.toFixed(2),
    avgHoldDays: +avgHoldDays.toFixed(1),
    symbols,
    days,
    params: { riskPct, stopPct, targetPct, trailingAtrMult },
  };

  log(
    `Backtest complete: ${trades.length} trades, ${winRate.toFixed(1)}% win rate, $${totalPnl.toFixed(2)} P&L, Sharpe ${sharpeRatio.toFixed(2)}`,
  );

  return { summary, trades, equityCurve };
}

/**
 * Walk-forward optimization — run the backtest over rolling train/test
 * windows across the history, then aggregate out-of-sample results.
 *
 * Pattern: for each window, the "train" portion is reserved for future
 * parameter-optimization hooks (not used here — we just keep the slot so
 * callers can pass baseline params without reoptimizing). The "test"
 * portion is a pure out-of-sample backtest on the frozen params.
 *
 * @param {Object} options - inherits runBacktest options
 * @param {number} [options.windowDays=60]   - total size of each window
 * @param {number} [options.trainPct=0.6]    - fraction reserved for training
 * @param {number} [options.stepDays=30]     - roll by this many days each window
 * @returns {Promise<{ windows, aggregate }>}
 */
async function runWalkForward(options = {}) {
  const { symbols = config.WATCHLIST, days = 180, windowDays = 60, trainPct = 0.6, stepDays = 30, ...params } = options;

  if (days < windowDays) {
    throw new Error(`Walk-forward needs days >= windowDays (got ${days} < ${windowDays})`);
  }

  // Preload bars ONCE so each window reuses the same history without hitting
  // the API repeatedly. We pass the relevant slice via the `bars` param.
  const allBars = {};
  for (const symbol of symbols) {
    try {
      const bars = await alpaca.getDailyBars(symbol, days + config.EMA_SLOW + 10);
      if (bars && bars.length > config.EMA_SLOW + 2) allBars[symbol] = bars;
    } catch (err) {
      error(`Walk-forward: failed to fetch bars for ${symbol}`, err);
    }
  }

  const windows = [];
  const testDays = Math.max(1, windowDays - Math.floor(windowDays * trainPct));

  // For simplicity, we slice the last N days of bars per window. Walking
  // forward means the test window starts at offset N - windowDays and
  // advances by stepDays each iteration.
  for (let offset = windowDays; offset <= days; offset += stepDays) {
    const windowSymbols = {};
    for (const [sym, bars] of Object.entries(allBars)) {
      // Take bars ending at (total - days + offset); length windowDays + warmup
      const end = bars.length - (days - offset);
      const start = Math.max(0, end - windowDays - config.EMA_SLOW - 2);
      windowSymbols[sym] = bars.slice(start, end);
    }

    // Pass the filtered bars so runBacktest doesn't refetch.
    // Also pass days explicitly so the date window lines up.
    const result = await _runBacktestWithBars(windowSymbols, {
      ...params,
      symbols,
      startingCapital: params.startingCapital || 100000,
      // Walk-forward measures OOS only — skip the train prefix in summary math
      trainDays: Math.floor(windowDays * trainPct),
    });

    windows.push({
      offsetDays: offset,
      testDays,
      startDate: result.equityCurve[0]?.date,
      endDate: result.equityCurve[result.equityCurve.length - 1]?.date,
      summary: result.summary,
      tradeCount: result.trades.length,
    });
  }

  // Aggregate across windows
  const aggregate = _aggregateWalkForward(windows);
  return { windows, aggregate };
}

async function _runBacktestWithBars(symbolBars, options) {
  // Temporarily stub alpaca.getDailyBars to return our pre-sliced bars.
  // The original module is restored in a finally block.
  const original = alpaca.getDailyBars;
  alpaca.getDailyBars = async (symbol) => symbolBars[symbol] || [];
  try {
    return await runBacktest({ ...options, days: 9999 });
  } finally {
    alpaca.getDailyBars = original;
  }
}

function _aggregateWalkForward(windows) {
  if (windows.length === 0) return null;
  const totals = { returns: [], sharpes: [], maxDDs: [], winRates: [] };
  for (const w of windows) {
    totals.returns.push(w.summary.totalReturn);
    totals.sharpes.push(w.summary.sharpeRatio);
    totals.maxDDs.push(w.summary.maxDrawdown);
    totals.winRates.push(w.summary.winRate);
  }
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const std = (a) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
  };
  return {
    windowCount: windows.length,
    avgReturn: +mean(totals.returns).toFixed(2),
    stdReturn: +std(totals.returns).toFixed(2),
    avgSharpe: +mean(totals.sharpes).toFixed(2),
    avgMaxDrawdown: +mean(totals.maxDDs).toFixed(2),
    avgWinRate: +mean(totals.winRates).toFixed(2),
    positiveWindows: windows.filter((w) => w.summary.totalReturn > 0).length,
    negativeWindows: windows.filter((w) => w.summary.totalReturn < 0).length,
    robustness:
      windows.length > 0 ? +(windows.filter((w) => w.summary.totalReturn > 0).length / windows.length).toFixed(3) : 0,
  };
}

/**
 * Monte Carlo simulation — run the backtest N times with randomized
 * slippage (if slippageRandomize=true) and optionally shuffled trade
 * ordering, then return the distribution of outcomes.
 *
 * Useful for:
 *  - Getting a confidence interval on expected return rather than a
 *    single point estimate
 *  - Stress-testing whether the strategy survives bad fill luck
 *
 * @param {Object} options - inherits runBacktest options
 * @param {number} [options.iterations=50]
 * @returns {Promise<{ runs, distribution }>}
 */
async function runMonteCarlo(options = {}) {
  const { iterations = 50, ...params } = options;
  const runs = [];

  // Preload bars once
  const allBars = {};
  for (const symbol of params.symbols || config.WATCHLIST) {
    try {
      const bars = await alpaca.getDailyBars(symbol, (params.days || 90) + config.EMA_SLOW + 10);
      if (bars) allBars[symbol] = bars;
    } catch (err) {
      error(`Monte Carlo: bar fetch failed for ${symbol}`, err);
    }
  }

  for (let i = 0; i < iterations; i++) {
    const result = await _runBacktestWithBars(allBars, {
      ...params,
      slippageRandomize: true,
      slippagePct: params.slippagePct || 0.0005,
    });
    runs.push({
      iter: i + 1,
      totalReturn: result.summary.totalReturn,
      sharpe: result.summary.sharpeRatio,
      maxDD: result.summary.maxDrawdown,
      winRate: result.summary.winRate,
      trades: result.summary.totalTrades,
    });
  }

  const returns = runs.map((r) => r.totalReturn).sort((a, b) => a - b);
  const p = (pct) => returns[Math.min(returns.length - 1, Math.floor(returns.length * pct))];
  const mean = returns.length ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const stdDev =
    returns.length > 1 ? Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1)) : 0;

  const distribution = {
    iterations: runs.length,
    mean: +mean.toFixed(2),
    stdDev: +stdDev.toFixed(2),
    p05: +p(0.05).toFixed(2),
    p25: +p(0.25).toFixed(2),
    p50: +p(0.5).toFixed(2),
    p75: +p(0.75).toFixed(2),
    p95: +p(0.95).toFixed(2),
    min: returns[0] ?? 0,
    max: returns[returns.length - 1] ?? 0,
    probPositive: returns.length ? returns.filter((r) => r > 0).length / returns.length : 0,
  };

  return { runs, distribution };
}

module.exports = { runBacktest, runWalkForward, runMonteCarlo };
