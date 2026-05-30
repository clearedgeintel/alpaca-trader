-- v2 Phase 2 Option D: reconcile production runtime_config drift.
--
-- Background (scripts/inspect-momentum-stop-config.js, 2026-05-29):
-- The runtime_config table accumulated overrides over weeks that
-- silently diverged from documented config.js defaults. Every time a
-- default was changed via code, the existing DB override kept the
-- prior value live in production — the code change was inert.
--
-- This migration deletes the now-redundant overrides AFTER the
-- companion commit aligned config.js defaults to match what was
-- actually running. Net production behavior is unchanged; the cleanup
-- makes "what's documented" == "what's running" so future maintainers
-- + audits have one source of truth.
--
-- For ORCHESTRATOR_MIN_CONFIDENCE specifically: we delete the 0.65
-- override so the 0.70 default (set 2026-05-21 per the floor revert)
-- takes effect. This IS a small live behavior change — slightly
-- tighter synthesis floor (0.65 → 0.70) — but the explicit decision
-- on Option A (Phase 2 Option D follow-up) was to land at 0.70 for
-- path-to-live discipline.

DELETE FROM runtime_config WHERE key IN (
  -- These overrides now equal the new defaults in config.js. No behavior change.
  'BREAKOUT_AGENT_ENABLED',
  'MEAN_REVERSION_AGENT_ENABLED',
  'MOMENTUM_STOP_PCT',
  'MOMENTUM_GAP_PCT',
  'MOMENTUM_MIN_VOLUME',
  'STOP_PCT',
  'TARGET_PCT',
  -- This one tightens the floor from 0.65 → 0.70. Intentional per Option A decision.
  'ORCHESTRATOR_MIN_CONFIDENCE'
);

-- Verify and surface what's left (visible in deploy logs):
DO $$
DECLARE
  remaining_count integer;
BEGIN
  SELECT COUNT(*) INTO remaining_count FROM runtime_config;
  RAISE NOTICE 'runtime_config rows remaining after 016 reconciliation: %', remaining_count;
END $$;
