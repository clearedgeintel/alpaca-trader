#!/usr/bin/env tsx
/**
 * Honest-stats CLI — runs the analyzer against a /api/trades CSV export.
 *
 * Usage:
 *   npx tsx scripts/honest-stats.ts trades_2026-06-04.csv
 *
 * The library lives at src/lib/honest-stats.ts; this file is just argv parsing
 * plus the formatted-report dump. Keeping the lib I/O-free lets jest test it
 * directly without spinning up a process.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { analyze, loadTradesCsv, formatReport } = require('../src/lib/honest-stats');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('node:path');

function main(): void {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: npx tsx scripts/honest-stats.ts <trades.csv>');
    process.exit(1);
  }
  const abs = path.resolve(arg);
  try {
    const trades = loadTradesCsv(abs);
    const report = analyze(trades);
    console.log(formatReport(report));
  } catch (err: any) {
    console.error(`honest-stats failed: ${err.message || err}`);
    process.exit(1);
  }
}

// Robust CLI guard — matches by basename so it survives bundling / renames.
// The prior version (endsWith('.ts')) would break the moment anything compiled
// this file or moved it under dist/.
if (process.argv[1] && path.basename(process.argv[1]) === 'honest-stats.ts') {
  main();
}
