const { z } = require('zod');

// Permissive — coerce common LLM-formatting variations. Strict enum +
// number-in-range on a per-decision shape used to cause retries that
// doubled the Sonnet bill any time the LLM emitted lowercase actions
// or a string confidence on a single decision.

const actionLike = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
  z.string().optional(),
);

const confidenceLike = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
  z.number().optional(),
);

const optionTypeLike = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
  z.string().optional(),
);

const decisionSchema = z
  .object({
    symbol: z.string(),
    action: actionLike,
    confidence: confidenceLike,
    reasoning: z.string().optional(),
    supporting_agents: z.array(z.string()).optional(),
    dissenting_agents: z.array(z.string()).optional(),
    size_adjustment: z.number().optional(),
    // Optional traceability fields when the LLM picks an OCC option
    // symbol. Executor doesn't depend on these (it parses the symbol),
    // but they help with logging and post-mortem analysis.
    option_type: optionTypeLike,
    target_expiration: z.string().optional(),
    target_strike: z.number().optional(),
  })
  .passthrough();

const orchestratorOutputSchema = z
  .object({
    decisions: z.array(decisionSchema).optional(),
    portfolio_summary: z.string().optional(),
  })
  .passthrough();

module.exports = { orchestratorOutputSchema, decisionSchema };
