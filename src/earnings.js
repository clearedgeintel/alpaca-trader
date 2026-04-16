/**
 * Earnings calendar + event filter.
 *
 * Alpaca's paper API does not expose earnings announcement dates (only
 * splits / dividends / mergers). Getting clean earnings data usually
 * requires Finnhub, IEX, or Yahoo scraping — none of which are free and
 * paper-safe. This module takes a pragmatic hybrid approach:
 *
 *   1. A hardcoded STATIC_CALENDAR of upcoming confirmed earnings for
 *      high-interest symbols. Update quarterly.
 *   2. Runtime overrides from the runtime_config table so users can
 *      drop in additional dates without a deploy.
 *   3. A news-keyword fallback: if the news agent has seen a recent
 *      headline containing earnings-related keywords for the symbol,
 *      treat the symbol as pre-earnings regardless of the calendar.
 *
 * Effect: when a symbol is flagged pre-earnings, the execution agent
 * either skips the BUY entirely (strict mode) or reduces position size
 * by 50 percent (default). Configurable via EARNINGS_MODE env var.
 */

const { log } = require('./logger');

// Static upcoming earnings calendar — add symbols and dates as you learn them.
// Dates are the reporting date (after close or before open). Update quarterly.
// Symbols not listed are assumed to have no upcoming earnings, so only populate
// the ones you actively trade.
const STATIC_CALENDAR = {
  // Example entries — replace with current-quarter dates
  // 'AAPL': '2026-05-01',
  // 'NVDA': '2026-05-22',
  // 'MSFT': '2026-04-24',
  // 'GOOGL': '2026-04-25',
  // 'TSLA': '2026-04-23',
  // 'META': '2026-04-30',
  // 'AMD': '2026-05-06',
  // 'AMZN': '2026-05-01',
};

// Earnings-related keywords that, if found in recent news headlines, signal
// the symbol is near an earnings event. Loose enough to catch pre-release,
// earnings preview, and earnings recap coverage.
const EARNINGS_KEYWORDS = [
  /\bearnings\b/i,
  /\bquarterly (?:results|report)\b/i,
  /\bQ[1-4] (?:results|report|earnings)\b/i,
  /\bpre[- ]announcement\b/i,
  /\bearnings preview\b/i,
  /\bbeats? (?:EPS|estimates?)\b/i,
  /\bmisses? (?:EPS|estimates?)\b/i,
  /\breports? (?:Q[1-4]|earnings|quarterly)/i,
];

let runtimeOverrides = {}; // symbol -> YYYY-MM-DD

/**
 * Allow runtime-config WATCHLIST_EARNINGS to inject additional dates.
 * Format: "SYMBOL:YYYY-MM-DD,SYMBOL:YYYY-MM-DD"
 */
function loadOverrides() {
  try {
    const runtimeConfig = require('./runtime-config');
    const raw = runtimeConfig.get('EARNINGS_CALENDAR');
    if (!raw || typeof raw !== 'string') return;
    const pairs = raw
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    const next = {};
    for (const pair of pairs) {
      const [sym, date] = pair.split(':').map((s) => s.trim());
      if (sym && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        next[sym.toUpperCase()] = date;
      }
    }
    runtimeOverrides = next;
  } catch {
    // runtime-config unavailable (e.g. in tests) — leave overrides empty
  }
}

/**
 * Return the next known earnings date for a symbol (YYYY-MM-DD string),
 * or null if none on record. Runtime overrides win over static.
 */
function getNextEarningsDate(symbol) {
  const key = symbol.toUpperCase();
  loadOverrides();
  return runtimeOverrides[key] || STATIC_CALENDAR[key] || null;
}

/**
 * How many trading days until the next earnings report for a symbol.
 * Returns null if no date on record. Counts weekdays only (approximate;
 * doesn't subtract market holidays).
 */
function daysUntilEarnings(symbol, today = new Date()) {
  const dateStr = getNextEarningsDate(symbol);
  if (!dateStr) return null;
  const target = new Date(dateStr + 'T00:00:00Z');
  if (Number.isNaN(target.getTime())) return null;
  const diffMs = target.getTime() - today.getTime();
  const calendarDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
  if (calendarDays < 0) return null; // past
  // Rough weekday adjustment: subtract weekends
  let weekdays = 0;
  const cur = new Date(today);
  for (let i = 0; i < calendarDays; i++) {
    const d = cur.getUTCDay();
    if (d !== 0 && d !== 6) weekdays++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return weekdays;
}

/**
 * News-keyword fallback: returns true if any recent headline for the
 * symbol contains an earnings-related keyword.
 * `recentNews` is an array of { headline, summary, symbols } — typically
 * passed in from the news agent's cached report for the symbol.
 */
function hasEarningsNewsSignal(symbol, recentNews = []) {
  const key = symbol.toUpperCase();
  for (const article of recentNews) {
    if (!article.symbols || !article.symbols.includes(key)) continue;
    const text = `${article.headline || ''} ${article.summary || ''}`;
    if (EARNINGS_KEYWORDS.some((re) => re.test(text))) return true;
  }
  return false;
}

/**
 * Is the symbol considered "near earnings"? Combines calendar + news signal.
 * Default window is 2 trading days (entry day + one day).
 */
function isNearEarnings(symbol, { withinDays = 2, recentNews = [] } = {}) {
  const days = daysUntilEarnings(symbol);
  if (days != null && days <= withinDays) return { near: true, source: 'calendar', days };
  if (hasEarningsNewsSignal(symbol, recentNews)) return { near: true, source: 'news_keyword' };
  return { near: false };
}

/**
 * Earnings mode — controls how the execution agent reacts to a pre-earnings flag.
 *   'block'   — skip the BUY entirely
 *   'reduce'  — halve the position size (default)
 *   'ignore'  — no action (equivalent to disabling this feature)
 */
function getMode() {
  const mode = (process.env.EARNINGS_MODE || 'reduce').toLowerCase();
  if (mode === 'block' || mode === 'reduce' || mode === 'ignore') return mode;
  log(`Unknown EARNINGS_MODE=${mode}, defaulting to 'reduce'`);
  return 'reduce';
}

module.exports = {
  getNextEarningsDate,
  daysUntilEarnings,
  hasEarningsNewsSignal,
  isNearEarnings,
  getMode,
  STATIC_CALENDAR,
};
