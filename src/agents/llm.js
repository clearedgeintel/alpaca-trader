const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const { log, error, warn, alert } = require('../logger');

// Model tiers — Haiku for frequent per-symbol calls, Sonnet for orchestrator synthesis
const MODELS = {
  fast: 'claude-haiku-4-5-20251001',
  standard: 'claude-sonnet-4-6',
};

// Track token usage and estimated cost
const usage = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  callCount: 0,
  estimatedCostUsd: 0,
  byAgent: {},
  resetDate: new Date().toISOString().slice(0, 10),
};

// Debug log — circular buffer of recent LLM calls
const debugLog = [];
const MAX_DEBUG_LOG = 50;

// Circuit breaker state
let consecutiveFailures = 0;
let breakerOpenUntil = 0;
const BREAKER_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// Approximate pricing per 1M tokens (USD)
const PRICING = {
  [MODELS.fast]: { input: 0.80, output: 4.00 },
  [MODELS.standard]: { input: 3.00, output: 15.00 },
};

let client = null;

function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is required for agent LLM calls');
    }
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

/**
 * Check if the LLM is available (budget not exhausted, circuit breaker closed).
 */
function isAvailable() {
  resetDailyIfNeeded();

  if (usage.estimatedCostUsd >= config.LLM_DAILY_COST_CAP_USD) return false;
  if (usage.totalInputTokens + usage.totalOutputTokens >= config.LLM_DAILY_TOKEN_CAP) return false;
  if (Date.now() < breakerOpenUntil) return false;

  return true;
}

function resetDailyIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== usage.resetDate) {
    usage.totalInputTokens = 0;
    usage.totalOutputTokens = 0;
    usage.callCount = 0;
    usage.estimatedCostUsd = 0;
    usage.byAgent = {};
    usage.resetDate = today;
  }
}

/**
 * Send a message to Claude and get a response.
 */
async function ask({ agentName, systemPrompt, userMessage, tier = 'fast', maxTokens = 1024 }) {
  // Budget check
  if (!isAvailable()) {
    const reason = Date.now() < breakerOpenUntil
      ? 'circuit breaker open'
      : 'daily budget exhausted';
    warn(`LLM unavailable for ${agentName}: ${reason}`);
    throw new BudgetExhaustedError(reason);
  }

  const model = MODELS[tier] || MODELS.fast;
  const anthropic = getClient();
  const callStart = Date.now();

  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;

    trackUsage(agentName, model, inputTokens, outputTokens);

    // Store in debug log
    debugLog.push({
      timestamp: new Date().toISOString(),
      agent: agentName,
      model,
      tier,
      systemPrompt: systemPrompt.slice(0, 500),
      userMessage: userMessage.slice(0, 1000),
      response: text.slice(0, 2000),
      inputTokens,
      outputTokens,
      durationMs: Date.now() - callStart,
    });
    if (debugLog.length > MAX_DEBUG_LOG) debugLog.shift();

    // Reset circuit breaker on success
    consecutiveFailures = 0;

    return { text, inputTokens, outputTokens };
  } catch (err) {
    if (err instanceof BudgetExhaustedError) throw err;

    consecutiveFailures++;
    error(`LLM call failed for ${agentName} (${consecutiveFailures} consecutive)`, err);

    if (consecutiveFailures >= config.LLM_CIRCUIT_BREAKER_FAILURES) {
      breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
      const msg = `Circuit breaker OPEN — ${consecutiveFailures} consecutive LLM failures. Cooldown ${BREAKER_COOLDOWN_MS / 1000}s.`;
      warn(msg);
      alert(msg);
    }

    throw err;
  }
}

/**
 * Send a message and parse JSON from the response.
 */
async function askJson(options) {
  const result = await ask(options);

  try {
    let jsonStr = result.text.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }
    const parsed = JSON.parse(jsonStr);
    return { ...result, data: parsed };
  } catch (err) {
    error(`LLM JSON parse failed for ${options.agentName}`, err);
    return { ...result, data: null, parseError: err.message };
  }
}

function trackUsage(agentName, model, inputTokens, outputTokens) {
  resetDailyIfNeeded();

  usage.totalInputTokens += inputTokens;
  usage.totalOutputTokens += outputTokens;
  usage.callCount++;

  const pricing = PRICING[model] || PRICING[MODELS.fast];
  const cost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  usage.estimatedCostUsd += cost;

  if (!usage.byAgent[agentName]) {
    usage.byAgent[agentName] = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }
  const agentUsage = usage.byAgent[agentName];
  agentUsage.calls++;
  agentUsage.inputTokens += inputTokens;
  agentUsage.outputTokens += outputTokens;
  agentUsage.costUsd += cost;

  log(`LLM usage [${agentName}]: ${inputTokens}in/${outputTokens}out tokens, $${cost.toFixed(4)} (daily total: $${usage.estimatedCostUsd.toFixed(4)})`);

  // Alert when approaching budget
  if (usage.estimatedCostUsd >= config.LLM_DAILY_COST_CAP_USD * 0.8 &&
      usage.estimatedCostUsd - cost < config.LLM_DAILY_COST_CAP_USD * 0.8) {
    alert(`LLM daily cost at 80% of cap ($${usage.estimatedCostUsd.toFixed(2)} / $${config.LLM_DAILY_COST_CAP_USD})`);
  }
}

function getUsage() {
  return {
    ...usage,
    circuitBreakerOpen: Date.now() < breakerOpenUntil,
    breakerOpenUntil: breakerOpenUntil > Date.now() ? new Date(breakerOpenUntil).toISOString() : null,
    dailyCostCapUsd: config.LLM_DAILY_COST_CAP_USD,
    dailyTokenCap: config.LLM_DAILY_TOKEN_CAP,
  };
}

class BudgetExhaustedError extends Error {
  constructor(reason) {
    super(`LLM unavailable: ${reason}`);
    this.name = 'BudgetExhaustedError';
    this.code = 'BUDGET_EXHAUSTED';
  }
}

function getDebugLog(limit = 20) {
  return debugLog.slice(-limit).reverse();
}

/**
 * Snapshot an agent's current LLM usage counters.
 * Call before a cycle starts; diff with getAgentUsageDiff() after.
 */
function snapshotAgentUsage(agentName) {
  const agent = usage.byAgent[agentName];
  if (!agent) return { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  return { ...agent };
}

/**
 * Get the difference between current usage and a prior snapshot.
 */
function getAgentUsageDiff(agentName, snapshot) {
  const current = usage.byAgent[agentName] || { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  return {
    calls: current.calls - (snapshot.calls || 0),
    inputTokens: current.inputTokens - (snapshot.inputTokens || 0),
    outputTokens: current.outputTokens - (snapshot.outputTokens || 0),
    costUsd: current.costUsd - (snapshot.costUsd || 0),
  };
}

module.exports = { ask, askJson, getUsage, getDebugLog, isAvailable, getClient, trackUsage, snapshotAgentUsage, getAgentUsageDiff, BudgetExhaustedError, MODELS };
