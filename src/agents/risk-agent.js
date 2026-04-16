const BaseAgent = require('./base-agent');
const { messageBus } = require('./message-bus');
const { askJson } = require('./llm');
const db = require('../db');
const alpaca = require('../alpaca');
const config = require('../config');
const { log, error, alert } = require('../logger');
const { checkCorrelationRisk } = require('../correlation');

// Static sector mapping for watchlist symbols
const SECTOR_MAP = {
  AAPL: 'Technology',
  MSFT: 'Technology',
  NVDA: 'Semiconductors',
  TSLA: 'Automotive',
  AMD: 'Semiconductors',
  META: 'Technology',
  GOOGL: 'Technology',
  AMZN: 'Consumer',
};

// Risk thresholds
const DAILY_LOSS_CAP_PCT = 0.04; // 4% max daily loss
const MAX_PORTFOLIO_HEAT_PCT = 0.2; // 20% max capital at risk
const MAX_SECTOR_EXPOSURE_PCT = 0.4; // 40% max per sector
const MAX_SECTOR_POSITIONS = 2; // Max open positions per sector
const CORRELATION_THRESHOLD = 0.85; // Block trades with >85% correlated positions
const MAX_DRAWDOWN_PCT = config.MAX_DRAWDOWN_PCT || 0.1; // 10% max drawdown → pause trading

// Drawdown circuit breaker state
let tradingPaused = false;
let pausedUntil = null;

const RISK_SYSTEM_PROMPT = `You are a portfolio risk manager for an automated stock trading system.
You analyze portfolio snapshots and provide risk assessments.

Your response must be valid JSON with this structure:
{
  "risk_level": "low" | "moderate" | "elevated" | "high" | "critical",
  "concerns": ["string"],
  "recommendations": ["string"],
  "narrative": "Brief 1-2 sentence assessment"
}

Be concise. Focus on concentration risk, drawdown risk, and correlation risk.`;

class RiskAgent extends BaseAgent {
  constructor() {
    super('risk-manager', { intervalMs: config.SCAN_INTERVAL_MS });
  }

  /**
   * Periodic analysis — produces a portfolio-wide risk report.
   * Called automatically on the scan interval.
   */
  async analyze() {
    const [openTrades, account, dailyPnl] = await Promise.all([
      this._getOpenTrades(),
      alpaca.getAccount(),
      this._getTodayPnl(),
    ]);

    const portfolioValue = account.portfolio_value;
    const sectorExposure = this._calcSectorExposure(openTrades, portfolioValue);
    const portfolioHeat = this._calcPortfolioHeat(openTrades, portfolioValue);
    const recentWinRate = await this._getRecentWinRate();

    const snapshot = {
      portfolioValue,
      buyingPower: account.buying_power,
      openPositions: openTrades.length,
      sectorExposure,
      portfolioHeat,
      dailyPnl,
      dailyPnlPct: portfolioValue > 0 ? dailyPnl / portfolioValue : 0,
      recentWinRate,
      trades: openTrades.map((t) => ({
        symbol: t.symbol,
        sector: SECTOR_MAP[t.symbol] || 'Unknown',
        entryPrice: parseFloat(t.entry_price),
        currentPrice: parseFloat(t.current_price),
        riskDollars: parseFloat(t.risk_dollars),
        pnlPct:
          t.entry_price > 0
            ? (((parseFloat(t.current_price) - parseFloat(t.entry_price)) / parseFloat(t.entry_price)) * 100).toFixed(2)
            : 0,
      })),
    };

    // Get LLM narrative assessment
    let llmAssessment = null;
    try {
      const result = await askJson({
        agentName: this.name,
        systemPrompt: RISK_SYSTEM_PROMPT,
        userMessage: `Portfolio snapshot:\n${JSON.stringify(snapshot, null, 2)}`,
        tier: 'fast',
        maxTokens: 512,
      });
      llmAssessment = result.data;
    } catch (err) {
      error('Risk agent LLM call failed, continuing with rule-based assessment', err);
    }

    // Drawdown circuit breaker check
    const drawdownResult = await this._checkDrawdownBreaker(portfolioValue);
    if (drawdownResult.paused) {
      snapshot.drawdownBreaker = drawdownResult;
    }

    const report = {
      symbol: null, // portfolio-wide
      signal: tradingPaused ? 'PAUSE' : 'HOLD',
      confidence: 0.8,
      reasoning: tradingPaused
        ? `TRADING PAUSED: ${drawdownResult.reason}`
        : llmAssessment?.narrative || 'Rule-based assessment only (LLM unavailable)',
      data: {
        ...snapshot,
        llmAssessment,
        tradingPaused,
        pausedUntil,
      },
    };

    // Persist report to DB
    await this._persistReport(report);

    // Publish to message bus
    await messageBus.publish('REPORT', this.name, report);

    return report;
  }

  /**
   * Evaluate a proposed trade BEFORE execution. Returns approval or veto.
   * Called synchronously by executor before placing an order.
   */
  async evaluate({ symbol, close }) {
    const [openTrades, account, dailyPnl, recentWinRate] = await Promise.all([
      this._getOpenTrades(),
      alpaca.getAccount(),
      this._getTodayPnl(),
      this._getRecentWinRate(),
    ]);

    const portfolioValue = account.portfolio_value;
    const sector = SECTOR_MAP[symbol] || 'Unknown';

    // Check 0: Drawdown circuit breaker
    if (tradingPaused) {
      if (pausedUntil && Date.now() > pausedUntil) {
        tradingPaused = false;
        pausedUntil = null;
        log('Drawdown circuit breaker reset — trading resumed');
      } else {
        const result = {
          approved: false,
          reason: `Trading paused — drawdown circuit breaker active until ${pausedUntil ? new Date(pausedUntil).toISOString() : 'manual reset'}`,
          adjustments: {},
        };
        await messageBus.publish('VETO', this.name, { symbol, ...result });
        return result;
      }
    }

    // Check 1: Daily loss cap
    const dailyPnlPct = portfolioValue > 0 ? Math.abs(dailyPnl) / portfolioValue : 0;
    if (dailyPnl < 0 && dailyPnlPct >= DAILY_LOSS_CAP_PCT) {
      const result = {
        approved: false,
        reason: `Daily loss cap reached: ${(dailyPnlPct * 100).toFixed(1)}% loss today (cap: ${DAILY_LOSS_CAP_PCT * 100}%)`,
        adjustments: {},
      };
      await messageBus.publish('VETO', this.name, { symbol, ...result });
      return result;
    }

    // Check 2: Portfolio heat
    const portfolioHeat = this._calcPortfolioHeat(openTrades, portfolioValue);
    if (portfolioHeat >= MAX_PORTFOLIO_HEAT_PCT) {
      const result = {
        approved: false,
        reason: `Portfolio heat too high: ${(portfolioHeat * 100).toFixed(1)}% at risk (max: ${MAX_PORTFOLIO_HEAT_PCT * 100}%)`,
        adjustments: {},
      };
      await messageBus.publish('VETO', this.name, { symbol, ...result });
      return result;
    }

    // Check 3: Sector concentration
    const sectorExposure = this._calcSectorExposure(openTrades, portfolioValue);
    const currentSectorPct = sectorExposure[sector] || 0;
    // Estimate what adding this position would do (rough: add ~RISK_PCT worth)
    const estimatedNewExposure = currentSectorPct + ((config.RISK_PCT / config.STOP_PCT) * close) / portfolioValue;
    if (estimatedNewExposure > MAX_SECTOR_EXPOSURE_PCT) {
      const result = {
        approved: false,
        reason: `Sector concentration limit: ${sector} at ${(currentSectorPct * 100).toFixed(1)}%, adding ${symbol} would exceed ${MAX_SECTOR_EXPOSURE_PCT * 100}%`,
        adjustments: {},
      };
      await messageBus.publish('VETO', this.name, { symbol, ...result });
      return result;
    }

    // Check 4: Correlation guard — max positions per sector
    const sectorPositions = openTrades.filter((t) => SECTOR_MAP[t.symbol] === sector).length;
    if (sectorPositions >= MAX_SECTOR_POSITIONS) {
      const result = {
        approved: false,
        reason: `Correlation guard: ${sector} already has ${sectorPositions} open positions (max: ${MAX_SECTOR_POSITIONS})`,
        adjustments: {},
      };
      await messageBus.publish('VETO', this.name, { symbol, ...result });
      return result;
    }

    // Check 5: Correlation risk — block highly correlated positions
    try {
      const existingSymbols = openTrades.map((t) => t.symbol);
      const corrResult = await checkCorrelationRisk(symbol, existingSymbols, CORRELATION_THRESHOLD);
      if (!corrResult.allowed) {
        const result = {
          approved: false,
          reason: `Correlation risk: ${corrResult.reason}`,
          adjustments: {},
        };
        await messageBus.publish('VETO', this.name, { symbol, ...result });
        return result;
      }
    } catch (corrErr) {
      // Don't block on correlation check failure — just log
      error('Correlation check failed, proceeding without', corrErr);
    }

    // Dynamic position sizing based on recent win rate
    let riskPct = config.RISK_PCT;
    if (recentWinRate > 0.6) {
      riskPct = 0.025; // Scale up after wins
    } else if (recentWinRate < 0.4 && recentWinRate >= 0) {
      riskPct = 0.015; // Scale down after losses
    }

    // Scale down if portfolio heat is approaching limit
    if (portfolioHeat > MAX_PORTFOLIO_HEAT_PCT * 0.75) {
      riskPct *= 0.75;
    }

    const result = {
      approved: true,
      reason: `Approved. Heat: ${(portfolioHeat * 100).toFixed(1)}%, Sector ${sector}: ${sectorPositions}/${MAX_SECTOR_POSITIONS} positions, Win rate: ${(recentWinRate * 100).toFixed(0)}%`,
      adjustments: {
        risk_pct: riskPct,
      },
    };

    await messageBus.publish('SIGNAL', this.name, { symbol, ...result });
    return result;
  }

  // --- Private helpers ---

  async _getOpenTrades() {
    const result = await db.query('SELECT * FROM trades WHERE status = $1', ['open']);
    return result.rows;
  }

  async _getTodayPnl() {
    const today = new Date().toISOString().split('T')[0];
    const result = await db.query('SELECT total_pnl FROM daily_performance WHERE trade_date = $1', [today]);
    return result.rows.length > 0 ? parseFloat(result.rows[0].total_pnl) : 0;
  }

  async _getRecentWinRate() {
    const result = await db.query(`SELECT pnl FROM trades WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 5`);
    if (result.rows.length === 0) return 0.5; // No history, assume neutral
    const wins = result.rows.filter((r) => parseFloat(r.pnl) > 0).length;
    return wins / result.rows.length;
  }

  _calcSectorExposure(openTrades, portfolioValue) {
    const exposure = {};
    for (const trade of openTrades) {
      const sector = SECTOR_MAP[trade.symbol] || 'Unknown';
      const value = parseFloat(trade.current_price) * trade.qty;
      exposure[sector] = (exposure[sector] || 0) + value;
    }
    // Convert to percentages
    for (const sector in exposure) {
      exposure[sector] = portfolioValue > 0 ? exposure[sector] / portfolioValue : 0;
    }
    return exposure;
  }

  _calcPortfolioHeat(openTrades, portfolioValue) {
    const totalRisk = openTrades.reduce((sum, t) => sum + parseFloat(t.risk_dollars || 0), 0);
    return portfolioValue > 0 ? totalRisk / portfolioValue : 0;
  }

  async _checkDrawdownBreaker(currentValue) {
    try {
      // Get peak portfolio value from performance history
      const result = await db.query(
        'SELECT MAX(portfolio_value) as peak FROM daily_performance WHERE portfolio_value > 0',
      );
      const peakValue = result.rows[0]?.peak ? parseFloat(result.rows[0].peak) : currentValue;

      if (peakValue <= 0) return { paused: false, reason: 'No peak data' };

      const drawdownPct = (peakValue - currentValue) / peakValue;

      if (drawdownPct >= MAX_DRAWDOWN_PCT && !tradingPaused) {
        tradingPaused = true;
        // Pause for rest of trading day (auto-resume next day)
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        pausedUntil = tomorrow.getTime();

        const msg = `DRAWDOWN CIRCUIT BREAKER: Portfolio down ${(drawdownPct * 100).toFixed(1)}% from peak $${peakValue.toFixed(0)} (threshold: ${MAX_DRAWDOWN_PCT * 100}%). Trading paused until tomorrow.`;
        log(msg);
        require('../alerting').critical('Drawdown circuit breaker tripped', msg, {
          drawdownPct: +(drawdownPct * 100).toFixed(2),
          peakValue,
          currentValue,
        });

        return { paused: true, drawdownPct: +(drawdownPct * 100).toFixed(2), peakValue, currentValue, reason: msg };
      }

      return {
        paused: tradingPaused,
        drawdownPct: +(drawdownPct * 100).toFixed(2),
        peakValue,
        currentValue,
        reason: tradingPaused ? 'Previously triggered' : 'Within limits',
      };
    } catch (err) {
      error('Drawdown breaker check failed', err);
      return { paused: tradingPaused, reason: 'Check failed' };
    }
  }

  isTradingPaused() {
    return tradingPaused;
  }

  async _persistReport(report) {
    try {
      await db.query(
        `INSERT INTO agent_reports (agent_name, symbol, signal, confidence, reasoning, data)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [this.name, report.symbol, report.signal, report.confidence, report.reasoning, JSON.stringify(report.data)],
      );
    } catch (err) {
      error('Failed to persist risk report', err);
    }
  }
}

// Singleton
const riskAgent = new RiskAgent();

module.exports = riskAgent;
