const { log } = require('./logger');

/**
 * Strategy modes:
 * - 'rules'  — pure indicator-based (EMA crossover + RSI + volume)
 * - 'llm'    — full AI agent pipeline (technical + news + regime → orchestrator)
 * - 'hybrid' — rules generate candidates, LLM confirms/rejects
 */

// Default strategy per symbol (can be overridden at runtime)
const symbolStrategies = {};

// Global default
let defaultStrategy = 'hybrid';

/**
 * Get the strategy mode for a symbol.
 */
function getStrategy(symbol) {
  return symbolStrategies[symbol] || defaultStrategy;
}

/**
 * Set the strategy mode for a symbol.
 * @param {string} symbol
 * @param {'rules'|'llm'|'hybrid'} mode
 */
function setStrategy(symbol, mode) {
  if (!['rules', 'llm', 'hybrid'].includes(mode)) {
    throw new Error(`Invalid strategy mode: ${mode}. Must be rules, llm, or hybrid.`);
  }
  symbolStrategies[symbol] = mode;
  log(`Strategy for ${symbol} set to: ${mode}`);
}

/**
 * Set the default strategy for all symbols without an explicit override.
 */
function setDefaultStrategy(mode) {
  if (!['rules', 'llm', 'hybrid'].includes(mode)) {
    throw new Error(`Invalid strategy mode: ${mode}. Must be rules, llm, or hybrid.`);
  }
  defaultStrategy = mode;
  log(`Default strategy set to: ${mode}`);
}

/**
 * Get all strategy assignments.
 */
function getAllStrategies() {
  return {
    default: defaultStrategy,
    overrides: { ...symbolStrategies },
  };
}

/**
 * Remove a per-symbol override (reverts to default).
 */
function clearStrategy(symbol) {
  delete symbolStrategies[symbol];
}

/**
 * Determine if a symbol should use rule-based signals.
 */
function usesRules(symbol) {
  const s = getStrategy(symbol);
  return s === 'rules' || s === 'hybrid';
}

/**
 * Determine if a symbol should use LLM analysis.
 */
function usesLlm(symbol) {
  const s = getStrategy(symbol);
  return s === 'llm' || s === 'hybrid';
}

module.exports = {
  getStrategy,
  setStrategy,
  setDefaultStrategy,
  getAllStrategies,
  clearStrategy,
  usesRules,
  usesLlm,
};
