/**
 * Prometheus metrics registry. Exposes a single Registry the `/metrics`
 * HTTP route serves; callers bump counters / histograms directly.
 *
 * Philosophy:
 *   - Counters for "events happened" (llm calls, trades opened/closed)
 *   - Histograms for "how long did X take" (cycle durations)
 *   - Gauges via `collect` callbacks for "what's the current value?"
 *     (open positions, budget remaining, Polygon cache size) — that
 *     way we read from the authoritative in-memory source at scrape
 *     time and never go stale.
 *
 * /metrics is mounted OUTSIDE /api/ so Prometheus can scrape without
 * the API key or rate limit. Convention for ops tooling.
 */

const client = require('prom-client');
const config = require('./config');

const registry = new client.Registry();
registry.setDefaultLabels({ app: 'alpaca-trader' });

// Node defaults — process_cpu, heap, event_loop_lag, handles, etc.
client.collectDefaultMetrics({ register: registry });

// -------- LLM --------

const llmCallsTotal = new client.Counter({
  name: 'llm_calls_total',
  help: 'LLM API calls, by agent + model tier',
  labelNames: ['agent', 'model'],
  registers: [registry],
});

const llmTokensTotal = new client.Counter({
  name: 'llm_tokens_total',
  help: 'LLM tokens consumed, by direction (input|output|cache_read|cache_write)',
  labelNames: ['direction'],
  registers: [registry],
});

const llmCostUsdTotal = new client.Counter({
  name: 'llm_cost_usd_total',
  help: 'Estimated LLM cost in USD (cumulative)',
  registers: [registry],
});

// Scrape-time gauges pull fresh values from llm.getUsage()
new client.Gauge({
  name: 'llm_budget_remaining_usd',
  help: 'Daily LLM cost cap minus spend so far',
  registers: [registry],
  async collect() {
    try {
      const u = require('./agents/llm').getUsage();
      this.set(Math.max(0, (u.dailyCostCapUsd || 0) - (u.estimatedCostUsd || 0)));
    } catch {
      /* pre-init or DB-down; leave blank */
    }
  },
});

new client.Gauge({
  name: 'llm_circuit_breaker_open',
  help: '1 if the LLM circuit breaker is tripped, else 0',
  registers: [registry],
  async collect() {
    try {
      const u = require('./agents/llm').getUsage();
      this.set(u.circuitBreakerOpen ? 1 : 0);
    } catch {
      /* leave blank */
    }
  },
});

// -------- Trades --------

const tradesOpenedTotal = new client.Counter({
  name: 'trades_opened_total',
  help: 'Trades opened (BUY orders placed + persisted)',
  registers: [registry],
});

const tradesClosedTotal = new client.Counter({
  name: 'trades_closed_total',
  help: 'Trades closed, by exit reason',
  labelNames: ['reason'],
  registers: [registry],
});

// Smart Order Routing — track limit vs market-fallback ratio and savings
const smartOrdersTotal = new client.Counter({
  name: 'smart_orders_total',
  help: 'Smart orders placed, by routing strategy',
  labelNames: ['strategy'], // limit | market | market_fallback
  registers: [registry],
});

const smartOrderSavingsBps = new client.Histogram({
  name: 'smart_order_savings_bps',
  help: 'Price improvement vs crossing the full spread, in basis points',
  buckets: [-10, -5, 0, 1, 2, 5, 10, 20, 50, 100],
  registers: [registry],
});

new client.Gauge({
  name: 'positions_open',
  help: 'Currently open positions (DB count of trades.status = open)',
  registers: [registry],
  async collect() {
    try {
      const db = require('./db');
      const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM trades WHERE status = 'open'");
      this.set(rows[0]?.n || 0);
    } catch {
      /* DB unavailable — skip */
    }
  },
});

// -------- Cycles --------

const agencyCycleDuration = new client.Histogram({
  name: 'agency_cycle_duration_seconds',
  help: 'Duration of a full agency cycle (all agents + orchestrator + execution)',
  buckets: [1, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

const agentCycleDuration = new client.Histogram({
  name: 'agent_cycle_duration_seconds',
  help: 'Per-agent analyze() duration',
  labelNames: ['agent'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

// -------- Datasources --------

new client.Gauge({
  name: 'polygon_calls_total_scraped',
  help: 'Polygon API calls since process start (snapshot of polygon.getStats().calls)',
  registers: [registry],
  async collect() {
    try {
      const { _providers } = require('./datasources');
      const s = _providers.polygon.getStats();
      this.set(s.calls || 0);
    } catch {
      /* leave blank */
    }
  },
});

new client.Gauge({
  name: 'polygon_rate_limited',
  help: '1 if Polygon is currently rate-limited / circuit open, else 0',
  registers: [registry],
  async collect() {
    try {
      const { _providers } = require('./datasources');
      const s = _providers.polygon.getStats();
      this.set(s.ratelimited ? 1 : 0);
    } catch {
      /* leave blank */
    }
  },
});

// -------- Public API --------

module.exports = {
  registry,
  // Counter/histogram instruments — exposed directly for call-sites to bump.
  llmCallsTotal,
  llmTokensTotal,
  llmCostUsdTotal,
  tradesOpenedTotal,
  tradesClosedTotal,
  smartOrdersTotal,
  smartOrderSavingsBps,
  agencyCycleDuration,
  agentCycleDuration,
  // Convenience for tests
  _reset() {
    registry.resetMetrics();
  },
  _contentType() {
    return registry.contentType;
  },
  async _metrics() {
    return registry.metrics();
  },
};

// Silence unused-variable lint for the config import reserved for future use.
void config;
