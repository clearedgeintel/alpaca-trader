-- Phase 1 MVP: single-leg long calls/puts.
--
-- Adds option-specific columns to `trades` and `signals` so the
-- existing query/reporting surface keeps working unchanged for
-- equities/crypto. Every new column is NULLable — equity rows will
-- continue to insert without setting any of these.
--
-- option_type:        'call' | 'put' (NULL = not an option)
-- expiration_date:    contract expiration (NULL = not an option)
-- strike:             strike price in dollars
-- contract_multiplier: shares represented per contract (default 100)
-- delta/gamma/theta/vega/rho/iv: Greeks at entry (snapshot, not live)
-- underlying:         underlying equity symbol (e.g. 'AAPL') — useful
--                     for indexing/grouping without re-parsing OCC
--
-- A CHECK keeps the option_type domain valid. We do NOT enforce
-- "expiration_date IS NOT NULL when option_type IS NOT NULL" because
-- old rows pre-migration are equities and have NULL across the board;
-- application-level validation handles new option inserts.

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS option_type         TEXT
    CHECK (option_type IS NULL OR option_type IN ('call', 'put')),
  ADD COLUMN IF NOT EXISTS expiration_date     DATE,
  ADD COLUMN IF NOT EXISTS strike              NUMERIC(12, 4),
  ADD COLUMN IF NOT EXISTS contract_multiplier INTEGER DEFAULT 100,
  ADD COLUMN IF NOT EXISTS underlying          TEXT,
  ADD COLUMN IF NOT EXISTS delta               NUMERIC(7, 4),
  ADD COLUMN IF NOT EXISTS gamma               NUMERIC(8, 5),
  ADD COLUMN IF NOT EXISTS theta               NUMERIC(8, 5),
  ADD COLUMN IF NOT EXISTS vega                NUMERIC(8, 5),
  ADD COLUMN IF NOT EXISTS rho                 NUMERIC(8, 5),
  ADD COLUMN IF NOT EXISTS iv                  NUMERIC(7, 4);

-- Indexes scoped to non-null rows so equity queries don't pay any cost.
CREATE INDEX IF NOT EXISTS idx_trades_option_underlying
  ON trades(underlying) WHERE underlying IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trades_option_expiration
  ON trades(expiration_date) WHERE expiration_date IS NOT NULL;

-- Same shape on signals so the agency pipeline can persist option
-- decisions with their Greeks at the time of signal.
ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS option_type         TEXT
    CHECK (option_type IS NULL OR option_type IN ('call', 'put')),
  ADD COLUMN IF NOT EXISTS expiration_date     DATE,
  ADD COLUMN IF NOT EXISTS strike              NUMERIC(12, 4),
  ADD COLUMN IF NOT EXISTS underlying          TEXT,
  ADD COLUMN IF NOT EXISTS delta               NUMERIC(7, 4),
  ADD COLUMN IF NOT EXISTS iv                  NUMERIC(7, 4);

CREATE INDEX IF NOT EXISTS idx_signals_option_underlying
  ON signals(underlying) WHERE underlying IS NOT NULL;
