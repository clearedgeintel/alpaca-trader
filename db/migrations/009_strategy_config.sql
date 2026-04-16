-- Persistent storage for per-symbol strategy assignments and the
-- global default. Previously strategy overrides lived only in memory
-- and vanished on every restart — so setting "AAPL uses LLM-only" in
-- the UI was silently lost the next morning.
--
-- Two-row design:
--   - one row per symbol override (scope='symbol', key=<symbol>)
--   - one row for the global default (scope='default', key='__default__')
--
-- Intentionally simple: no foreign keys, no JSONB. Mode is always one
-- of 'rules' | 'llm' | 'hybrid'. A CHECK constraint enforces that.

CREATE TABLE IF NOT EXISTS strategy_config (
  scope       TEXT NOT NULL CHECK (scope IN ('symbol', 'default')),
  key         TEXT NOT NULL,
  mode        TEXT NOT NULL CHECK (mode IN ('rules', 'llm', 'hybrid')),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);

CREATE INDEX IF NOT EXISTS idx_strategy_config_scope
  ON strategy_config(scope);
