const { ask } = require('./agents/llm');
const db = require('./db');
const alpaca = require('./alpaca');
const config = require('./config');
const { log, error } = require('./logger');

const CHAT_SYSTEM_PROMPT = `You are an AI trading assistant for the Alpaca Auto Trader system.
You have access to live portfolio data, trade history, agent reports, and market information.

Your role:
- Answer questions about the portfolio, positions, trades, and strategy
- Explain why trades were taken or skipped
- Provide market analysis and trading insights
- Help the user understand their P&L, risk exposure, and agent decisions
- Suggest watchlist changes or strategy adjustments when asked

Be concise, data-driven, and specific. Use numbers from the context provided.
If you don't have enough data to answer, say so rather than guessing.
Format currency as $X,XXX.XX and percentages as X.X%.`;

/**
 * Answer a user question with full portfolio context.
 */
async function chat(question) {
  // Gather context in parallel
  const [account, openTrades, recentClosed, recentSignals, recentDecisions, performance] = await Promise.all([
    alpaca.getAccount().catch(() => null),
    db.query("SELECT * FROM trades WHERE status = 'open' ORDER BY created_at DESC").catch(() => ({ rows: [] })),
    db.query("SELECT * FROM trades WHERE status = 'closed' ORDER BY closed_at DESC LIMIT 10").catch(() => ({ rows: [] })),
    db.query("SELECT * FROM signals ORDER BY created_at DESC LIMIT 10").catch(() => ({ rows: [] })),
    db.query("SELECT * FROM agent_decisions ORDER BY created_at DESC LIMIT 5").catch(() => ({ rows: [] })),
    db.query("SELECT * FROM daily_performance ORDER BY trade_date DESC LIMIT 7").catch(() => ({ rows: [] })),
  ]);

  // Build context summary
  const context = {
    account: account || { portfolio_value: 'unknown', buying_power: 'unknown', cash: 'unknown' },
    openPositions: openTrades.rows.map(t => ({
      symbol: t.symbol,
      qty: t.qty,
      entry: t.entry_price,
      current: t.current_price,
      stop: t.stop_loss,
      target: t.take_profit,
      trailingStop: t.trailing_stop,
      pnl: t.current_price && t.entry_price ? ((parseFloat(t.current_price) - parseFloat(t.entry_price)) * t.qty).toFixed(2) : 'unknown',
    })),
    recentClosedTrades: recentClosed.rows.map(t => ({
      symbol: t.symbol,
      pnl: t.pnl,
      pnlPct: t.pnl_pct,
      exitReason: t.exit_reason,
      closedAt: t.closed_at,
    })),
    recentSignals: recentSignals.rows.map(s => ({
      symbol: s.symbol,
      signal: s.signal,
      rsi: s.rsi,
      volumeRatio: s.volume_ratio,
      actedOn: s.acted_on,
      createdAt: s.created_at,
    })),
    recentDecisions: recentDecisions.rows.map(d => ({
      symbol: d.symbol,
      action: d.action,
      confidence: d.confidence,
      reasoning: d.reasoning?.slice(0, 200),
    })),
    weeklyPerformance: performance.rows.map(p => ({
      date: p.trade_date,
      trades: p.total_trades,
      pnl: p.total_pnl,
      winRate: p.win_rate,
      portfolioValue: p.portfolio_value,
    })),
    config: {
      mode: config.USE_AGENCY ? 'agency' : 'legacy',
      watchlist: config.WATCHLIST,
      riskPct: config.RISK_PCT,
      stopPct: config.STOP_PCT,
      targetPct: config.TARGET_PCT,
    },
  };

  const userMessage = `Portfolio context:\n${JSON.stringify(context, null, 2)}\n\nUser question: ${question}`;

  const result = await ask({
    agentName: 'chat',
    systemPrompt: CHAT_SYSTEM_PROMPT,
    userMessage,
    tier: 'standard', // Use Sonnet for better conversational quality
    maxTokens: 1024,
  });

  return {
    answer: result.text,
    tokensUsed: result.inputTokens + result.outputTokens,
  };
}

module.exports = { chat };
