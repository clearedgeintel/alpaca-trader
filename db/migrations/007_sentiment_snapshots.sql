-- Per-symbol sentiment snapshots captured once per news-agent cycle.
-- agent_reports already persists the whole report, but mining per-symbol
-- sentiment out of JSONB is slow when we want time-series queries.
-- A dedicated table with (symbol, captured_at) indexes lets us answer
-- "how has AAPL sentiment moved over the last 7 days?" in a single
-- range scan and detect inflection points without deserializing JSONB.

CREATE TABLE IF NOT EXISTS sentiment_snapshots (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol             TEXT NOT NULL,
  captured_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Canonical -1..1 score from the news-agent LLM synthesis
  sentiment          NUMERIC(5, 3) NOT NULL,
  urgency            TEXT,
  -- Provenance + raw input counts (for replay / debugging drift)
  article_count      INT DEFAULT 0,
  polygon_positive   INT DEFAULT 0,
  polygon_negative   INT DEFAULT 0,
  polygon_neutral    INT DEFAULT 0,
  reddit_buzz        INT DEFAULT 0,
  key_headline       TEXT,
  reasoning          TEXT
);

CREATE INDEX IF NOT EXISTS idx_sentiment_symbol_time
  ON sentiment_snapshots(symbol, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_sentiment_time
  ON sentiment_snapshots(captured_at DESC);
