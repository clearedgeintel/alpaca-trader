const EventEmitter = require('events');
const { log, error } = require('../logger');
const db = require('../db');
const { snapshotAgentUsage, getAgentUsageDiff } = require('./llm');

class BaseAgent extends EventEmitter {
  constructor(name, options = {}) {
    super();
    this.name = name;
    this.enabled = options.enabled !== false;
    this.intervalMs = options.intervalMs || null;
    this._intervalHandle = null;
    this._lastReport = null;
    this._lastRunAt = null;
    this._running = false;
    this._runCount = 0;
    this._lastDurationMs = null;
    this._cycleMetrics = null; // populated per cycle
  }

  // Override in subclasses — perform analysis and return a report
  async analyze(context) {
    throw new Error(`${this.name}: analyze() not implemented`);
  }

  // Reset per-cycle metrics tracker (call at start of each cycle)
  _resetCycleMetrics() {
    this._cycleMetrics = {
      llmCalls: 0,
      llmInputTokens: 0,
      llmOutputTokens: 0,
      llmCostUsd: 0,
      symbolsProcessed: 0,
      signalsProduced: 0,
      errors: 0,
    };
  }

  // Track LLM usage within this cycle (called by subclasses or llm wrapper)
  trackLlmUsage({ inputTokens = 0, outputTokens = 0, costUsd = 0 } = {}) {
    if (!this._cycleMetrics) return;
    this._cycleMetrics.llmCalls++;
    this._cycleMetrics.llmInputTokens += inputTokens;
    this._cycleMetrics.llmOutputTokens += outputTokens;
    this._cycleMetrics.llmCostUsd += costUsd;
  }

  // Persist cycle metrics to agent_metrics table
  async _persistMetrics(durationMs) {
    if (!this._cycleMetrics) return;
    try {
      const meta = {};
      if (this._cycleMetrics.errorMessage) meta.error = this._cycleMetrics.errorMessage;
      if (this._cycleMetrics.errorStack) meta.stack = this._cycleMetrics.errorStack;
      await db.query(
        `INSERT INTO agent_metrics
         (agent_name, cycle_duration_ms, llm_calls, llm_input_tokens, llm_output_tokens,
          llm_cost_usd, symbols_processed, signals_produced, errors, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          this.name,
          durationMs,
          this._cycleMetrics.llmCalls,
          this._cycleMetrics.llmInputTokens,
          this._cycleMetrics.llmOutputTokens,
          this._cycleMetrics.llmCostUsd,
          this._cycleMetrics.symbolsProcessed,
          this._cycleMetrics.signalsProduced,
          this._cycleMetrics.errors,
          JSON.stringify(meta),
        ]
      );
    } catch (err) {
      error(`${this.name}: failed to persist cycle metrics`, err);
    }
  }

  // Run a single analysis cycle
  async run(context = {}) {
    if (this._running) {
      log(`${this.name}: skipping, previous cycle still running`);
      return this._lastReport;
    }

    this._running = true;
    this._resetCycleMetrics();
    const llmSnapshot = snapshotAgentUsage(this.name);
    const startTime = Date.now();

    try {
      const report = await this.analyze(context);

      const elapsed = Date.now() - startTime;
      this._lastDurationMs = elapsed;

      // Auto-populate LLM metrics from snapshot diff
      const llmDiff = getAgentUsageDiff(this.name, llmSnapshot);
      this._cycleMetrics.llmCalls = llmDiff.calls;
      this._cycleMetrics.llmInputTokens = llmDiff.inputTokens;
      this._cycleMetrics.llmOutputTokens = llmDiff.outputTokens;
      this._cycleMetrics.llmCostUsd = llmDiff.costUsd;

      this._lastReport = {
        agent: this.name,
        ...report,
        durationMs: elapsed,
        timestamp: new Date().toISOString(),
      };
      this._lastRunAt = new Date().toISOString();
      this._runCount++;
      this._lastError = null;

      log(`${this.name}: cycle completed in ${elapsed}ms`, {
        signal: this._lastReport.signal,
        confidence: this._lastReport.confidence,
        llmCalls: llmDiff.calls,
        llmCost: `$${llmDiff.costUsd.toFixed(4)}`,
      });

      // Persist telemetry (non-blocking)
      this._persistMetrics(elapsed).catch(() => {});

      this.emit('report', this._lastReport);
      return this._lastReport;
    } catch (err) {
      const elapsed = Date.now() - startTime;
      this._lastDurationMs = elapsed;
      if (this._cycleMetrics) {
        this._cycleMetrics.errors++;
        this._cycleMetrics.errorMessage = err.message;
        this._cycleMetrics.errorStack = err.stack?.split('\n').slice(0, 5).join('\n');
      }
      this._lastError = err.message;
      this._persistMetrics(elapsed).catch(() => {});

      error(`${this.name}: analysis failed`, err);
      this.emit('error', { agent: this.name, error: err.message });
      return null;
    } finally {
      this._running = false;
    }
  }

  // Start recurring analysis on an interval
  start(context = {}) {
    if (!this.enabled) {
      log(`${this.name}: disabled, not starting`);
      return;
    }

    log(`${this.name}: starting`);
    this.emit('started', { agent: this.name });

    if (this.intervalMs) {
      // Run immediately, then on interval
      this.run(context);
      this._intervalHandle = setInterval(() => this.run(context), this.intervalMs);
    }
  }

  // Stop recurring analysis
  stop() {
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
    }
    log(`${this.name}: stopped`);
    this.emit('stopped', { agent: this.name });
  }

  // Get the last report produced by this agent
  getReport() {
    return this._lastReport;
  }

  // Get agent status for API/dashboard
  getStatus() {
    return {
      name: this.name,
      enabled: this.enabled,
      running: this._running,
      lastRunAt: this._lastRunAt,
      runCount: this._runCount,
      lastDurationMs: this._lastDurationMs,
      lastError: this._lastError || null,
      hasReport: this._lastReport !== null,
      lastSignal: this._lastReport?.signal || null,
      lastConfidence: this._lastReport?.confidence || null,
      lastCycleMetrics: this._cycleMetrics,
    };
  }
}

module.exports = BaseAgent;
