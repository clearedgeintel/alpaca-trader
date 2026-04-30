const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config');
const runtimeConfig = require('../runtime-config');
const { log, error, warn } = require('../logger');
const { retryWithBackoff } = require('../util/retry');
const { SHARED_PREAMBLE } = require('./prompts/shared-preamble');

// Effective cap — runtime override wins over static config
function costCap() {
  return runtimeConfig.get('LLM_DAILY_COST_CAP_USD') ?? config.LLM_DAILY_COST_CAP_USD;
}
function tokenCap() {
  return runtimeConfig.get('LLM_DAILY_TOKEN_CAP') ?? config.LLM_DAILY_TOKEN_CAP;
}
function breakerFailures() {
  return runtimeConfig.get('LLM_CIRCUIT_BREAKER_FAILURES') ?? config.LLM_CIRCUIT_BREAKER_FAILURES;
}

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
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
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

// Approximate pricing per 1M tokens (USD).
// cache_write = ~25% more than regular input; cache_read = ~10% of regular input.
const PRICING = {
  [MODELS.fast]: { input: 0.8, output: 4.0, cacheWrite: 1.0, cacheRead: 0.08 },
  [MODELS.standard]: { input: 3.0, output: 15.0, cacheWrite: 3.75, cacheRead: 0.3 },
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
  const cCap = costCap();
  const tCap = tokenCap();
  if (usage.estimatedCostUsd >= cCap) {
    return `daily cost cap reached ($${usage.estimatedCostUsd.toFixed(2)} >= $${cCap})`;
  }
  const totalTokens = usage.totalInputTokens + usage.totalOutputTokens;
  if (totalTokens >= tCap) {
    return `daily token cap reached (${totalTokens.toLocaleString()} >= ${tCap.toLocaleString()})`;
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
 * Normalize a system-prompt input into an array of content blocks
 * that Anthropic accepts. Supports three shapes:
 *   1. string                                 → single uncached text block
 *   2. array of { type: 'text', text, cache } → pass-through with optional
 *      cache marker converted to cache_control: { type: 'ephemeral' }
 *   3. array of strings                       → converted to text blocks;
 *      the FIRST string is cached (typical shared-preamble pattern)
 */
function normalizeSystemPrompt(systemPrompt) {
  if (typeof systemPrompt === 'string') return systemPrompt;
  if (!Array.isArray(systemPrompt)) return String(systemPrompt);
  return systemPrompt.map((block, i) => {
    if (typeof block === 'string') {
      // Convention: first string is the cached preamble
      return i === 0
        ? { type: 'text', text: block, cache_control: { type: 'ephemeral' } }
        : { type: 'text', text: block };
    }
    if (block && typeof block === 'object') {
      const { cache, ...rest } = block;
      const out = { type: rest.type || 'text', text: rest.text || rest.content || '' };
      if (cache || rest.cache_control) out.cache_control = rest.cache_control || { type: 'ephemeral' };
      return out;
    }
    return { type: 'text', text: String(block) };
  });
}

/**
 * Send a message to Claude and get a response.
 *
 * systemPrompt accepts:
 *   - string: single uncached block (legacy)
 *   - [preamble, suffix]: array of strings; preamble is marked cached
 *   - [{text, cache: true}, {text}]: explicit block form for fine control
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
  // Auto-prepend the shared cached preamble when given a plain-string prompt.
  // Callers wanting fine control over caching can pass an array directly.
  const promptWithPreamble = typeof systemPrompt === 'string' ? [SHARED_PREAMBLE, systemPrompt] : systemPrompt;
  const systemBlocks = normalizeSystemPrompt(promptWithPreamble);

  try {
    const response = await retryWithBackoff(
      () =>
        anthropic.messages.create({
          model,
          max_tokens: maxTokens,
          system: systemBlocks,
          messages: [{ role: 'user', content: userMessage }],
        }),
      {
        retries: 3,
        baseMs: 1000,
        maxMs: 15000,
        shouldRetry: isRetryableAnthropic,
        label: `llm ${agentName}`,
      },
    );

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    // Anthropic returns cache metrics in usage when prompt caching is active
    const cacheCreationTokens = response.usage?.cache_creation_input_tokens || 0;
    const cacheReadTokens = response.usage?.cache_read_input_tokens || 0;

    trackUsage(agentName, model, inputTokens, outputTokens, { cacheCreationTokens, cacheReadTokens });

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

    if (consecutiveFailures >= breakerFailures()) {
      breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
      const msg = `Circuit breaker OPEN — ${consecutiveFailures} consecutive LLM failures. Cooldown ${BREAKER_COOLDOWN_MS / 1000}s.`;
      warn(msg);
      require('../alerting').critical('LLM circuit breaker open', msg, {
        consecutiveFailures,
        cooldownMs: BREAKER_COOLDOWN_MS,
      });
    }

    throw err;
  }
}

/**
 * Send a message and parse JSON from the response.
 *
 * Optional `schema` (Zod) validates the parsed object's shape. If parsing
 * OR validation fails AND `retryOnce !== false`, we append a corrective
 * user message and call `ask` once more. The retry rate is tracked in
 * the `llm_json_retries_total` Prometheus counter so we can spot prompts
 * that consistently produce malformed output.
 *
 * Failure modes (after retry):
 *   - JSON parse failed         → { data: null, parseError }
 *   - Schema validation failed  → { data: null, schemaIssues }
 * Both are existing null-safe paths in the agents that consume `data`.
 */
async function askJson(options) {
  const { schema, retryOnce = true, ...askOptions } = options || {};
  const result = await ask(askOptions);

  const validate = (parsed) => {
    if (!schema) return { ok: true, data: parsed };
    const r = schema.safeParse(parsed);
    if (r.success) return { ok: true, data: r.data };
    return {
      ok: false,
      issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    };
  };

  let parseError = null;
  let parsed = null;
  try {
    parsed = extractJson(result.text);
  } catch (err) {
    parseError = err.message;
  }

  if (!parseError) {
    const v = validate(parsed);
    if (v.ok) return { ...result, data: v.data };
    parseError = `schema: ${v.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`;
  }

  // Retry once with a corrective message
  if (!retryOnce) {
    error(`LLM JSON failed for ${askOptions.agentName}: ${parseError}`);
    bumpRetryMetric(askOptions.agentName, 'failure');
    return { ...result, data: null, parseError };
  }

  const correctiveMessage =
    `${askOptions.userMessage}\n\nYour previous response failed validation: ${parseError.slice(0, 400)}\n` +
    `Return ONLY valid JSON matching the schema described in the system prompt. No prose, no fences.`;

  const retryResult = await ask({ ...askOptions, userMessage: correctiveMessage });

  let retryParsed = null;
  let retryError = null;
  try {
    retryParsed = extractJson(retryResult.text);
  } catch (err) {
    retryError = err.message;
  }

  if (!retryError) {
    const v2 = validate(retryParsed);
    if (v2.ok) {
      bumpRetryMetric(askOptions.agentName, 'success');
      return { ...retryResult, data: v2.data, retried: true };
    }
    retryError = `schema: ${v2.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`;
  }

  error(
    `LLM JSON retry failed for ${askOptions.agentName}: first=${parseError}, retry=${retryError}. Raw retry text (first 200): ${retryResult.text.slice(0, 200)}`,
  );
  bumpRetryMetric(askOptions.agentName, 'failure');
  return { ...retryResult, data: null, parseError: retryError, retried: true };
}

function bumpRetryMetric(agent, outcome) {
  try {
    const m = require('../metrics');
    m.llmJsonRetriesTotal?.inc({ agent: agent || 'unknown', outcome });
  } catch {
    /* metrics optional */
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
      if (escape) {
        escape = false;
        continue;
      }
      if (c === '\\') {
        escape = true;
        continue;
      }
      if (c === '"') {
        inStr = !inStr;
        continue;
      }
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

function trackUsage(agentName, model, inputTokens, outputTokens, cacheMeta = {}) {
  resetDailyIfNeeded();
  const { cacheCreationTokens = 0, cacheReadTokens = 0 } = cacheMeta;

  usage.totalInputTokens += inputTokens;
  usage.totalOutputTokens += outputTokens;
  usage.cacheCreationTokens += cacheCreationTokens;
  usage.cacheReadTokens += cacheReadTokens;
  usage.callCount++;

  const pricing = PRICING[model] || PRICING[MODELS.fast];
  const cost =
    (inputTokens * pricing.input +
      outputTokens * pricing.output +
      cacheCreationTokens * (pricing.cacheWrite || pricing.input) +
      cacheReadTokens * (pricing.cacheRead || pricing.input * 0.1)) /
    1_000_000;
  usage.estimatedCostUsd += cost;

  if (!usage.byAgent[agentName]) {
    usage.byAgent[agentName] = {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
    };
  }
  const agentUsage = usage.byAgent[agentName];
  agentUsage.calls++;
  agentUsage.inputTokens += inputTokens;
  agentUsage.outputTokens += outputTokens;
  agentUsage.cacheCreationTokens += cacheCreationTokens;
  agentUsage.cacheReadTokens += cacheReadTokens;
  agentUsage.costUsd += cost;

  // Prometheus — lazy-require to avoid a circular hop at startup
  try {
    const metrics = require('../metrics');
    metrics.llmCallsTotal.inc({ agent: agentName, model });
    if (inputTokens) metrics.llmTokensTotal.inc({ direction: 'input' }, inputTokens);
    if (outputTokens) metrics.llmTokensTotal.inc({ direction: 'output' }, outputTokens);
    if (cacheReadTokens) metrics.llmTokensTotal.inc({ direction: 'cache_read' }, cacheReadTokens);
    if (cacheCreationTokens) metrics.llmTokensTotal.inc({ direction: 'cache_write' }, cacheCreationTokens);
    if (cost > 0) metrics.llmCostUsdTotal.inc(cost);
  } catch {
    /* metrics module failed to load; skip */
  }

  const cacheInfo =
    cacheReadTokens > 0 || cacheCreationTokens > 0
      ? ` (cache: ${cacheReadTokens} read, ${cacheCreationTokens} write)`
      : '';
  const totalTokensToday = usage.totalInputTokens + usage.totalOutputTokens;
  const cCap = costCap();
  const tCap = tokenCap();
  const costPct = ((usage.estimatedCostUsd / cCap) * 100).toFixed(0);
  const tokenPct = ((totalTokensToday / tCap) * 100).toFixed(0);
  log(
    `LLM usage [${agentName}]: ${inputTokens}in/${outputTokens}out tokens${cacheInfo}, $${cost.toFixed(4)} (daily: $${usage.estimatedCostUsd.toFixed(4)}/$${cCap} [${costPct}%] · ${totalTokensToday.toLocaleString()}/${tCap.toLocaleString()} tokens [${tokenPct}%])`,
  );

  // Alert when approaching budget
  if (usage.estimatedCostUsd >= cCap * 0.8 && usage.estimatedCostUsd - cost < cCap * 0.8) {
    require('../alerting').warn(
      'LLM daily cost at 80% of cap',
      `Spend today $${usage.estimatedCostUsd.toFixed(2)} / $${cCap} — agents will pause when cap is reached.`,
      { costUsd: usage.estimatedCostUsd, capUsd: cCap },
    );
  }
}

function getUsage() {
  const unavailableReason = getUnavailableReason();
  return {
    ...usage,
    circuitBreakerOpen: Date.now() < breakerOpenUntil,
    breakerOpenUntil: breakerOpenUntil > Date.now() ? new Date(breakerOpenUntil).toISOString() : null,
    dailyCostCapUsd: costCap(),
    dailyTokenCap: tokenCap(),
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

module.exports = {
  ask,
  askJson,
  getUsage,
  getDebugLog,
  isAvailable,
  getUnavailableReason,
  getClient,
  trackUsage,
  snapshotAgentUsage,
  getAgentUsageDiff,
  BudgetExhaustedError,
  MODELS,
};
