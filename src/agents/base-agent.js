const EventEmitter = require('events');
const { log, error } = require('../logger');

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
  }

  // Override in subclasses — perform analysis and return a report
  async analyze(context) {
    throw new Error(`${this.name}: analyze() not implemented`);
  }

  // Run a single analysis cycle
  async run(context = {}) {
    if (this._running) {
      log(`${this.name}: skipping, previous cycle still running`);
      return this._lastReport;
    }

    this._running = true;
    const startTime = Date.now();

    try {
      const report = await this.analyze(context);

      this._lastReport = {
        agent: this.name,
        ...report,
        timestamp: new Date().toISOString(),
      };
      this._lastRunAt = new Date().toISOString();
      this._runCount++;

      const elapsed = Date.now() - startTime;
      log(`${this.name}: cycle completed in ${elapsed}ms`, {
        signal: this._lastReport.signal,
        confidence: this._lastReport.confidence,
      });

      this.emit('report', this._lastReport);
      return this._lastReport;
    } catch (err) {
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
      hasReport: this._lastReport !== null,
      lastSignal: this._lastReport?.signal || null,
      lastConfidence: this._lastReport?.confidence || null,
    };
  }
}

module.exports = BaseAgent;
