-- MAE/MFE per-trade attribution. Phase 2 measurement prereq for the
-- path-to-live v2 roadmap.
--
-- mae_pct: max-adverse-excursion as a signed % of entry — the WORST
--   unrealized loss (most negative) the trade reached during its life.
--   Compared to stop_pct, it tells us whether stops are well-placed:
--     - mae_pct cluster ≈ stop_pct → stops catching real exits
--     - mae_pct cluster >> stop_pct (more negative) → stops being
--       picked off by noise then continuing to win — too tight
--     - mae_pct cluster << stop_pct (less negative) → stops too wide,
--       not protecting capital
--
-- mfe_pct: max-favorable-excursion as a signed % of entry — the BEST
--   unrealized gain the trade reached. Compared to target_pct (and
--   the actual exit), tells us if we're giving back too much profit.
--
-- Both default to 0 for existing rows (no retro back-fill — we don't
-- have intra-trade tick history stored). Monitor populates going
-- forward on every cycle via a triangle-inequality-safe MIN/MAX update.

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS mae_pct NUMERIC(8, 4) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mfe_pct NUMERIC(8, 4) DEFAULT 0;

-- Index for the retro card's per-setup MAE/MFE aggregation queries
CREATE INDEX IF NOT EXISTS idx_trades_strategy_pool_status
  ON trades (strategy_pool, status);
