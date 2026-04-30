const { z } = require('zod');

// Permissive schema — enums are strict, everything else is optional.
// Tighten over time based on llm_json_retries_total{outcome="failure"}.
const decisionSchema = z
  .object({
    symbol: z.string(),
    action: z.enum(['BUY', 'SELL', 'HOLD']),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().optional(),
    supporting_agents: z.array(z.string()).optional(),
    dissenting_agents: z.array(z.string()).optional(),
    size_adjustment: z.number().optional(),
    // Optional traceability fields when the LLM picks an OCC option
    // symbol. Executor doesn't depend on these (it parses the symbol),
    // but they help with logging and post-mortem analysis.
    option_type: z.enum(['call', 'put']).optional(),
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
