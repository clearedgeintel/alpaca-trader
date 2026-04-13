const BaseAgent = require('./base-agent');
const { messageBus } = require('./message-bus');
const { askJson } = require('./llm');
const alpaca = require('../alpaca');
const config = require('../config');
const db = require('../db');
const { log, error } = require('../logger');
const { getMostActivePennyStocks } = require('../yahoo');
const { setSymbolClass } = require('../asset-classes');

// Filters for candidate discovery
const FILTERS = {
  MIN_PRICE: 0.10,         // Allow penny stocks (down to $0.10)
  MAX_PRICE: 1000,         // Allow higher-priced stocks
  MIN_AVG_VOLUME: 300000,  // Liquidity floor
  MIN_CHANGE_PCT: 0.5,     // Lower threshold to catch more movers
  MAX_CANDIDATES: 50,      // Feed more candidates to LLM for ranking
};

// Broader universe for snapshot-based discovery when screener API is unavailable
const DISCOVERY_POOL = [
  // Mega caps & popular
  'AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'META', 'GOOGL', 'AMZN', 'NFLX', 'AVGO',
  'CRM', 'ORCL', 'ADBE', 'INTC', 'QCOM', 'MU', 'MRVL', 'ANET', 'PANW', 'SNOW',
  // Financials
  'JPM', 'GS', 'MS', 'BAC', 'C', 'WFC', 'SCHW', 'BLK', 'AXP', 'V', 'MA',
  // Healthcare & biotech
  'UNH', 'JNJ', 'LLY', 'PFE', 'ABBV', 'MRK', 'BMY', 'GILD', 'AMGN', 'MRNA',
  // Energy & materials
  'XOM', 'CVX', 'COP', 'SLB', 'OXY', 'FSLR', 'ENPH', 'LNG',
  // Consumer
  'WMT', 'COST', 'HD', 'NKE', 'SBUX', 'MCD', 'DIS', 'ABNB', 'UBER', 'LYFT',
  // Industrial & transport
  'BA', 'CAT', 'DE', 'GE', 'HON', 'UPS', 'FDX', 'DAL', 'UAL',
  // High-beta / meme-adjacent
  'COIN', 'HOOD', 'PLTR', 'SOFI', 'RIVN', 'LCID', 'NIO', 'MARA', 'RIOT', 'SMCI',
  // ETFs for sector rotation signals
  'SPY', 'QQQ', 'IWM', 'XLF', 'XLE', 'XLK', 'XLV', 'ARKK',
];

const SCREENER_SYSTEM_PROMPT = `You are a market screener for an automated stock trading system.
You receive a list of candidate stocks with their market data (price, volume, % change, etc.)
and must rank them by trading opportunity quality.

Your response must be valid JSON with this structure:
{
  "watchlist": [
    {
      "symbol": "AAPL",
      "score": 0.0 to 1.0,
      "category": "momentum" | "breakout" | "bounce" | "volume_spike" | "sector_strength",
      "reasoning": "Brief 1-sentence explanation"
    }
  ],
  "market_theme": "1-sentence summary of what's driving the market today"
}

Rules:
- Return 20-35 symbols ranked by score (best first)
- Score 0.8+: strong setup, multiple confirming factors
- Score 0.5-0.8: decent opportunity, worth monitoring
- Score <0.5: weak, don't include
- Prefer stocks with: high relative volume, clean % moves (not choppy), price > $10
- Diversify across categories — don't return all momentum plays
- Filter out stocks that moved on earnings (gap + volume but unpredictable direction)
- Favor liquid names (>500k avg volume) for clean execution`;

class ScreenerAgent extends BaseAgent {
  constructor() {
    super('market-screener', { intervalMs: config.SCAN_INTERVAL_MS });
    // Start with user watchlist (runtime overrides or static default)
    this._dynamicWatchlist = this._getBaseWatchlist();
    this._candidates = [];
    this._marketTheme = '';
  }

  /**
   * Periodic analysis — discovers tradeable symbols from market data.
   */
  async analyze() {
    try {
      // Phase 1: Gather candidates from multiple sources in parallel
      const [mostActive, movers, pennyStocks] = await Promise.allSettled([
        alpaca.getMostActive(40),
        alpaca.getTopMovers('stocks', 30),
        getMostActivePennyStocks(15),
      ]);

      // Collect unique symbols from all sources
      const symbolSet = new Set();
      const pennySymbols = new Set();

      // Always include the static watchlist as a base
      for (const s of config.WATCHLIST) symbolSet.add(s);

      const screenerWorked = mostActive.status === 'fulfilled' && mostActive.value.length > 0;
      const moversWorked = movers.status === 'fulfilled' && movers.value.gainers?.length > 0;

      // Most active by volume
      if (screenerWorked) {
        for (const s of mostActive.value) symbolSet.add(s.symbol);
        log(`Screener: ${mostActive.value.length} most-active symbols from Alpaca`);
      }

      // Top gainers (momentum) + losers (bounce candidates)
      if (moversWorked) {
        for (const s of movers.value.gainers) symbolSet.add(s.symbol);
        for (const s of movers.value.losers.slice(0, 5)) symbolSet.add(s.symbol);
        log(`Screener: ${movers.value.gainers.length} gainers + ${Math.min(movers.value.losers.length, 5)} losers from Alpaca`);
      }

      // Discovery pool: supplement when live screener APIs are unavailable
      if (!screenerWorked || !moversWorked) {
        const poolBefore = symbolSet.size;
        for (const s of DISCOVERY_POOL) symbolSet.add(s);
        const added = symbolSet.size - poolBefore;
        log(`Screener: supplemented with ${added} symbols from discovery pool (most-active: ${screenerWorked ? 'ok' : 'unavailable'}, movers: ${moversWorked ? 'ok' : 'unavailable'})`);
      }

      // Yahoo penny stocks — tag them as penny_stock asset class
      if (pennyStocks.status === 'fulfilled' && pennyStocks.value.length > 0) {
        for (const p of pennyStocks.value) {
          symbolSet.add(p.symbol);
          pennySymbols.add(p.symbol);
          setSymbolClass(p.symbol, 'penny_stock');
        }
        log(`Screener: added ${pennyStocks.value.length} penny stocks from Yahoo`);
      }

      const allSymbols = [...symbolSet];
      log(`Screener: discovered ${allSymbols.length} candidate symbols (screener API: ${screenerWorked ? 'ok' : 'unavailable'}, movers API: ${moversWorked ? 'ok' : 'unavailable'})`);

      // Phase 2: Get snapshots for all candidates
      let snapshots = {};
      // Alpaca snapshots endpoint has a limit, batch in groups of 30
      for (let i = 0; i < allSymbols.length; i += 30) {
        const batch = allSymbols.slice(i, i + 30);
        try {
          const batchSnaps = await alpaca.getMultiSnapshots(batch);
          snapshots = { ...snapshots, ...batchSnaps };
        } catch (err) {
          error('Screener: snapshot batch failed', err);
        }
      }

      // Phase 3: Apply hard filters
      const candidates = [];
      for (const symbol of allSymbols) {
        const snap = snapshots[symbol];
        if (!snap) continue;

        // Price filter
        if (snap.price < FILTERS.MIN_PRICE || snap.price > FILTERS.MAX_PRICE) continue;

        // Volume filter (use daily volume as proxy)
        if (snap.volume < FILTERS.MIN_AVG_VOLUME) continue;

        const changePct = Math.abs(snap.changeFromPrevClose);

        candidates.push({
          symbol,
          price: +snap.price.toFixed(2),
          open: +snap.open.toFixed(2),
          high: +snap.high.toFixed(2),
          low: +snap.low.toFixed(2),
          volume: snap.volume,
          changePct: +snap.changeFromPrevClose.toFixed(2),
          absChangePct: +changePct.toFixed(2),
          gapPct: snap.open && snap.prevClose
            ? +((snap.open - snap.prevClose) / snap.prevClose * 100).toFixed(2)
            : 0,
          isFromWatchlist: config.WATCHLIST.includes(symbol),
        });
      }

      // Sort by absolute change descending
      candidates.sort((a, b) => b.absChangePct - a.absChangePct);
      const topCandidates = candidates.slice(0, FILTERS.MAX_CANDIDATES);

      this._candidates = topCandidates;

      // Phase 4: Claude ranks and categorizes
      let watchlist = topCandidates.map(c => ({
        symbol: c.symbol,
        score: c.absChangePct >= 3 ? 0.7 : c.absChangePct >= 1.5 ? 0.5 : 0.3,
        category: 'momentum',
        reasoning: `${c.changePct > 0 ? '+' : ''}${c.changePct}% on ${(c.volume / 1000).toFixed(0)}k vol`,
      }));
      let marketTheme = 'Rule-based screening only';

      try {
        const result = await askJson({
          agentName: this.name,
          systemPrompt: SCREENER_SYSTEM_PROMPT,
          userMessage: `Today's candidates (${topCandidates.length} stocks):\n${JSON.stringify(topCandidates, null, 2)}`,
          tier: 'fast',
          maxTokens: 3000,
        });

        if (result.data?.watchlist?.length > 0) {
          watchlist = result.data.watchlist;
          marketTheme = result.data.market_theme || marketTheme;
        }
      } catch (err) {
        error('Screener LLM call failed, using rule-based ranking', err);
      }

      // Build final dynamic watchlist — LLM picks + always include static/runtime watchlist
      watchlist.sort((a, b) => b.score - a.score);
      const llmSymbols = new Set(watchlist.map(w => w.symbol));

      // Always include the base watchlist (static + any runtime overrides)
      let baseWatchlist;
      try {
        const runtimeConfig = require('../runtime-config');
        baseWatchlist = runtimeConfig.get('WATCHLIST') || config.WATCHLIST;
      } catch {
        baseWatchlist = config.WATCHLIST;
      }
      for (const sym of baseWatchlist) {
        if (!llmSymbols.has(sym)) {
          watchlist.push({ symbol: sym, score: 0.4, category: 'watchlist', reasoning: 'User watchlist' });
        }
      }

      this._dynamicWatchlist = watchlist.map(w => w.symbol);
      this._marketTheme = marketTheme;

      const report = {
        symbol: null,
        signal: 'HOLD',
        confidence: 0.7,
        reasoning: `${marketTheme}. Screening ${candidates.length} candidates, selected ${watchlist.length} for analysis.`,
        data: {
          watchlist,
          marketTheme,
          candidateCount: candidates.length,
          sourceBreakdown: {
            staticWatchlist: config.WATCHLIST.length,
            mostActive: mostActive.status === 'fulfilled' ? mostActive.value.length : 0,
            gainers: movers.status === 'fulfilled' ? movers.value.gainers.length : 0,
            losers: movers.status === 'fulfilled' ? movers.value.losers.length : 0,
            pennyStocks: pennySymbols.size,
          },
        },
      };

      await this._persistReport(report);
      await messageBus.publish('REPORT', this.name, report);

      log(`Screener: dynamic watchlist = [${this._dynamicWatchlist.join(', ')}]`);

      return report;
    } catch (err) {
      error('Screener analysis failed', err);
      // Fallback to user watchlist
      const fallback = this._getBaseWatchlist();
      this._dynamicWatchlist = fallback;
      return {
        symbol: null,
        signal: 'HOLD',
        confidence: 0.3,
        reasoning: `Screener encountered an error. Monitoring base watchlist: ${fallback.join(', ')}`,
        data: { watchlist: fallback.map(s => ({ symbol: s, score: 0.5, category: 'watchlist', reasoning: 'Base watchlist' })) },
      };
    }
  }

  /**
   * Get the current dynamic watchlist for downstream agents.
   */
  getWatchlist() {
    return [...this._dynamicWatchlist];
  }

  /**
   * Get ranked candidates with scores.
   */
  getCandidates() {
    return [...this._candidates];
  }

  /**
   * Get today's market theme.
   */
  getMarketTheme() {
    return this._marketTheme;
  }

  _getBaseWatchlist() {
    try {
      const runtimeConfig = require('../runtime-config');
      return runtimeConfig.get('WATCHLIST') || [...config.WATCHLIST];
    } catch {
      return [...config.WATCHLIST];
    }
  }

  async _persistReport(report) {
    try {
      await db.query(
        `INSERT INTO agent_reports (agent_name, symbol, signal, confidence, reasoning, data)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [this.name, report.symbol, report.signal, report.confidence, report.reasoning, JSON.stringify(report.data)]
      );
    } catch (err) {
      error('Failed to persist screener report', err);
    }
  }
}

// Singleton
const screenerAgent = new ScreenerAgent();
screenerAgent.DISCOVERY_POOL = DISCOVERY_POOL;
screenerAgent.FILTERS = FILTERS;

module.exports = screenerAgent;
module.exports.DISCOVERY_POOL = DISCOVERY_POOL;
module.exports.FILTERS = FILTERS;
