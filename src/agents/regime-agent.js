const BaseAgent = require('./base-agent');
const { messageBus } = require('./message-bus');
const { askJson } = require('./llm');
const { emaArray, calcRsi } = require('../indicators');
const alpaca = require('../alpaca');
const config = require('../config');
const db = require('../db');
const { log, error } = require('../logger');

// Regime parameter presets
const REGIME_PARAMS = {
  trending_bull:    { stop_pct: 0.03, target_pct: 0.08, position_scale: 1.0,  bias: 'long' },
  trending_bear:    { stop_pct: 0.02, target_pct: 0.04, position_scale: 0.5,  bias: 'avoid' },
  range_bound:      { stop_pct: 0.02, target_pct: 0.04, position_scale: 0.7,  bias: 'neutral' },
  high_vol_selloff: { stop_pct: 0.04, target_pct: 0.03, position_scale: 0.3,  bias: 'defensive' },
  recovery:         { stop_pct: 0.03, target_pct: 0.06, position_scale: 0.8,  bias: 'selective_long' },
};

const DEFAULT_REGIME = 'range_bound';

const REGIME_SYSTEM_PROMPT = `You are a market regime classifier for an automated stock trading system.
You analyze broad market indicators and classify the current market environment.

Your response must be valid JSON with this structure:
{
  "regime": "trending_bull" | "trending_bear" | "range_bound" | "high_vol_selloff" | "recovery",
  "confidence": 0.0 to 1.0,
  "reasoning": "Brief 2-3 sentence explanation",
  "key_signals": ["string"]
}

Regime definitions:
- trending_bull: SPY above key DMAs, breadth positive, VIX low/normal
- trending_bear: SPY below key DMAs, breadth negative, sustained selling
- range_bound: SPY choppy between DMAs, mixed signals, no clear direction
- high_vol_selloff: VIX spiking (>25), sharp decline, fear-driven selling
- recovery: Market bouncing off lows, VIX declining from highs, early bullish signs

Be decisive. Pick the single best regime classification.`;

class RegimeAgent extends BaseAgent {
  constructor() {
    super('market-regime', { intervalMs: config.SCAN_INTERVAL_MS });
    this._currentRegime = DEFAULT_REGIME;
    this._currentParams = { ...REGIME_PARAMS[DEFAULT_REGIME] };
  }

  /**
   * Periodic analysis — classifies current market regime.
   */
  async analyze() {
    // Fetch daily bars for SPY and QQQ
    const [spyBars, qqqBars] = await Promise.all([
      alpaca.getDailyBars('SPY', 220),
      alpaca.getDailyBars('QQQ', 220),
    ]);

    if (spyBars.length < 200) {
      return {
        symbol: null,
        signal: 'HOLD',
        confidence: 0.3,
        reasoning: `Insufficient SPY data (${spyBars.length} bars, need 200)`,
        data: { regime: this._currentRegime, params: this._currentParams },
      };
    }

    // Compute indicators for SPY
    const spyCloses = spyBars.map(b => b.c);
    const spyEma20 = emaArray(spyCloses, 20);
    const spyEma50 = emaArray(spyCloses, 50);
    const spyEma200 = emaArray(spyCloses, 200);
    const spyRsi = calcRsi(spyCloses, 14);

    const last = spyCloses.length - 1;
    const spyPrice = spyCloses[last];

    // Compute indicators for QQQ
    const qqqCloses = qqqBars.map(b => b.c);
    const qqqEma20 = emaArray(qqqCloses, 20);
    const qqqEma50 = emaArray(qqqCloses, 50);

    const qqqLast = qqqCloses.length - 1;
    const qqqPrice = qqqCloses[qqqLast];

    // Market breadth — % of watchlist symbols above their 20 DMA
    const breadth = await this._calcBreadth();

    // Estimate VIX from SPY volatility (realized vol of last 20 days, annualized)
    const estimatedVix = this._estimateVolatility(spyCloses.slice(-21));

    const indicators = {
      spy: {
        price: spyPrice,
        ema20: spyEma20[last],
        ema50: spyEma50[last],
        ema200: spyEma200[last],
        aboveEma20: spyPrice > spyEma20[last],
        aboveEma50: spyPrice > spyEma50[last],
        aboveEma200: spyPrice > spyEma200[last],
        rsi: spyRsi,
        change5d: ((spyPrice - spyCloses[last - 5]) / spyCloses[last - 5] * 100).toFixed(2),
        change20d: ((spyPrice - spyCloses[last - 20]) / spyCloses[last - 20] * 100).toFixed(2),
      },
      qqq: {
        price: qqqPrice,
        aboveEma20: qqqPrice > qqqEma20[qqqLast],
        aboveEma50: qqqPrice > qqqEma50[qqqLast],
      },
      breadth: breadth,
      estimatedVix: estimatedVix,
    };

    // Get LLM regime classification
    let regime = this._ruleBasedRegime(indicators);
    let confidence = 0.6;
    let reasoning = `Rule-based: ${regime}`;
    let keySignals = [];

    try {
      const result = await askJson({
        agentName: this.name,
        systemPrompt: REGIME_SYSTEM_PROMPT,
        userMessage: `Market indicators:\n${JSON.stringify(indicators, null, 2)}`,
        tier: 'fast',
        maxTokens: 512,
      });

      if (result.data?.regime && REGIME_PARAMS[result.data.regime]) {
        regime = result.data.regime;
        confidence = result.data.confidence || 0.7;
        reasoning = result.data.reasoning || reasoning;
        keySignals = result.data.key_signals || [];
      }
    } catch (err) {
      error('Regime agent LLM call failed, using rule-based classification', err);
    }

    // Update current regime and params
    this._currentRegime = regime;
    this._currentParams = { ...REGIME_PARAMS[regime] };

    const report = {
      symbol: null,
      signal: 'HOLD',
      confidence,
      reasoning,
      data: {
        regime,
        params: this._currentParams,
        indicators,
        keySignals,
        previousRegime: this._currentRegime,
      },
    };

    // Persist
    await this._persistReport(report);
    await messageBus.publish('REPORT', this.name, report);

    log(`Market regime: ${regime} (confidence: ${confidence})`, this._currentParams);

    return report;
  }

  /**
   * Get current regime-adjusted trading parameters.
   * Called by executor to get dynamic stop/target/scale values.
   */
  getParams() {
    return {
      regime: this._currentRegime,
      ...this._currentParams,
    };
  }

  /**
   * Rule-based fallback regime classification.
   */
  _ruleBasedRegime(indicators) {
    const { spy, estimatedVix, breadth } = indicators;

    // High vol selloff: VIX proxy > 25 and SPY below 20 DMA
    if (estimatedVix > 25 && !spy.aboveEma20) {
      return 'high_vol_selloff';
    }

    // Trending bull: above all DMAs, breadth positive
    if (spy.aboveEma20 && spy.aboveEma50 && spy.aboveEma200 && breadth.pctAbove20dma > 0.6) {
      return 'trending_bull';
    }

    // Trending bear: below all DMAs
    if (!spy.aboveEma20 && !spy.aboveEma50 && !spy.aboveEma200) {
      return 'trending_bear';
    }

    // Recovery: below 50 DMA but above 20 DMA (bouncing)
    if (spy.aboveEma20 && !spy.aboveEma50 && spy.rsi > 40) {
      return 'recovery';
    }

    return 'range_bound';
  }

  /**
   * Calculate breadth — % of watchlist symbols above their 20-day EMA.
   */
  async _calcBreadth() {
    let aboveCount = 0;
    let totalCount = 0;

    const results = await Promise.allSettled(
      config.WATCHLIST.map(async (symbol) => {
        const bars = await alpaca.getDailyBars(symbol, 25);
        if (bars.length < 20) return null;
        const closes = bars.map(b => b.c);
        const ema20 = emaArray(closes, 20);
        const last = closes.length - 1;
        return { symbol, above: closes[last] > ema20[last] };
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        totalCount++;
        if (r.value.above) aboveCount++;
      }
    }

    return {
      aboveCount,
      totalCount,
      pctAbove20dma: totalCount > 0 ? aboveCount / totalCount : 0.5,
    };
  }

  /**
   * Estimate annualized volatility from daily closes (VIX proxy).
   */
  _estimateVolatility(closes) {
    if (closes.length < 2) return 15; // default
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      returns.push(Math.log(closes[i] / closes[i - 1]));
    }
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
    const dailyStdDev = Math.sqrt(variance);
    return +(dailyStdDev * Math.sqrt(252) * 100).toFixed(1); // annualized %
  }

  async _persistReport(report) {
    try {
      await db.query(
        `INSERT INTO agent_reports (agent_name, symbol, signal, confidence, reasoning, data)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [this.name, report.symbol, report.signal, report.confidence, report.reasoning, JSON.stringify(report.data)]
      );
    } catch (err) {
      error('Failed to persist regime report', err);
    }
  }
}

// Singleton
const regimeAgent = new RegimeAgent();

module.exports = regimeAgent;
