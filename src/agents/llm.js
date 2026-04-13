const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const { log, error, warn, alert } = require('../logger');
const { retryWithBackoff } = require('../util/retry');

function isRetryableAnthropic(err) {
  // Typed SDK errors
  if (Anthropic.RateLimitError && err instanceof Anthropic.RateLimitError) return true;
  if (Anthropic.APIConnectionError && err instanceof Anthropic.APIConnectionError) return true;
  // Fallback: inspect status field
  const status = err?.status ?? err?.response?.status;
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

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
  return getUnavailableReason() === null;
}

function getUnavailableReason() {
  resetDailyIfNeeded();
  if (usage.estimatedCostUsd >= config.LLM_DAILY_COST_CAP_USD) {
    return `daily cost cap reached ($${usage.estimatedCostUsd.toFixed(2)} >= $${config.LLM_DAILY_COST_CAP_USD})`;
  }
  const totalTokens = usage.totalInputTokens + usage.totalOutputTokens;
  if (totalTokens >= config.LLM_DAILY_TOKEN_CAP) {
    return `daily token cap reached (${totalTokens.toLocaleString()} >= ${config.LLM_DAILY_TOKEN_CAP.toLocaleString()})`;
  }
  if (Date.now() < breakerOpenUntil) {
    const secsLeft = Math.ceil((breakerOpenUntil - Date.now()) / 1000);
    return `circuit breaker open (${secsLeft}s remaining)`;
  }
  return null;
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
  const unavailableReason = getUnavailableReason();
  if (unavailableReason) {
    warn(`LLM unavailable for ${agentName}: ${unavailableReason}`);
    throw new BudgetExhaustedError(unavailableReason);
  }

  const model = MODELS[tier] || MODELS.fast;
  const anthropic = getClient();
  const callStart = Date.now();

  try {
    const response = await retryWithBackoff(() => anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    }), {
      retries: 3,
      baseMs: 1000,
      maxMs: 15000,
      shouldRetry: isRetryableAnthropic,
      label: `llm ${agentName}`,
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

    // Only increment breaker after retries exhausted (happens once per user-visible failure)
    consecutiveFailures++;
    error(`LLM call failed for ${agentName} (${consecutiveFailures} consecutive, retries exhausted)`, err);

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
    const parsed = extractJson(result.text);
    return { ...result, data: parsed };
  } catch (err) {
    error(`LLM JSON parse failed for ${options.agentName}: ${err.message}. Raw text (first 200 chars): ${result.text.slice(0, 200)}`);
    return { ...result, data: null, parseError: err.message };
  }
}

/**
 * Robust JSON extraction from LLM responses.
 * Handles: raw JSON, code-fenced JSON, partial fences (truncated output),
 * and text-prefixed JSON.
 */
function extractJson(text) {
  let s = text.trim();

  // Try fenced block first
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    return JSON.parse(fenceMatch[1].trim());
  }

  // Try fenced block with no closing fence (truncated response)
  const openFence = s.match(/```(?:json)?\s*([\s\S]*)$/);
  if (openFence) {
    s = openFence[1].trim();
  }

  // Find the first { or [ and try to parse from there
  const objStart = s.indexOf('{');
  const arrStart = s.indexOf('[');
  let start = -1;
  if (objStart !== -1 && arrStart !== -1) start = Math.min(objStart, arrStart);
  else if (objStart !== -1) start = objStart;
  else if (arrStart !== -1) start = arrStart;

  if (start === -1) throw new Error('No JSON object/array found in response');
  s = s.slice(start);

  // Try parsing as-is
  try {
    return JSON.parse(s);
  } catch {
    // Truncated — try trimming back to last complete object
    // Find the last } or ] that balances
    let depth = 0;
    let inStr = false;
    let escape = false;
    let lastValidEnd = -1;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) lastValidEnd = i;
      }
    }
    if (lastValidEnd !== -1) {
      return JSON.parse(s.slice(0, lastValidEnd + 1));
    }
    throw new Error('Could not extract valid JSON');
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
  const unavailableReason = getUnavailableReason();
  return {
    ...usage,
    circuitBreakerOpen: Date.now() < breakerOpenUntil,
    breakerOpenUntil: breakerOpenUntil > Date.now() ? new Date(breakerOpenUntil).toISOString() : null,
    dailyCostCapUsd: config.LLM_DAILY_COST_CAP_USD,
    dailyTokenCap: config.LLM_DAILY_TOKEN_CAP,
    available: unavailableReason === null,
    unavailableReason,
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

module.exports = { ask, askJson, getUsage, getDebugLog, isAvailable, getUnavailableReason, getClient, trackUsage, snapshotAgentUsage, getAgentUsageDiff, BudgetExhaustedError, MODELS };
