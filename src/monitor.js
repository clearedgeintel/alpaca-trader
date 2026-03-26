const db = require('./db');
const alpaca = require('./alpaca');
const { log, error } = require('./logger');

async function runMonitor() {
  try {
    // Get all open trades from DB
    const result = await db.query('SELECT * FROM trades WHERE status = $1', ['open']);
    const openTrades = result.rows;

    if (openTrades.length === 0) {
      log('No open positions to monitor');
      return;
    }

    // Get current positions from Alpaca
    const positions = await alpaca.getPositions();
    const priceMap = {};
    for (const pos of positions) {
      priceMap[pos.symbol] = parseFloat(pos.current_price);
    }

    for (const trade of openTrades) {
      try {
        const currentPrice = priceMap[trade.symbol];

        if (currentPrice == null) {
          log(`Position not found in Alpaca for ${trade.symbol}`);
          continue;
        }

        const entryPrice = parseFloat(trade.entry_price);
        const stopLoss = parseFloat(trade.stop_loss);
        const takeProfit = parseFloat(trade.take_profit);
        const qty = trade.qty;

        const pnl = +((currentPrice - entryPrice) * qty).toFixed(2);
        const pnlPct = +(((currentPrice - entryPrice) / entryPrice) * 100).toFixed(4);

        // Check exit conditions
        let exitReason = null;
        if (currentPrice <= stopLoss) {
          exitReason = 'stop_loss';
        } else if (currentPrice >= takeProfit) {
          exitReason = 'take_profit';
        }

        if (exitReason) {
          // Close position
          await alpaca.closePosition(trade.symbol);

          await db.query(
            `UPDATE trades
             SET status = 'closed', exit_price = $1, pnl = $2, pnl_pct = $3,
                 exit_reason = $4, closed_at = NOW(), current_price = $1
             WHERE id = $5`,
            [currentPrice, pnl, pnlPct, exitReason, trade.id]
          );

          log(`🔴 POSITION CLOSED: ${trade.symbol} pnl=${pnl} reason=${exitReason}`);

          // Update daily performance
          await updateDailyPerformance(pnl);
        } else {
          // Update current price for dashboard
          await db.query(
            'UPDATE trades SET current_price = $1 WHERE id = $2',
            [currentPrice, trade.id]
          );
        }
      } catch (err) {
        error(`Monitor failed for trade ${trade.symbol}`, err);
      }
    }

    log('Monitor cycle complete');
  } catch (err) {
    error('Monitor run failed', err);
  }
}

async function updateDailyPerformance(pnl) {
  const today = new Date().toISOString().split('T')[0];
  const isWin = pnl > 0;

  try {
    // Upsert daily performance
    await db.query(
      `INSERT INTO daily_performance (trade_date, total_trades, winning_trades, losing_trades, total_pnl, win_rate)
       VALUES ($1, 1, $2, $3, $4, $5)
       ON CONFLICT (trade_date) DO UPDATE SET
         total_trades = daily_performance.total_trades + 1,
         winning_trades = daily_performance.winning_trades + $2,
         losing_trades = daily_performance.losing_trades + $3,
         total_pnl = daily_performance.total_pnl + $4,
         win_rate = ROUND(
           (daily_performance.winning_trades + $2)::numeric /
           (daily_performance.total_trades + 1) * 100, 2
         )`,
      [today, isWin ? 1 : 0, isWin ? 0 : 1, pnl, isWin ? 100 : 0]
    );

    // Update portfolio value
    const account = await (require('./alpaca')).getAccount();
    await db.query(
      'UPDATE daily_performance SET portfolio_value = $1 WHERE trade_date = $2',
      [account.portfolio_value, today]
    );
  } catch (err) {
    error('Failed to update daily performance', err);
  }
}

module.exports = { runMonitor };
