#!/usr/bin/env node
/**
 * Option D — find out why production uses -5% momentum stops, not the
 * documented -15%. Three hypotheses to test:
 *
 *   1. Runtime-config override: MOMENTUM_STOP_PCT may have been set to
 *      0.05 in the runtime_config table.
 *   2. Risk-agent adjustments leaking through: execution-agent's
 *      momentum branch is *supposed* to ignore riskResult.adjustments.
 *      stop_pct, but if it doesn't, that'd explain the override.
 *   3. Trades created with different stop logic at the time (history).
 *
 * This script dumps:
 *   - Current runtime_config rows for MOMENTUM_STOP_PCT (or any related)
 *   - Any agent_decisions on momentum symbols showing size_adjustment
 *     or stop_pct in the inputs
 *   - The full execution flow we'd need to read to rule out #2
 */

require('dotenv').config();
const db = require('../src/db');

async function main() {
  console.log('\n=== Runtime-config rows for momentum-related keys ===\n');
  const { rows: cfg } = await db.query(
    `SELECT key, value, updated_at
       FROM runtime_config
      WHERE key LIKE 'MOMENTUM_%' OR key LIKE '%STOP%' OR key = 'STOP_PCT'
      ORDER BY key`,
  );
  if (cfg.length === 0) {
    console.log('(no momentum/stop runtime overrides set)');
  } else {
    for (const row of cfg) {
      console.log(`  ${row.key.padEnd(30)} = ${String(row.value).padEnd(15)} (updated ${row.updated_at})`);
    }
  }

  console.log('\n=== All runtime_config rows (for context) ===\n');
  const { rows: all } = await db.query(
    `SELECT key, value FROM runtime_config ORDER BY key`,
  );
  for (const row of all) {
    console.log(`  ${row.key.padEnd(30)} = ${row.value}`);
  }

  // Did momentum stops change over time? Pull stop% by week.
  console.log('\n=== Momentum stop% by week (last 12 weeks) ===\n');
  const { rows: weekly } = await db.query(
    `SELECT date_trunc('week', created_at) AS week,
            COUNT(*) AS n,
            ROUND(AVG((stop_loss - entry_price) / entry_price * 100)::numeric, 2) AS avg_stop_pct,
            ROUND(MIN((stop_loss - entry_price) / entry_price * 100)::numeric, 2) AS min_stop_pct,
            ROUND(MAX((stop_loss - entry_price) / entry_price * 100)::numeric, 2) AS max_stop_pct
       FROM trades
      WHERE strategy_pool = 'momentum'
        AND status = 'closed'
        AND option_type IS NULL
        AND created_at >= NOW() - INTERVAL '12 weeks'
      GROUP BY 1
      ORDER BY 1 DESC`,
  );
  if (weekly.length === 0) {
    console.log('(no momentum trades in the last 12 weeks)');
  } else {
    for (const row of weekly) {
      console.log(
        `  ${row.week.toISOString().slice(0, 10)}  n=${String(row.n).padStart(3)}  ` +
        `avg=${row.avg_stop_pct}%  min=${row.min_stop_pct}%  max=${row.max_stop_pct}%`,
      );
    }
  }

  // Was MOMENTUM_STOP_PCT ever set in runtime_config? Check audit log if any
  console.log('\n=== Conclusion checklist ===\n');
  const momKey = cfg.find((r) => r.key === 'MOMENTUM_STOP_PCT');
  if (momKey) {
    const stopVal = parseFloat(momKey.value);
    if (stopVal && Math.abs(stopVal - 0.05) < 0.005) {
      console.log('  ✅ FOUND IT: MOMENTUM_STOP_PCT runtime override = ' + momKey.value);
      console.log('     This is the cause. Either clear the override (DELETE runtime_config row)');
      console.log('     OR document that 5% is intentional and update the default in config.js.');
    } else if (stopVal && Math.abs(stopVal - 0.15) < 0.005) {
      console.log('  ⚠ MOMENTUM_STOP_PCT runtime override IS set, but to 0.15 (the documented default).');
      console.log('     The -5% in DB must come from somewhere else (risk-agent or code path).');
    } else {
      console.log(`  ⚠ MOMENTUM_STOP_PCT runtime override = ${momKey.value}, not 0.05 or 0.15.`);
      console.log('     Unexpected. Investigate what value this is and why.');
    }
  } else {
    console.log('  ❌ No runtime override for MOMENTUM_STOP_PCT.');
    console.log('     The -5% momentum stop in DB is NOT coming from runtime_config.');
    console.log('     Suspect a code path — read execution-agent.js momentum branch carefully.');
    console.log('     Likely: risk-agent.evaluate() returns adjustments.stop_pct, and the');
    console.log('     momentum branch is leaking that adjustment through despite the comment');
    console.log('     saying it should be ignored.');
  }
  console.log('');
}

main()
  .catch((err) => {
    console.error('inspect-momentum-stop-config failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await db.close(); } catch { /* ignore */ }
  });
