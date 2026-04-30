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
        // Options branch — premium-curve stop/target + theta-decay force close.
        // Equity flow continues in the same loop iteration when this returns.
        if (trade.option_type) {
          await monitorOptionTrade(trade);
          continue;
        }

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

          // Compute new trailing stop using daily ATR (less noisy than intraday)
          try {
            const dailyBars = await alpaca.getDailyBars(trade.symbol, config.ATR_PERIOD + 5);
            const atr = calcAtr(dailyBars, config.ATR_PERIOD);
            if (atr) {
              const atrTrail = +(currentPrice - atr * config.TRAILING_ATR_MULT).toFixed(4);
              // Enforce minimum trailing distance (never less than TRAILING_MIN_PCT below high)
              const minTrail = +(currentPrice * (1 - config.TRAILING_MIN_PCT)).toFixed(4);
              const newTrail = Math.min(atrTrail, minTrail);
              // Only move trailing stop up, never down
              if (newTrail > trailingStop) {
                trailingStop = newTrail;
                log(
                  `Trailing stop raised for ${trade.symbol}: ${trailingStop} (dailyATR=${atr.toFixed(2)}, minFloor=${minTrail})`,
                );
              }
            }
          } catch (atrErr) {
            error(`ATR fetch failed for ${trade.symbol} trailing stop`, atrErr);
          }
        }

        // Partial exit — sell half when price hits 50% of target distance
        // Mutually exclusive with scale-in: a position that has added via
        // scale-in should not also partial-exit, and vice versa.
        const targetDist = takeProfit - entryPrice;
        const partialTrigger = entryPrice + targetDist * config.PARTIAL_EXIT_TRIGGER;
        const alreadyScaled = trade.order_type === 'scaled_out' || trade.order_type === 'scaled_in';

        if (!alreadyScaled && qty > 1 && currentPrice >= partialTrigger && currentPrice < takeProfit) {
          const sellQty = Math.floor(qty * config.PARTIAL_EXIT_PCT);
          if (sellQty >= 1) {
            try {
              const sor = require('./smart-order-router');
              const sorRes = await sor.placeSmartOrder({ symbol: trade.symbol, qty: sellQty, side: 'sell' });
              try {
                require('./metrics').smartOrdersTotal.inc({ strategy: sorRes.strategy });
                if (sorRes.strategy === 'limit' && Number.isFinite(sorRes.savingsBps)) {
                  require('./metrics').smartOrderSavingsBps.observe(sorRes.savingsBps);
                }
              } catch {}
              const remainQty = qty - sellQty;
              const partialPnl = +((currentPrice - entryPrice) * sellQty).toFixed(2);

              // Move stop to breakeven on remaining position
              const breakeven = entryPrice;

              await db.query(
                `UPDATE trades SET qty = $1, stop_loss = $2, order_type = 'scaled_out', current_price = $3, trailing_stop = GREATEST(trailing_stop, $2) WHERE id = $4`,
                [remainQty, breakeven, currentPrice, trade.id],
              );

              log(
                `PARTIAL EXIT: ${trade.symbol} sold ${sellQty}/${qty} @ ${currentPrice} (P&L $${partialPnl}), stop moved to breakeven ${breakeven}`,
              );
              alert(`Partial exit: ${trade.symbol} sold ${sellQty} shares @ $${currentPrice}, P&L $${partialPnl}`);
              continue; // Skip full exit check this cycle
            } catch (partialErr) {
              error(`Partial exit failed for ${trade.symbol}`, partialErr);
            }
          }
        }

        // Smart position scaling — add to winners when a trade moves
        // by N×ATR in our favor. Opt-in via SCALE_IN_ENABLED. Mutually
        // exclusive with partial-exit (handled via order_type guard).
        try {
          const scaling = require('./position-scaling');
          const account = await alpaca.getAccount();
          // Reuse the ATR computed for trailing-stop above. If ATR wasn't
          // fetched this cycle (e.g. the price didn't make a new high), fetch
          // a fresh one now — it's cached by Alpaca for the same day anyway.
          let scaleAtr = null;
          try {
            const dailyBars = await alpaca.getDailyBars(trade.symbol, config.ATR_PERIOD + 5);
            scaleAtr = calcAtr(dailyBars, config.ATR_PERIOD);
          } catch {}

          const decision = scaling.shouldScaleIn(trade, currentPrice, scaleAtr, account.portfolio_value);
          if (decision.scaleIn) {
            const sorScale = require('./smart-order-router');
            const sorScaleRes = await sorScale.placeSmartOrder({
              symbol: trade.symbol,
              qty: decision.addQty,
              side: 'buy',
            });
            try {
              require('./metrics').smartOrdersTotal.inc({ strategy: sorScaleRes.strategy });
              if (sorScaleRes.strategy === 'limit' && Number.isFinite(sorScaleRes.savingsBps)) {
                require('./metrics').smartOrderSavingsBps.observe(sorScaleRes.savingsBps);
              }
            } catch {}
            await db.query(
              `UPDATE trades
                 SET qty = $1, entry_price = $2, stop_loss = $3,
                     order_type = 'scaled_in', scale_ins_count = $4,
                     last_scale_in_price = $5, current_price = $6,
                     original_qty = COALESCE(original_qty, qty)
               WHERE id = $7`,
              [
                decision.newTotalQty,
                decision.newBlendedEntry,
                decision.newStop,
                decision.scaleInsCount,
                currentPrice,
                currentPrice,
                trade.id,
              ],
            );
            log(
              `SCALE-IN: ${trade.symbol} added ${decision.addQty} shares @ ${currentPrice} (total ${decision.newTotalQty}, blended entry $${decision.newBlendedEntry}, stop moved to $${decision.newStop})`,
            );
            alert(
              `Scale-in: ${trade.symbol} +${decision.addQty} shares @ $${currentPrice}, total ${decision.newTotalQty}`,
            );
            try {
              require('./metrics').tradesOpenedTotal.inc();
            } catch {}
            continue; // Skip exit check this cycle
          }
        } catch (scaleErr) {
          error(`Scale-in check failed for ${trade.symbol}`, scaleErr);
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
              [currentPrice, pnl, pnlPct, exitReason, trade.id, trailingStop, highestPrice],
            );

            await updateDailyPerformance(pnl, client);
          });

          log(`POSITION CLOSED: ${trade.symbol} pnl=${pnl} reason=${exitReason}`);
          alert(`Trade closed: ${trade.symbol} ${exitReason} P&L=$${pnl}`);
          socketEvents.tradeClosed({ symbol: trade.symbol, pnl, pnlPct, exitReason });
          try {
            require('./metrics').tradesClosedTotal.inc({ reason: exitReason || 'unknown' });
          } catch {
            /* skip */
          }
        } else {
          // Update current price, trailing stop, and highest price
          await db.query(`UPDATE trades SET current_price = $1, trailing_stop = $2, highest_price = $3 WHERE id = $4`, [
            currentPrice,
            trailingStop,
            highestPrice,
            trade.id,
          ]);
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
  const qry = txClient ? (text, params) => txClient.query(text, params) : (text, params) => db.query(text, params);

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
      [today, isWin ? 1 : 0, isWin ? 0 : 1, pnl],
    );

    const account = await alpaca.getAccount();
    await qry('UPDATE daily_performance SET portfolio_value = $1 WHERE trade_date = $2', [
      account.portfolio_value,
      today,
    ]);
  } catch (err) {
    error('Failed to update daily performance', err);
  }
}

/**
 * Monitor a single open option position.
 *   - Stop: 50% premium loss (configurable via per-trade stop_loss column,
 *           but defaults are encoded in asset-classes.js for the 'option'
 *           class so existing rows without explicit stops still work).
 *   - Target: 100% premium gain.
 *   - Force-close: last day to expiry (avoids pin/exercise risk).
 * No trailing stop, no partial exit, no scale-in for options in MVP.
 */
async function monitorOptionTrade(trade) {
  const alpacaApi = require('./alpaca');
  const { daysToExpiry } = require('./asset-classes');

  const symbol = trade.symbol;
  const entryPremium = parseFloat(trade.entry_price);
  const qty = trade.qty;
  const mult = trade.contract_multiplier || 100;

  // Pull a fresh snapshot. If it fails, skip this cycle — better to miss
  // one tick than close on stale data.
  let snap = null;
  try {
    snap = await alpacaApi.getOptionSnapshot(symbol);
  } catch (err) {
    error(`Option snapshot failed for ${symbol}, skipping cycle`, err);
    return;
  }
  const currentPremium =
    snap?.last && snap.last > 0
      ? snap.last
      : snap?.ask != null && snap?.bid != null
        ? (snap.ask + snap.bid) / 2
        : null;
  if (!currentPremium || !(currentPremium > 0)) {
    log(`No tradeable premium for ${symbol}, skipping monitor cycle`);
    return;
  }

  const pnl = +((currentPremium - entryPremium) * qty * mult).toFixed(2);
  const pnlPct = entryPremium > 0 ? +(((currentPremium - entryPremium) / entryPremium) * 100).toFixed(4) : 0;

  // Defaults from asset-classes 'option' class: 50% stop, 100% target.
  // Per-row stop_loss/take_profit override only when explicitly set.
  const stopFactor = 0.5;   // 50% loss of premium
  const targetFactor = 1.0; // 100% gain of premium
  const stopLevel = trade.stop_loss ? parseFloat(trade.stop_loss) : entryPremium * (1 - stopFactor);
  const targetLevel = trade.take_profit ? parseFloat(trade.take_profit) : entryPremium * (1 + targetFactor);

  // Theta-decay force close: at <=1 day, the position is at risk of pin
  // and assignment. Close regardless of P&L.
  const dte = daysToExpiry(symbol);
  let exitReason = null;
  if (dte != null && dte <= 1) {
    exitReason = 'theta_decay_force_close';
  } else if (currentPremium <= stopLevel) {
    exitReason = 'stop_loss';
  } else if (currentPremium >= targetLevel) {
    exitReason = 'take_profit';
  }

  if (exitReason) {
    try {
      await db.withTransaction(async (client) => {
        await alpacaApi.placeOptionOrder(symbol, qty, 'sell', { orderType: 'market' });
        await client.query(
          `UPDATE trades
              SET status = 'closed', exit_price = $1, pnl = $2, pnl_pct = $3,
                  exit_reason = $4, closed_at = NOW(), current_price = $1
            WHERE id = $5`,
          [currentPremium, pnl, pnlPct, exitReason, trade.id],
        );
        await updateDailyPerformance(pnl, client);
      });
      log(`OPTION CLOSED: ${symbol} qty=${qty} exit=$${currentPremium} pnl=${pnl} reason=${exitReason} dte=${dte}d`);
      alert(`Option closed: ${symbol} ${exitReason} P&L=$${pnl}`);
      try {
        require('./metrics').tradesClosedTotal.inc({ reason: exitReason });
      } catch {}
    } catch (closeErr) {
      error(`Option close failed for ${symbol}`, closeErr);
    }
    return;
  }

  // No exit — just update current_price for dashboards.
  await db.query(`UPDATE trades SET current_price = $1 WHERE id = $2`, [currentPremium, trade.id]);
}

module.exports = { runMonitor };
