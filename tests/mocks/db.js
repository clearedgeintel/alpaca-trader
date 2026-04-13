/**
 * In-memory DB mock for integration tests.
 *
 * Mirrors the shape of src/db.js — query, getClient, withTransaction,
 * initSchema. The goal is NOT full SQL emulation; it's to let the
 * execution-agent / chat.js write paths run end-to-end so we can
 * assert rows are inserted/linked/rolled-back as expected.
 *
 * Supported tables via a simple Map<table, rows[]>. SQL statements
 * are parsed with regexes against the exact statements our code emits
 * (INSERT INTO signals, trades, agent_decisions; UPDATE trades;
 * UPDATE agent_decisions; simple SELECT WHERE clauses).
 *
 * BEGIN/COMMIT/ROLLBACK are tracked on the transactional client so
 * rollback reverts mutations made inside the block.
 */

const { randomUUID } = require('crypto');

function createDbMock() {
  const tables = new Map();
  const getRows = (name) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  };

  // Query engine — minimal subset matching what our write paths emit
  function runQuery(sql, params = []) {
    const trimmed = sql.trim().replace(/\s+/g, ' ');

    // --- INSERT INTO signals ... RETURNING id ---
    if (/^INSERT INTO signals/i.test(trimmed)) {
      const row = {
        id: randomUUID(),
        symbol: params[0],
        signal: params[1],
        reason: params[2],
        close: params[3],
        ema9: params[4] ?? null,
        ema21: params[5] ?? null,
        rsi: params[6] ?? null,
        volume_ratio: params[7] ?? null,
        acted_on: true,
        created_at: new Date(),
      };
      getRows('signals').push(row);
      return { rows: [{ id: row.id }] };
    }

    // --- INSERT INTO trades ---
    if (/^INSERT INTO trades/i.test(trimmed)) {
      // Two known shapes: 12-col (execution-agent) and 15-col (executor legacy)
      // and the chat shapes (7 or 9 cols). We just pattern-match the positional params.
      const row = {
        id: randomUUID(),
        symbol: params[0],
        alpaca_order_id: params[1],
        side: params[2],
        qty: params[3],
        entry_price: params[4],
        current_price: params[5],
        stop_loss: params[6] ?? null,
        take_profit: params[7] ?? null,
        order_value: params[8] ?? null,
        risk_dollars: params[9] ?? null,
        status: params[10] ?? 'open',
        signal_id: params[11] ?? null,
        created_at: new Date(),
      };
      getRows('trades').push(row);
      return { rows: [row] };
    }

    // --- INSERT INTO agent_decisions ---
    if (/^INSERT INTO agent_decisions/i.test(trimmed)) {
      const row = {
        id: randomUUID(),
        symbol: params[0],
        action: params[1],
        confidence: params[2],
        reasoning: params[3],
        agent_inputs: params[4],
        duration_ms: params[5],
        signal_id: null,
        created_at: new Date(),
      };
      getRows('agent_decisions').push(row);
      return { rows: [row] };
    }

    // --- UPDATE agent_decisions SET signal_id ---
    if (/^UPDATE agent_decisions SET signal_id/i.test(trimmed)) {
      const [newSignalId, symbol] = params;
      const matches = getRows('agent_decisions')
        .filter(d => d.symbol === symbol && d.action === 'BUY' && !d.signal_id)
        .sort((a, b) => b.created_at - a.created_at);
      if (matches.length > 0) {
        matches[0].signal_id = newSignalId;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // --- UPDATE trades SET status='closed' ---
    if (/^UPDATE trades SET status = 'closed'/i.test(trimmed) || /^UPDATE trades SET status='closed'/i.test(trimmed)) {
      const [exitPrice, pnl, pnlPct, exitReason, tradeId] = params;
      const trade = getRows('trades').find(t => t.id === tradeId);
      if (trade) {
        trade.status = 'closed';
        trade.exit_price = exitPrice;
        trade.pnl = pnl;
        trade.pnl_pct = pnlPct;
        trade.exit_reason = exitReason;
        trade.closed_at = new Date();
        trade.current_price = exitPrice;
      }
      return { rows: [], rowCount: trade ? 1 : 0 };
    }

    // --- SELECT * FROM trades WHERE symbol = $1 AND status = $2 ---
    if (/SELECT .* FROM trades WHERE symbol = \$1 AND status = \$2/i.test(trimmed)) {
      const [symbol, status] = params;
      const rows = getRows('trades').filter(t => t.symbol === symbol && t.status === status);
      return { rows };
    }

    // --- SELECT id FROM trades WHERE symbol ... open (existing-position check) ---
    if (/^SELECT id FROM trades WHERE symbol = \$1 AND status = \$2/i.test(trimmed)) {
      const [symbol, status] = params;
      const rows = getRows('trades').filter(t => t.symbol === symbol && t.status === status);
      return { rows };
    }

    // Generic fallback — return empty
    return { rows: [] };
  }

  // Transactional client — snapshots tables on BEGIN so ROLLBACK can revert
  function makeClient() {
    let snapshot = null;
    let inTx = false;

    return {
      async query(sql, params) {
        const trimmed = sql.trim().toUpperCase();
        if (trimmed === 'BEGIN') {
          snapshot = snapshotTables(tables);
          inTx = true;
          return { rows: [] };
        }
        if (trimmed === 'COMMIT') {
          inTx = false;
          snapshot = null;
          return { rows: [] };
        }
        if (trimmed === 'ROLLBACK') {
          if (snapshot) restoreTables(tables, snapshot);
          inTx = false;
          snapshot = null;
          return { rows: [] };
        }
        return runQuery(sql, params);
      },
      release() {
        // If released mid-tx (shouldn't happen), still clean up snapshot
        snapshot = null;
        inTx = false;
      },
    };
  }

  async function query(sql, params) {
    return runQuery(sql, params);
  }

  async function getClient() {
    return makeClient();
  }

  async function withTransaction(fn) {
    const client = makeClient();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async function initSchema() { /* no-op for tests */ }

  return {
    query,
    getClient,
    withTransaction,
    initSchema,
    // Test helpers (not in the real module)
    _tables: tables,
    _getRows: getRows,
    _reset: () => tables.clear(),
  };
}

function snapshotTables(tables) {
  const snap = new Map();
  for (const [name, rows] of tables) {
    snap.set(name, rows.map(r => ({ ...r })));
  }
  return snap;
}

function restoreTables(tables, snap) {
  tables.clear();
  for (const [name, rows] of snap) {
    tables.set(name, rows.map(r => ({ ...r })));
  }
}

module.exports = { createDbMock };
