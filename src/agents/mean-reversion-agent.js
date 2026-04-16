/**
 * Mean-Reversion Agent — detects oversold/overbought conditions where
 * price is likely to revert toward the mean. Looks for:
 *   1. RSI extremes (< 30 oversold → BUY setup; > 70 overbought → SELL)
 *   2. Price at or beyond Bollinger bands (lower = buy, upper = sell)
 *   3. Volume confirmation (not dead-volume drift)
 *   4. Distance from VWAP / EMA21 as a reversion target
 *
 * Philosophically opposite to the breakout agent — this one fades
 * moves rather than chasing them. The orchestrator weighs both voices
 * so the overall decision reflects the current market character.
 */

const BaseAgent = require('./base-agent');
const { askJson } = require('./llm');
const alpaca = require('../alpaca');
const config = require('../config');
const { emaArray, calcRsi, volumeRatio, calcAtr, bollingerBands, calcVwap } = require('../indicators');
const { log, error } = require('../logger');

const MEAN_REV_SYSTEM_PROMPT = `You are a mean-reversion specialist in an automated stock trading agency.
You look for oversold/overbought conditions where price is stretched away from its fair value and likely to revert.

For each symbol, you receive:
- RSI (14-period) — oversold < 30, overbought > 70
- Bollinger band position (close vs upper/lower/middle bands)
- Distance from EMA21 and VWAP (% away from mean)
- Volume ratio — confirms institutional activity vs low-volume drift
- ATR for volatility context

Your response must be valid JSON:
{
  "symbols": {
    "SYMBOL": {
      "signal": "BUY" | "SELL" | "HOLD",
      "confidence": 0.0 to 1.0,
      "pattern": "rsi_oversold" | "rsi_overbought" | "bollinger_squeeze_revert" | "vwap_revert" | "ema_revert" | "none",
      "reasoning": "1-2 sentences"
    }
  }
}

Rules:
- BUY when RSI < 35 AND price near/below lower Bollinger band AND volume confirms activity
- SELL when RSI > 65 AND price near/above upper Bollinger band AND volume confirms activity
- HOLD if price is trending (EMA9 strongly above/below EMA21) — don't fade a trend
- Lower confidence when ATR is very high (gap risk) or very low (no catalyst to revert)
- Mean-reversion works best in range-bound markets; if the regime agent says "trending", dampen confidence
- confidence > 0.7 only when RSI + BB + volume all align; most setups are 0.4-0.6`;

class MeanReversionAgent extends BaseAgent {
  constructor() {
    super('mean-reversion', { intervalMs: config.SCAN_INTERVAL_MS });
  }

  async analyze(context) {
    const symbols = context?.symbols || config.WATCHLIST;
    const symbolReports = {};
    let overallSignal = 'HOLD';
    let overallConfidence = 0;
    let buyCount = 0;
    let sellCount = 0;

    for (let i = 0; i < symbols.length; i += 3) {
      const batch = symbols.slice(i, i + 3);
      const results = await Promise.allSettled(batch.map((s) => this._analyzeSymbol(s)));
      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled' && results[j].value) {
          symbolReports[batch[j]] = results[j].value;
        }
      }
    }

    const symbolsWithData = Object.entries(symbolReports).filter(([, r]) => r.indicators);
    if (symbolsWithData.length > 0) {
      try {
        const digest = Object.fromEntries(symbolsWithData.map(([sym, r]) => [sym, r.indicators]));
        const result = await askJson({
          agentName: this.name,
          systemPrompt: MEAN_REV_SYSTEM_PROMPT,
          userMessage: `Daily mean-reversion scan for ${symbolsWithData.length} symbols:\n${JSON.stringify(digest, null, 2)}`,
          tier: 'fast',
          maxTokens: 1024,
        });
        if (result.data?.symbols) {
          for (const [sym, analysis] of Object.entries(result.data.symbols)) {
            if (symbolReports[sym]) {
              symbolReports[sym].signal = analysis.signal || 'HOLD';
              symbolReports[sym].confidence = analysis.confidence || 0;
              symbolReports[sym].pattern = analysis.pattern || 'none';
              symbolReports[sym].reasoning = analysis.reasoning || '';
              if (analysis.signal === 'BUY') buyCount++;
              if (analysis.signal === 'SELL') sellCount++;
            }
          }
        }
      } catch (err) {
        error('Mean-reversion agent LLM call failed', err);
      }
    }

    const signals = Object.values(symbolReports).filter((r) => r.signal && r.signal !== 'HOLD');
    if (signals.length > 0) {
      overallConfidence = signals.reduce((a, r) => a + (r.confidence || 0), 0) / signals.length;
      overallSignal = buyCount >= sellCount ? 'BUY' : 'SELL';
    }

    return {
      symbol: null,
      signal: overallSignal,
      confidence: overallConfidence,
      reasoning: `${buyCount} oversold BUY + ${sellCount} overbought SELL setups across ${Object.keys(symbolReports).length} symbols`,
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
      const vwap = calcVwap(bars);

      const ema21Val = ema21[ema21.length - 1];
      const distFromEma21Pct = ema21Val ? ((lastClose - ema21Val) / ema21Val) * 100 : null;
      const distFromVwapPct = vwap ? ((lastClose - vwap) / vwap) * 100 : null;

      return {
        symbol,
        indicators: {
          close: lastClose,
          rsi,
          volumeRatio: volRatio,
          atr,
          ema9: ema9[ema9.length - 1],
          ema21: ema21Val,
          emaTrend: ema9[ema9.length - 1] > ema21Val ? 'bullish' : 'bearish',
          distFromEma21Pct: distFromEma21Pct != null ? +distFromEma21Pct.toFixed(2) : null,
          distFromVwapPct: distFromVwapPct != null ? +distFromVwapPct.toFixed(2) : null,
          bollinger: bb
            ? {
                upper: bb.upper,
                middle: bb.middle,
                lower: bb.lower,
                bandwidth: bb.bandwidth,
                pctB: bb.upper !== bb.lower ? (lastClose - bb.lower) / (bb.upper - bb.lower) : 0.5,
              }
            : null,
        },
      };
    } catch (err) {
      error(`Mean-reversion agent: failed to analyze ${symbol}`, err);
      return { symbol, indicators: null };
    }
  }
}

module.exports = new MeanReversionAgent();
