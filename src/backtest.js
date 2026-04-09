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
} = {}) {
  log(`Backtest starting: ${symbols.length} symbols, ${days} days`);

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
      const idx = bars.findIndex(b => b.t.slice(0, 10) === date);
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
          const pnl = (exitPrice - pos.entry) * pos.qty;
          capital += pnl;

          trades.push({
            symbol,
            side: 'buy',
            qty: pos.qty,
            entryPrice: pos.entry,
            exitPrice,
            pnl: +pnl.toFixed(2),
            pnlPct: +(((exitPrice - pos.entry) / pos.entry) * 100).toFixed(2),
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
          const entry = currentPrice;
          const stop = +(entry * (1 - stopPct)).toFixed(4);
          const target = +(entry * (1 + targetPct)).toFixed(4);
          const stopDist = entry - stop;
          const riskDollars = capital * riskPct;
          let qty = Math.floor(riskDollars / stopDist);
          const maxQty = Math.floor((capital * config.MAX_POS_PCT) / entry);
          qty = Math.min(qty, maxQty);
          qty = Math.max(1, qty);

          if (qty * entry <= capital * 0.95) {
            // ATR trailing stop
            let trailing = stop;
            const atr = calcAtr(windowBars, config.ATR_PERIOD);
            if (atr) {
              trailing = Math.max(+(entry - atr * trailingAtrMult).toFixed(4), stop);
            }

            openPositions[symbol] = {
              entry,
              stop,
              target,
              trailing,
              highest: entry,
              qty,
              entryDate: date,
            };
          }
        }
      }
    }

    // Track equity curve
    const unrealizedPnl = Object.entries(openPositions).reduce((sum, [sym, pos]) => {
      const bars = allBars[sym];
      if (!bars) return sum;
      const idx = bars.findIndex(b => b.t.slice(0, 10) === date);
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

  // Close any remaining open positions at last price
  for (const [symbol, pos] of Object.entries(openPositions)) {
    const bars = allBars[symbol];
    if (!bars || bars.length === 0) continue;
    const lastPrice = bars[bars.length - 1].c;
    const pnl = (lastPrice - pos.entry) * pos.qty;
    capital += pnl;
    trades.push({
      symbol,
      side: 'buy',
      qty: pos.qty,
      entryPrice: pos.entry,
      exitPrice: lastPrice,
      pnl: +pnl.toFixed(2),
      pnlPct: +(((lastPrice - pos.entry) / pos.entry) * 100).toFixed(2),
      exitReason: 'end_of_backtest',
      entryDate: pos.entryDate,
      exitDate: dates[dates.length - 1],
      holdDays: Math.round((new Date(dates[dates.length - 1]) - new Date(pos.entryDate)) / 86400000),
    });
  }

  // Compute summary stats
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const profitFactor = Math.abs(avgLoss) > 0 ? avgWin / Math.abs(avgLoss) : avgWin > 0 ? Infinity : 0;
  const avgHoldDays = trades.length > 0 ? trades.reduce((s, t) => s + t.holdDays, 0) / trades.length : 0;

  // Sharpe ratio (annualized, assuming 252 trading days)
  const meanReturn = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const stdReturn = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((sum, r) => sum + (r - meanReturn) ** 2, 0) / (dailyReturns.length - 1))
    : 0;
  const sharpeRatio = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(252) : 0;

  const summary = {
    startingCapital,
    endingCapital: +capital.toFixed(2),
    totalReturn: +(((capital - startingCapital) / startingCapital) * 100).toFixed(2),
    totalPnl: +totalPnl.toFixed(2),
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

  log(`Backtest complete: ${trades.length} trades, ${winRate.toFixed(1)}% win rate, $${totalPnl.toFixed(2)} P&L, Sharpe ${sharpeRatio.toFixed(2)}`);

  return { summary, trades, equityCurve };
}

module.exports = { runBacktest };
