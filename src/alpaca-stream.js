const WebSocket = require('ws');
const { log, error, warn } = require('./logger');
const { emit, events } = require('./socket');
const { backoffDelay } = require('./util/retry');
const db = require('./db');

/**
 * Persist a fill / partial-fill event into the trades table.
 * - Looks up the open trade row by alpaca_order_id
 * - Updates qty (for partial fills — the position is smaller than originally sized)
 *   and refreshes entry_price / current_price / order_value with the actual fill
 * - Stores the fill event in the trades.metadata column if available
 *
 * Exported for testing. Idempotent: if the row is already fully filled (qty
 * matches and entry_price is set), subsequent updates for the same order
 * will still reflect the latest fill_avg_price.
 */
async function persistFillEvent(event, order) {
  if (!order?.id) return { updated: false, reason: 'no order id' };
  if (event !== 'fill' && event !== 'partial_fill') {
    return { updated: false, reason: `ignoring event ${event}` };
  }

  const filledQty = parseInt(order.filled_qty || '0', 10);
  const filledPrice = parseFloat(order.filled_avg_price || '0');
  if (filledQty <= 0 || filledPrice <= 0) {
    return { updated: false, reason: 'no filled data yet' };
  }

  try {
    const result = await db.query(
      `UPDATE trades
         SET qty = $1,
             entry_price = $2,
             current_price = $2,
             order_value = $1 * $2
       WHERE alpaca_order_id = $3
         AND status = 'open'
       RETURNING id, symbol`,
      [filledQty, filledPrice, order.id],
    );
    if (result.rows.length > 0) {
      log(`Alpaca stream: persisted ${event} ${result.rows[0].symbol} qty=${filledQty} @ $${filledPrice.toFixed(4)}`);
      return { updated: true, tradeId: result.rows[0].id, filledQty, filledPrice };
    }
    return { updated: false, reason: 'no matching open trade' };
  } catch (err) {
    error(`Failed to persist ${event} for order ${order.id}`, err);
    return { updated: false, reason: err.message };
  }
}

const API_KEY = process.env.ALPACA_API_KEY;
const API_SECRET = process.env.ALPACA_API_SECRET;
const BASE_URL = process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets';
const isPaper = BASE_URL.includes('paper');

// Market data stream — real-time trades/quotes/bars
const MARKET_DATA_URL = 'wss://stream.data.alpaca.markets/v2/iex';
// Trade updates stream — order fills, cancels, etc.
const TRADE_UPDATES_URL = isPaper ? 'wss://paper-api.alpaca.markets/stream' : 'wss://api.alpaca.markets/stream';

// Symbols to stream live prices for
const TICKER_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'DIA'];

let marketWs = null;
let tradeWs = null;
let reconnectTimers = {};
let reconnectAttempts = { market: 0, trade: 0 };

// --- Market Data Stream ---

function connectMarketData() {
  if (marketWs) {
    try {
      marketWs.close();
    } catch {}
  }

  log('Alpaca stream: connecting to market data...');
  marketWs = new WebSocket(MARKET_DATA_URL);

  marketWs.on('open', () => {
    log('Alpaca stream: market data connected');
  });

  marketWs.on('message', (raw) => {
    let messages;
    try {
      messages = JSON.parse(raw);
    } catch {
      return;
    }

    // Alpaca sends arrays of messages
    if (!Array.isArray(messages)) messages = [messages];

    for (const msg of messages) {
      if (msg.T === 'success' && msg.msg === 'connected') {
        // Authenticate
        marketWs.send(JSON.stringify({ action: 'auth', key: API_KEY, secret: API_SECRET }));
      } else if (msg.T === 'success' && msg.msg === 'authenticated') {
        log('Alpaca stream: market data authenticated');
        reconnectAttempts.market = 0; // reset backoff on successful auth
        // Subscribe to bars and trades for ticker symbols
        marketWs.send(
          JSON.stringify({
            action: 'subscribe',
            bars: TICKER_SYMBOLS,
            trades: TICKER_SYMBOLS,
          }),
        );
      } else if (msg.T === 'subscription') {
        log(`Alpaca stream: subscribed — bars: [${msg.bars?.join(',')}], trades: [${msg.trades?.join(',')}]`);
      } else if (msg.T === 'error') {
        error(`Alpaca stream: market data error — ${msg.code}: ${msg.msg}`);
      } else if (msg.T === 't') {
        // Trade tick — emit to frontend
        emit('market:trade', {
          symbol: msg.S,
          price: msg.p,
          size: msg.s,
          timestamp: msg.t,
        });
      } else if (msg.T === 'b') {
        // Bar — emit to frontend
        emit('market:bar', {
          symbol: msg.S,
          open: msg.o,
          high: msg.h,
          low: msg.l,
          close: msg.c,
          volume: msg.v,
          timestamp: msg.t,
        });
      }
    }
  });

  marketWs.on('close', (code) => {
    const delay = backoffDelay(reconnectAttempts.market, { baseMs: 1000, maxMs: 60000 });
    reconnectAttempts.market += 1;
    warn(
      `Alpaca stream: market data disconnected (code ${code}), reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempts.market})`,
    );
    scheduleReconnect('market', connectMarketData, delay);
  });

  marketWs.on('error', (err) => {
    error('Alpaca stream: market data error', err.message);
  });
}

// --- Trade Updates Stream ---

function connectTradeUpdates() {
  if (tradeWs) {
    try {
      tradeWs.close();
    } catch {}
  }

  log('Alpaca stream: connecting to trade updates...');
  tradeWs = new WebSocket(TRADE_UPDATES_URL);

  tradeWs.on('open', () => {
    log('Alpaca stream: trade updates connected');
    // Authenticate
    tradeWs.send(
      JSON.stringify({
        action: 'auth',
        key: API_KEY,
        secret: API_SECRET,
      }),
    );
  });

  tradeWs.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.stream === 'authorization') {
      if (msg.data?.status === 'authorized') {
        log('Alpaca stream: trade updates authenticated');
        reconnectAttempts.trade = 0; // reset backoff on successful auth
        // Subscribe to trade updates
        tradeWs.send(
          JSON.stringify({
            action: 'listen',
            data: { streams: ['trade_updates'] },
          }),
        );
      } else {
        error('Alpaca stream: trade auth failed', msg.data);
      }
    } else if (msg.stream === 'listening') {
      log(`Alpaca stream: listening to [${msg.data?.streams?.join(',')}]`);
    } else if (msg.stream === 'trade_updates') {
      const event = msg.data?.event;
      const order = msg.data?.order || {};
      const symbol = order.symbol || 'unknown';

      log(
        `Alpaca stream: trade_update — ${event} ${symbol} (${order.filled_qty || 0}/${order.qty} @ $${msg.data?.price || order.filled_avg_price || '?'})`,
      );

      // Emit to frontend
      emit('order:update', {
        event,
        symbol,
        side: order.side,
        qty: order.qty,
        filledQty: order.filled_qty,
        filledAvgPrice: order.filled_avg_price || msg.data?.price,
        status: order.status,
        orderId: order.id,
        timestamp: msg.data?.timestamp,
      });

      // Also trigger cache invalidations via existing events
      if (event === 'fill' || event === 'partial_fill') {
        // Persist the fill (fire-and-forget; errors logged inside)
        persistFillEvent(event, order).catch(() => {});
        events.tradeUpdate({ symbol, event, order });
        events.accountUpdate({});
      } else if (event === 'canceled' || event === 'expired' || event === 'rejected') {
        events.tradeUpdate({ symbol, event, order });
      }
    }
  });

  tradeWs.on('close', (code) => {
    const delay = backoffDelay(reconnectAttempts.trade, { baseMs: 1000, maxMs: 60000 });
    reconnectAttempts.trade += 1;
    warn(
      `Alpaca stream: trade updates disconnected (code ${code}), reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempts.trade})`,
    );
    scheduleReconnect('trade', connectTradeUpdates, delay);
  });

  tradeWs.on('error', (err) => {
    error('Alpaca stream: trade updates error', err.message);
  });
}

// --- Reconnect Logic ---

function scheduleReconnect(name, connectFn, delayMs) {
  if (reconnectTimers[name]) clearTimeout(reconnectTimers[name]);
  reconnectTimers[name] = setTimeout(() => {
    connectFn();
  }, delayMs);
}

// --- Dynamic Subscriptions ---

function subscribeSymbols(symbols) {
  if (marketWs?.readyState === WebSocket.OPEN) {
    marketWs.send(
      JSON.stringify({
        action: 'subscribe',
        trades: symbols,
      }),
    );
    log(`Alpaca stream: subscribed to trades for [${symbols.join(',')}]`);
  }
}

function unsubscribeSymbols(symbols) {
  if (marketWs?.readyState === WebSocket.OPEN) {
    marketWs.send(
      JSON.stringify({
        action: 'unsubscribe',
        trades: symbols,
      }),
    );
  }
}

// --- Public API ---

function startStreaming() {
  if (!API_KEY || !API_SECRET) {
    warn('Alpaca stream: missing API keys, skipping websocket connections');
    return;
  }
  connectMarketData();
  connectTradeUpdates();
}

function stopStreaming() {
  for (const timer of Object.values(reconnectTimers)) clearTimeout(timer);
  reconnectTimers = {};
  if (marketWs) {
    try {
      marketWs.close();
    } catch {}
    marketWs = null;
  }
  if (tradeWs) {
    try {
      tradeWs.close();
    } catch {}
    tradeWs = null;
  }
  log('Alpaca stream: all connections closed');
}

module.exports = { startStreaming, stopStreaming, subscribeSymbols, unsubscribeSymbols, persistFillEvent };
