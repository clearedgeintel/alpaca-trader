-- P2 of the 2026-06-03 fine-tune: disable the options module until the
-- stop/target ratio has independent validation.
--
-- Background. The honest-stats audit (commit 8fe98b5) plus a multiplier /
-- pnl% / stop-target audit of the options module produced this verdict:
--
--   - The 100× contract multiplier IS applied correctly at every site
--     (monitor.js:387, execution-agent.js:846, 1000).
--   - pnl_pct uses entry premium as the denominator, not underlying
--     notional. The percentage is correct.
--   - Stops and targets are enforced on the premium curve at the
--     documented 50% / 100% ratio in monitor.js:403-407.
--
-- The problem is structural, not implementation:
--
--   At the observed 20% option win rate:
--     EV/trade = 0.2 × 100% − 0.8 × 50% = −20% of premium per trade
--
--   Break-even requires ~33% win rate at 50/100. Below that, the ratio
--   is provably negative — every additional contract makes the book
--   worse on average.
--
-- The P1 commit (d70e8c8) made `option.scannable=false` actually mean
-- something — autonomous option BUYs are blocked at execution-agent's
-- unscannable-class veto. This migration completes the kill by clearing
-- any runtime override that has OPTIONS_ENABLED=true so the master
-- toggle in Settings reflects the off state, and Quick Trade rejects
-- option entries cleanly.
--
-- SELL/close path is untouched. Existing option positions continue to
-- be monitored and closed at stop / target / theta-decay as before.
--
-- To re-enable: don't flip OPTIONS_ENABLED back on. Validate the ratio
-- first — accumulate ≥ 30 option closes with a stop/target combination
-- that's positive-EV at the live win rate. Then turn it back on with
-- the validated parameters.

DELETE FROM runtime_config WHERE key = 'OPTIONS_ENABLED';

DO $$
DECLARE
  removed integer;
BEGIN
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE 'runtime_config: cleared % OPTIONS_ENABLED override(s). Code default (config.js) is now in effect: OPTIONS_ENABLED=false unless OPTIONS_ENABLED=true is set in .env.', removed;
END $$;
