const { z } = require('zod');

// breakout-agent expects per-symbol verdicts with breakout-specific fields
const breakoutVerdictSchema = z
  .object({
    signal: z.enum(['BUY', 'SELL', 'HOLD']),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().optional(),
    breakout_type: z.string().optional(),
    target: z.number().nullable().optional(),
    stop: z.number().nullable().optional(),
  })
  .passthrough();

const breakoutOutputSchema = z
  .object({
    symbols: z.record(z.string(), breakoutVerdictSchema).optional(),
    verdicts: z.record(z.string(), breakoutVerdictSchema).optional(),
  })
  .passthrough();

module.exports = { breakoutOutputSchema, breakoutVerdictSchema };
