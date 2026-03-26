CREATE TABLE IF NOT EXISTS signals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol        TEXT NOT NULL,
  signal        TEXT NOT NULL CHECK (signal IN ('BUY', 'SELL')),
  reason        TEXT,
  close         NUMERIC(12,4),
  ema9          NUMERIC(12,6),
  ema21         NUMERIC(12,6),
  rsi           NUMERIC(6,2),
  volume        BIGINT,
  avg_volume    BIGINT,
  volume_ratio  NUMERIC(6,2),
  acted_on      BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_signals_symbol  ON signals(symbol);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at DESC);

CREATE TABLE IF NOT EXISTS trades (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol          TEXT NOT NULL,
  alpaca_order_id TEXT,
  side            TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  qty             INTEGER NOT NULL,
  entry_price     NUMERIC(12,4),
  current_price   NUMERIC(12,4),
  stop_loss       NUMERIC(12,4),
  take_profit     NUMERIC(12,4),
  order_value     NUMERIC(14,2),
  risk_dollars    NUMERIC(10,2),
  status          TEXT DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  exit_price      NUMERIC(12,4),
  pnl             NUMERIC(12,2),
  pnl_pct         NUMERIC(8,4),
  exit_reason     TEXT,
  signal_id       UUID REFERENCES signals(id),
  created_at      TIMESTAMPTZ DEFAULT now(),
  closed_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);

CREATE TABLE IF NOT EXISTS daily_performance (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_date      DATE NOT NULL UNIQUE,
  total_trades    INTEGER DEFAULT 0,
  winning_trades  INTEGER DEFAULT 0,
  losing_trades   INTEGER DEFAULT 0,
  total_pnl       NUMERIC(12,2) DEFAULT 0,
  win_rate        NUMERIC(5,2),
  portfolio_value NUMERIC(14,2),
  created_at      TIMESTAMPTZ DEFAULT now()
);
