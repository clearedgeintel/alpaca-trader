const { z } = require('zod');

/**
 * Express middleware factory — validates req.body against a Zod schema.
 * On failure, sends a 400 with { success: false, error, issues }.
 * On success, replaces req.body with the parsed (possibly coerced) value.
 */
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request body',
        issues: result.error.issues.map(i => ({
          path: i.path.join('.'),
          message: i.message,
          code: i.code,
        })),
      });
    }
    req.body = result.data;
    next();
  };
}

// ---- Shared schemas ----

const symbolSchema = z.string().trim().toUpperCase().min(1).max(10);

// ---- Per-endpoint schemas ----

const schemas = {
  // POST /api/chat
  chat: z.object({
    question: z.string().trim().min(1, 'question is required').max(4000),
    sessionId: z.string().max(128).optional(),
  }),

  // POST /api/backtest
  backtest: z.object({
    symbols: z.array(symbolSchema).max(50).optional(),
    days: z.number().int().min(7).max(365).optional(),
    riskPct: z.number().min(0.001).max(0.2).optional(),
    stopPct: z.number().min(0.005).max(0.2).optional(),
    targetPct: z.number().min(0.01).max(0.5).optional(),
    trailingAtrMult: z.number().min(0.5).max(10).optional(),
    startingCapital: z.number().positive().max(10_000_000).optional(),
    slippagePct: z.number().min(0).max(0.05).optional(),
    feePerShare: z.number().min(0).max(1).optional(),
    feePerOrder: z.number().min(0).max(100).optional(),
  }),

  // POST /api/backtest/walk-forward
  walkForward: z.object({
    symbols: z.array(symbolSchema).max(50).optional(),
    days: z.number().int().min(30).max(730).optional(),
    windowDays: z.number().int().min(15).max(180).optional(),
    trainPct: z.number().min(0.3).max(0.9).optional(),
    stepDays: z.number().int().min(5).max(60).optional(),
    riskPct: z.number().min(0.001).max(0.2).optional(),
    stopPct: z.number().min(0.005).max(0.2).optional(),
    targetPct: z.number().min(0.01).max(0.5).optional(),
    trailingAtrMult: z.number().min(0.5).max(10).optional(),
    slippagePct: z.number().min(0).max(0.05).optional(),
    feePerShare: z.number().min(0).max(1).optional(),
    feePerOrder: z.number().min(0).max(100).optional(),
  }),

  // POST /api/backtest/monte-carlo
  monteCarlo: z.object({
    symbols: z.array(symbolSchema).max(50).optional(),
    days: z.number().int().min(7).max(365).optional(),
    iterations: z.number().int().min(5).max(200).optional(),
    riskPct: z.number().min(0.001).max(0.2).optional(),
    stopPct: z.number().min(0.005).max(0.2).optional(),
    targetPct: z.number().min(0.01).max(0.5).optional(),
    trailingAtrMult: z.number().min(0.5).max(10).optional(),
    slippagePct: z.number().min(0).max(0.05).optional(),
    feePerShare: z.number().min(0).max(1).optional(),
    feePerOrder: z.number().min(0).max(100).optional(),
  }),

  // POST /api/watchlist
  watchlistAdd: z.object({
    symbol: symbolSchema,
  }),

  // PUT /api/strategies/:symbol
  strategyForSymbol: z.object({
    mode: z.enum(['rules', 'llm', 'hybrid']),
  }),

  // PUT /api/strategies  (default)
  defaultStrategy: z.object({
    default: z.enum(['rules', 'llm', 'hybrid']),
  }),

  // PUT /api/runtime-config/:key
  runtimeConfigSet: z.object({
    // value is untyped-flexible (numbers, strings, arrays for WATCHLIST, etc.)
    // but must be present — runtime-config.set rejects undefined anyway
    value: z.union([z.string(), z.number(), z.array(z.string()), z.boolean()]),
  }),

  // POST /api/config/import
  configImport: z.object({
    strategies: z.object({
      default: z.enum(['rules', 'llm', 'hybrid']).optional(),
      overrides: z.record(z.string(), z.enum(['rules', 'llm', 'hybrid'])).optional(),
    }).optional(),
    watchlist: z.array(symbolSchema).optional(),
  }).passthrough(), // allow forward-compatible extra fields
};

module.exports = { validateBody, schemas, symbolSchema };
