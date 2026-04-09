const config = require('./config');
const db = require('./db');
const alpaca = require('./alpaca');
const { calcAtr } = require('./indicators');
const { log, error, alert } = require('./logger');
const { events: socketEvents } = require('./socket');

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
        let trailingStop = trade.trailing_stop ? parseFloat(trade.trailing_stop) : stopLoss;
        let highestPrice = trade.highest_price ? parseFloat(trade.highest_price) : entryPrice;

        const pnl = +((currentPrice - entryPrice) * qty).toFixed(2);
        const pnlPct = +(((currentPrice - entryPrice) / entryPrice) * 100).toFixed(4);

        // Update trailing stop if price made a new high
        if (currentPrice > highestPrice) {
          highestPrice = currentPrice;

          // Compute new ATR-based trailing stop
          try {
            const bars = await alpaca.getBars(trade.symbol, config.BAR_TIMEFRAME, config.ATR_PERIOD + 5);
            const atr = calcAtr(bars, config.ATR_PERIOD);
            if (atr) {
              const newTrail = +(currentPrice - atr * config.TRAILING_ATR_MULT).toFixed(4);
              // Only move trailing stop up, never down
              if (newTrail > trailingStop) {
                trailingStop = newTrail;
                log(`Trailing stop raised for ${trade.symbol}: ${trailingStop} (ATR=${atr})`);
              }
            }
          } catch (atrErr) {
            error(`ATR fetch failed for ${trade.symbol} trailing stop`, atrErr);
          }
        }

        // Partial exit — sell half when price hits 50% of target distance
        const targetDist = takeProfit - entryPrice;
        const partialTrigger = entryPrice + targetDist * config.PARTIAL_EXIT_TRIGGER;
        const alreadyScaled = trade.order_type === 'scaled_out';

        if (!alreadyScaled && qty > 1 && currentPrice >= partialTrigger && currentPrice < takeProfit) {
          const sellQty = Math.floor(qty * config.PARTIAL_EXIT_PCT);
          if (sellQty >= 1) {
            try {
              await alpaca.placeOrder(trade.symbol, sellQty, 'sell');
              const remainQty = qty - sellQty;
              const partialPnl = +((currentPrice - entryPrice) * sellQty).toFixed(2);

              // Move stop to breakeven on remaining position
              const breakeven = entryPrice;

              await db.query(
                `UPDATE trades SET qty = $1, stop_loss = $2, order_type = 'scaled_out', current_price = $3, trailing_stop = GREATEST(trailing_stop, $2) WHERE id = $4`,
                [remainQty, breakeven, currentPrice, trade.id]
              );

              log(`PARTIAL EXIT: ${trade.symbol} sold ${sellQty}/${qty} @ ${currentPrice} (P&L $${partialPnl}), stop moved to breakeven ${breakeven}`);
              alert(`Partial exit: ${trade.symbol} sold ${sellQty} shares @ $${currentPrice}, P&L $${partialPnl}`);
              continue; // Skip full exit check this cycle
            } catch (partialErr) {
              error(`Partial exit failed for ${trade.symbol}`, partialErr);
            }
          }
        }

        // Check exit conditions — use the higher of fixed stop and trailing stop
        const effectiveStop = Math.max(stopLoss, trailingStop);
        let exitReason = null;
        if (currentPrice <= effectiveStop) {
          exitReason = trailingStop > stopLoss ? 'trailing_stop' : 'stop_loss';
        } else if (currentPrice >= takeProfit) {
          exitReason = 'take_profit';
        }

        if (exitReason) {
          // Wrap close + DB updates in a transaction
          await db.withTransaction(async (client) => {
            await alpaca.closePosition(trade.symbol);

            await client.query(
              `UPDATE trades
               SET status = 'closed', exit_price = $1, pnl = $2, pnl_pct = $3,
                   exit_reason = $4, closed_at = NOW(), current_price = $1,
                   trailing_stop = $6, highest_price = $7
               WHERE id = $5`,
              [currentPrice, pnl, pnlPct, exitReason, trade.id, trailingStop, highestPrice]
            );

            await updateDailyPerformance(pnl, client);
          });

          log(`POSITION CLOSED: ${trade.symbol} pnl=${pnl} reason=${exitReason}`);
          alert(`Trade closed: ${trade.symbol} ${exitReason} P&L=$${pnl}`);
          socketEvents.tradeClosed({ symbol: trade.symbol, pnl, pnlPct, exitReason });
        } else {
          // Update current price, trailing stop, and highest price
          await db.query(
            `UPDATE trades SET current_price = $1, trailing_stop = $2, highest_price = $3 WHERE id = $4`,
            [currentPrice, trailingStop, highestPrice, trade.id]
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

async function updateDailyPerformance(pnl, txClient = null) {
  const today = new Date().toISOString().split('T')[0];
  const isWin = pnl > 0;
  const qry = txClient
    ? (text, params) => txClient.query(text, params)
    : (text, params) => db.query(text, params);

  try {
    await qry(
      `INSERT INTO daily_performance (trade_date, total_trades, winning_trades, losing_trades, total_pnl, win_rate)
       VALUES ($1, 1, $2, $3, $4, CASE WHEN $2 = 1 THEN 100.00 ELSE 0.00 END)
       ON CONFLICT (trade_date) DO UPDATE SET
         total_trades = daily_performance.total_trades + 1,
         winning_trades = daily_performance.winning_trades + $2,
         losing_trades = daily_performance.losing_trades + $3,
         total_pnl = daily_performance.total_pnl + $4,
         win_rate = ROUND(
           (daily_performance.winning_trades + $2)::numeric /
           GREATEST(daily_performance.total_trades + 1, 1) * 100, 2
         )`,
      [today, isWin ? 1 : 0, isWin ? 0 : 1, pnl]
    );

    const account = await alpaca.getAccount();
    await qry(
      'UPDATE daily_performance SET portfolio_value = $1 WHERE trade_date = $2',
      [account.portfolio_value, today]
    );
  } catch (err) {
    error('Failed to update daily performance', err);
  }
}

module.exports = { runMonitor };
