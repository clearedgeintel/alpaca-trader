const BaseAgent = require('./base-agent');
const { messageBus } = require('./message-bus');
const { askJson } = require('./llm');
const alpaca = require('../alpaca');
const datasources = require('../datasources');
const config = require('../config');
const db = require('../db');
const { log, error } = require('../logger');
const { getRedditBuzz } = require('../reddit');

/**
 * Merge Alpaca + Polygon news, deduplicating by URL. When both sources
 * have the same article, prefer the Polygon version because it carries
 * the `insights[]` sentiment field.
 */
function mergeNewsSources(alpacaNews, polygonNews) {
  const byUrl = new Map();
  for (const n of alpacaNews) {
    if (n.url) byUrl.set(n.url, n);
  }
  for (const n of polygonNews) {
    if (n.url) byUrl.set(n.url, n); // overwrite → Polygon wins
  }
  return Array.from(byUrl.values());
}

const NEWS_SYSTEM_PROMPT = `You are a financial news analyst for an automated stock trading system.
You analyze recent news headlines and summaries to assess sentiment and urgency for specific stocks.

Your response must be valid JSON with this structure:
{
  "overall_sentiment": -1.0 to 1.0,
  "overall_urgency": "low" | "medium" | "high" | "critical",
  "symbols": {
    "SYMBOL": {
      "sentiment": -1.0 to 1.0,
      "urgency": "low" | "medium" | "high" | "critical",
      "key_headline": "most impactful headline for this symbol",
      "reasoning": "brief explanation"
    }
  },
  "alerts": [
    {
      "symbol": "SYMBOL",
      "type": "earnings_miss" | "earnings_beat" | "fda_decision" | "lawsuit" | "downgrade" | "upgrade" | "macro_event" | "other",
      "headline": "string",
      "impact": "very_bearish" | "bearish" | "neutral" | "bullish" | "very_bullish"
    }
  ]
}

Scoring guide:
- sentiment: -1.0 (extremely bearish) to 1.0 (extremely bullish), 0 = neutral
- urgency "critical": breaking news that should override technical signals (FDA rejection, massive earnings miss, fraud, etc.)
- urgency "high": significant news that should heavily weight decisions
- urgency "medium": notable news worth considering
- urgency "low": routine news, minimal impact
- alerts: only include for actionable, high-impact events

If no news is available, return overall_sentiment 0, overall_urgency "low", empty symbols and alerts.`;

// How far back to look for news (ms) — 30 minutes
const NEWS_LOOKBACK_MS = 30 * 60 * 1000;

class NewsAgent extends BaseAgent {
  constructor() {
    super('news-sentinel', { intervalMs: config.SCAN_INTERVAL_MS });
    this._symbolSentiment = {};
    this._alerts = [];
    this._lastNewsIds = new Set();
  }

  /**
   * Periodic analysis — fetches news and runs sentiment analysis.
   * Accepts context.symbols to use a dynamic watchlist (from screener).
   */
  async analyze(context) {
    const symbols = context?.symbols || config.WATCHLIST;

    // Fetch recent news for watchlist symbols — Alpaca (primary) + Polygon (enrichment) in parallel
    let allNews = [];
    try {
      const [alpacaNews, polygonNewsArrays] = await Promise.all([
        alpaca.getNews(symbols, 30),
        Promise.all(symbols.slice(0, 5).map(s => datasources.getNewsWithInsights(s, 5))),
      ]);
      allNews = mergeNewsSources(alpacaNews || [], (polygonNewsArrays || []).flat().filter(Boolean));
    } catch (err) {
      error('News agent: failed to fetch news', err);
      return this._emptyReport('Failed to fetch news from Alpaca');
    }

    // Filter to recent news only (Polygon uses published_utc; Alpaca uses created_at)
    const cutoff = new Date(Date.now() - NEWS_LOOKBACK_MS).toISOString();
    const recentNews = allNews.filter(n => (n.created_at || n.published_utc || '') >= cutoff);

    // Deduplicate — skip news we already analyzed
    const newArticles = recentNews.filter(n => !this._lastNewsIds.has(n.id));
    this._lastNewsIds = new Set(recentNews.map(n => n.id));

    if (recentNews.length === 0) {
      return this._emptyReport('No recent news for watchlist symbols');
    }

    // Build news digest for LLM — include Polygon insights when present so
    // the LLM can reason with pre-scored sentiment + reasoning per ticker.
    const digest = recentNews.map(n => ({
      headline: n.headline,
      summary: (n.summary || '').slice(0, 200),
      source: n.source,
      symbols: n.symbols,
      time: n.created_at || n.published_utc,
      ...(n.insights?.length ? { polygon_insights: n.insights } : {}),
    }));

    // Fetch Reddit social sentiment in parallel
    let redditData = { symbolBuzz: {}, topPosts: [] };
    try {
      redditData = await getRedditBuzz(symbols);
    } catch (err) {
      error('Reddit buzz fetch failed, continuing without', err);
    }

    // Build social context for LLM
    const socialContext = Object.entries(redditData.symbolBuzz)
      .filter(([_, b]) => b.mentions > 0)
      .map(([sym, b]) => `${sym}: ${b.mentions} Reddit mentions, avg score ${b.avgScore}, buzz=${b.buzzLevel}`)
      .join('\n');

    const topRedditPosts = redditData.topPosts.slice(0, 5)
      .map(p => `[${p.symbol}] r/${p.subreddit}: "${p.title}" (score: ${p.score}, comments: ${p.comments})`)
      .join('\n');

    // Get LLM sentiment analysis
    let analysis = null;
    try {
      const userMsg = [
        `Watchlist: ${symbols.join(', ')}`,
        `\nRecent news (${recentNews.length} articles):\n${JSON.stringify(digest, null, 2)}`,
        socialContext ? `\nReddit social sentiment:\n${socialContext}` : '',
        topRedditPosts ? `\nTop Reddit posts:\n${topRedditPosts}` : '',
      ].filter(Boolean).join('\n');

      const result = await askJson({
        agentName: this.name,
        systemPrompt: NEWS_SYSTEM_PROMPT,
        userMessage: userMsg,
        tier: 'fast',
        maxTokens: 1024,
      });
      analysis = result.data;
    } catch (err) {
      error('News agent LLM call failed', err);
      return this._emptyReport('LLM analysis unavailable');
    }

    if (!analysis) {
      return this._emptyReport('LLM returned invalid response');
    }

    // Update internal state
    this._symbolSentiment = analysis.symbols || {};
    this._alerts = analysis.alerts || [];

    // Publish critical alerts immediately
    for (const alert of this._alerts) {
      if (alert.impact === 'very_bearish' || alert.impact === 'very_bullish') {
        await messageBus.publish('ALERT', this.name, {
          symbol: alert.symbol,
          type: alert.type,
          headline: alert.headline,
          impact: alert.impact,
          urgency: 'critical',
        });
        log(`🚨 NEWS ALERT: ${alert.symbol} — ${alert.headline} (${alert.impact})`);
      }
    }

    const report = {
      symbol: null,
      signal: this._deriveSignal(analysis),
      confidence: this._deriveConfidence(analysis),
      reasoning: this._buildReasoning(analysis, recentNews.length, newArticles.length),
      data: {
        overallSentiment: analysis.overall_sentiment,
        overallUrgency: analysis.overall_urgency,
        symbolSentiment: this._symbolSentiment,
        alerts: this._alerts,
        articleCount: recentNews.length,
        newArticleCount: newArticles.length,
        reddit: {
          symbolBuzz: redditData.symbolBuzz,
          topPosts: redditData.topPosts.slice(0, 5),
        },
      },
    };

    // Persist
    await this._persistReport(report);
    await messageBus.publish('REPORT', this.name, report);

    return report;
  }

  /**
   * Get sentiment for a specific symbol.
   * Returns { sentiment, urgency, reasoning } or null.
   */
  getSymbolSentiment(symbol) {
    return this._symbolSentiment[symbol] || null;
  }

  /**
   * Get all current alerts.
   */
  getAlerts() {
    return [...this._alerts];
  }

  /**
   * Check if there's a critical alert that should block/override a trade.
   * Returns the alert object or null.
   */
  getCriticalAlert(symbol) {
    return this._alerts.find(
      a => a.symbol === symbol && (a.impact === 'very_bearish' || a.impact === 'very_bullish')
    ) || null;
  }

  // --- Private helpers ---

  _deriveSignal(analysis) {
    if (analysis.overall_urgency === 'critical') {
      return analysis.overall_sentiment < 0 ? 'SELL' : 'BUY';
    }
    return 'HOLD';
  }

  _deriveConfidence(analysis) {
    const urgencyWeight = { low: 0.3, medium: 0.5, high: 0.7, critical: 0.9 };
    return urgencyWeight[analysis.overall_urgency] || 0.3;
  }

  _buildReasoning(analysis, totalCount, newCount) {
    const parts = [`${totalCount} recent articles (${newCount} new)`];
    parts.push(`Overall sentiment: ${analysis.overall_sentiment > 0 ? '+' : ''}${analysis.overall_sentiment}`);
    parts.push(`Urgency: ${analysis.overall_urgency}`);
    if (this._alerts.length > 0) {
      parts.push(`${this._alerts.length} alert(s)`);
    }
    return parts.join('. ');
  }

  _emptyReport(reason) {
    return {
      symbol: null,
      signal: 'HOLD',
      confidence: 0.2,
      reasoning: reason,
      data: {
        overallSentiment: 0,
        overallUrgency: 'low',
        symbolSentiment: {},
        alerts: [],
        articleCount: 0,
        newArticleCount: 0,
      },
    };
  }

  async _persistReport(report) {
    try {
      await db.query(
        `INSERT INTO agent_reports (agent_name, symbol, signal, confidence, reasoning, data)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [this.name, report.symbol, report.signal, report.confidence, report.reasoning, JSON.stringify(report.data)]
      );
    } catch (err) {
      error('Failed to persist news report', err);
    }
  }
}

// Singleton
const newsAgent = new NewsAgent();

module.exports = newsAgent;
