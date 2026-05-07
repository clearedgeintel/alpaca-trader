const BaseAgent = require('./base-agent');
const { messageBus } = require('./message-bus');
const { askJson } = require('./llm');
const indicators = require('../indicators');
const alpaca = require('../alpaca');
const config = require('../config');
const db = require('../db');
const { log, error } = require('../logger');

const TA_SYSTEM_PROMPT = `You are a technical analysis expert for an automated stock trading system.
You analyze multi-timeframe indicator data for MULTIPLE symbols in one pass and return per-symbol verdicts.

Input: { "symbols": { "AAPL": { timeframes: {...} }, "MSFT": { timeframes: {...} }, ... } }

Your response must be valid JSON with this structure:
{
  "verdicts": {
    "AAPL": {
      "signal": "BUY" | "SELL" | "HOLD",
      "confidence": 0.0 to 1.0,
      "patterns": ["pattern names detected"],
      "reasoning": "2-3 sentence analysis",
      "key_levels": { "nearest_support": number or null, "nearest_resistance": number or null }
    },
    "MSFT": { ... }
  }
}

Include every input symbol in the verdicts object.

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

    // Phase 2 — Rule-based gate. Cheap scan filters down to symbols
    // showing actually-interesting movement (fresh EMA cross, RSI extreme,
    // BB breach, or rule-based BUY/SELL trigger on 5min bars). Quiet
    // symbols get a HOLD verdict directly without paying for an LLM.
    // When zero symbols are interesting, the LLM call is skipped entirely.
    const interesting = symbols.filter((s) => this._isInteresting(s, symbolData[s], perSymbolBars[s]));
    let verdicts = {};
    if (interesting.length === 0) {
      log(`TA: 0/${symbols.length} symbols show interesting movement — LLM call skipped`);
      try {
        require('../metrics').taLlmSkippedTotal?.inc({ reason: 'no_interesting_symbols' });
      } catch {
        /* metrics optional */
      }
    } else {
      try {
        const { technicalOutputSchema } = require('./schemas');
        const interestingData = Object.fromEntries(interesting.map((s) => [s, symbolData[s]]));
        log(`TA: LLM analyzing ${interesting.length}/${symbols.length} interesting symbols: ${interesting.join(', ')}`);
        const result = await askJson({
          agentName: this.name,
          systemPrompt: TA_SYSTEM_PROMPT,
          userMessage: `Analyze these symbols:\n${JSON.stringify({ symbols: interestingData }, null, 2)}`,
          tier: 'fast',
          maxTokens: Math.min(512 + interesting.length * 100, 4096),
          schema: technicalOutputSchema,
          // No retry on this agent — the batched call is the most expensive
          // single LLM hit per cycle, and a single malformed verdict in a
          // 20-symbol batch used to double the cost. Per-symbol rule-based
          // fallback handles missing/malformed verdicts gracefully.
          retryOnce: false,
        });
        verdicts = result.data?.verdicts || {};
        try {
          require('../metrics').taLlmAnalyzedSymbolsTotal?.inc({}, interesting.length);
        } catch {
          /* metrics optional */
        }
      } catch (err) {
        error('TA batched LLM failed, falling back to rule-based for all symbols', err);
      }
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
   *  - RSI in extreme zone (<30 or >70) on any timeframe
   *  - price outside Bollinger bands (above_upper or below_lower)
   *  - rule-based detectSignal returns BUY/SELL on 5min bars
   *  - volume ratio > 2 on any timeframe (volume spike)
   * Quiet ranges return false → LLM call is skipped for that symbol,
   * saving the bulk of TA spend on chop days.
   */
  _isInteresting(symbol, timeframeData, allBars) {
    if (!timeframeData) return false;
    for (const tf of Object.values(timeframeData)) {
      if (!tf?.available) continue;
      if (tf.emaCrossover === 'bullish_cross' || tf.emaCrossover === 'bearish_cross') return true;
      if (typeof tf.rsi === 'number' && (tf.rsi >= 70 || tf.rsi <= 30)) return true;
      if (tf.bbPosition === 'above_upper' || tf.bbPosition === 'below_lower') return true;
      if (typeof tf.volumeRatio === 'number' && tf.volumeRatio >= 2) return true;
    }
    const fiveMinBars = (allBars || []).find((b) => b.label === '5min')?.bars;
    if (fiveMinBars && fiveMinBars.length >= config.EMA_SLOW + 2) {
      const ruleResult = indicators.detectSignal(fiveMinBars);
      if (ruleResult.signal === 'BUY' || ruleResult.signal === 'SELL') return true;
    }
    return false;
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
