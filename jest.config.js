/**
 * Jest configuration.
 *
 * Coverage thresholds are intentionally anchored slightly below current
 * measurements so CI catches regressions on files we've already tested,
 * without blocking on files not yet covered (executor.js, monitor.js,
 * llm.js — queued for Phase 1 follow-ups).
 *
 * Update thresholds upward as coverage grows. Never lower them.
 */

module.exports = {
  testEnvironment: 'node',
  collectCoverageFrom: [
    'src/**/*.js',
    '!src/index.js',        // entry point — harness + wiring
    '!src/swagger.js',      // swagger setup boilerplate
    '!src/ml-model.js',     // tensorflow model — covered separately
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'text-summary', 'html', 'lcov'],
  // Per-file floors — globs matched against collectCoverageFrom paths.
  // Do NOT lower these; raise them as coverage improves.
  coverageThreshold: {
    'src/agents/execution-agent.js': { statements: 70, branches: 50, functions: 65, lines: 70 },
    'src/agents/message-bus.js':      { statements: 90, branches: 85, functions: 80, lines: 95 },
    'src/agents/orchestrator.js':     { statements: 28, branches: 20, functions: 15, lines: 28 },
    'src/agents/risk-agent.js':       { statements: 20, branches: 12, functions: 22, lines: 20 },
    'src/middleware/validate.js':     { statements: 95, branches: 95, functions: 95, lines: 95 },
    'src/strategy.js':                { statements: 90, branches: 85, functions: 95, lines: 90 },
    'src/correlation.js':             { statements: 50, branches: 40, functions: 50, lines: 50 },
    'src/asset-classes.js':           { statements: 55, branches: 30, functions: 55, lines: 55 },
    'src/indicators.js':              { statements: 70, branches: 55, functions: 60, lines: 70 },
  },
};
