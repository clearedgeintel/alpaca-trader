/**
 * Breakout Agent — detects price breaking above resistance with volume
 * confirmation. Looks for:
 *   1. Close above the nearest resistance level (from pivot-based S/R)
 *   2. Volume spike ≥ 1.5× average (confirms institutional participation)
 *   3. Bollinger upper-band expansion (volatility breakout)
 *   4. ATR context for sizing / stop placement
 *
 * Uses daily bars only — the technical-agent already covers MTF depth;
 * this agent adds a specialized breakout lens on the same symbols.
 */

const BaseAgent = require('./base-agent');
const { askJson } = require('./llm');
const alpaca = require('../alpaca');
const config = require('../config');
const { emaArray, calcRsi, volumeRatio, calcAtr, bollingerBands, findSupportResistance } = require('../indicators');
const { log, error } = require('../logger');

const BREAKOUT_SYSTEM_PROMPT = `You are a breakout pattern specialist in an automated stock trading agency.
You analyze daily-bar indicators to detect genuine breakout setups vs false breakouts.

For each symbol, you receive:
- Price vs nearest resistance/support levels
- Volume ratio (current vs 20-day average)
- Bollinger band position (close relative to upper/lower/middle)
- RSI and ATR context
- EMA trend (9 vs 21)

Your response must be valid JSON:
{
  "symbols": {
    "SYMBOL": {
      "signal": "BUY" | "SELL" | "HOLD",
      "confidence": 0.0 to 1.0,
      "pattern": "resistance_break" | "bollinger_break" | "volume_surge" | "consolidation_break" | "none",
      "reasoning": "1-2 sentences"
    }
  }
}

Rules:
- BUY only when MULTIPLE confirmations align (price above resistance + volume spike + trend up)
- SELL when price breaks below support with volume confirmation
- High false-breakout risk: require volume ≥ 1.5× AND close above (not just wick above) resistance
- If RSI > 80 on a breakout, it's likely exhaustion — lower confidence or HOLD
- confidence > 0.7 only for textbook setups; most breakouts are 0.4-0.6`;

class BreakoutAgent extends BaseAgent {
  constructor() {
    super('breakout-agent', { intervalMs: config.SCAN_INTERVAL_MS });
  }

  async analyze(context) {
    const symbols = context?.symbols || config.WATCHLIST;
    const symbolReports = {};
    let overallSignal = 'HOLD';
    let overallConfidence = 0;
    let buyCount = 0;

    // Process in parallel batches
    for (let i = 0; i < symbols.length; i += 3) {
      const batch = symbols.slice(i, i + 3);
      const results = await Promise.allSettled(batch.map((s) => this._analyzeSymbol(s)));
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled' && results[j].value) {
          symbolReports[batch[j]] = results[j].value;
        }
      }
    }

    // Synthesize via LLM
    const symbolsWithData = Object.entries(symbolReports).filter(([, r]) => r.indicators);
    if (symbolsWithData.length > 0) {
      try {
        const digest = Object.fromEntries(symbolsWithData.map(([sym, r]) => [sym, r.indicators]));
        const { breakoutOutputSchema } = require('./schemas');
        const result = await askJson({
          agentName: this.name,
          systemPrompt: BREAKOUT_SYSTEM_PROMPT,
          userMessage: `Daily breakout scan for ${symbolsWithData.length} symbols:\n${JSON.stringify(digest, null, 2)}`,
          tier: 'fast',
          maxTokens: 1024,
          schema: breakoutOutputSchema,
        });
        if (result.data?.symbols) {
          for (const [sym, analysis] of Object.entries(result.data.symbols)) {
            if (symbolReports[sym]) {
              symbolReports[sym].signal = analysis.signal || 'HOLD';
              symbolReports[sym].confidence = analysis.confidence || 0;
              symbolReports[sym].pattern = analysis.pattern || 'none';
              symbolReports[sym].reasoning = analysis.reasoning || '';
              if (analysis.signal === 'BUY') buyCount++;
            }
          }
        }
      } catch (err) {
        error('Breakout agent LLM call failed', err);
      }
    }

    // Derive overall signal
    const signals = Object.values(symbolReports).filter((r) => r.signal && r.signal !== 'HOLD');
    if (signals.length > 0) {
      overallConfidence = signals.reduce((a, r) => a + (r.confidence || 0), 0) / signals.length;
      overallSignal = buyCount > 0 ? 'BUY' : 'SELL';
    }

    return {
      symbol: null,
      signal: overallSignal,
      confidence: overallConfidence,
      reasoning: `${buyCount} breakout setups detected across ${Object.keys(symbolReports).length} symbols`,
      data: { symbolReports },
    };
  }

  async _analyzeSymbol(symbol) {
    try {
      const bars = await alpaca.getDailyBars(symbol, 55);
      if (!bars || bars.length < 21) return { symbol, indicators: null };

      const closes = bars.map((b) => b.c);
      const volumes = bars.map((b) => b.v);
      const lastClose = closes[closes.length - 1];

      const ema9 = emaArray(closes, 9);
      const ema21 = emaArray(closes, 21);
      const rsi = calcRsi(closes, 14);
      const volRatio = volumeRatio(volumes, 20);
      const atr = calcAtr(bars, 14);
      const bb = bollingerBands(closes, 20, 2);
      const sr = findSupportResistance(bars, 20);

      const nearestResistance = sr.resistance?.filter((r) => r > lastClose).sort((a, b) => a - b)[0] || null;
      const nearestSupport = sr.support?.filter((s) => s < lastClose).sort((a, b) => b - a)[0] || null;

      return {
        symbol,
        indicators: {
          close: lastClose,
          ema9: ema9[ema9.length - 1],
          ema21: ema21[ema21.length - 1],
          emaTrend: ema9[ema9.length - 1] > ema21[ema21.length - 1] ? 'bullish' : 'bearish',
          rsi,
          volumeRatio: volRatio,
          atr,
          bollinger: bb
            ? {
                upper: bb.upper,
                middle: bb.middle,
                lower: bb.lower,
                bandwidth: bb.bandwidth,
                aboveUpper: lastClose > bb.upper,
                belowLower: lastClose < bb.lower,
              }
            : null,
          nearestResistance,
          nearestSupport,
          aboveResistance: nearestResistance ? lastClose > nearestResistance : null,
          belowSupport: nearestSupport ? lastClose < nearestSupport : null,
        },
      };
    } catch (err) {
      error(`Breakout agent: failed to analyze ${symbol}`, err);
      return { symbol, indicators: null };
    }
  }
}

module.exports = new BreakoutAgent();
