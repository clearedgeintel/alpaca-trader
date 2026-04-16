/**
 * Inter-agent debate — structured 1-round adversarial exchange between
 * dissenting agents before the orchestrator synthesizes.
 *
 * Protocol:
 *   1. Identify the majority signal (BUY vs SELL vs HOLD by count).
 *   2. Find dissenters — agents whose signal opposes the majority.
 *   3. For each dissenter: one Haiku call where the dissenter challenges
 *      the majority's best argument (highest-confidence supporter).
 *   4. The supporter gets one Haiku call to respond.
 *   5. The full transcript is returned so the orchestrator can weigh
 *      the arguments during synthesis.
 *
 * Cost: 2 × Haiku calls per dissenter. When all agents agree → zero
 * LLM calls. Typical cycle with 7 agents: 1-2 dissenters → 2-4 calls.
 *
 * Failures are silent — a failed debate round is logged and skipped;
 * the orchestrator still sees the raw reports.
 */

const { ask } = require('./llm');
const { log, error } = require('../logger');

const CHALLENGE_PROMPT = `You are an adversarial reviewer in a stock trading agency.
Another agent recommended a trade. You DISAGREE. Your job is to make the strongest
possible counter-argument in 2-3 sentences. Be specific — cite the indicators or
conditions that make their recommendation risky. Do NOT hedge or agree partially.`;

const RESPONSE_PROMPT = `You are defending your trade recommendation against a challenge.
Acknowledge the challenger's specific concern, then explain in 2-3 sentences why your
signal is still correct despite that risk. Cite concrete data (price levels, ratios,
volumes). If their point is valid, say so — but explain why the setup still works.`;

/**
 * Run a structured debate round between dissenting agents.
 *
 * @param {Object} agentReports — keyed by agent name, each with { signal, confidence, reasoning, data }
 * @returns {Promise<{ hasDissent, majority, debateRounds, summary }>}
 */
async function runDebate(agentReports) {
  const entries = Object.entries(agentReports).filter(([, r]) => r?.signal && r.signal !== 'HOLD');

  if (entries.length === 0) {
    return { hasDissent: false, majority: 'HOLD', debateRounds: [], summary: 'All agents HOLD — no debate needed.' };
  }

  // Count signals
  const counts = {};
  for (const [, r] of entries) {
    counts[r.signal] = (counts[r.signal] || 0) + 1;
  }
  const majority = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'HOLD';

  // Find dissenters (signal != majority) and supporters (signal == majority)
  const supporters = entries
    .filter(([, r]) => r.signal === majority)
    .sort((a, b) => (b[1].confidence || 0) - (a[1].confidence || 0));
  const dissenters = entries.filter(([, r]) => r.signal !== majority);

  if (dissenters.length === 0) {
    return {
      hasDissent: false,
      majority,
      debateRounds: [],
      summary: `All active agents agree on ${majority} — no debate needed.`,
    };
  }

  const topSupporter = supporters[0];
  if (!topSupporter) {
    return {
      hasDissent: true,
      majority,
      debateRounds: [],
      summary: `Dissent detected but no supporter to debate against.`,
    };
  }

  const debateRounds = [];

  // Cap at 3 debate rounds per cycle to bound LLM cost
  for (const [dissenterName, dissenterReport] of dissenters.slice(0, 3)) {
    const [supporterName, supporterReport] = topSupporter;
    try {
      // Dissenter challenges
      const challengeContext = [
        `You are "${dissenterName}" (signal: ${dissenterReport.signal}, confidence: ${(dissenterReport.confidence || 0).toFixed(2)}).`,
        `Your reasoning: ${dissenterReport.reasoning || 'none'}`,
        ``,
        `The majority signal is ${majority}. The strongest supporter is "${supporterName}" (confidence: ${(supporterReport.confidence || 0).toFixed(2)}):`,
        `"${supporterReport.reasoning || 'none'}"`,
        ``,
        `Challenge their recommendation:`,
      ].join('\n');

      const challengeResult = await ask({
        agentName: `debate-${dissenterName}`,
        systemPrompt: CHALLENGE_PROMPT,
        userMessage: challengeContext,
        tier: 'fast',
        maxTokens: 256,
      });

      // Supporter responds
      const responseContext = [
        `You are "${supporterName}" (signal: ${supporterReport.signal}, confidence: ${(supporterReport.confidence || 0).toFixed(2)}).`,
        `Your reasoning: ${supporterReport.reasoning || 'none'}`,
        ``,
        `"${dissenterName}" challenges you:`,
        `"${challengeResult.text}"`,
        ``,
        `Defend your position:`,
      ].join('\n');

      const responseResult = await ask({
        agentName: `debate-${supporterName}`,
        systemPrompt: RESPONSE_PROMPT,
        userMessage: responseContext,
        tier: 'fast',
        maxTokens: 256,
      });

      debateRounds.push({
        dissenter: dissenterName,
        dissenterSignal: dissenterReport.signal,
        challenge: challengeResult.text,
        responder: supporterName,
        responderSignal: supporterReport.signal,
        response: responseResult.text,
      });

      log(`Debate: ${dissenterName}(${dissenterReport.signal}) challenged ${supporterName}(${supporterReport.signal})`);
    } catch (err) {
      error(`Debate round failed: ${dissenterName} vs ${supporterName}`, err);
      debateRounds.push({
        dissenter: dissenterName,
        dissenterSignal: dissenterReport.signal,
        challenge: null,
        responder: supporterName,
        responderSignal: supporterReport.signal,
        response: null,
        error: err.message,
      });
    }
  }

  const summary =
    debateRounds.length > 0
      ? `${debateRounds.length} debate round(s): ${dissenters.map(([n]) => n).join(', ')} challenged ${topSupporter[0]}'s ${majority} recommendation.`
      : 'Debate attempted but all rounds failed.';

  return { hasDissent: true, majority, debateRounds, summary };
}

module.exports = { runDebate };
