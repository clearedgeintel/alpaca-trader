const { z } = require('zod');

// Permissive — same rationale as technical-output.js. Coerce common
// LLM-formatting variations rather than retrying.

const signalLike = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
  z.string().optional(),
);

const confidenceLike = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
  z.number().optional(),
);

const breakoutVerdictSchema = z
  .object({
    signal: signalLike,
    confidence: confidenceLike,
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
