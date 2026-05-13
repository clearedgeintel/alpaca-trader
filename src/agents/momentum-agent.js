const BaseAgent = require('./base-agent');
const { messageBus } = require('./message-bus');
const config = require('../config');
const runtimeConfig = require('../runtime-config');
const screenerAgent = require('./screener-agent');
const { log } = require('../logger');

// Read momentum knobs through runtime-config with fallback to static config
function rc(key) {
  return runtimeConfig.get(key) ?? config[key];
}

/**
 * Momentum Hunter — purely rule-based agent that flags stocks already up
 * 30%+ today on huge volume. Bypasses the regular TA path entirely
 * because those signals (RSI, EMA, BB) all read as "overbought, don't
 * chase" exactly when a parabolic move is happening — that's the trap
 * the standard agents fall into.
 *
 * Emits BUY decisions tagged with `strategy_pool: 'momentum'`. The
 * execution-agent's momentum branch applies a separate risk model:
 * smaller position size, wider stop, time-based exit. No LLM cost — this
 * agent is 100% rule-based to keep latency / spend negligible.
 *
 * Hard-skip conditions:
 *   - MOMENTUM_HUNTER_ENABLED=false (default) — agent exits early
 *   - Symbol is OTC or unknown exchange — Alpaca paper can't route those
 *   - Symbol is an option (OCC format) — momentum logic is equity-only
 *   - Already at MOMENTUM_MAX_OPEN concurrent momentum positions
 */
class MomentumAgent extends BaseAgent {
  constructor() {
    super('momentum-hunter', { intervalMs: null }); // event-driven, runs in cycle
    this._candidates = [];
  }

  async analyze(context) {
    const enabled = rc('MOMENTUM_HUNTER_ENABLED') === true;
    if (!enabled) {
      this._candidates = [];
      return {
        symbol: null,
        signal: 'HOLD',
        confidence: 0.5,
        reasoning: 'Momentum Hunter disabled (MOMENTUM_HUNTER_ENABLED=false)',
        data: { candidates: [], enabled: false },
      };
    }

    const gapPct = Number(rc('MOMENTUM_GAP_PCT')) || 0.30;
    const minVolume = Number(rc('MOMENTUM_MIN_VOLUME')) || 1_000_000;
    const maxOpen = Number(rc('MOMENTUM_MAX_OPEN')) || 3;
    const conf = Math.max(0, Math.min(1, Number(rc('MOMENTUM_CONFIDENCE')) || 0.60));

    // Pull screener candidates. Screener already enriches with changePct,
    // gapPct, volume etc. — we don't re-fetch snapshots.
    const screenerCandidates = screenerAgent.getCandidates?.() || [];

    // Count existing open momentum positions to enforce MAX_OPEN
    let openMomentumCount = 0;
    try {
      const db = require('../db');
      const r = await db.query(
        "SELECT COUNT(*)::int AS n FROM trades WHERE status = 'open' AND strategy_pool = 'momentum'",
      );
      openMomentumCount = r.rows[0]?.n || 0;
    } catch {
      /* DB may be unavailable during tests — skip the cap check */
    }
    const slotsLeft = Math.max(0, maxOpen - openMomentumCount);

    // Filter to true runners
    const { isOptionSymbol } = require('../asset-classes');
    const passing = [];
    for (const c of screenerCandidates) {
      if (!c?.symbol) continue;
      if (isOptionSymbol(c.symbol)) continue;
      if (c.symbol.includes('/')) continue;       // skip crypto pairs
      const absChange = Math.abs(Number(c.changePct) || 0) / 100; // changePct is %, convert to fraction
      if (absChange < gapPct) continue;
      if (Number(c.volume) < minVolume) continue;
      // Direction: only chase UP-moves. Downside parabolic moves are
      // captured by mean-reversion agent and require a different exit model.
      if (Number(c.changePct) < 0) continue;
      passing.push({
        symbol: c.symbol,
        changePct: Number(c.changePct),
        gapPct: Number(c.gapPct) || 0,
        volume: Number(c.volume) || 0,
        price: Number(c.price) || 0,
      });
    }

    // Sort by absChangePct desc — biggest movers first — and take only slotsLeft
    passing.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
    const picked = passing.slice(0, Math.max(0, slotsLeft));
    this._candidates = picked;

    // Publish per-symbol BUY signals so the orchestrator's agent vote
    // count picks them up and includes them in the synthesis prompt.
    for (const p of picked) {
      const reasoning = `Parabolic move: ${p.changePct.toFixed(1)}% on ${(p.volume / 1e6).toFixed(1)}M shares (gap ${p.gapPct.toFixed(1)}%). Momentum-hunter strategy.`;
      const report = {
        agent: this.name,
        symbol: p.symbol,
        signal: 'BUY',
        confidence: conf,
        reasoning,
        strategy_pool: 'momentum',
        data: { ...p },
      };
      await messageBus.publish('SIGNAL', this.name, report);
    }

    const summary = {
      symbol: null,
      signal: picked.length > 0 ? 'BUY' : 'HOLD',
      confidence: picked.length > 0 ? conf : 0.5,
      reasoning: picked.length > 0
        ? `${picked.length} runner${picked.length === 1 ? '' : 's'} found: ${picked.map((p) => `${p.symbol} (+${p.changePct.toFixed(0)}%)`).join(', ')}`
        : openMomentumCount >= maxOpen
          ? `Already at max ${maxOpen} momentum positions — skipping scan`
          : `Scanned ${screenerCandidates.length} screener candidates — 0 met ${(gapPct * 100).toFixed(0)}%/${(minVolume / 1e6).toFixed(0)}M-vol threshold`,
      data: {
        enabled: true,
        candidates: picked,
        openMomentumCount,
        slotsLeft,
        threshold: { gapPct, minVolume, maxOpen },
        // Surface symbol-level BUY signals for the orchestrator's
        // hasSymbolSignal check (mirrors the TA agent's buySignals shape)
        buySignals: picked.map((p) => p.symbol),
        sellSignals: [],
      },
    };

    await messageBus.publish('REPORT', this.name, summary);
    return summary;
  }

  getCandidates() {
    return [...this._candidates];
  }
}

const momentumAgent = new MomentumAgent();
module.exports = momentumAgent;
