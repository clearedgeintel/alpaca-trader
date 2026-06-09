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
  // Schema-validation retry tracking — bumped from bumpRetryMetric().
  // Helps spot agents whose schema is too strict (the retry doubles
  // the call cost any time validation fails).
  jsonRetries: { success: 0, failure: 0, byAgent: {} },
  resetDate: new Date().toISOString().slice(0, 10),
};

// Debug log — circular buffer of recent LLM calls
const debugLog = [];
const MAX_DEBUG_LOG = 50;

// Circuit breaker state
let consecutiveFailures = 0;
let breakerOpenUntil = 0;
// One-shot guard for the prompt-cache health probe (see trackUsage). Set
// to true after the first 10 calls so we don't spam the log every cycle.
let _cacheCheckDone = false;
// Capture the last LLM error so the dashboard can surface the root cause
// instead of just "circuit breaker open". When zero tokens have charged
// and the breaker keeps tripping, this is the only way to see *why* —
// auth failure, model name typo, network drop, Anthropic outage, etc.
let lastLlmError = null;  // { message, name, status, agent, at }
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
    usage.cacheCreationTokens = 0;
    usage.cacheReadTokens = 0;
    usage.callCount = 0;
    usage.estimatedCostUsd = 0;
    usage.byAgent = {};
    usage.jsonRetries = { success: 0, failure: 0, byAgent: {} };
    usage.resetDate = today;
    // Re-arm the cache health probe so we re-check next day in case
    // an Anthropic-side change silently disables caching.
    _cacheCheckDone = false;
  }
}

/**
 * Normalize a system-prompt input into an array of content blocks
 * that Anthropic accepts. Supports three shapes:
 *   1. string                                 → single uncached text block
 *   2. array of { type: 'text', text, cache } → pass-through with optional
 *      cache marker converted to cache_control: { type: 'ephemeral' }
 *   3. array of strings                       → converted to text blocks;
 *      ALL strings get a cache breakpoint. Cumulative-prefix sizing means
 *      block #2 (the per-agent prompt) is still cacheable because the
 *      prefix is already past 4096 tokens thanks to the SHARED_PREAMBLE
 *      at block #1. Anthropic allows up to 4 breakpoints per request —
 *      we use 2 here, leaving headroom for callers that pass more layers.
 */
function normalizeSystemPrompt(systemPrompt) {
  if (typeof systemPrompt === 'string') return systemPrompt;
  if (!Array.isArray(systemPrompt)) return String(systemPrompt);
  return systemPrompt.map((block) => {
    if (typeof block === 'string') {
      return { type: 'text', text: block, cache_control: { type: 'ephemeral' } };
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
    lastLlmError = {
      message: err?.message || String(err),
      name: err?.name || 'Error',
      status: err?.status ?? err?.response?.status ?? null,
      agent: agentName,
      at: new Date().toISOString(),
    };
    error(`LLM call failed for ${agentName} (${consecutiveFailures} consecutive, retries exhausted)`, err);

    if (consecutiveFailures >= breakerFailures()) {
      breakerOpenUntil = Date.now() + BREAKER_COOLDOWN_MS;
      const msg = `Circuit breaker OPEN — ${consecutiveFailures} consecutive LLM failures. Cooldown ${BREAKER_COOLDOWN_MS / 1000}s. Last error: ${lastLlmError.message}`;
      warn(msg);
      require('../alerting').critical('LLM circuit breaker open', msg, {
        consecutiveFailures,
        cooldownMs: BREAKER_COOLDOWN_MS,
        lastError: lastLlmError,
      });
    }

    throw err;
  }
}

/**
 * Manually reset the circuit breaker. Use when the underlying cause has
 * been fixed (API key rotated, model name corrected, network restored)
 * and you don't want to wait the 5-min cooldown — or when the breaker
 * is stuck in a re-trip loop because every call after cooldown also fails.
 */
function resetBreaker() {
  const wasOpen = Date.now() < breakerOpenUntil;
  consecutiveFailures = 0;
  breakerOpenUntil = 0;
  return { wasOpen, lastError: lastLlmError };
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
    bumpRetryMetric(askOptions.agentName, 'failure', parseError);
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
  bumpRetryMetric(askOptions.agentName, 'failure', retryError);
  return { ...retryResult, data: null, parseError: retryError, retried: true };
}

function bumpRetryMetric(agent, outcome, parseError) {
  // In-memory counter (surfaced via getUsage so the dashboard sees it)
  if (outcome === 'success' || outcome === 'failure') {
    usage.jsonRetries[outcome] = (usage.jsonRetries[outcome] || 0) + 1;
    const a = agent || 'unknown';
    if (!usage.jsonRetries.byAgent[a]) usage.jsonRetries.byAgent[a] = { success: 0, failure: 0 };
    usage.jsonRetries.byAgent[a][outcome]++;
    // Capture the last parse error per-agent so the dashboard can show
    // *why* parsing failed instead of leaving the operator to guess from
    // call counts. Was added 2026-05-27 to diagnose a silent truncation
    // bug — TA was failing 111/111 cycles with no visible cause until
    // this surfaced "Unexpected end of JSON input".
    if (outcome === 'failure' && parseError) {
      usage.jsonRetries.byAgent[a].lastError = String(parseError).slice(0, 240);
      usage.jsonRetries.byAgent[a].lastErrorAt = new Date().toISOString();
    }
  }
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
    // Recovery: walk through tracking depth + a closing-char stack so
    // we can do synthetic close if needed. Two attempts:
    //   1. Balanced-bracket recovery — trim to last spot where depth=0
    //   2. Synthetic close — strip back to a safe point and append the
    //      missing closing brackets from the stack so partial responses
    //      still yield usable data.
    let depth = 0;
    let inStr = false;
    let escape = false;
    let lastValidEnd = -1;
    const closeStack = [];
    // Track every comma with its depth so the synthetic-close recovery can
    // pick the right strip point regardless of where the LLM truncated.
    // Previous version tracked only depth=1 commas, which missed the common
    // TA shape `{ "verdicts": { "AAPL": ..., "MSFT": ..., ... }` where the
    // inter-symbol commas live at depth=2.
    const commas = [];
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (escape) { escape = false; continue; }
      if (c === '\\') { escape = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') { depth++; closeStack.push('}'); }
      else if (c === '[') { depth++; closeStack.push(']'); }
      else if (c === '}' || c === ']') {
        depth--;
        closeStack.pop();
        if (depth === 0) lastValidEnd = i;
      } else if (c === ',') {
        commas.push({ pos: i, depth });
      }
    }
    if (lastValidEnd !== -1) {
      return JSON.parse(s.slice(0, lastValidEnd + 1));
    }
    // Synthetic close. Find the latest comma at any depth that's still
    // inside an open scope (depth <= eofDepth). Strip to just before it,
    // then close the still-open outer scopes. This salvages partial
    // results — e.g., TA with 14 complete verdicts + a 15th cut off
    // mid-string returns the 14 instead of throwing.
    if (closeStack.length > 0 && commas.length > 0) {
      const eofDepth = closeStack.length;
      let bestComma = null;
      for (let i = commas.length - 1; i >= 0; i--) {
        if (commas[i].depth <= eofDepth) {
          bestComma = commas[i];
          break;
        }
      }
      if (bestComma) {
        const trimmed = s.slice(0, bestComma.pos);
        // Close the outer N scopes that were still open at the strip
        // point. closeStack[0] is the outermost; we need indices
        // 0..(bestComma.depth-1) reversed to close innermost-first.
        const closesNeeded = closeStack
          .slice(0, bestComma.depth)
          .reverse()
          .join('');
        const synthetic = trimmed + closesNeeded;
        try {
          return JSON.parse(synthetic);
        } catch { /* synthetic close failed too */ }
      }
    }
    throw new Error(
      `Could not extract valid JSON (response ${s.length} chars, ` +
      `${closeStack.length} unclosed brackets, ends: "${s.slice(-50).replace(/\n/g, '\\n')}")`,
    );
  }
}

function trackUsage(agentName, model, inputTokens, outputTokens, cacheMeta = {}) {
  resetDailyIfNeeded();
  const { cacheCreationTokens = 0, cacheReadTokens = 0 } = cacheMeta;

  // Silent-cache-disable detector. Anthropic silently disables caching
  // when the cached prefix is below the model's minimum cacheable size —
  // the API returns 0 for both cache_creation_input_tokens and
  // cache_read_input_tokens with no error. Without this check, a one-
  // character preamble edit could double the bill and we'd never notice.
  //
  // Minimum cacheable-prefix sizes are per-model and change across model
  // generations. The numbers worth remembering:
  //   Claude 3 Haiku:    2048 tok (older — not in active use here)
  //   Claude 3.5 Sonnet: 1024 tok
  //   Claude 4.x family: 1024 tok (Opus 4.x, Sonnet 4.x, Haiku 4.5)
  // Current models (MODELS at the top of this file): Haiku 4.5 + Sonnet
  // 4.6 — both 1024-token minimum. SHARED_PREAMBLE is well above that
  // (~4K tokens) so caching should fire on every call. If this detector
  // EVER trips with the current preamble, suspect either a model swap to
  // an older Claude 3 Haiku (2048 tok requirement) or a preamble that's
  // been cut down. See https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
  // for the authoritative current thresholds.
  //
  // Warn ONCE per process if we hit 10 calls with zero cache activity.
  if (!_cacheCheckDone && usage.callCount >= 10) {
    _cacheCheckDone = true;
    if (usage.cacheCreationTokens === 0 && usage.cacheReadTokens === 0) {
      const reason = 'no cache_creation or cache_read tokens billed across first 10 calls — SHARED_PREAMBLE may be below the model cache threshold';
      warn(`PROMPT CACHE SILENTLY DISABLED: ${reason}. Expected ~10× higher input bill until fixed.`);
      try {
        require('../alerting').warn(
          'Prompt cache silently disabled',
          `${reason}. Check src/agents/prompts/shared-preamble.js — current Claude 4.x models need ≥ 1024 cached tokens; older Claude 3 Haiku needs ≥ 2048.`,
          { totalCalls: usage.callCount },
        );
      } catch { /* alerting optional */ }
    } else {
      log(
        `Prompt cache verified active: ${usage.cacheReadTokens.toLocaleString()} read tokens, ${usage.cacheCreationTokens.toLocaleString()} write tokens across ${usage.callCount} calls`,
      );
    }
  }

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
    consecutiveFailures,
    lastError: lastLlmError,
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
  resetBreaker,
  getClient,
  trackUsage,
  snapshotAgentUsage,
  getAgentUsageDiff,
  BudgetExhaustedError,
  MODELS,
};
