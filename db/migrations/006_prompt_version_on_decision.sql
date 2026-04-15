-- Link each orchestrator decision to the prompt version that produced
-- it. Enables A/B comparison: given N versions of the orchestrator
-- prompt, aggregate closed-trade outcomes per version and see which
-- one is actually making money.
--
-- Nullable so historical decisions (written before this column existed)
-- keep working. New decisions written after this migration runs will
-- carry the active version's id, or NULL when the orchestrator is
-- still using its hardcoded fallback prompt.

ALTER TABLE agent_decisions
  ADD COLUMN IF NOT EXISTS prompt_version_id UUID REFERENCES prompt_versions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_agent_decisions_prompt_version
  ON agent_decisions(prompt_version_id)
  WHERE prompt_version_id IS NOT NULL;
