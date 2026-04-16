-- Smart position scaling — add-to-winners tracking fields.
--
-- scale_ins_count: how many times we've added to this position (0 = no scaling).
-- last_scale_in_price: the price at which the most recent scale-in was placed
--   (used to guard against re-triggering at the same level within a cycle).
-- original_qty: qty at trade open before any scale-ins; lets the UI show
--   "scaled 2× from 100 to 150" for transparency.

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS scale_ins_count INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_scale_in_price NUMERIC(10,4),
  ADD COLUMN IF NOT EXISTS original_qty INT;
