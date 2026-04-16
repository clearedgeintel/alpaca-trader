-- Prompt A/B shadow mode.
--
-- Extends the existing prompt-versioning tables with an is_shadow
-- flag: a prompt can now be `is_active` (one per agent, drives live
-- decisions) OR `is_shadow` (at most one per agent, runs in parallel
-- on every cycle but its output is never executed). Both live and
-- shadow decisions land in `agent_decisions`; execution filters by
-- `is_shadow = false`.
--
-- Linking back to the matching live row:
--   shadow_of → agent_decisions(id)  (NULL when the shadow produced
--   a decision for a symbol the live run didn't cover — useful on
--   its own for A/B analysis)
--
-- Partial unique index: at most one is_shadow=true per agent_name
-- (matches the existing is_active constraint shape from migration 005).

ALTER TABLE prompt_versions
  ADD COLUMN IF NOT EXISTS is_shadow BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_versions_shadow
  ON prompt_versions(agent_name)
  WHERE is_shadow;

ALTER TABLE agent_decisions
  ADD COLUMN IF NOT EXISTS is_shadow BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS shadow_of UUID REFERENCES agent_decisions(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_agent_decisions_shadow
  ON agent_decisions(is_shadow)
  WHERE is_shadow;

CREATE INDEX IF NOT EXISTS idx_agent_decisions_shadow_of
  ON agent_decisions(shadow_of)
  WHERE shadow_of IS NOT NULL;
