const Anthropic = require('@anthropic-ai/sdk');
const { log, error } = require('../logger');

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
 * Send a message to Claude and get a response.
 *
 * @param {Object} options
 * @param {string} options.agentName - Which agent is calling (for tracking)
 * @param {string} options.systemPrompt - System prompt defining agent role
 * @param {string} options.userMessage - The analysis request
 * @param {string} [options.tier='fast'] - 'fast' (Haiku) or 'standard' (Sonnet)
 * @param {number} [options.maxTokens=1024] - Max response tokens
 * @returns {Promise<{text: string, inputTokens: number, outputTokens: number}>}
 */
async function ask({ agentName, systemPrompt, userMessage, tier = 'fast', maxTokens = 1024 }) {
  const model = MODELS[tier] || MODELS.fast;
  const anthropic = getClient();

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

    return { text, inputTokens, outputTokens };
  } catch (err) {
    error(`LLM call failed for ${agentName}`, err);
    throw err;
  }
}

/**
 * Send a message and parse JSON from the response.
 * Same params as ask(), but expects Claude to return valid JSON.
 */
async function askJson(options) {
  const result = await ask(options);

  try {
    // Extract JSON from response — handle markdown code blocks
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
  // Reset daily counters if date changed
  const today = new Date().toISOString().slice(0, 10);
  if (today !== usage.resetDate) {
    usage.totalInputTokens = 0;
    usage.totalOutputTokens = 0;
    usage.callCount = 0;
    usage.estimatedCostUsd = 0;
    usage.byAgent = {};
    usage.resetDate = today;
  }

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
}

function getUsage() {
  return { ...usage };
}

module.exports = { ask, askJson, getUsage, MODELS };
