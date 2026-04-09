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
  trailing_stop   NUMERIC(12,4),
  highest_price   NUMERIC(12,4),
  order_type      TEXT DEFAULT 'market',
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

-- Runtime config for hot-reloadable settings
CREATE TABLE IF NOT EXISTS runtime_config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Agent framework tables

CREATE TABLE IF NOT EXISTS agent_messages (
  id          UUID PRIMARY KEY,
  type        TEXT NOT NULL CHECK (type IN ('SIGNAL', 'ALERT', 'VETO', 'REPORT', 'DECISION')),
  from_agent  TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_type ON agent_messages(type);
CREATE INDEX IF NOT EXISTS idx_agent_messages_from ON agent_messages(from_agent);
CREATE INDEX IF NOT EXISTS idx_agent_messages_created ON agent_messages(created_at DESC);

CREATE TABLE IF NOT EXISTS agent_reports (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name  TEXT NOT NULL,
  symbol      TEXT,
  signal      TEXT,
  confidence  NUMERIC(4,3),
  reasoning   TEXT,
  data        JSONB NOT NULL DEFAULT '{}',
  duration_ms INTEGER,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_reports_agent ON agent_reports(agent_name);
CREATE INDEX IF NOT EXISTS idx_agent_reports_created ON agent_reports(created_at DESC);

CREATE TABLE IF NOT EXISTS agent_decisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol          TEXT NOT NULL,
  action          TEXT NOT NULL,
  confidence      NUMERIC(4,3),
  reasoning       TEXT,
  agent_inputs    JSONB NOT NULL DEFAULT '{}',
  trade_id        UUID REFERENCES trades(id),
  signal_id       UUID REFERENCES signals(id),
  duration_ms     INTEGER,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_decisions_symbol ON agent_decisions(symbol);
CREATE INDEX IF NOT EXISTS idx_agent_decisions_created ON agent_decisions(created_at DESC);

-- Agent per-cycle telemetry
CREATE TABLE IF NOT EXISTS agent_metrics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name      TEXT NOT NULL,
  cycle_duration_ms INTEGER,
  llm_calls       INTEGER DEFAULT 0,
  llm_input_tokens  INTEGER DEFAULT 0,
  llm_output_tokens INTEGER DEFAULT 0,
  llm_cost_usd    NUMERIC(10,6) DEFAULT 0,
  symbols_processed INTEGER DEFAULT 0,
  signals_produced  INTEGER DEFAULT 0,
  errors          INTEGER DEFAULT 0,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_metrics_agent ON agent_metrics(agent_name);
CREATE INDEX IF NOT EXISTS idx_agent_metrics_created ON agent_metrics(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_metrics_agent_date ON agent_metrics(agent_name, created_at DESC);

-- Agent performance — daily aggregated stats
CREATE TABLE IF NOT EXISTS agent_performance (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name      TEXT NOT NULL,
  trade_date      DATE NOT NULL,
  decisions_made  INTEGER DEFAULT 0,
  decisions_correct INTEGER DEFAULT 0,
  decisions_wrong INTEGER DEFAULT 0,
  total_pnl       NUMERIC(12,2) DEFAULT 0,
  avg_confidence  NUMERIC(4,3),
  avg_latency_ms  INTEGER,
  total_llm_cost  NUMERIC(10,4) DEFAULT 0,
  win_rate        NUMERIC(5,2),
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ DEFAULT now(),
  UNIQUE(agent_name, trade_date)
);
CREATE INDEX IF NOT EXISTS idx_agent_performance_agent ON agent_performance(agent_name);
CREATE INDEX IF NOT EXISTS idx_agent_performance_date ON agent_performance(trade_date DESC);
