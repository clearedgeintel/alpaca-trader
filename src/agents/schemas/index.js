/**
 * Barrel re-export of LLM-output Zod schemas.
 *
 * Mirrors the pattern in src/middleware/validate.js (HTTP request
 * validation). Schemas are intentionally permissive on entry — every
 * object uses .passthrough() and most fields are .optional() — and
 * are tightened over time based on the llm_json_retries_total
 * {outcome="failure"} Prometheus counter.
 *
 * Consumers pass the schema into askJson({ schema }) — see
 * src/agents/llm.js for the retry-on-validation-failure protocol.
 */

const { orchestratorOutputSchema, decisionSchema } = require('./orchestrator-output');
const { technicalOutputSchema, verdictSchema } = require('./technical-output');
const { breakoutOutputSchema, breakoutVerdictSchema } = require('./breakout-output');
const { riskOutputSchema } = require('./risk-output');

module.exports = {
  orchestratorOutputSchema,
  decisionSchema,
  technicalOutputSchema,
  verdictSchema,
  breakoutOutputSchema,
  breakoutVerdictSchema,
  riskOutputSchema,
};
