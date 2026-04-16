-- ML live-accuracy tracking. Every time the ml-model fallback fires,
-- we log its prediction + probabilities so we can score them once the
-- downstream trade closes. Live accuracy over the last 30/60/90 days
-- tells us whether the model is drifting.

CREATE TABLE IF NOT EXISTS ml_predictions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  predicted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  symbol          TEXT NOT NULL,
  signal          TEXT NOT NULL CHECK (signal IN ('BUY', 'SELL', 'HOLD')),
  confidence      NUMERIC(5, 3) NOT NULL,
  prob_buy        NUMERIC(5, 3),
  prob_sell       NUMERIC(5, 3),
  prob_hold       NUMERIC(5, 3),
  features        JSONB,
  trade_id        UUID REFERENCES trades(id) ON DELETE SET NULL,
  actual_pnl      NUMERIC(12, 2),
  was_correct     BOOLEAN,
  scored_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ml_predictions_symbol ON ml_predictions(symbol);
CREATE INDEX IF NOT EXISTS idx_ml_predictions_predicted_at ON ml_predictions(predicted_at DESC);
CREATE INDEX IF NOT EXISTS idx_ml_predictions_scored ON ml_predictions(scored_at) WHERE scored_at IS NOT NULL;
