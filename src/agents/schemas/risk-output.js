const { z } = require('zod');

// risk-agent's narrative assessment — kept very permissive since the
// orchestrator and execution-agent only consume a few fields.
const riskOutputSchema = z
  .object({
    narrative: z.string().optional(),
    portfolio_heat: z.number().min(0).optional(),
    concerns: z.array(z.string()).optional(),
    recommendations: z.array(z.string()).optional(),
    veto: z.boolean().optional(),
    veto_reason: z.string().optional(),
  })
  .passthrough();

module.exports = { riskOutputSchema };
