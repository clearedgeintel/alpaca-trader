const { z } = require('zod');

const verdictSchema = z
  .object({
    signal: z.enum(['BUY', 'SELL', 'HOLD']),
    confidence: z.number().min(0).max(1),
    reasoning: z.string().optional(),
    patterns: z.array(z.string()).optional(),
    key_levels: z
      .object({
        nearest_support: z.number().nullable().optional(),
        nearest_resistance: z.number().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const technicalOutputSchema = z
  .object({
    verdicts: z.record(z.string(), verdictSchema).optional(),
  })
  .passthrough();

module.exports = { technicalOutputSchema, verdictSchema };
