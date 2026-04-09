-- Runtime config table for hot-reloadable settings
CREATE TABLE IF NOT EXISTS runtime_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now()
);
