/**
 * Tests for src/lib/strategy-pool — the shared predicate used by both
 * execution-agent (to swap in the momentum risk model + tag the trade row)
 * and orchestrator (to bypass the global confidence floor for momentum
 * decisions). Used to be duplicated; extracted 2026-06-09 so both callers
 * can't drift.
 */

const { deriveStrategyPool, isMomentumDecision } = require('../src/lib/strategy-pool');

describe('deriveStrategyPool', () => {
  test('explicit strategy_pool=momentum wins regardless of supporters', () => {
    expect(deriveStrategyPool({ strategy_pool: 'momentum' })).toBe('momentum');
    expect(deriveStrategyPool({ strategy_pool: 'momentum', supporting_agents: ['technical-analysis'] })).toBe('momentum');
  });

  test('momentum-hunter in supporting_agents resolves to momentum', () => {
    expect(deriveStrategyPool({ supporting_agents: ['momentum-hunter'] })).toBe('momentum');
    expect(deriveStrategyPool({ supporting_agents: ['momentum-hunter', 'technical-analysis'] })).toBe('momentum');
  });

  test('breakout-agent supporter → breakout', () => {
    expect(deriveStrategyPool({ supporting_agents: ['breakout-agent'] })).toBe('breakout');
  });

  test('mean-reversion supporter → mean_reversion', () => {
    expect(deriveStrategyPool({ supporting_agents: ['mean-reversion'] })).toBe('mean_reversion');
  });

  test('news-sentinel supporter → news', () => {
    expect(deriveStrategyPool({ supporting_agents: ['news-sentinel'] })).toBe('news');
  });

  test('technical-analysis supporter → technical', () => {
    expect(deriveStrategyPool({ supporting_agents: ['technical-analysis'] })).toBe('technical');
  });

  test('Fallback: prefixed reasoning → fallback', () => {
    expect(deriveStrategyPool({ reasoning: 'Fallback: technical signals only' })).toBe('fallback');
    expect(deriveStrategyPool({ reasoning: 'fallback: caps lower match too' })).toBe('fallback');
  });

  test('default → technical when nothing matches', () => {
    expect(deriveStrategyPool({})).toBe('technical');
    expect(deriveStrategyPool({ supporting_agents: ['some-other-agent'] })).toBe('technical');
    expect(deriveStrategyPool({ reasoning: 'just a regular decision' })).toBe('technical');
  });

  test('null/undefined decision → technical (defensive)', () => {
    expect(deriveStrategyPool(null)).toBe('technical');
    expect(deriveStrategyPool(undefined)).toBe('technical');
  });

  test('priority: explicit strategy_pool > supporters > reasoning fallback', () => {
    // Even when momentum-hunter is in supporters AND reasoning says Fallback,
    // explicit strategy_pool wins.
    const d = {
      strategy_pool: 'momentum',
      supporting_agents: ['breakout-agent'],
      reasoning: 'Fallback: ignore me',
    };
    expect(deriveStrategyPool(d)).toBe('momentum');
  });
});

describe('isMomentumDecision', () => {
  test('true when strategy_pool=momentum', () => {
    expect(isMomentumDecision({ strategy_pool: 'momentum' })).toBe(true);
  });

  test('true when supporting_agents includes momentum-hunter', () => {
    expect(isMomentumDecision({ supporting_agents: ['momentum-hunter'] })).toBe(true);
  });

  test('false for non-momentum pools', () => {
    expect(isMomentumDecision({ supporting_agents: ['technical-analysis'] })).toBe(false);
    expect(isMomentumDecision({ supporting_agents: ['breakout-agent'] })).toBe(false);
    expect(isMomentumDecision({ supporting_agents: ['mean-reversion'] })).toBe(false);
    expect(isMomentumDecision({})).toBe(false);
  });
});

describe('orchestrator filter bypass scenarios (2026-06-09 step-back plan)', () => {
  // These exercise the predicate the way the orchestrator filter uses it.
  // Tests in this block document the decision-filter rules without
  // requiring the full orchestrator.run() integration to fire.

  function shouldPass(decision, minConfidence, bypassMomentum) {
    if (decision.action !== 'BUY' && decision.action !== 'SELL') return false;
    if (bypassMomentum && deriveStrategyPool(decision) === 'momentum') return true;
    return decision.confidence >= minConfidence;
  }

  test('momentum signal at 0.60 confidence passes when bypass is on', () => {
    const d = { action: 'BUY', confidence: 0.6, strategy_pool: 'momentum' };
    expect(shouldPass(d, 0.7, true)).toBe(true);
  });

  test('momentum signal at 0.60 confidence is dropped when bypass is off', () => {
    const d = { action: 'BUY', confidence: 0.6, strategy_pool: 'momentum' };
    expect(shouldPass(d, 0.7, false)).toBe(false);
  });

  test('non-momentum signal at 0.60 is dropped regardless of bypass', () => {
    const d = { action: 'BUY', confidence: 0.6, supporting_agents: ['technical-analysis'] };
    expect(shouldPass(d, 0.7, true)).toBe(false);
    expect(shouldPass(d, 0.7, false)).toBe(false);
  });

  test('non-momentum signal at 0.70 passes regardless of bypass', () => {
    const d = { action: 'BUY', confidence: 0.7, supporting_agents: ['technical-analysis'] };
    expect(shouldPass(d, 0.7, true)).toBe(true);
    expect(shouldPass(d, 0.7, false)).toBe(true);
  });

  test('HOLD action is always dropped', () => {
    expect(shouldPass({ action: 'HOLD', confidence: 1.0, strategy_pool: 'momentum' }, 0.7, true)).toBe(false);
  });

  test('momentum detection via supporting_agents (no explicit tag) also bypasses', () => {
    // The LLM might list momentum-hunter as a supporting agent without
    // setting strategy_pool. The predicate handles both.
    const d = { action: 'BUY', confidence: 0.6, supporting_agents: ['momentum-hunter'] };
    expect(shouldPass(d, 0.7, true)).toBe(true);
  });
});
