-- Phase 2 migration: trailing stops, order type tracking
ALTER TABLE trades ADD COLUMN IF NOT EXISTS trailing_stop  NUMERIC(12,4);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS highest_price  NUMERIC(12,4);
ALTER TABLE trades ADD COLUMN IF NOT EXISTS order_type     TEXT DEFAULT 'market';
