const config = require('./config');
const db = require('./db');
const alpaca = require('./alpaca');
const { log, error, alert } = require('./logger');

const BASE_URL = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
const STREAM_URL = BASE_URL.includes('paper')
  ? 'wss://paper-api.alpaca.markets/stream'
  : 'wss://api.alpaca.markets/stream';

let ws = null;
let reconnectTimer = null;
let isShuttingDown = false;

/**
 * Start listening to Alpaca trade update events via WebSocket.
 * Handles order fills, partial fills, cancellations, and rejections in real-time.
 */
function startTradeStream() {
  if (isShuttingDown) return;

  try {
    const WebSocket = require('ws');

    ws = new WebSocket(STREAM_URL);

    ws.on('open', () => {
      log('Alpaca trade stream connected');

      // Authenticate
      ws.send(
        JSON.stringify({
          action: 'auth',
          key: process.env.ALPACA_API_KEY,
          secret: process.env.ALPACA_API_SECRET,
        }),
      );

      // Subscribe to trade updates
      ws.send(
        JSON.stringify({
          action: 'listen',
          data: { streams: ['trade_updates'] },
        }),
      );
    });

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.stream === 'authorization' && msg.data?.status === 'authorized') {
          log('Alpaca trade stream authenticated');
          return;
        }

        if (msg.stream === 'trade_updates') {
          await handleTradeUpdate(msg.data);
        }
      } catch (err) {
        error('Failed to process trade stream message', err);
      }
    });

    ws.on('close', () => {
      log('Alpaca trade stream disconnected');
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      error('Alpaca trade stream error', err);
      scheduleReconnect();
    });
  } catch (err) {
    // ws module might not be installed — fall back to polling only
    if (err.code === 'MODULE_NOT_FOUND') {
      log('WebSocket (ws) module not installed — using polling monitor only. Run: npm install ws');
      return;
    }
    error('Failed to start trade stream', err);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (isShuttingDown || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    log('Reconnecting to Alpaca trade stream...');
    startTradeStream();
  }, 5000);
}

async function handleTradeUpdate(data) {
  const event = data.event;
  const order = data.order;

  if (!order) return;

  const symbol = order.symbol;
  const orderId = order.id;

  switch (event) {
    case 'fill':
    case 'partial_fill': {
      const filledQty = parseInt(order.filled_qty) || 0;
      const filledPrice = parseFloat(order.filled_avg_price) || 0;
      log(`Trade update [${event}]: ${symbol} qty=${filledQty} price=${filledPrice}`);

      // Update trade entry price if this is a fill on our order
      try {
        await db.query(
          `UPDATE trades SET entry_price = $1, current_price = $1, qty = $2
           WHERE alpaca_order_id = $3 AND status = 'open'`,
          [filledPrice, filledQty, orderId],
        );
      } catch (err) {
        error(`Failed to update trade on fill for ${symbol}`, err);
      }
      break;
    }

    case 'rejected':
    case 'canceled':
    case 'expired': {
      log(`Trade update [${event}]: ${symbol} order=${orderId}`);

      try {
        await db.query(
          `UPDATE trades SET status = 'cancelled'
           WHERE alpaca_order_id = $1 AND status = 'open'`,
          [orderId],
        );
      } catch (err) {
        error(`Failed to cancel trade on ${event} for ${symbol}`, err);
      }

      alert(`Order ${event}: ${symbol} (${orderId})`);
      break;
    }

    case 'stopped': {
      // Bracket order stop triggered by Alpaca
      log(`Trade update [stopped]: ${symbol} — bracket stop triggered`);

      try {
        const trade = await db.query(`SELECT * FROM trades WHERE alpaca_order_id = $1 AND status = 'open'`, [orderId]);

        if (trade.rows.length > 0) {
          const t = trade.rows[0];
          const exitPrice = parseFloat(order.filled_avg_price) || parseFloat(t.stop_loss);
          const pnl = +((exitPrice - parseFloat(t.entry_price)) * t.qty).toFixed(2);
          const pnlPct = +(((exitPrice - parseFloat(t.entry_price)) / parseFloat(t.entry_price)) * 100).toFixed(4);

          await db.query(
            `UPDATE trades SET status = 'closed', exit_price = $1, pnl = $2, pnl_pct = $3,
             exit_reason = 'bracket_stop', closed_at = NOW() WHERE id = $4`,
            [exitPrice, pnl, pnlPct, t.id],
          );

          alert(`Bracket stop hit: ${symbol} P&L=$${pnl}`);
        }
      } catch (err) {
        error(`Failed to process bracket stop for ${symbol}`, err);
      }
      break;
    }

    default:
      break;
  }
}

function stopTradeStream() {
  isShuttingDown = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}

module.exports = { startTradeStream, stopTradeStream };
