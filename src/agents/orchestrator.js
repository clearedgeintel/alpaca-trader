const BaseAgent = require('./base-agent');
const { messageBus } = require('./message-bus');
const { askJson, isAvailable: llmAvailable } = require('./llm');
const promptRegistry = require('./prompt-registry');
const config = require('../config');
const runtimeConfig = require('../runtime-config');
const db = require('../db');
const crypto = require('crypto');
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
- Be decisive but conservative — protecting capital is priority #1
- Crypto pairs (symbols with /USD suffix like BTC/USD) trade 24/7 with higher volatility — use wider stops and smaller position sizes. No earnings events for crypto; focus on technical + regime + news for crypto decisions.

Options context (only relevant when "optionChains" is present in the cycle's input):
- The user message may include "optionChains": { UNDERLYING: [{ symbol, type, strike, expiration, dte, premium, delta, theta, iv, openInterest }, ...] }
- When you have a high-confidence directional view on an underlying AND that underlying appears in optionChains, you MAY issue a BUY decision whose "symbol" is one of the OCC contract symbols listed there instead of the underlying ticker.
- Picking guidance:
    * Bullish thesis  → choose a CALL with delta in the 0.40-0.60 band (near the money, not deep ITM, not far OTM)
    * Bearish thesis  → choose a PUT with delta in the -0.60 to -0.40 band
    * Prefer the longest available DTE in the listed set when conviction is moderate (lets theta hurt less)
    * Prefer shorter DTE only when the technical setup expects resolution within days
    * Avoid contracts where openInterest < 100 (illiquid)
    * Avoid contracts where iv looks anomalous (e.g. >2.0 unless specifically a vol play)
- Risk: position sizing, delta-exposure cap, and DTE blocks are enforced downstream. You only pick the contract; the executor handles size.
- If no listed contract fits, prefer the underlying (BUY/SELL the equity) over forcing a marginal option pick.
- "decisions[].option_type" / "target_expiration" / "target_strike" are optional fields you may include for traceability; the executor reads them from the OCC symbol regardless.`;

class Orchestrator extends BaseAgent {
  constructor() {
    super('orchestrator', { intervalMs: null }); // Not self-scheduling — driven by runCycle()
    this._lastDecisions = [];
    this._agents = {};
    // Context hash cache — skips Sonnet call when agent inputs haven't changed
    this._lastInputHash = null;
    this._lastCachedDecisions = null;
    this._lastCachedSummary = null;
  }

  /**
   * Register an agent so the orchestrator can collect its reports.
   */
  registerAgent(agent) {
    this._agents[agent.name] = agent;
    log(`Orchestrator: registered agent "${agent.name}"`);
  }

  /**
   * Tag the next analyze() with a cycle number so cycle-log events
   * group correctly. Called by index.js before each cycle's run().
   */
  setCycleNumber(n) {
    this._currentCycle = n;
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
      const weight = cal && cal.sampleSize >= 10 ? cal.winRate : 0.5;
      // adjusted = reported * (winRate * 0.7 + 0.3) — keeps a floor so calibrated agents aren't muted entirely
      const adjustedConfidence =
        typeof report.confidence === 'number'
          ? +(report.confidence * (weight * 0.7 + 0.3)).toFixed(3)
          : report.confidence;
      weightedReports[name] = {
        ...report,
        reportedConfidence: report.confidence,
        adjustedConfidence,
        calibration: cal
          ? { winRate: cal.winRate, sampleSize: cal.sampleSize, coldStart: cal.sampleSize < 10 }
          : { coldStart: true, reason: 'no_history' },
      };
    }

    // Optional fundamentals enrichment (Polygon free tier). Cached ~6h,
    // so per-cycle cost is ~0. Returns null-values silently when disabled.
    const datasources = require('../datasources');
    const sectorRotation = require('../sector-rotation');
    const tickerContext = {};
    await Promise.all(
      config.WATCHLIST.map(async (sym) => {
        const details = await datasources.getTickerDetails(sym);
        if (details) {
          tickerContext[sym] = {
            marketCap: details.marketCap,
            sector: details.sic_description,
          };
        }
      }),
    );

    // Sector rotation — leaders/laggards over the last 5 trading days.
    // Bounded cost: cached 30min, reuses datasources cache for ticker sector.
    // Silently returns empty when Polygon disabled.
    let rotationSummary = null;
    try {
      const rotation = await sectorRotation.computeRotation({ symbols: config.WATCHLIST, days: 5 });
      if (rotation.sectors.length > 1) {
        rotationSummary = {
          leaders: rotation.leaders.map((s) => ({
            name: s.name,
            avgReturn: s.avgReturn,
            momentumScore: s.momentumScore,
          })),
          laggards: rotation.laggards.map((s) => ({
            name: s.name,
            avgReturn: s.avgReturn,
            momentumScore: s.momentumScore,
          })),
          lookbackDays: rotation.lookbackDays,
        };
      }
    } catch (err) {
      // Fail-open: rotation is a nudge, not a gate
      this.log?.(`sector-rotation skipped: ${err.message}`);
    }

    // Optional option-chain summary — empty {} when OPTIONS_ENABLED is
    // false or when chain fetches all fail. When non-empty, the LLM is
    // permitted to issue option BUY decisions whose `symbol` is an OCC
    // contract picked from this list (see prompt appendix below).
    let optionChains = {};
    try {
      const optionsContext = require('../options-context');
      optionChains = await optionsContext.buildChainSummary(config.WATCHLIST);
    } catch (err) {
      this.log?.(`option-chain summary skipped: ${err.message}`);
    }

    // Build context for LLM — weights live in the USER MESSAGE so the system prompt stays static.
    // NOTE: deliberately no timestamp field here — it would defeat the context-hash cache below.
    // Slim reports: strip bulky raw indicator dumps but keep the per-symbol
    // BUY/SELL lists the orchestrator needs to pick trades.
    const slimReports = {};
    for (const [name, r] of Object.entries(weightedReports)) {
      const { data, ...rest } = r;
      if (data && (data.buySignals?.length || data.sellSignals?.length || data.symbolReports)) {
        // Keep the actionable lists; drop the heavy symbolReports detail.
        const slimData = {};
        if (data.buySignals) slimData.buySignals = data.buySignals;
        if (data.sellSignals) slimData.sellSignals = data.sellSignals;
        // Include a compact per-symbol verdict so the LLM can reason about
        // specific tickers without the full indicator dump.
        if (data.symbolReports) {
          slimData.symbolVerdicts = Object.fromEntries(
            Object.entries(data.symbolReports).map(([sym, sr]) => [
              sym,
              { signal: sr.signal, confidence: sr.confidence, reasoning: sr.reasoning, mtfAlignment: sr.mtfAlignment },
            ]),
          );
        }
        slimReports[name] = { ...rest, data: slimData };
      } else {
        slimReports[name] = rest;
      }
    }
    const context = {
      watchlist: config.WATCHLIST,
      agentReports: slimReports,
      ...(Object.keys(tickerContext).length > 0 ? { tickerContext } : {}),
      ...(rotationSummary ? { sectorRotation: rotationSummary } : {}),
      ...(Object.keys(optionChains).length > 0 ? { optionChains } : {}),
    };

    // Inter-agent debate: when agents disagree, let dissenters challenge
    // the majority before the orchestrator synthesizes. The debate
    // transcript gives the LLM explicit counterarguments to weigh.
    // Skips entirely (zero LLM cost) when all agents agree.
    const { runDebate } = require('./debate');
    let debateResult = { hasDissent: false, debateRounds: [], summary: '' };
    if (llmAvailable()) {
      try {
        debateResult = await runDebate(weightedReports);
        if (debateResult.hasDissent) {
          log(`Orchestrator debate: ${debateResult.summary}`);
        }
      } catch (err) {
        error('Orchestrator debate failed (continuing without)', err);
      }
    }
    this._lastDebate = debateResult;

    let decisions = [];
    let portfolioSummary = 'No LLM response — no action taken';
    const synthesisStart = Date.now();

    // Short-circuit #1: no agent AND no symbol has a BUY/SELL signal → nothing
    // worth synthesizing. The technical agent reports `signal: 'HOLD'` at the
    // portfolio level while its per-symbol BUY/SELL signals live in data —
    // so we must check BOTH top-level signals AND the TA per-symbol lists.
    const hasTopLevelSignal = Object.values(weightedReports).some(
      (r) => r?.signal === 'BUY' || r?.signal === 'SELL',
    );
    const taReportForCheck = weightedReports['technical-analysis'];
    const taBuy = taReportForCheck?.data?.buySignals || [];
    const taSell = taReportForCheck?.data?.sellSignals || [];
    const hasSymbolSignal = taBuy.length > 0 || taSell.length > 0;
    const hasActionableSignal = hasTopLevelSignal || hasSymbolSignal;

    // Diagnostic log: what did the agents tell the orchestrator?
    try {
      const signals = Object.values(weightedReports).map((r) => r?.signal || 'NONE');
      const cycleLog = require('../cycle-log');
      cycleLog.orchestratorSignals({
        cycleNumber: this._currentCycle,
        buyCount: signals.filter((s) => s === 'BUY').length,
        sellCount: signals.filter((s) => s === 'SELL').length,
        holdCount: signals.filter((s) => s === 'HOLD' || s === 'NONE').length,
        taBuySymbols: taBuy,
        taSellSymbols: taSell,
      });
    } catch {}

    if (!hasActionableSignal) {
      log('Orchestrator: no BUY/SELL signals from any agent — skipping Sonnet synthesis (all HOLD)');
      try {
        require('../cycle-log').orchestratorShortCircuit({
          cycleNumber: this._currentCycle,
          reason: 'all-agents-HOLD-and-no-TA-symbol-signals',
        });
      } catch {}
      decisions = [];
      portfolioSummary = 'All agents returned HOLD — no synthesis needed.';
    } else if (!llmAvailable()) {
      log('Orchestrator: LLM unavailable (budget/breaker), using fallback logic');
      decisions = this._fallbackDecisions(weightedReports);
      portfolioSummary = 'Fallback mode — LLM unavailable, acting on technical signals only';
    } else {
      try {
        const calSummary = Object.entries(calibration)
          .map(
            ([name, c]) =>
              `- ${name}: ${c.sampleSize >= 10 ? `${(c.winRate * 100).toFixed(0)}% win-rate over ${c.sampleSize} decisions` : `cold-start (${c.sampleSize} decisions) — weighted 0.5`}`,
          )
          .join('\n');
        const calBlock = calSummary
          ? `\n\nAgent historical accuracy (30d, used to adjust reported confidences):\n${calSummary}\nEach agent's adjustedConfidence already reflects its historical win rate. Favor agents with higher calibration when weighing dissent.`
          : '';

        // A/B plumbing: prefer a DB-active prompt version over the hardcoded
        // fallback. Capture id + version label so each decision we persist
        // can be traced back to the exact prompt that produced it.
        const activePrompt = promptRegistry.getActive(this.name, ORCHESTRATOR_SYSTEM_PROMPT);
        this._activePromptVersionId = promptRegistry.getActiveId(this.name);
        this._activePromptVersion = promptRegistry.getActiveVersion(this.name);

        // Shadow-mode: if a candidate version is designated as shadow,
        // fire it in parallel with the live call. Shadow failures are
        // silent and never affect live trading. Costs ~2x LLM spend per
        // cycle while active — only run when explicitly configured.
        const shadowPrompt = promptRegistry.getShadow(this.name);
        const shadowMeta = promptRegistry.getShadowMeta(this.name);
        // Build debate block for the user message when agents disagreed
        const debateBlock =
          debateResult.hasDissent && debateResult.debateRounds.length > 0
            ? `\n\nInter-agent debate (dissenting agents challenged the majority before your synthesis):\n${debateResult.debateRounds
                .map((r, i) =>
                  [
                    `Round ${i + 1}: ${r.dissenter} (${r.dissenterSignal}) vs ${r.responder} (${r.responderSignal})`,
                    r.challenge ? `  Challenge: "${r.challenge}"` : '  (challenge failed)',
                    r.response ? `  Response:  "${r.response}"` : '  (response failed)',
                  ].join('\n'),
                )
                .join(
                  '\n\n',
                )}\n\nWeigh these arguments explicitly in your reasoning. If a dissenter raised a valid risk, acknowledge it and adjust confidence accordingly.`
            : '';

        const userMessage = `Agent reports for this cycle:\n${JSON.stringify(context, null, 2)}${calBlock}${debateBlock}`;

        // Context hash — skip the expensive Sonnet call if agent inputs are
        // identical to the previous cycle. Saves ~0.8c per skipped cycle.
        const inputHash = crypto.createHash('md5').update(userMessage).digest('hex');
        if (inputHash === this._lastInputHash && this._lastCachedDecisions) {
          log('Orchestrator: context unchanged — reusing cached decisions (Sonnet call skipped)');
          decisions = this._lastCachedDecisions;
          portfolioSummary = this._lastCachedSummary || portfolioSummary;
        } else {
        // Tier selection: if agents unanimously agreed (no debate fired),
        // the synthesis is low-nuance — Haiku is plenty. Sonnet only when
        // we have real dissent to weigh. Saves ~5x per call on agreement.
        const tier = debateResult.hasDissent && debateResult.debateRounds.length > 0
          ? 'standard'
          : 'fast';
        const maxTokens = 1024; // was 2048; orchestrator outputs are typically <500 tok
        const { orchestratorOutputSchema } = require('./schemas');
        const [liveResult, shadowResultSettled] = await Promise.all([
          askJson({
            agentName: this.name,
            systemPrompt: activePrompt,
            userMessage,
            tier,
            maxTokens,
            schema: orchestratorOutputSchema,
          }),
          shadowPrompt
            ? askJson({
                agentName: `${this.name}-shadow`,
                systemPrompt: shadowPrompt,
                userMessage,
                tier,
                maxTokens,
                schema: orchestratorOutputSchema,
              })
                .then((r) => ({ status: 'fulfilled', value: r }))
                .catch((err) => ({ status: 'rejected', reason: err }))
            : Promise.resolve(null),
        ]);

        if (liveResult?.data) {
          decisions = liveResult.data.decisions || [];
          portfolioSummary = liveResult.data.portfolio_summary || portfolioSummary;
        }

        // Cache for next cycle comparison
        this._lastInputHash = inputHash;
        this._lastCachedDecisions = decisions;
        this._lastCachedSummary = portfolioSummary;

        // Stash shadow result on the instance so the persist phase can
        // write paired rows after live decisions have been saved.
        this._pendingShadow = null;
        if (shadowMeta && shadowResultSettled?.status === 'fulfilled' && shadowResultSettled.value?.data) {
          this._pendingShadow = {
            meta: shadowMeta,
            decisions: shadowResultSettled.value.data.decisions || [],
            portfolioSummary: shadowResultSettled.value.data.portfolio_summary || null,
          };
        } else if (shadowMeta && shadowResultSettled?.status === 'rejected') {
          error(`orchestrator-shadow: ${shadowMeta.version} call failed`, shadowResultSettled.reason);
        }
        } // end context-hash else
      } catch (err) {
        error('Orchestrator LLM call failed, using fallback logic', err);
        decisions = this._fallbackDecisions(weightedReports);
        portfolioSummary = 'Fallback mode — acting on technical signals only';
      }
    }

    // Filter: only high-confidence actionable decisions. Threshold is hot-reloadable
    // via runtime-config so operators can tune trade aggressiveness live.
    const minConfidence = runtimeConfig.get('ORCHESTRATOR_MIN_CONFIDENCE');
    const rawDecisionCount = decisions.length;
    decisions = decisions.filter((d) => (d.action === 'BUY' || d.action === 'SELL') && d.confidence >= minConfidence);
    try {
      require('../cycle-log').orchestratorSynthesis({
        cycleNumber: this._currentCycle,
        rawDecisions: rawDecisionCount,
        finalDecisions: decisions.length,
        minConfidence,
        droppedByConfidence: rawDecisionCount - decisions.length,
      });
    } catch {}

    // Cap at 3 BUY decisions per cycle
    const buyDecisions = decisions.filter((d) => d.action === 'BUY').slice(0, 3);
    const sellDecisions = decisions.filter((d) => d.action === 'SELL');
    decisions = [...buyDecisions, ...sellDecisions];

    this._lastDecisions = decisions;
    const synthesisDurationMs = Date.now() - synthesisStart;

    // Persist decisions to DB — snapshot weightedReports + calibration so
    // the TradeDrawer can replay the exact weighting that produced each
    // decision, even as agent_performance drifts later. Capture id by
    // symbol so shadow decisions can pair via shadow_of.
    const liveIdsBySymbol = new Map();
    for (const decision of decisions) {
      const id = await this._persistDecision(decision, weightedReports, synthesisDurationMs, calibration);
      if (id) liveIdsBySymbol.set(decision.symbol, id);
    }

    // Shadow decisions land alongside live rows with is_shadow=true.
    // Writes are best-effort and never affect live execution.
    await this._persistShadowDecisions(liveIdsBySymbol, synthesisDurationMs);

    // Publish decisions to message bus (live only — shadow rows stay DB-side)
    for (const decision of decisions) {
      await messageBus.publish('DECISION', this.name, decision);
    }

    const report = {
      symbol: null,
      signal: decisions.length > 0 ? 'ACTIVE' : 'HOLD',
      confidence: decisions.length > 0 ? decisions.reduce((sum, d) => sum + d.confidence, 0) / decisions.length : 0.5,
      reasoning: portfolioSummary,
      data: {
        decisions,
        portfolioSummary,
        agentReportSummary: Object.fromEntries(
          Object.entries(agentReports).map(([name, r]) => [
            name,
            {
              signal: r?.signal,
              confidence: r?.confidence,
            },
          ]),
        ),
      },
    };

    log(`Orchestrator: ${decisions.length} actionable decision(s)`, {
      buys: buyDecisions.map((d) => d.symbol),
      sells: sellDecisions.map((d) => d.symbol),
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
        [days],
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
         WHERE symbol = $1 AND action = $2 AND is_shadow = false
           AND created_at::date = $3::date
         LIMIT 1`,
        [decision.symbol, decision.action, today],
      );
      if (recent.rows.length > 0) {
        return; // Already decided this symbol+action today
      }

      const insertRes = await db.query(
        `INSERT INTO agent_decisions (symbol, action, confidence, reasoning, agent_inputs, duration_ms, prompt_version_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
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
              Object.entries(weightedInputs).map(([name, r]) => [
                name,
                {
                  signal: r?.signal,
                  confidence: r?.confidence, // this IS the adjusted (or original) confidence used for synthesis
                  reportedConfidence: r?.reportedConfidence ?? r?.confidence,
                  adjustedConfidence: r?.adjustedConfidence ?? r?.confidence,
                  reasoning: r?.reasoning,
                },
              ]),
            ),
            // Full calibration snapshot at decision time — win rates + sample sizes
            // used to compute the weighting above. Survives even if agent_performance
            // drifts later, so historical decisions remain reproducible.
            calibration,
            promptVersion: this._activePromptVersion || 'hardcoded',
            ...(this._lastDebate?.hasDissent ? { debate: this._lastDebate } : {}),
          }),
          durationMs,
          this._activePromptVersionId || null,
        ],
      );
      return insertRes.rows[0]?.id || null;
    } catch (err) {
      error('Failed to persist orchestrator decision', err);
      return null;
    }
  }

  /**
   * Persist shadow decisions alongside each cycle's live decisions.
   * Shadow rows are flagged `is_shadow=true` so every existing reader
   * that filters `is_shadow = false` stays unaffected. When we have a
   * matching live row for the same symbol, `shadow_of` links back so
   * the comparison endpoint can pair them cleanly.
   *
   * Shadow decisions are NEVER subjected to the same confidence
   * filter / BUY cap as live, and NEVER publish to the message bus —
   * they're pure observations.
   */
  async _persistShadowDecisions(liveIdsBySymbol, durationMs) {
    if (!this._pendingShadow || !this._pendingShadow.meta) return;
    const { meta, decisions: shadowDecisions } = this._pendingShadow;

    for (const shadow of shadowDecisions || []) {
      try {
        const shadowOf = liveIdsBySymbol.get(shadow.symbol) || null;
        await db.query(
          `INSERT INTO agent_decisions
             (symbol, action, confidence, reasoning, agent_inputs,
              duration_ms, prompt_version_id, is_shadow, shadow_of)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)`,
          [
            shadow.symbol,
            shadow.action,
            shadow.confidence,
            shadow.reasoning,
            JSON.stringify({
              supporting: shadow.supporting_agents,
              dissenting: shadow.dissenting_agents,
              size_adjustment: shadow.size_adjustment,
              promptVersion: meta.version,
              shadow: true,
            }),
            durationMs,
            meta.id,
            shadowOf,
          ],
        );
      } catch (err) {
        error(`Failed to persist shadow decision for ${shadow.symbol}`, err);
      }
    }
  }
}

// Singleton
const orchestrator = new Orchestrator();

module.exports = orchestrator;
