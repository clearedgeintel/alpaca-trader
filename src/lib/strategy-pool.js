/**
 * strategy-pool.js
 * -----------------------------------------------------------------------------
 * Maps an orchestrator decision back to the strategy pool that produced it.
 * Used by:
 *   - execution-agent.js to swap in the momentum risk model + persist the
 *     correct strategy_pool on the trades row
 *   - orchestrator.js to bypass the global confidence floor for momentum
 *     decisions (momentum-hunter stamps signals at 0.60 and has its own
 *     discipline; the 0.70 orchestrator floor would otherwise drop them)
 *
 * Lives in src/lib/ so both callers share one source of truth — the predicate
 * used to be duplicated and could drift silently.
 *
 * Pool labels (return values):
 *   'momentum'        — momentum-hunter (parabolic-runner pool with its own risk model)
 *   'breakout'        — breakout-agent (Rupture) — Phase 0 cut, currently off
 *   'mean_reversion'  — mean-reversion (Bounce) — Phase 0 cut, currently off
 *   'news'            — news-sentinel-driven entry
 *   'technical'       — technical-analysis (Quant) — the default equity-hybrid path
 *   'fallback'        — rule-based fallback when the LLM was unavailable
 */

function deriveStrategyPool(decision) {
  const supporters = decision?.supporting_agents || [];
  // Momentum-hunter wins the priority — it has its own risk model in
  // execution-agent and must not be confused with a regular technical
  // entry. Explicit strategy_pool on the decision also wins.
  if (decision?.strategy_pool === 'momentum') return 'momentum';
  if (supporters.includes('momentum-hunter')) return 'momentum';
  if (supporters.includes('breakout-agent')) return 'breakout';
  if (supporters.includes('mean-reversion')) return 'mean_reversion';
  if (supporters.includes('news-sentinel')) return 'news';
  if (supporters.includes('technical-analysis')) return 'technical';
  // Fallback decisions have reasoning starting with 'Fallback:'
  if (typeof decision?.reasoning === 'string' && /^Fallback:/i.test(decision.reasoning)) return 'fallback';
  return 'technical';
}

/**
 * Detect whether a decision should route through the momentum risk model.
 * Convenience wrapper around deriveStrategyPool — used at hot paths where
 * a label comparison is the operation we actually care about.
 */
function isMomentumDecision(decision) {
  return deriveStrategyPool(decision) === 'momentum';
}

module.exports = {
  deriveStrategyPool,
  isMomentumDecision,
};
