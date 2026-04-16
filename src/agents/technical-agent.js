const BaseAgent = require('./base-agent');
const { messageBus } = require('./message-bus');
const { askJson } = require('./llm');
const indicators = require('../indicators');
const alpaca = require('../alpaca');
const config = require('../config');
const db = require('../db');
const { log, error } = require('../logger');

const TA_SYSTEM_PROMPT = `You are a technical analysis expert for an automated stock trading system.
You analyze multi-timeframe indicator data and identify patterns, trend strength, and trade setups.

Your response must be valid JSON with this structure:
{
  "signal": "BUY" | "SELL" | "HOLD",
  "confidence": 0.0 to 1.0,
  "patterns": ["string — pattern names detected"],
  "reasoning": "2-3 sentence analysis",
  "key_levels": {
    "nearest_support": number or null,
    "nearest_resistance": number or null
  }
}

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
    const reports = [];

    // Process symbols with controlled concurrency (2 at a time to avoid rate limits)
    for (let i = 0; i < symbols.length; i += 2) {
      const batch = symbols.slice(i, i + 2);
      const batchResults = await Promise.allSettled(batch.map((symbol) => this._analyzeSymbol(symbol)));

      for (const result of batchResults) {
        if (result.status === 'fulfilled' && result.value) {
          reports.push(result.value);
        }
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
   * Analyze a single symbol across multiple timeframes.
   */
  async _analyzeSymbol(symbol) {
    try {
      // Fetch bars for all timeframes + daily
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

      // Build LLM prompt with indicator data
      const analysisInput = {
        symbol,
        timeframes: timeframeData,
      };

      // Get LLM interpretation
      let signal = 'HOLD';
      let confidence = 0.5;
      let reasoning = 'Rule-based only';
      let patterns = [];
      let keyLevels = { nearest_support: null, nearest_resistance: null };

      try {
        const result = await askJson({
          agentName: this.name,
          systemPrompt: TA_SYSTEM_PROMPT,
          userMessage: `Analyze ${symbol}:\n${JSON.stringify(analysisInput, null, 2)}`,
          tier: 'fast',
          maxTokens: 512,
        });

        if (result.data) {
          signal = result.data.signal || signal;
          confidence = result.data.confidence || confidence;
          reasoning = result.data.reasoning || reasoning;
          patterns = result.data.patterns || [];
          keyLevels = result.data.key_levels || keyLevels;
        }
      } catch (err) {
        error(`TA agent LLM failed for ${symbol}, using rule-based`, err);
        // Rule-based fallback using existing detectSignal on 5min bars
        const fiveMinBars = allBars.find((b) => b.label === '5min')?.bars;
        if (fiveMinBars && fiveMinBars.length >= config.EMA_SLOW + 2) {
          const ruleResult = indicators.detectSignal(fiveMinBars);
          signal = ruleResult.signal === 'NONE' ? 'HOLD' : ruleResult.signal;
          reasoning = `Rule-based fallback: ${ruleResult.reason}`;
          confidence = signal === 'HOLD' ? 0.3 : 0.5;
        }
      }

      // Multi-timeframe alignment score — fraction of available timeframes
      // whose EMA trend agrees with the final signal direction. Used by
      // the orchestrator to veto/downweight signals that the LLM staged
      // with high confidence based on just one timeframe.
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

      // Dampen reported confidence when timeframes disagree. A BUY signal
      // with only 1 of 4 timeframes agreeing shouldn't earn a 0.8 confidence
      // just because the LLM said so.
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
        mtfAlignment, // 0.0 - 1.0, fraction of timeframes agreeing (null if no TF data)
        mtfAligned, // count of agreeing timeframes
        mtfTotal, // total timeframes with EMA trend data
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

      // Persist to DB
      await this._persistReport(report);

      // Publish actionable signals to message bus
      if (signal !== 'HOLD') {
        await messageBus.publish('SIGNAL', this.name, report);
      }

      return report;
    } catch (err) {
      error(`TA analysis failed for ${symbol}`, err);
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
