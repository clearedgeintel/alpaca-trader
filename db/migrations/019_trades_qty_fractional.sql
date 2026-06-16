-- Widen trades.qty from INTEGER to NUMERIC so fractional shares can land.
--
-- Operator hit this in the wild on 2026-06-16 when the positions
-- reconciler tried to INSERT 8 Alpaca positions with fractional qtys
-- (AMD=0.0666, LYFT=6.6982, RXT=1.4567, etc) and every one failed
-- with "invalid input syntax for type integer: \"0.0666\"".
--
-- This was always a latent bug — the bot's own execution-agent INSERT
-- on the FRACTIONAL_SHARES_ENABLED path would have hit the same
-- constraint, but most operators never enabled that flag before the
-- small-account fixes landed in early June. Crypto qty (also fractional)
-- happened to round to whole numbers in practice on the larger account.
-- The bug surfaced when reconciling Alpaca's already-fractional positions
-- on a small account.
--
-- NUMERIC(14, 6) matches the precision the asset-classes config uses:
--   us_equity / etf with FRACTIONAL_SHARES_ENABLED: 4 decimals
--   crypto: 6 decimals
--   options: integer (no truncation since values are whole anyway)
--
-- Cast is non-destructive: existing INTEGER values become e.g. 100.000000
-- which is the same number, just stored differently. No data loss.
-- The constraint stays NOT NULL.

ALTER TABLE trades ALTER COLUMN qty TYPE NUMERIC(14, 6);

-- original_qty has the same problem — added in migration 011 for the
-- scale-in feature, also INT-typed. Same widening so scale-in entries
-- on fractional positions can record their starting size honestly.
-- ALTER COLUMN ... TYPE only runs if the column exists; older deploys
-- that haven't applied 011 yet will skip silently via the DO block.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'trades' AND column_name = 'original_qty'
  ) THEN
    EXECUTE 'ALTER TABLE trades ALTER COLUMN original_qty TYPE NUMERIC(14, 6)';
  END IF;
END $$;

-- Verify + log so deploy output makes it clear the column type changed.
DO $$
DECLARE
  col_type text;
BEGIN
  SELECT data_type INTO col_type
    FROM information_schema.columns
   WHERE table_name = 'trades' AND column_name = 'qty';
  RAISE NOTICE 'trades.qty type after migration: %', col_type;
END $$;
