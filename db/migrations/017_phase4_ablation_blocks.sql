-- v2 Phase 4 — ablation block tracking.
--
-- Phase 4 adds LLM agents back one at a time and compares EV/trade
-- per block against the rules-only baseline. To do that honestly we
-- need a timeline of which flags were active for each block so closed
-- trades can be attributed to the block they opened during.
--
-- Block windows are operator-driven (start/end via the Settings UI),
-- not derived from flag-change events — flags can drift mid-block for
-- legitimate operational reasons (cost-cap breaker, manual override)
-- and we want a clean intentional window for measurement, not a
-- flag-event log.
--
-- flag_snapshot captures the active flag values at block start so the
-- audit trail is self-contained: looking at any historical block tells
-- you exactly what was on without cross-referencing runtime_config
-- history. Schema for the snapshot is intentionally flexible (jsonb)
-- — flags get added/removed across phases and we don't want to migrate
-- this table every time.
--
-- ended_at NULL = block is currently active. Only one block can be
-- active at a time; starting a new block auto-closes the prior one
-- (the API enforces this — no DB trigger needed).

CREATE TABLE IF NOT EXISTS phase4_blocks (
  id            SERIAL PRIMARY KEY,
  label         TEXT NOT NULL,           -- '4a' / '4b' / '4c' / '4d' / '4e' / 'baseline' / custom
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at      TIMESTAMPTZ,             -- NULL = active
  flag_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lookup by active block (where ended_at IS NULL) — used on every
-- analytics request that needs to know the current window.
CREATE INDEX IF NOT EXISTS idx_phase4_blocks_active
  ON phase4_blocks (started_at DESC)
  WHERE ended_at IS NULL;

-- Timeline scan by label for cross-block comparisons (e.g. compare
-- the second 4a run vs the first 4a run when the operator re-ran a block).
CREATE INDEX IF NOT EXISTS idx_phase4_blocks_label_started
  ON phase4_blocks (label, started_at DESC);
