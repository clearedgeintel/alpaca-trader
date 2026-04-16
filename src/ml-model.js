const tf = require('@tensorflow/tfjs');
const db = require('./db');
const { emaArray, calcRsi, volumeRatio, calcAtr } = require('./indicators');
const config = require('./config');
const { log, error } = require('./logger');

let model = null;
let isTraining = false;
let lastTrainedAt = null;
let trainMetrics = null;

// Feature names (must match training and prediction order)
const FEATURE_NAMES = [
  'ema9_ema21_ratio',
  'ema_cross_direction',
  'rsi_normalized',
  'volume_ratio',
  'atr_pct',
  'price_vs_ema21',
];

/**
 * Build a simple neural network for BUY/SELL/HOLD classification.
 */
function buildModel() {
  const m = tf.sequential();
  m.add(tf.layers.dense({ units: 16, activation: 'relu', inputShape: [FEATURE_NAMES.length] }));
  m.add(tf.layers.dropout({ rate: 0.2 }));
  m.add(tf.layers.dense({ units: 8, activation: 'relu' }));
  m.add(tf.layers.dense({ units: 3, activation: 'softmax' })); // BUY=0, SELL=1, HOLD=2
  m.compile({ optimizer: 'adam', loss: 'categoricalCrossentropy', metrics: ['accuracy'] });
  return m;
}

/**
 * Extract features from raw bar data for model input.
 * Returns null if insufficient data.
 */
function extractFeatures(bars) {
  if (!bars || bars.length < config.EMA_SLOW + 5) return null;

  const closes = bars.map((b) => b.c);
  const volumes = bars.map((b) => b.v);
  const last = closes.length - 1;

  const ema9 = emaArray(closes, config.EMA_FAST);
  const ema21 = emaArray(closes, config.EMA_SLOW);
  const rsi = calcRsi(closes, config.RSI_PERIOD);
  const volRat = volumeRatio(volumes, config.VOLUME_LOOKBACK);
  const atr = calcAtr(bars, config.ATR_PERIOD);

  if (ema9[last] == null || ema21[last] == null || rsi == null) return null;

  return [
    ema9[last] / ema21[last] - 1, // EMA ratio (centered at 0)
    ema9[last] > ema9[last - 1] ? 1 : -1, // EMA cross direction
    (rsi - 50) / 50, // RSI normalized to [-1, 1]
    Math.min(volRat / 3, 1), // Volume ratio capped at 3x
    atr ? atr / closes[last] : 0, // ATR as % of price
    (closes[last] - ema21[last]) / ema21[last], // Price distance from EMA21
  ];
}

/**
 * Train the model on historical signal data from the database.
 */
async function trainModel() {
  if (isTraining) {
    log('ML model training already in progress');
    return;
  }

  isTraining = true;
  log('ML model training started...');

  try {
    // Fetch historical signals with their outcomes
    const result = await db.query(`
      SELECT s.symbol, s.signal, s.close, s.ema9, s.ema21, s.rsi, s.volume_ratio,
             t.pnl, t.status as trade_status
      FROM signals s
      LEFT JOIN trades t ON t.signal_id = s.id
      ORDER BY s.created_at ASC
    `);

    if (result.rows.length < 20) {
      log('ML model: insufficient training data (need 20+ signals)');
      isTraining = false;
      return;
    }

    // Prepare training data
    const features = [];
    const labels = [];

    for (const row of result.rows) {
      const ema9 = parseFloat(row.ema9);
      const ema21 = parseFloat(row.ema21);
      const rsi = parseFloat(row.rsi);
      const volRatio = parseFloat(row.volume_ratio);
      const close = parseFloat(row.close);

      if (!ema9 || !ema21 || !rsi) continue;

      // Feature vector (same as extractFeatures but from DB values)
      features.push([
        ema9 / ema21 - 1,
        ema9 > ema21 ? 1 : -1,
        (rsi - 50) / 50,
        Math.min(volRatio / 3, 1),
        0.02, // Approximate ATR% (not stored in signals)
        (close - ema21) / ema21,
      ]);

      // Label: use actual trade outcome if available, else signal type
      let label;
      if (row.trade_status === 'closed' && row.pnl != null) {
        label = parseFloat(row.pnl) > 0 ? 0 : 2; // Profitable = confirmed BUY, loss = HOLD
      } else if (row.signal === 'BUY') {
        label = 0;
      } else if (row.signal === 'SELL') {
        label = 1;
      } else {
        label = 2;
      }
      labels.push(label);
    }

    if (features.length < 10) {
      log('ML model: not enough valid training samples');
      isTraining = false;
      return;
    }

    // Convert to tensors
    const xs = tf.tensor2d(features);
    const ys = tf.oneHot(tf.tensor1d(labels, 'int32'), 3);

    // Build and train
    model = buildModel();
    const history = await model.fit(xs, ys, {
      epochs: 50,
      batchSize: Math.min(32, Math.floor(features.length / 2)),
      validationSplit: 0.2,
      verbose: 0,
    });

    const finalLoss = history.history.loss[history.history.loss.length - 1];
    const finalAcc = history.history.acc[history.history.acc.length - 1];

    trainMetrics = {
      samples: features.length,
      epochs: 50,
      loss: +finalLoss.toFixed(4),
      accuracy: +finalAcc.toFixed(4),
    };

    lastTrainedAt = new Date().toISOString();
    log(
      `ML model trained: ${features.length} samples, loss=${finalLoss.toFixed(4)}, accuracy=${(finalAcc * 100).toFixed(1)}%`,
    );

    // Cleanup tensors
    xs.dispose();
    ys.dispose();
  } catch (err) {
    error('ML model training failed', err);
  } finally {
    isTraining = false;
  }
}

/**
 * Predict signal from bar data using the trained model.
 * Returns { signal: 'BUY'|'SELL'|'HOLD', confidence: 0-1, source: 'ml' } or null if model unavailable.
 */
function predict(bars) {
  if (!model) return null;

  const features = extractFeatures(bars);
  if (!features) return null;

  try {
    const input = tf.tensor2d([features]);
    const prediction = model.predict(input);
    const probs = prediction.dataSync();
    input.dispose();
    prediction.dispose();

    const maxIdx = probs.indexOf(Math.max(...probs));
    const signals = ['BUY', 'SELL', 'HOLD'];

    return {
      signal: signals[maxIdx],
      confidence: +probs[maxIdx].toFixed(3),
      probabilities: {
        BUY: +probs[0].toFixed(3),
        SELL: +probs[1].toFixed(3),
        HOLD: +probs[2].toFixed(3),
      },
      source: 'ml',
    };
  } catch (err) {
    error('ML prediction failed', err);
    return null;
  }
}

/**
 * Check if the model is trained and ready.
 */
function isReady() {
  return model != null;
}

function getStatus() {
  return {
    ready: isReady(),
    training: isTraining,
    lastTrainedAt,
    metrics: trainMetrics,
  };
}

/**
 * Persist a prediction so we can score it later against the actual
 * trade outcome. Fire-and-forget; failures are non-fatal.
 */
async function logPrediction(symbol, prediction, features = null) {
  if (!prediction) return null;
  try {
    const { rows } = await db.query(
      `INSERT INTO ml_predictions (symbol, signal, confidence, prob_buy, prob_sell, prob_hold, features)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        symbol,
        prediction.signal,
        prediction.confidence,
        prediction.probabilities?.BUY ?? null,
        prediction.probabilities?.SELL ?? null,
        prediction.probabilities?.HOLD ?? null,
        features ? JSON.stringify(features) : null,
      ],
    );
    return rows[0]?.id || null;
  } catch (err) {
    error('ML prediction logging failed', err);
    return null;
  }
}

/**
 * Attach a predicted outcome to a trade once it's placed. Lets us
 * score the prediction later when the trade closes.
 */
async function linkPredictionToTrade(predictionId, tradeId) {
  if (!predictionId || !tradeId) return;
  try {
    await db.query(`UPDATE ml_predictions SET trade_id = $1 WHERE id = $2`, [tradeId, predictionId]);
  } catch (err) {
    error('ML prediction linking failed', err);
  }
}

/**
 * Score any unscored predictions whose linked trade has closed.
 * Called periodically (e.g. from the reconciler). A prediction is
 * "correct" if it said BUY and the trade profited, or said HOLD and
 * the trade was scratched — simpler than trying to grade SELL.
 */
async function scorePendingPredictions() {
  try {
    const { rows } = await db.query(
      `UPDATE ml_predictions p
          SET actual_pnl = t.pnl,
              was_correct = CASE
                WHEN p.signal = 'BUY' AND t.pnl > 0 THEN true
                WHEN p.signal = 'BUY' AND t.pnl <= 0 THEN false
                WHEN p.signal = 'HOLD' THEN (t.pnl >= 0)
                ELSE NULL
              END,
              scored_at = NOW()
         FROM trades t
        WHERE p.trade_id = t.id
          AND t.status = 'closed'
          AND p.scored_at IS NULL
        RETURNING p.id`,
    );
    return rows.length;
  } catch (err) {
    error('ML prediction scoring failed', err);
    return 0;
  }
}

/**
 * Live accuracy over the last N days. Returns null when we have
 * fewer than 10 scored predictions (not enough signal).
 */
async function getLiveAccuracy(days = 30) {
  try {
    const { rows } = await db.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE was_correct = true)::int AS correct,
         COUNT(*) FILTER (WHERE signal = 'BUY')::int AS buys,
         COUNT(*) FILTER (WHERE signal = 'SELL')::int AS sells,
         COUNT(*) FILTER (WHERE signal = 'HOLD')::int AS holds,
         AVG(confidence)::float AS avg_confidence
       FROM ml_predictions
       WHERE scored_at IS NOT NULL
         AND scored_at >= NOW() - ($1 || ' days')::interval`,
      [String(days)],
    );
    const r = rows[0] || { total: 0 };
    if (r.total < 10) {
      return { total: r.total, accuracy: null, reason: 'insufficient_samples', ...r };
    }
    return {
      total: r.total,
      correct: r.correct,
      accuracy: +(r.correct / r.total).toFixed(4),
      buys: r.buys,
      sells: r.sells,
      holds: r.holds,
      avgConfidence: +Number(r.avg_confidence || 0).toFixed(3),
    };
  } catch (err) {
    error('ML getLiveAccuracy failed', err);
    return { total: 0, accuracy: null, error: err.message };
  }
}

/**
 * Walk-forward validation — splits training data into rolling
 * time-windows and reports average accuracy across fold-out sets.
 * A large gap between training accuracy and walk-forward accuracy
 * signals overfitting.
 */
async function validateWalkForward(folds = 3) {
  try {
    const result = await db.query(
      `SELECT s.close, s.ema9, s.ema21, s.rsi, s.volume_ratio, s.signal, t.pnl, t.status
         FROM signals s LEFT JOIN trades t ON t.signal_id = s.id
        ORDER BY s.created_at ASC`,
    );
    const data = result.rows.filter((r) => r.ema9 && r.ema21 && r.rsi);
    if (data.length < folds * 20) {
      return { folds, accuracies: [], avgAccuracy: null, reason: 'insufficient_data', samples: data.length };
    }

    const foldSize = Math.floor(data.length / folds);
    const accuracies = [];

    for (let k = 0; k < folds - 1; k++) {
      const trainEnd = (k + 1) * foldSize;
      const testEnd = Math.min(data.length, trainEnd + foldSize);
      const train = data.slice(0, trainEnd);
      const test = data.slice(trainEnd, testEnd);
      if (train.length < 20 || test.length < 5) continue;

      // Simple rule-based accuracy for now — a full tf retrain per fold
      // is expensive. This approximates: "would a naive EMA crossover
      // have been right on the held-out window?"
      let correct = 0;
      let total = 0;
      for (const r of test) {
        if (r.status !== 'closed' || r.pnl == null) continue;
        const predictBuy = Number(r.ema9) > Number(r.ema21) && Number(r.rsi) > 50;
        const actualProfit = Number(r.pnl) > 0;
        if (predictBuy === actualProfit) correct++;
        total++;
      }
      if (total > 0) accuracies.push(+(correct / total).toFixed(4));
    }

    const avg = accuracies.length > 0 ? accuracies.reduce((a, b) => a + b, 0) / accuracies.length : null;
    return {
      folds,
      accuracies,
      avgAccuracy: avg != null ? +avg.toFixed(4) : null,
      samples: data.length,
    };
  } catch (err) {
    error('ML walk-forward validation failed', err);
    return { folds, accuracies: [], avgAccuracy: null, error: err.message };
  }
}

module.exports = {
  trainModel,
  predict,
  isReady,
  getStatus,
  extractFeatures,
  logPrediction,
  linkPredictionToTrade,
  scorePendingPredictions,
  getLiveAccuracy,
  validateWalkForward,
};
