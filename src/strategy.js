const db = require('./db');
const { log, error } = require('./logger');

/**
 * Strategy modes:
 * - 'rules'  — pure indicator-based (EMA crossover + RSI + volume)
 * - 'llm'    — full AI agent pipeline (technical + news + regime → orchestrator)
 * - 'hybrid' — rules generate candidates, LLM confirms/rejects
 *
 * Assignments are persisted in the `strategy_config` table so per-symbol
 * overrides survive restarts. In-memory state mirrors the DB for zero-
 * latency reads in the hot scanner path; writes are write-through.
 */

const VALID_MODES = ['rules', 'llm', 'hybrid'];

// In-memory mirror — authoritative for reads, kept in sync with DB writes
const symbolStrategies = {};
let defaultStrategy = 'hybrid';

/**
 * Load strategy state from DB on startup. Idempotent and non-fatal:
 * if the table is missing or DB is down, we silently keep the built-in
 * defaults so the bot still starts.
 */
async function init() {
  try {
    const { rows } = await db.query(`SELECT scope, key, mode FROM strategy_config`);
    for (const row of rows) {
      if (row.scope === 'default') defaultStrategy = row.mode;
      else if (row.scope === 'symbol') symbolStrategies[row.key] = row.mode;
    }
    const overrideCount = Object.keys(symbolStrategies).length;
    if (overrideCount > 0 || rows.some((r) => r.scope === 'default')) {
      log(`Strategy loaded: default=${defaultStrategy}, ${overrideCount} override(s)`);
    }
  } catch (err) {
    const msg = err?.message || String(err);
    const expected = /does not exist/i.test(msg) || /ECONNREFUSED/i.test(msg);
    if (!expected) error('Failed to load strategy_config (continuing with in-memory defaults)', err);
  }
}

function getStrategy(symbol) {
  return symbolStrategies[symbol] || defaultStrategy;
}

async function setStrategy(symbol, mode) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`Invalid strategy mode: ${mode}. Must be rules, llm, or hybrid.`);
  }
  symbolStrategies[symbol] = mode;
  try {
    await db.query(
      `INSERT INTO strategy_config (scope, key, mode, updated_at)
       VALUES ('symbol', $1, $2, NOW())
       ON CONFLICT (scope, key) DO UPDATE SET mode = EXCLUDED.mode, updated_at = NOW()`,
      [symbol, mode],
    );
  } catch (err) {
    error(`Failed to persist strategy for ${symbol} (in-memory only)`, err);
  }
  log(`Strategy for ${symbol} set to: ${mode}`);
}

async function setDefaultStrategy(mode) {
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`Invalid strategy mode: ${mode}. Must be rules, llm, or hybrid.`);
  }
  defaultStrategy = mode;
  try {
    await db.query(
      `INSERT INTO strategy_config (scope, key, mode, updated_at)
       VALUES ('default', '__default__', $1, NOW())
       ON CONFLICT (scope, key) DO UPDATE SET mode = EXCLUDED.mode, updated_at = NOW()`,
      [mode],
    );
  } catch (err) {
    error(`Failed to persist default strategy (in-memory only)`, err);
  }
  log(`Default strategy set to: ${mode}`);
}

function getAllStrategies() {
  return {
    default: defaultStrategy,
    overrides: { ...symbolStrategies },
  };
}

/**
 * Remove a per-symbol override (reverts to default).
 */
async function clearStrategy(symbol) {
  delete symbolStrategies[symbol];
  try {
    await db.query(`DELETE FROM strategy_config WHERE scope = 'symbol' AND key = $1`, [symbol]);
  } catch (err) {
    error(`Failed to clear strategy for ${symbol} from DB`, err);
  }
}

function usesRules(symbol) {
  const s = getStrategy(symbol);
  return s === 'rules' || s === 'hybrid';
}

function usesLlm(symbol) {
  const s = getStrategy(symbol);
  return s === 'llm' || s === 'hybrid';
}

// Test helper — resets in-memory state between tests.
function _resetForTests() {
  for (const k of Object.keys(symbolStrategies)) delete symbolStrategies[k];
  defaultStrategy = 'hybrid';
}

module.exports = {
  init,
  getStrategy,
  setStrategy,
  setDefaultStrategy,
  getAllStrategies,
  clearStrategy,
  usesRules,
  usesLlm,
  _resetForTests,
};
