-- Phase 1: Observability & Telemetry
-- Persistent agent metrics for latency, LLM usage, and performance tracking

-- Per-cycle agent telemetry
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

-- Add duration_ms to agent_reports
ALTER TABLE agent_reports ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

-- Add duration_ms to agent_decisions
ALTER TABLE agent_decisions ADD COLUMN IF NOT EXISTS duration_ms INTEGER;

-- Agent performance tracking — aggregated daily stats per agent
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
