const BaseAgent = require('./base-agent');
const { messageBus } = require('./message-bus');
const { askJson, isAvailable: llmAvailable } = require('./llm');
const config = require('../config');
const db = require('../db');
const { log, error } = require('../logger');

const ORCHESTRATOR_SYSTEM_PROMPT = `You are the chief portfolio manager of an automated stock trading agency.
You receive reports from 4 specialized agents and must synthesize them into final trading decisions.

Your agents:
1. **Technical Analysis** — multi-timeframe indicators, pattern recognition, BUY/SELL/HOLD per symbol
2. **News Sentinel** — news sentiment per symbol, urgency levels, breaking alerts
3. **Risk Manager** — portfolio heat, sector exposure, daily P&L, trade veto capability
4. **Market Regime** — current market environment (bull/bear/range/high-vol), parameter adjustments

Decision hierarchy (MUST follow):
- Risk Manager VETO is absolute — if risk says no, you say no
- News critical alerts override technical signals
- Technical + regime alignment needed for high-confidence trades
- When agents disagree, explain why you sided with one

Your response must be valid JSON with this structure:
{
  "decisions": [
    {
      "symbol": "AAPL",
      "action": "BUY" | "SELL" | "HOLD",
      "confidence": 0.0 to 1.0,
      "reasoning": "2-3 sentences explaining the decision",
      "supporting_agents": ["agent names that agree"],
      "dissenting_agents": ["agent names that disagree"],
      "size_adjustment": 0.5 to 1.5 (1.0 = normal, <1 = reduce, >1 = increase)
    }
  ],
  "portfolio_summary": "1-2 sentence overall market view and portfolio stance"
}

Rules:
- Only include symbols where action is BUY or SELL (omit HOLD symbols)
- confidence > 0.7 required for BUY/SELL — otherwise default to HOLD
- Maximum 3 simultaneous BUY decisions per cycle to avoid overtrading
- If market regime is "high_vol_selloff", only SELL decisions allowed
- If bias is "short_only", strongly prefer SELL but allow high-conviction BUY (confidence > 0.8) at reduced size
- If bias is "selective_long", allow BUY but only for strongest setups with clear technical confirmation
- Be decisive but conservative — protecting capital is priority #1`;

class Orchestrator extends BaseAgent {
  constructor() {
    super('orchestrator', { intervalMs: null }); // Not self-scheduling — driven by runCycle()
    this._lastDecisions = [];
    this._agents = {};
  }

  /**
   * Register an agent so the orchestrator can collect its reports.
   */
  registerAgent(agent) {
    this._agents[agent.name] = agent;
    log(`Orchestrator: registered agent "${agent.name}"`);
  }

  /**
   * Run a full decision cycle — collect all agent reports and synthesize.
   * Called by the main loop after all agents have run their analysis.
   */
  async analyze() {
    // Collect latest reports from all registered agents
    const agentReports = {};
    for (const [name, agent] of Object.entries(this._agents)) {
      const report = agent.getReport();
      agentReports[name] = report || { signal: 'HOLD', confidence: 0, reasoning: 'No report available' };
    }

    // Pull 30-day calibration data and scale each agent's reported confidence.
    // Cold start (sample < 10) defaults to weight 0.5 so early data can't collapse decisions.
    const calibration = await this.getAgentCalibration(30);
    const weightedReports = {};
    for (const [name, report] of Object.entries(agentReports)) {
      const cal = calibration[name];
      const weight = (cal && cal.sampleSize >= 10) ? cal.winRate : 0.5;
      // adjusted = reported * (winRate * 0.7 + 0.3) — keeps a floor so calibrated agents aren't muted entirely
      const adjustedConfidence = typeof report.confidence === 'number'
        ? +(report.confidence * (weight * 0.7 + 0.3)).toFixed(3)
        : report.confidence;
      weightedReports[name] = {
        ...report,
        reportedConfidence: report.confidence,
        adjustedConfidence,
        calibration: cal ? { winRate: cal.winRate, sampleSize: cal.sampleSize, coldStart: cal.sampleSize < 10 } : { coldStart: true, reason: 'no_history' },
      };
    }

    // Optional fundamentals enrichment (Polygon free tier). Cached ~6h,
    // so per-cycle cost is ~0. Returns null-values silently when disabled.
    const datasources = require('../datasources');
    const sectorRotation = require('../sector-rotation');
    const tickerContext = {};
    await Promise.all(config.WATCHLIST.map(async (sym) => {
      const details = await datasources.getTickerDetails(sym);
      if (details) {
        tickerContext[sym] = {
          marketCap: details.marketCap,
          sector: details.sic_description,
        };
      }
    }));

    // Sector rotation — leaders/laggards over the last 5 trading days.
    // Bounded cost: cached 30min, reuses datasources cache for ticker sector.
    // Silently returns empty when Polygon disabled.
    let rotationSummary = null;
    try {
      const rotation = await sectorRotation.computeRotation({ symbols: config.WATCHLIST, days: 5 });
      if (rotation.sectors.length > 1) {
        rotationSummary = {
          leaders: rotation.leaders.map(s => ({ name: s.name, avgReturn: s.avgReturn, momentumScore: s.momentumScore })),
          laggards: rotation.laggards.map(s => ({ name: s.name, avgReturn: s.avgReturn, momentumScore: s.momentumScore })),
          lookbackDays: rotation.lookbackDays,
        };
      }
    } catch (err) {
      // Fail-open: rotation is a nudge, not a gate
      this.log?.(`sector-rotation skipped: ${err.message}`);
    }

    // Build context for LLM — weights live in the USER MESSAGE so the system prompt stays static
    const context = {
      watchlist: config.WATCHLIST,
      agentReports: weightedReports,
      ...(Object.keys(tickerContext).length > 0 ? { tickerContext } : {}),
      ...(rotationSummary ? { sectorRotation: rotationSummary } : {}),
      timestamp: new Date().toISOString(),
    };

    let decisions = [];
    let portfolioSummary = 'No LLM response — no action taken';
    const synthesisStart = Date.now();

    if (!llmAvailable()) {
      log('Orchestrator: LLM unavailable (budget/breaker), using fallback logic');
      decisions = this._fallbackDecisions(weightedReports);
      portfolioSummary = 'Fallback mode — LLM unavailable, acting on technical signals only';
    } else {
      try {
        const calSummary = Object.entries(calibration)
          .map(([name, c]) => `- ${name}: ${c.sampleSize >= 10 ? `${(c.winRate * 100).toFixed(0)}% win-rate over ${c.sampleSize} decisions` : `cold-start (${c.sampleSize} decisions) — weighted 0.5`}`)
          .join('\n');
        const calBlock = calSummary
          ? `\n\nAgent historical accuracy (30d, used to adjust reported confidences):\n${calSummary}\nEach agent's adjustedConfidence already reflects its historical win rate. Favor agents with higher calibration when weighing dissent.`
          : '';

        const result = await askJson({
          agentName: this.name,
          systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
          userMessage: `Agent reports for this cycle:\n${JSON.stringify(context, null, 2)}${calBlock}`,
          tier: 'standard', // Sonnet for synthesis
          maxTokens: 2048,
        });

        if (result.data) {
          decisions = result.data.decisions || [];
          portfolioSummary = result.data.portfolio_summary || portfolioSummary;
        }
      } catch (err) {
        error('Orchestrator LLM call failed, using fallback logic', err);
        decisions = this._fallbackDecisions(weightedReports);
        portfolioSummary = 'Fallback mode — acting on technical signals only';
      }
    }

    // Filter: only high-confidence actionable decisions
    decisions = decisions.filter(d =>
      (d.action === 'BUY' || d.action === 'SELL') && d.confidence >= 0.7
    );

    // Cap at 3 BUY decisions per cycle
    const buyDecisions = decisions.filter(d => d.action === 'BUY').slice(0, 3);
    const sellDecisions = decisions.filter(d => d.action === 'SELL');
    decisions = [...buyDecisions, ...sellDecisions];

    this._lastDecisions = decisions;
    const synthesisDurationMs = Date.now() - synthesisStart;

    // Persist decisions to DB — snapshot weightedReports + calibration so
    // the TradeDrawer can replay the exact weighting that produced each
    // decision, even as agent_performance drifts later.
    for (const decision of decisions) {
      await this._persistDecision(decision, weightedReports, synthesisDurationMs, calibration);
    }

    // Publish decisions to message bus
    for (const decision of decisions) {
      await messageBus.publish('DECISION', this.name, decision);
    }

    const report = {
      symbol: null,
      signal: decisions.length > 0 ? 'ACTIVE' : 'HOLD',
      confidence: decisions.length > 0
        ? decisions.reduce((sum, d) => sum + d.confidence, 0) / decisions.length
        : 0.5,
      reasoning: portfolioSummary,
      data: {
        decisions,
        portfolioSummary,
        agentReportSummary: Object.fromEntries(
          Object.entries(agentReports).map(([name, r]) => [name, {
            signal: r?.signal,
            confidence: r?.confidence,
          }])
        ),
      },
    };

    log(`Orchestrator: ${decisions.length} actionable decision(s)`, {
      buys: buyDecisions.map(d => d.symbol),
      sells: sellDecisions.map(d => d.symbol),
    });

    await messageBus.publish('REPORT', this.name, report);
    return report;
  }

  /**
   * Get the latest decisions from the last cycle.
   */
  getDecisions() {
    return [...this._lastDecisions];
  }

  /**
   * Pull per-agent 30-day win-rate + sample size from agent_performance.
   * Returns: { [agentName]: { winRate: 0..1, sampleSize: number } }
   * Empty object if the query fails (agents fall back to neutral 0.5 weight).
   */
  async getAgentCalibration(days = 30) {
    try {
      const result = await db.query(
        `SELECT agent_name,
                AVG(win_rate)::float / 100.0 AS win_rate,
                COALESCE(SUM(decisions_made), 0)::int AS sample_size
         FROM agent_performance
         WHERE trade_date >= CURRENT_DATE - ($1::int || ' days')::interval
         GROUP BY agent_name`,
        [days]
      );
      const out = {};
      for (const row of result.rows) {
        // win_rate is stored as percent (0-100) in agent_performance; normalize to 0-1
        const wr = row.win_rate != null ? Math.max(0, Math.min(1, Number(row.win_rate))) : 0.5;
        out[row.agent_name] = {
          winRate: +wr.toFixed(3),
          sampleSize: Number(row.sample_size) || 0,
        };
      }
      return out;
    } catch (err) {
      // Silently return empty — fallback to cold-start weighting keeps the system running
      return {};
    }
  }

  /**
   * Fallback when LLM is unavailable — just pass through technical agent signals.
   */
  _fallbackDecisions(agentReports) {
    const taReport = agentReports['technical-analysis'];
    if (!taReport?.data?.symbolReports) return [];

    const decisions = [];
    for (const [symbol, report] of Object.entries(taReport.data.symbolReports)) {
      if (report.signal === 'BUY' && report.confidence >= 0.6) {
        // MTF alignment gate: in fallback mode (no LLM synthesis), require
        // at least 50 percent of timeframes agreeing with the signal. This
        // prevents the rule-based path from taking single-timeframe setups.
        if (report.mtfAlignment != null && report.mtfAlignment < 0.5) continue;

        decisions.push({
          symbol,
          action: 'BUY',
          confidence: report.confidence * 0.8, // Discount without full synthesis
          reasoning: `Fallback: Technical signal only — ${report.reasoning}`,
          supporting_agents: ['technical-analysis'],
          dissenting_agents: [],
          size_adjustment: 0.8, // Smaller size in fallback mode
        });
      }
    }
    return decisions;
  }

  async _persistDecision(decision, weightedInputs, durationMs = null, calibration = {}) {
    try {
      // Skip if same symbol+action was already decided today (one decision per symbol per day)
      const today = new Date().toISOString().slice(0, 10);
      const recent = await db.query(
        `SELECT id FROM agent_decisions
         WHERE symbol = $1 AND action = $2 AND created_at::date = $3::date
         LIMIT 1`,
        [decision.symbol, decision.action, today]
      );
      if (recent.rows.length > 0) {
        return; // Already decided this symbol+action today
      }

      await db.query(
        `INSERT INTO agent_decisions (symbol, action, confidence, reasoning, agent_inputs, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          decision.symbol,
          decision.action,
          decision.confidence,
          decision.reasoning,
          JSON.stringify({
            supporting: decision.supporting_agents,
            dissenting: decision.dissenting_agents,
            size_adjustment: decision.size_adjustment,
            // Per-agent input snapshot — captures reported AND calibrated confidence so
            // a later reader can see which agent tipped the decision and whether the
            // tip survived the calibration weighting.
            inputs: Object.fromEntries(
              Object.entries(weightedInputs).map(([name, r]) => [name, {
                signal: r?.signal,
                confidence: r?.confidence, // this IS the adjusted (or original) confidence used for synthesis
                reportedConfidence: r?.reportedConfidence ?? r?.confidence,
                adjustedConfidence: r?.adjustedConfidence ?? r?.confidence,
                reasoning: r?.reasoning,
              }])
            ),
            // Full calibration snapshot at decision time — win rates + sample sizes
            // used to compute the weighting above. Survives even if agent_performance
            // drifts later, so historical decisions remain reproducible.
            calibration,
          }),
          durationMs,
        ]
      );
    } catch (err) {
      error('Failed to persist orchestrator decision', err);
    }
  }
}

// Singleton
const orchestrator = new Orchestrator();

module.exports = orchestrator;
