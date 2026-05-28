/**
 * Pure rule-based critical-news detector. Replaces the LLM-side alert
 * scanning in news-agent when NEWS_PER_CYCLE_LLM_ENABLED is false (v2
 * Phase 0b cut). Scans recent headlines + summaries for high-confidence
 * trigger phrases and emits the same `_alerts[]` shape the LLM produced,
 * so the executor's `newsAgent.getCriticalAlert(symbol)` veto path keeps
 * working unchanged.
 *
 * Conservative design notes:
 *   - Symbol attribution requires the article to *explicitly* tag the
 *     symbol (n.symbols includes it). We do not infer symbols from
 *     mentions in body text — too many false positives from generic
 *     mega-cap name-dropping ("AAPL competitor reports earnings…").
 *   - Phrases use word boundaries to avoid partial matches.
 *   - One trigger per article per direction — a headline saying
 *     "missed earnings and got downgraded" emits one bearish alert,
 *     not two.
 *   - Final dedupe by (symbol, type) so the same trigger fired in
 *     duplicate articles (Polygon + Alpaca on the same wire) collapses
 *     to a single alert.
 */

// Bearish: each fires `impact: 'very_bearish'`, which the executor
// treats as a BUY veto on the affected symbol.
const BEARISH_TRIGGERS = [
  { type: 'earnings_miss', re: /\b(?:earnings\s+miss|miss(?:es|ed)\s+(?:earnings|estimates|expectations))\b/i },
  { type: 'downgrade', re: /\b(?:downgrade(?:d|s)?(?:\s+(?:by|to|from))?|cut\s+(?:to|rating))\b/i },
  { type: 'fraud_or_probe', re: /\b(?:accounting\s+fraud|securities\s+fraud|SEC\s+(?:investigation|probe|charges?)|DOJ\s+(?:investigation|probe))\b/i },
  { type: 'delisting', re: /\b(?:delist(?:ed|ing)|delisting\s+notice)\b/i },
  { type: 'bankruptcy', re: /\b(?:bankrupt(?:cy)?|chapter\s+(?:7|11)|files?\s+for\s+bankruptcy)\b/i },
  { type: 'product_recall', re: /\b(?:product\s+recall|recalls?\s+(?:millions?\s+of\s+|its\s+)?[a-z]+|massive\s+recall)\b/i },
  { type: 'fda_reject', re: /\b(?:FDA\s+(?:reject(?:ed|s|ion)|denies?|denied)|complete\s+response\s+letter|CRL\b|clinical\s+trial\s+fail(?:ure|ed|s))\b/i },
  { type: 'guidance_cut', re: /\b(?:cut(?:s|ting)?\s+guidance|lower(?:s|ed|ing)\s+(?:full[- ]year\s+)?(?:outlook|guidance|forecast)|withdraw(?:s|n)\s+guidance|suspend(?:s|ed)\s+guidance)\b/i },
  { type: 'executive_exit', re: /\b(?:CEO\s+(?:resign(?:s|ed|ation)?|steps?\s+down|ousted|fired|exits?)|CFO\s+(?:resign(?:s|ed|ation)?|steps?\s+down|ousted|fired))\b/i },
  { type: 'data_breach', re: /\b(?:data\s+breach|massive\s+breach|security\s+breach|customer\s+data\s+(?:exposed|stolen|leaked))\b/i },
  { type: 'short_report', re: /\b(?:short[- ]seller\s+(?:report|attack)|short\s+report|hindenburg|muddy\s+waters|citron)\b/i },
  { type: 'antitrust', re: /\b(?:antitrust\s+(?:probe|investigation|lawsuit|case|charges?)|monopoly\s+probe|DOJ\s+antitrust)\b/i },
  { type: 'accounting_restate', re: /\b(?:restate(?:s|d|ment)\s+(?:earnings|financials)|accounting\s+(?:irregularit|error|mistake))/i },
  { type: 'fatal_incident', re: /\b(?:fatal\s+(?:accident|crash|incident)|production\s+halt(?:ed)?|plant\s+(?:fire|explosion|shutdown))\b/i },
];

// Bullish: fires `impact: 'very_bullish'`. The executor uses these less
// aggressively (it doesn't *force* a BUY) but they unblock symbols
// that other gates were holding.
const BULLISH_TRIGGERS = [
  { type: 'earnings_beat', re: /\b(?:earnings\s+beat|beat(?:s)?\s+(?:earnings|estimates|expectations)|earnings\s+surprise|crushed\s+earnings)\b/i },
  { type: 'upgrade', re: /\b(?:upgrade(?:d|s)?(?:\s+(?:to|by|from))?|rating\s+raised|raised\s+(?:to|its)\s+rating)\b/i },
  { type: 'fda_approve', re: /\b(?:FDA\s+approv(?:al|ed|es)|drug\s+approval|approved\s+by\s+the\s+FDA)\b/i },
  { type: 'buyback', re: /\b(?:share\s+buyback|buyback\s+program|share\s+repurchase|announces?\s+buyback|\$[\d.]+ ?[bm](?:illion)?\s+buyback)\b/i },
  { type: 'acquisition', re: /\b(?:to\s+(?:acquire|buy)|acquired\s+by|to\s+be\s+acquired|merger\s+agreement|takeover\s+(?:bid|offer))\b/i },
  { type: 'guidance_raise', re: /\b(?:raise(?:s|d)?\s+(?:full[- ]year\s+)?(?:outlook|guidance|forecast)|increases?\s+guidance|raised\s+outlook)\b/i },
];

/**
 * Scan recent articles for critical alerts on watchlist symbols.
 * Returns an array of `{ symbol, type, headline, impact }` matching the
 * shape news-agent's LLM-side path produces.
 *
 * @param {Array} articles  — recent news, each with .headline, .summary, .symbols
 * @param {Array} watchlist — symbols to attribute alerts to
 */
function detectCriticalAlerts(articles, watchlist) {
  const watchlistSet = new Set((watchlist || []).map((s) => String(s).toUpperCase()));
  const raw = [];

  for (const article of articles || []) {
    const headline = String(article.headline || '');
    const summary = String(article.summary || '').slice(0, 600);
    const text = `${headline}\n${summary}`;

    // Restrict attribution to symbols the article explicitly tags AND
    // that are in our watchlist. Cross-symbol contamination is a real
    // risk on macro/sector headlines.
    const articleSymbols = (article.symbols || [])
      .map((s) => String(s).toUpperCase())
      .filter((s) => watchlistSet.has(s));
    if (articleSymbols.length === 0) continue;

    // First bearish hit wins per article.
    let bearishHit = null;
    for (const trigger of BEARISH_TRIGGERS) {
      if (trigger.re.test(text)) {
        bearishHit = trigger;
        break;
      }
    }
    if (bearishHit) {
      for (const sym of articleSymbols) {
        raw.push({
          symbol: sym,
          type: bearishHit.type,
          headline: headline.slice(0, 200),
          impact: 'very_bearish',
        });
      }
    }

    // First bullish hit also fires (a single article CAN carry both
    // directions, e.g. earnings beat with a regulatory probe — rare,
    // but we surface both and let the executor's veto logic pick).
    let bullishHit = null;
    for (const trigger of BULLISH_TRIGGERS) {
      if (trigger.re.test(text)) {
        bullishHit = trigger;
        break;
      }
    }
    if (bullishHit) {
      for (const sym of articleSymbols) {
        raw.push({
          symbol: sym,
          type: bullishHit.type,
          headline: headline.slice(0, 200),
          impact: 'very_bullish',
        });
      }
    }
  }

  // Dedupe by (symbol, type) — duplicate wires (Polygon + Alpaca on
  // the same story) collapse to one alert.
  const seen = new Set();
  return raw.filter((a) => {
    const key = `${a.symbol}:${a.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { detectCriticalAlerts, BEARISH_TRIGGERS, BULLISH_TRIGGERS };
