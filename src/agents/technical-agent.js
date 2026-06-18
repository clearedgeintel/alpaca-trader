const BaseAgent = require('./base-agent');
const { messageBus } = require('./message-bus');
const { askJson } = require('./llm');
const indicators = require('../indicators');
const alpaca = require('../alpaca');
const config = require('../config');
const db = require('../db');
const { log, error } = require('../logger');
const runtimeConfig = require('../runtime-config');
const crypto = require('crypto');

const TA_SYSTEM_PROMPT = `You are a technical analysis expert for an automated stock trading system.
You analyze multi-timeframe indicator data for MULTIPLE symbols in one pass and return per-symbol verdicts.

Each symbol ships pre-computed derived signals per timeframe (5min/15min/1hour/daily):
  trend (bullish/bearish), cross (bullish_cross/bearish_cross/none), rsi,
  bb (above_upper/below_lower/upper_half/lower_half), vwap (above/below),
  vol (volume ratio vs 20-period avg), macd (positive/negative histogram).

Your response must be valid JSON with this structure:
{
  "verdicts": {
    "AAPL": { "signal": "BUY" | "SELL" | "HOLD", "confidence": 0.0 to 1.0, "reasoning": "ONE concise sentence" },
    "MSFT": { ... }
  }
}

Include every input symbol in the verdicts object. Keep reasoning to a single sentence.

Rules:
- BUY: Clear bullish setup with multiple confirming indicators across timeframes
- SELL: Clear bearish setup or breakdown
- HOLD: Mixed signals, no clear setup, or insufficient confirmation
- Higher confidence when multiple timeframes agree
- Note divergences between price and indicators (RSI divergence, MACD divergence)
- Be conservative — HOLD is the default when signals are ambiguous`;

// Timeframes to analyze
const TIMEFRAMES = [
  { label: '5min', timeframe: '5Min', limit: 55 },
  { label: '15min', timeframe: '15Min', limit: 55 },
  { label: '1hour', timeframe: '1Hour', limit: 55 },
];

class TechnicalAgent extends BaseAgent {
  constructor() {
    super('technical-analysis', { intervalMs: config.SCAN_INTERVAL_MS });
    this._symbolReports = {};
    // symbol -> { hash, verdict, at } — reuse last verdict when the slim
    // indicator snapshot is unchanged (see analyze()). Bounded by TTL eviction.
    this._verdictCache = new Map();
  }

  /**
   * Periodic analysis — runs multi-timeframe TA on watchlist symbols.
   * Accepts context.symbols to use a dynamic watchlist (from screener).
   */
  async analyze(context) {
    const symbols = context?.symbols || config.WATCHLIST;

    // Phase 1 — gather indicator data for every symbol in parallel (no LLM).
    // Bars fetching is batched 4 at a time to stay under Alpaca's rate limit.
    const symbolData = {};
    const perSymbolBars = {};
    for (let i = 0; i < symbols.length; i += 4) {
      const batch = symbols.slice(i, i + 4);
      const results = await Promise.allSettled(batch.map((s) => this._gatherIndicators(s)));
      for (let j = 0; j < batch.length; j++) {
        const r = results[j];
        if (r.status === 'fulfilled' && r.value) {
          symbolData[batch[j]] = r.value.timeframeData;
          perSymbolBars[batch[j]] = r.value.allBars;
        }
      }
    }

    // Phase 2 — Rule-based gate + top-N safety net. The cheap scan first
    // surfaces symbols showing real movement (looser thresholds since
    // 2026-05-26 — see _isInteresting). If fewer than MIN_LLM_BATCH
    // symbols qualify, we top up with the highest-scored remaining
    // symbols so the LLM batch is never starved. Without this, quiet
    // sessions leave Quant with zero verdicts and every symbol falls
    // back to HOLD@0.30 — short-circuiting the orchestrator.
    const MIN_LLM_BATCH = 5;
    const MAX_LLM_BATCH = Math.max(
      MIN_LLM_BATCH,
      runtimeConfig.get('TECHNICAL_MAX_LLM_BATCH') ?? config.TECHNICAL_MAX_LLM_BATCH ?? 12,
    );
    const trulyInteresting = symbols.filter((s) =>
      this._isInteresting(s, symbolData[s], perSymbolBars[s]),
    );
    let interesting = trulyInteresting;
    if (interesting.length < MIN_LLM_BATCH) {
      const set = new Set(interesting);
      const topUp = symbols
        .filter((s) => !set.has(s) && symbolData[s])
        .map((s) => ({ s, score: this._scoreMovement(symbolData[s]) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, MIN_LLM_BATCH - interesting.length)
        .map((x) => x.s);
      interesting = [...interesting, ...topUp];
    }
    // Batch cap — the dominant cost lever (audit 2026-06-17). Screener can
    // surface 30+ "interesting" names; grading them all every cycle is what
    // pushed Quant to ~62K input + truncated 8K output tokens/call. Keep the
    // highest-movement-scored MAX_LLM_BATCH for the LLM; the overflow falls
    // through to indicators.detectSignal in _buildReport (no LLM cost).
    if (interesting.length > MAX_LLM_BATCH) {
      const scored = interesting
        .map((s) => ({ s, score: this._scoreMovement(symbolData[s]) }))
        .sort((a, b) => b.score - a.score);
      const dropped = scored.slice(MAX_LLM_BATCH).map((x) => x.s);
      interesting = scored.slice(0, MAX_LLM_BATCH).map((x) => x.s);
      log(`TA: capped LLM batch at ${MAX_LLM_BATCH} (dropped ${dropped.length} lower-scored to rule-based: ${dropped.join(', ')})`);
    }

    let verdicts = {};
    // v2 Phase 3 — strip-to-rules-only baseline. When TECHNICAL_LLM_ENABLED
    // is false, skip the LLM call entirely; every symbol falls through to
    // the rule-based fallback in _buildReport (detectSignal on 5min bars).
    // Flip TECHNICAL_LLM_ENABLED=true at runtime to restore Quant's LLM
    // grading (Phase 4 ablation block 4a).
    const llmEnabled = runtimeConfig.get('TECHNICAL_LLM_ENABLED') !== false;

    // Per-symbol verdict cache — reuse last cycle's verdict for symbols whose
    // slim indicator snapshot is unchanged (5-min bars rarely flip a verdict
    // between cycles). Only the changed symbols go to the LLM. TTL-bounded so
    // a quiet symbol still re-grades periodically. Audit 2026-06-17.
    const cacheTtl = runtimeConfig.get('TECHNICAL_VERDICT_CACHE_TTL_MS')
      ?? config.TECHNICAL_VERDICT_CACHE_TTL_MS ?? 30 * 60 * 1000;
    const now = Date.now();
    const slimBySymbol = {};
    const hashBySymbol = {};
    for (const s of interesting) {
      slimBySymbol[s] = this._slimForLlm(symbolData[s]);
      hashBySymbol[s] = this._verdictHash(slimBySymbol[s]);
    }

    if (interesting.length === 0) {
      log(`TA: 0/${symbols.length} symbols (none qualified, none scored) — LLM call skipped`);
      try {
        require('../metrics').taLlmSkippedTotal?.inc({ reason: 'no_interesting_symbols' });
      } catch {
        /* metrics optional */
      }
    } else if (!llmEnabled) {
      log(`TA: TECHNICAL_LLM_ENABLED=false — rules-only signals for ${interesting.length}/${symbols.length} symbols (Phase 3 baseline)`);
      try {
        require('../metrics').taLlmSkippedTotal?.inc({ reason: 'llm_disabled' });
      } catch {
        /* metrics optional */
      }
    } else {
      // Split into cache hits (reuse) and symbols that need grading.
      const toGrade = [];
      for (const s of interesting) {
        const cached = this._verdictCache.get(s);
        if (cached && cached.hash === hashBySymbol[s] && now - cached.at < cacheTtl) {
          verdicts[s] = cached.verdict;
        } else {
          toGrade.push(s);
        }
      }
      const reused = interesting.length - toGrade.length;

      if (toGrade.length === 0) {
        log(`TA: all ${interesting.length} interesting symbols unchanged — reused cached verdicts, LLM call skipped`);
        try {
          require('../metrics').taLlmSkippedTotal?.inc({ reason: 'verdict_cache_hit' });
        } catch {
          /* metrics optional */
        }
      } else {
        try {
          const { technicalOutputSchema } = require('./schemas');
          // Slim payload — derived signals only, not raw MACD/BB/VWAP/S-R
          // objects. ~60-70% input reduction vs the full timeframeData dump.
          const gradeData = Object.fromEntries(toGrade.map((s) => [s, slimBySymbol[s]]));
          log(`TA: LLM analyzing ${toGrade.length}/${symbols.length} symbols (${trulyInteresting.length} hit thresholds, ${reused} reused from cache): ${toGrade.join(', ')}`);
          const result = await askJson({
            agentName: this.name,
            systemPrompt: TA_SYSTEM_PROMPT,
            userMessage: `Analyze these symbols:\n${JSON.stringify({ symbols: gradeData }, null, 2)}`,
            tier: 'fast',
            // Output cap tightened 8192 → 4096 alongside the slim one-sentence
            // output (no patterns/key_levels). ~70 tok/symbol covers signal +
            // confidence + a single reasoning sentence. The old 150 tok/symbol
            // + 8192 cap truncated 85% of cycles (audit 2026-06-17).
            maxTokens: Math.min(256 + toGrade.length * 70, 4096),
            schema: technicalOutputSchema,
            // No retry on this agent — the batched call is the most expensive
            // single LLM hit per cycle, and a single malformed verdict in a
            // 20-symbol batch used to double the cost. Per-symbol rule-based
            // fallback handles missing/malformed verdicts gracefully.
            retryOnce: false,
          });
          const fresh = result.data?.verdicts || {};
          // Merge fresh verdicts and refresh the cache for graded symbols.
          for (const s of toGrade) {
            if (fresh[s]) {
              verdicts[s] = fresh[s];
              this._verdictCache.set(s, { hash: hashBySymbol[s], verdict: fresh[s], at: now });
            }
          }
          try {
            require('../metrics').taLlmAnalyzedSymbolsTotal?.inc({}, toGrade.length);
          } catch {
            /* metrics optional */
          }
        } catch (err) {
          error('TA batched LLM failed, falling back to rule-based for all symbols', err);
        }
      }
    }

    // Evict stale cache entries so the Map doesn't grow unbounded as the
    // dynamic universe churns through symbols.
    for (const [sym, entry] of this._verdictCache) {
      if (now - entry.at >= cacheTtl) this._verdictCache.delete(sym);
    }

    // Phase 3 — build per-symbol reports from the batched verdicts (or fallback)
    const reports = [];
    for (const symbol of symbols) {
      if (!symbolData[symbol]) continue;
      const report = this._buildReport(symbol, symbolData[symbol], verdicts[symbol], perSymbolBars[symbol]);
      if (report) reports.push(report);
    }

    // Phase 4 — persist all reports in parallel + publish actionable signals
    await Promise.allSettled(reports.map((r) => this._persistReport(r)));
    for (const r of reports) {
      if (r.signal !== 'HOLD') {
        await messageBus.publish('SIGNAL', this.name, r);
      }
    }

    const buySignals = reports.filter((r) => r.signal === 'BUY');
    const sellSignals = reports.filter((r) => r.signal === 'SELL');

    const summary = {
      symbol: null,
      signal: 'HOLD',
      confidence: 0.7,
      reasoning: `Scanned ${reports.length} symbols: ${buySignals.length} BUY, ${sellSignals.length} SELL, ${reports.length - buySignals.length - sellSignals.length} HOLD`,
      data: {
        symbolReports: this._symbolReports,
        buySignals: buySignals.map((r) => r.symbol),
        sellSignals: sellSignals.map((r) => r.symbol),
      },
    };

    await messageBus.publish('REPORT', this.name, summary);
    return summary;
  }

  /**
   * Cheap rule-based scan that decides whether a symbol's movement is
   * actually worth the LLM tokens. Returns true when ANY of:
   *  - fresh EMA9/21 cross on any timeframe (the strongest trigger)
   *  - strong EMA alignment (|EMA9 − EMA21| / EMA21 ≥ 1%) — momentum
   *  - RSI in extended zone (≤40 or ≥60) on any timeframe
   *  - price outside Bollinger bands (above_upper or below_lower)
   *  - rule-based detectSignal returns BUY/SELL on 5min bars
   *  - volume ratio ≥ 1.5 on any timeframe (real spike)
   *
   * Thresholds loosened on 2026-05-26 — the prior values (RSI ≥70/≤30,
   * vol ≥2, fresh-cross-only EMA) admitted 0% of symbols in current
   * market conditions, leaving Quant publishing HOLD@0.30 across the
   * board and short-circuiting the orchestrator. The looser thresholds
   * pair with the MIN_LLM_BATCH top-up in analyze() so a normal session
   * always feeds the LLM something to grade.
   */
  _isInteresting(symbol, timeframeData, allBars) {
    if (!timeframeData) return false;
    for (const tf of Object.values(timeframeData)) {
      if (!tf?.available) continue;
      if (tf.emaCrossover === 'bullish_cross' || tf.emaCrossover === 'bearish_cross') return true;
      if (typeof tf.rsi === 'number' && (tf.rsi >= 60 || tf.rsi <= 40)) return true;
      if (tf.bbPosition === 'above_upper' || tf.bbPosition === 'below_lower') return true;
      if (typeof tf.volumeRatio === 'number' && tf.volumeRatio >= 1.5) return true;
      // Strong EMA alignment — not a fresh cross, but a meaningful gap
      // between EMA9 and EMA21 implies the trend is still extending and
      // a continuation setup may be live.
      if (
        typeof tf.ema9 === 'number' &&
        typeof tf.ema21 === 'number' &&
        tf.ema21 > 0 &&
        Math.abs((tf.ema9 - tf.ema21) / tf.ema21) >= 0.01
      ) {
        return true;
      }
    }
    const fiveMinBars = (allBars || []).find((b) => b.label === '5min')?.bars;
    if (fiveMinBars && fiveMinBars.length >= config.EMA_SLOW + 2) {
      const ruleResult = indicators.detectSignal(fiveMinBars);
      if (ruleResult.signal === 'BUY' || ruleResult.signal === 'SELL') return true;
    }
    return false;
  }

  /**
   * Continuous "movement score" for a symbol across all its timeframes.
   * Used by the MIN_LLM_BATCH top-up in analyze() to pick the best of
   * what's available when the hard gate didn't admit enough symbols.
   * Higher score = more interesting; values sum across timeframes so a
   * symbol with mild interest on multiple timeframes outranks a symbol
   * with mild interest on one. Pure rule-based — no LLM calls.
   */
  _scoreMovement(timeframeData) {
    if (!timeframeData) return 0;
    let score = 0;
    for (const tf of Object.values(timeframeData)) {
      if (!tf?.available) continue;
      if (typeof tf.rsi === 'number') score += Math.abs(tf.rsi - 50) / 50;
      if (typeof tf.volumeRatio === 'number') score += Math.max(0, tf.volumeRatio - 1);
      if (
        typeof tf.ema9 === 'number' &&
        typeof tf.ema21 === 'number' &&
        tf.ema21 > 0
      ) {
        score += Math.abs((tf.ema9 - tf.ema21) / tf.ema21);
      }
      if (tf.emaCrossover === 'bullish_cross' || tf.emaCrossover === 'bearish_cross') score += 1;
      if (tf.bbPosition === 'above_upper' || tf.bbPosition === 'below_lower') score += 0.5;
    }
    return score;
  }

  /**
   * Compress a symbol's full multi-timeframe indicator object into the
   * compact derived signals the LLM actually reasons over — dropping the raw
   * MACD/Bollinger/VWAP/support-resistance objects and the redundant numeric
   * ema9/ema21/price fields. ~60-70% input-token reduction vs the full
   * timeframeData dump. The verdict cache hashes this same slim shape, so
   * "unchanged" means "no derived signal moved." Audit 2026-06-17.
   */
  _slimForLlm(timeframeData) {
    const out = {};
    for (const [label, tf] of Object.entries(timeframeData || {})) {
      if (!tf?.available) continue;
      out[label] = {
        trend: tf.emaTrend,
        cross: tf.emaCrossover,
        rsi: tf.rsi,
        bb: tf.bbPosition,
        vwap: tf.vwapPosition,
        vol: tf.volumeRatio,
        macd:
          tf.macd && typeof tf.macd === 'object' && tf.macd.histogram != null
            ? tf.macd.histogram >= 0
              ? 'positive'
              : 'negative'
            : null,
      };
    }
    return out;
  }

  /**
   * Stable hash of a slim indicator snapshot — the verdict-cache key.
   * Identical slim payload → identical verdict, so we can skip the LLM.
   */
  _verdictHash(slim) {
    return crypto.createHash('md5').update(JSON.stringify(slim)).digest('hex');
  }

  /**
   * Gather indicator data for a single symbol across multiple timeframes.
   * No LLM calls — pure data collection. Returns null on failure.
   */
  async _gatherIndicators(symbol) {
    try {
      const barRequests = TIMEFRAMES.map((tf) =>
        alpaca
          .getBars(symbol, tf.timeframe, tf.limit)
          .then((bars) => ({ label: tf.label, bars }))
          .catch(() => ({ label: tf.label, bars: [] })),
      );
      barRequests.push(
        alpaca
          .getDailyBars(symbol, 55)
          .then((bars) => ({ label: 'daily', bars }))
          .catch(() => ({ label: 'daily', bars: [] })),
      );

      const allBars = await Promise.all(barRequests);

      // Compute indicators for each timeframe
      const timeframeData = {};

      for (const { label, bars } of allBars) {
        if (!bars || bars.length < 25) {
          timeframeData[label] = { available: false };
          continue;
        }

        const closes = bars.map((b) => b.c);
        const volumes = bars.map((b) => b.v);

        const ema9 = indicators.emaArray(closes, 9);
        const ema21 = indicators.emaArray(closes, 21);
        const rsi = indicators.calcRsi(closes, 14);
        const macd = indicators.calcMacd(closes);
        const bb = indicators.bollingerBands(closes);
        const vwap = indicators.calcVwap(bars);
        const sr = indicators.findSupportResistance(bars);
        const volRatio = indicators.volumeRatio(volumes, 20);

        const last = closes.length - 1;
        const prev = last - 1;

        timeframeData[label] = {
          available: true,
          price: closes[last],
          ema9: ema9[last],
          ema21: ema21[last],
          emaTrend: ema9[last] > ema21[last] ? 'bullish' : 'bearish',
          emaCrossover:
            prev >= 0 && ema9[prev] != null && ema21[prev] != null
              ? ema9[prev] <= ema21[prev] && ema9[last] > ema21[last]
                ? 'bullish_cross'
                : ema9[prev] >= ema21[prev] && ema9[last] < ema21[last]
                  ? 'bearish_cross'
                  : 'none'
              : 'none',
          rsi: rsi != null ? +rsi.toFixed(1) : null,
          macd,
          bollingerBands: bb,
          bbPosition: bb
            ? closes[last] > bb.upper
              ? 'above_upper'
              : closes[last] < bb.lower
                ? 'below_lower'
                : closes[last] > bb.middle
                  ? 'upper_half'
                  : 'lower_half'
            : null,
          vwap,
          vwapPosition: vwap ? (closes[last] > vwap ? 'above' : 'below') : null,
          supportResistance: sr,
          volumeRatio: +volRatio.toFixed(2),
        };
      }

      return { timeframeData, allBars };
    } catch (err) {
      error(`TA indicator gather failed for ${symbol}`, err);
      return null;
    }
  }

  /**
   * Build the final per-symbol report from batched LLM verdicts.
   * If verdict is missing (LLM failed / symbol not returned), falls
   * back to the rule-based detectSignal on 5min bars.
   */
  _buildReport(symbol, timeframeData, verdict, allBars) {
    try {
      let signal = 'HOLD';
      let confidence = 0.5;
      let reasoning = 'Rule-based only';
      let patterns = [];
      let keyLevels = { nearest_support: null, nearest_resistance: null };

      if (verdict) {
        signal = verdict.signal || signal;
        confidence = verdict.confidence ?? confidence;
        reasoning = verdict.reasoning || reasoning;
        patterns = verdict.patterns || [];
        keyLevels = verdict.key_levels || keyLevels;
      } else {
        // Rule-based fallback on 5min bars
        const fiveMinBars = (allBars || []).find((b) => b.label === '5min')?.bars;
        if (fiveMinBars && fiveMinBars.length >= config.EMA_SLOW + 2) {
          const ruleResult = indicators.detectSignal(fiveMinBars);
          signal = ruleResult.signal === 'NONE' ? 'HOLD' : ruleResult.signal;
          reasoning = `Rule-based fallback: ${ruleResult.reason}`;
          confidence = signal === 'HOLD' ? 0.3 : 0.5;
        }
      }

      // Multi-timeframe alignment score
      const expectedTrend = signal === 'BUY' ? 'bullish' : signal === 'SELL' ? 'bearish' : null;
      const availableTfs = Object.values(timeframeData).filter((v) => v.available);
      let mtfAligned = 0;
      let mtfTotal = 0;
      for (const tf of availableTfs) {
        if (tf.emaTrend) {
          mtfTotal++;
          if (expectedTrend && tf.emaTrend === expectedTrend) mtfAligned++;
        }
      }
      const mtfAlignment = mtfTotal > 0 ? +(mtfAligned / mtfTotal).toFixed(2) : null;

      if (expectedTrend && mtfAlignment != null && mtfAlignment < 0.5) {
        const dampened = +(confidence * (0.4 + mtfAlignment * 0.6)).toFixed(3);
        if (dampened < confidence) {
          reasoning = `${reasoning} [MTF alignment ${Math.round(mtfAlignment * 100)}% — confidence dampened ${confidence} -> ${dampened}]`;
          confidence = dampened;
        }
      }

      const report = {
        symbol,
        signal,
        confidence,
        reasoning,
        patterns,
        keyLevels,
        mtfAlignment,
        mtfAligned,
        mtfTotal,
        timeframes: Object.fromEntries(
          Object.entries(timeframeData)
            .filter(([, v]) => v.available)
            .map(([k, v]) => [
              k,
              { emaTrend: v.emaTrend, rsi: v.rsi, bbPosition: v.bbPosition, vwapPosition: v.vwapPosition },
            ]),
        ),
      };

      this._symbolReports[symbol] = report;
      return report;
    } catch (err) {
      error(`TA report build failed for ${symbol}`, err);
      return null;
    }
  }

  /**
   * Get the latest report for a specific symbol.
   */
  getSymbolReport(symbol) {
    return this._symbolReports[symbol] || null;
  }

  /**
   * Get all symbol reports from the last cycle.
   */
  getAllSymbolReports() {
    return { ...this._symbolReports };
  }

  async _persistReport(report) {
    try {
      await db.query(
        `INSERT INTO agent_reports (agent_name, symbol, signal, confidence, reasoning, data)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [this.name, report.symbol, report.signal, report.confidence, report.reasoning, JSON.stringify(report)],
      );
    } catch (err) {
      error('Failed to persist TA report', err);
    }
  }
}

// Singleton
const technicalAgent = new TechnicalAgent();

module.exports = technicalAgent;
