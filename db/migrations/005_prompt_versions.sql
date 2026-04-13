-- Prompt versioning — track every prompt variant we ship so we can
-- A/B test and rollback without code changes.
--
-- One row per (agent_name, version); exactly one row per agent_name
-- has is_active = true at any time.
CREATE TABLE IF NOT EXISTS prompt_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name    TEXT NOT NULL,
  version       TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT false,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(agent_name, version)
);

CREATE INDEX IF NOT EXISTS idx_prompt_versions_agent
  ON prompt_versions(agent_name);

-- Enforce at most one active version per agent
CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_versions_active
  ON prompt_versions(agent_name)
  WHERE is_active;
