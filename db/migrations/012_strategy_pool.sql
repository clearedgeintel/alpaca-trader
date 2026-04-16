-- Multi-strategy attribution — tag each trade with the "pool" it
-- belongs to so we can track per-strategy performance.
--
-- Pools are derived from which specialized agent supported the
-- orchestrator's decision most strongly. Examples:
--   - 'breakout'        → breakout-agent was top supporter
--   - 'mean_reversion'  → mean-reversion was top supporter
--   - 'technical'       → technical-analysis was top supporter
--   - 'news'            → news-sentinel was top supporter
--   - 'fallback'        → rule-based fallback (LLM unavailable)
--   - 'unknown'         → pre-migration trades or no clear supporter

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS strategy_pool TEXT;

CREATE INDEX IF NOT EXISTS idx_trades_strategy_pool
  ON trades(strategy_pool)
  WHERE strategy_pool IS NOT NULL;
