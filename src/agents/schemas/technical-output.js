const { z } = require('zod');

// Permissive verdict shape — the original strict version (enum + required
// number-in-range) caused frequent retries because LLMs occasionally
// return lowercase signals, string confidences ("0.65"), or omit
// confidence on a symbol. Each retry doubles the call cost on a
// batched-per-symbol agent like technical-analysis. We coerce common
// shapes and let the consumer agent decide what to do with edge values.

const signalLike = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toUpperCase() : v),
  z.string().optional(),
);

const confidenceLike = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
  z.number().optional(),
);

const verdictSchema = z
  .object({
    signal: signalLike,
    confidence: confidenceLike,
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
