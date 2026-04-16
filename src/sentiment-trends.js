/**
 * Sentiment trend aggregator.
 *
 * Reads sentiment_snapshots (one row per symbol per news-agent cycle)
 * and answers two questions:
 *
 *   1. getTrend(symbol, days) — chronological series for plotting
 *      sparklines or full charts in the UI.
 *   2. getShifts(hours, threshold) — which symbols had a sentiment
 *      *inflection* in the lookback window? Defined as the absolute
 *      difference between the latest and earliest snapshot inside the
 *      window exceeding `threshold`. Intended to surface early
 *      warnings before price has fully repriced.
 *
 * Both queries fail-open: on DB error they return empty arrays so
 * the UI degrades to "no data yet" rather than breaking the page.
 */

const db = require('./db');
const { error } = require('./logger');

/**
 * Chronological sentiment points for a single symbol.
 * Returns `[{ t: ISO, sentiment, urgency, article_count, polygon_positive, polygon_negative }]`.
 */
async function getTrend(symbol, days = 7) {
  try {
    const { rows } = await db.query(
      `SELECT captured_at AS t,
              sentiment::float AS sentiment,
              urgency,
              article_count,
              polygon_positive,
              polygon_negative
         FROM sentiment_snapshots
        WHERE symbol = $1
          AND captured_at >= NOW() - ($2 || ' days')::interval
        ORDER BY captured_at ASC`,
      [symbol, String(days)],
    );
    return rows;
  } catch (err) {
    error(`sentiment-trends.getTrend(${symbol}) failed`, err);
    return [];
  }
}

/**
 * Symbols with a sentiment *shift* in the lookback window.
 *
 * For each symbol in the window we compute:
 *   - first:    earliest snapshot's sentiment
 *   - last:     latest snapshot's sentiment
 *   - delta:    last - first
 *   - direction: 'bullish' when delta > 0, 'bearish' when < 0
 *
 * Only symbols with |delta| >= threshold AND >= 2 snapshots are returned.
 * Ordered by |delta| descending so the loudest moves are first.
 */
async function getShifts({ hours = 24, threshold = 0.4 } = {}) {
  try {
    const { rows } = await db.query(
      `WITH windowed AS (
         SELECT
           symbol,
           sentiment::float AS sentiment,
           captured_at,
           ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY captured_at ASC)  AS rn_asc,
           ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY captured_at DESC) AS rn_desc,
           COUNT(*)    OVER (PARTITION BY symbol) AS sample_size,
           AVG(sentiment::float) OVER (PARTITION BY symbol) AS avg_sentiment
         FROM sentiment_snapshots
         WHERE captured_at >= NOW() - ($1 || ' hours')::interval
       ),
       endpoints AS (
         SELECT
           symbol,
           MAX(CASE WHEN rn_asc  = 1 THEN sentiment END)    AS first_sentiment,
           MAX(CASE WHEN rn_desc = 1 THEN sentiment END)    AS last_sentiment,
           MAX(CASE WHEN rn_desc = 1 THEN captured_at END)  AS last_at,
           MIN(captured_at)                                 AS first_at,
           MAX(sample_size)                                 AS sample_size,
           MAX(avg_sentiment)                               AS avg_sentiment
         FROM windowed
         GROUP BY symbol
       )
       SELECT
         symbol,
         first_sentiment,
         last_sentiment,
         (last_sentiment - first_sentiment) AS delta,
         first_at,
         last_at,
         sample_size,
         avg_sentiment
       FROM endpoints
       WHERE sample_size >= 2
         AND ABS(last_sentiment - first_sentiment) >= $2
       ORDER BY ABS(last_sentiment - first_sentiment) DESC`,
      [String(hours), threshold],
    );

    return rows.map((r) => ({
      symbol: r.symbol,
      first: Number(r.first_sentiment),
      last: Number(r.last_sentiment),
      delta: Number(r.delta),
      direction: Number(r.delta) > 0 ? 'bullish' : 'bearish',
      sampleSize: Number(r.sample_size),
      avgSentiment: Number(r.avg_sentiment),
      firstAt: r.first_at,
      lastAt: r.last_at,
    }));
  } catch (err) {
    error(`sentiment-trends.getShifts failed`, err);
    return [];
  }
}

module.exports = { getTrend, getShifts };
