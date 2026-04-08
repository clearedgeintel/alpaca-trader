const BaseAgent = require('./base-agent');
const { messageBus } = require('./message-bus');
const { askJson } = require('./llm');
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
- If market regime is "high_vol_selloff" or bias is "avoid", only SELL decisions allowed
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

    // Build context for LLM
    const context = {
      watchlist: config.WATCHLIST,
      agentReports,
      timestamp: new Date().toISOString(),
    };

    let decisions = [];
    let portfolioSummary = 'No LLM response — no action taken';

    try {
      const result = await askJson({
        agentName: this.name,
        systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
        userMessage: `Agent reports for this cycle:\n${JSON.stringify(context, null, 2)}`,
        tier: 'standard', // Sonnet for synthesis
        maxTokens: 2048,
      });

      if (result.data) {
        decisions = result.data.decisions || [];
        portfolioSummary = result.data.portfolio_summary || portfolioSummary;
      }
    } catch (err) {
      error('Orchestrator LLM call failed, using fallback logic', err);
      decisions = this._fallbackDecisions(agentReports);
      portfolioSummary = 'Fallback mode — acting on technical signals only';
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

    // Persist decisions to DB
    for (const decision of decisions) {
      await this._persistDecision(decision, agentReports);
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
   * Fallback when LLM is unavailable — just pass through technical agent signals.
   */
  _fallbackDecisions(agentReports) {
    const taReport = agentReports['technical-analysis'];
    if (!taReport?.data?.symbolReports) return [];

    const decisions = [];
    for (const [symbol, report] of Object.entries(taReport.data.symbolReports)) {
      if (report.signal === 'BUY' && report.confidence >= 0.6) {
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

  async _persistDecision(decision, agentInputs) {
    try {
      await db.query(
        `INSERT INTO agent_decisions (symbol, action, confidence, reasoning, agent_inputs)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          decision.symbol,
          decision.action,
          decision.confidence,
          decision.reasoning,
          JSON.stringify({
            supporting: decision.supporting_agents,
            dissenting: decision.dissenting_agents,
            size_adjustment: decision.size_adjustment,
            inputs: Object.fromEntries(
              Object.entries(agentInputs).map(([name, r]) => [name, {
                signal: r?.signal,
                confidence: r?.confidence,
                reasoning: r?.reasoning,
              }])
            ),
          }),
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
