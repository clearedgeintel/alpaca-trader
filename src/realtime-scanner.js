/**
 * Real-time EMA crossover detector.
 *
 * Listens to the Alpaca 1-min bar stream, maintains a rolling in-memory
 * buffer per symbol, computes EMA9/EMA21 + RSI + volume ratio on every
 * new bar, and fires crossover signals ~1 second after the bar closes —
 * vs. the 3-5 minute lag of the 5-min REST scanner.
 *
 * This is an *early warning* layer, not a replacement: it writes
 * detected signals into the `signals` table with source='realtime_stream'
 * so they appear in dashboards and the next agency cycle sees them.
 * The existing 5-min scanner stays as a safety net.
 *
 * Per-symbol rolling buffer holds the last 30 × 1-min bars, enough for
 * EMA21 + volume lookback. Backfill runs on startup via REST so buffers
 * are warm before the stream opens.
 *
 * To prevent duplicate signals during brief oscillations, each symbol
 * has a cooldown after a crossover fires (5 min by default).
 */

const alpaca = require('./alpaca');
const config = require('./config');
const db = require('./db');
const { detectSignal } = require('./indicators');
const { log, error, warn } = require('./logger');
const { emit } = require('./socket');

const BUFFER_SIZE = 30; // 1-min bars per symbol (enough for EMA21 + volume lookback)
const CROSSOVER_COOLDOWN_MS = 5 * 60 * 1000; // don't re-fire same direction within 5 min

// Per-symbol state: { bars: Bar[], lastSignal: string|null, lastSignalAt: number }
const state = new Map();

let stats = {
  barsReceived: 0,
  signalsDetected: 0,
  cooldownsSuppressed: 0,
  startedAt: null,
};

function getOrInitState(symbol) {
  let s = state.get(symbol);
  if (!s) {
    s = { bars: [], lastSignal: null, lastSignalAt: 0 };
    state.set(symbol, s);
  }
  return s;
}

/**
 * Seed each symbol's buffer from REST so we can detect a crossover on
 * the very first streamed bar. Runs once at startup.
 */
async function backfill(symbols) {
  log(`Realtime scanner: backfilling ${symbols.length} symbol buffers...`);
  const results = await Promise.allSettled(
    symbols.map(async (sym) => {
      const bars = await alpaca.getBars(sym, '1Min', BUFFER_SIZE);
      if (bars && bars.length > 0) {
        const s = getOrInitState(sym);
        s.bars = bars.slice(-BUFFER_SIZE);
      }
      return { sym, count: bars?.length || 0 };
    }),
  );
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  log(`Realtime scanner: backfilled ${ok}/${symbols.length} symbols`);
  stats.startedAt = new Date().toISOString();
}

/**
 * Called by alpaca-stream on every 1-min bar push.
 * Appends to buffer, evaluates, and records a signal if one fires.
 */
async function onBar({ symbol, open, high, low, close, volume, timestamp }) {
  stats.barsReceived++;
  const s = getOrInitState(symbol);

  // Append to rolling buffer
  s.bars.push({ t: timestamp, o: open, h: high, l: low, c: close, v: volume });
  if (s.bars.length > BUFFER_SIZE) s.bars.shift();

  // Need enough bars for EMA21 + volume lookback to mean anything
  if (s.bars.length < Math.max(config.EMA_SLOW + 2, config.VOLUME_LOOKBACK + 1)) return;

  const result = detectSignal(s.bars);
  if (result.signal === 'NONE') return;

  // Cooldown: suppress duplicate same-direction signals within the window
  const now = Date.now();
  if (
    s.lastSignal === result.signal &&
    now - s.lastSignalAt < CROSSOVER_COOLDOWN_MS
  ) {
    stats.cooldownsSuppressed++;
    return;
  }

  s.lastSignal = result.signal;
  s.lastSignalAt = now;
  stats.signalsDetected++;

  log(
    `Realtime scanner: ${result.signal} ${symbol} — ${result.reason} (1min bar @ ${timestamp})`,
  );

  // Persist to signals table with a distinct source so it's filterable
  try {
    await db.query(
      `INSERT INTO signals (symbol, signal, reason, close, ema9, ema21, rsi, volume, avg_volume, volume_ratio)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        symbol,
        result.signal,
        `[realtime-1m] ${result.reason}`,
        result.close,
        result.ema9,
        result.ema21,
        result.rsi,
        result.volume,
        result.avg_volume,
        result.volume_ratio,
      ],
    );
  } catch (err) {
    error(`Realtime scanner: failed to persist signal for ${symbol}`, err);
  }

  // Broadcast to frontend so the UI can flash the symbol
  emit('realtime:signal', {
    symbol,
    signal: result.signal,
    reason: result.reason,
    close: result.close,
    timestamp,
  });
}

/**
 * Drop a symbol's buffer (e.g., when the dynamic watchlist rotates it out).
 */
function drop(symbol) {
  state.delete(symbol);
}

function getStats() {
  return {
    ...stats,
    trackedSymbols: state.size,
    symbolsWithBuffers: Array.from(state.entries())
      .filter(([, s]) => s.bars.length >= config.EMA_SLOW + 2)
      .map(([sym]) => sym),
  };
}

function reset() {
  state.clear();
  stats = { barsReceived: 0, signalsDetected: 0, cooldownsSuppressed: 0, startedAt: null };
}

module.exports = { backfill, onBar, drop, getStats, reset };
