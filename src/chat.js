const db = require('./db');
const alpaca = require('./alpaca');
const config = require('./config');
const { log, error } = require('./logger');
const { trackUsage, isAvailable, getClient, BudgetExhaustedError } = require('./agents/llm');

const MODEL = 'claude-sonnet-4-6';
const MAX_TURNS = 8;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min
const MAX_HISTORY = 40; // max messages kept per session

// In-memory conversation sessions: sessionId -> { messages, lastAccess }
const sessions = new Map();

const SYSTEM_PROMPT = `You are an AI trading assistant for the Alpaca Auto Trader system (paper trading account).

You have tools to query live portfolio data, market prices, trade history, agent reports, and place/close orders.
Use these tools to answer questions accurately — don't guess when you can look up data.

Guidelines:
- Be concise, data-driven, and specific. Use real numbers.
- Format currency as $X,XXX.XX and percentages as X.X%.
- For order placement: ALWAYS confirm the details with the user before placing. This is a paper account but treat it seriously.
- If a tool call fails, tell the user what went wrong.
- When asked about strategy or agents, query the relevant DB tables.

Current config: ${config.USE_AGENCY ? 'Agency mode (multi-agent)' : 'Legacy scanner mode'}, watchlist: ${config.WATCHLIST.join(', ')}.`;

// Tool definitions for Claude
const TOOLS = [
  {
    name: 'get_account',
    description: 'Get account info: portfolio value, cash, buying power, equity, PDT status',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_positions',
    description: 'Get all currently open positions with unrealized P&L',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_position',
    description: 'Get a specific open position by symbol',
    input_schema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  },
  {
    name: 'get_quote',
    description: 'Get latest quote (bid/ask/last price) for a stock symbol',
    input_schema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  },
  {
    name: 'get_snapshot',
    description: 'Get full snapshot for a symbol: latest trade, quote, minute bar, daily bar, prev daily bar',
    input_schema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  },
  {
    name: 'get_bars',
    description: 'Get OHLCV price bars for a symbol. Timeframe examples: 5Min, 15Min, 1Hour, 1Day',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        timeframe: { type: 'string', default: '1Day' },
        limit: { type: 'number', default: 20 },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_orders',
    description: 'Get recent orders. Status: open, closed, all',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', default: 'all' },
        limit: { type: 'number', default: 10 },
      },
      required: [],
    },
  },
  {
    name: 'get_news',
    description: 'Get recent news articles for given symbols',
    input_schema: {
      type: 'object',
      properties: {
        symbols: { type: 'array', items: { type: 'string' } },
        limit: { type: 'number', default: 5 },
      },
      required: ['symbols'],
    },
  },
  {
    name: 'get_market_movers',
    description: 'Get top market movers (gainers and losers)',
    input_schema: {
      type: 'object',
      properties: { market_type: { type: 'string', enum: ['stocks', 'crypto'], default: 'stocks' } },
      required: [],
    },
  },
  {
    name: 'get_most_active',
    description: 'Get most active stocks by volume',
    input_schema: {
      type: 'object',
      properties: { top: { type: 'number', default: 10 } },
      required: [],
    },
  },
  {
    name: 'query_trades',
    description: 'Query trade history from DB. Status: open, closed, or all. Returns symbol, qty, entry/exit prices, P&L, exit reason.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', default: 'all' },
        limit: { type: 'number', default: 10 },
        symbol: { type: 'string', description: 'Filter by symbol (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'query_signals',
    description: 'Query recent signals from DB. Returns symbol, signal type, RSI, volume ratio, whether acted on.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number', default: 10 }, symbol: { type: 'string' } },
      required: [],
    },
  },
  {
    name: 'query_decisions',
    description: 'Query recent agent orchestrator decisions. Returns symbol, action, confidence, reasoning, supporting/dissenting agents.',
    input_schema: {
      type: 'object',
      properties: { limit: { type: 'number', default: 10 } },
      required: [],
    },
  },
  {
    name: 'query_performance',
    description: 'Query daily performance history: date, total trades, P&L, win rate, portfolio value.',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'number', default: 7 } },
      required: [],
    },
  },
  {
    name: 'query_agent_metrics',
    description: 'Query agent performance metrics: latency, LLM cost, errors, signals produced per agent.',
    input_schema: {
      type: 'object',
      properties: { agent_name: { type: 'string' }, limit: { type: 'number', default: 10 } },
      required: [],
    },
  },
  {
    name: 'place_order',
    description: 'Place a market order. Side: buy or sell. ONLY use after confirming with the user.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        qty: { type: 'number' },
        side: { type: 'string', enum: ['buy', 'sell'] },
      },
      required: ['symbol', 'qty', 'side'],
    },
  },
  {
    name: 'place_bracket_order',
    description: 'Place a bracket order with stop-loss and take-profit. ONLY use after confirming with the user.',
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string' },
        qty: { type: 'number' },
        side: { type: 'string', enum: ['buy', 'sell'] },
        stop_price: { type: 'number' },
        take_profit_price: { type: 'number' },
      },
      required: ['symbol', 'qty', 'side', 'stop_price', 'take_profit_price'],
    },
  },
  {
    name: 'close_position',
    description: 'Close an open position entirely. ONLY use after confirming with the user.',
    input_schema: {
      type: 'object',
      properties: { symbol: { type: 'string' } },
      required: ['symbol'],
    },
  },
  {
    name: 'get_clock',
    description: 'Get market clock: is market open, next open/close times',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

// Tool execution
async function executeTool(name, input) {
  switch (name) {
    case 'get_account':
      return await alpaca.getAccount();
    case 'get_positions':
      return await alpaca.getPositions();
    case 'get_position':
      return await alpaca.getPosition(input.symbol);
    case 'get_quote': {
      const snap = await alpaca.getSnapshot(input.symbol);
      return { symbol: input.symbol, latestTrade: snap.latestTrade, latestQuote: snap.latestQuote };
    }
    case 'get_snapshot':
      return await alpaca.getSnapshot(input.symbol);
    case 'get_bars':
      return await alpaca.getBars(input.symbol, input.timeframe || '1Day', input.limit || 20);
    case 'get_orders':
      return await alpaca.getOrders(input.status || 'all', input.limit || 10);
    case 'get_news':
      return await alpaca.getNews(input.symbols, input.limit || 5);
    case 'get_market_movers':
      return await alpaca.getTopMovers(input.market_type || 'stocks');
    case 'get_most_active':
      return await alpaca.getMostActive(input.top || 10);
    case 'query_trades': {
      let sql = 'SELECT * FROM trades';
      const params = [];
      const where = [];
      if (input.status && input.status !== 'all') { where.push(`status = $${params.length + 1}`); params.push(input.status); }
      if (input.symbol) { where.push(`symbol = $${params.length + 1}`); params.push(input.symbol.toUpperCase()); }
      if (where.length) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
      params.push(input.limit || 10);
      return (await db.query(sql, params)).rows;
    }
    case 'query_signals': {
      let sql = 'SELECT * FROM signals';
      const params = [];
      if (input.symbol) { sql += ' WHERE symbol = $1'; params.push(input.symbol.toUpperCase()); }
      sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
      params.push(input.limit || 10);
      return (await db.query(sql, params)).rows;
    }
    case 'query_decisions': {
      const sql = 'SELECT * FROM agent_decisions ORDER BY created_at DESC LIMIT $1';
      return (await db.query(sql, [input.limit || 10])).rows;
    }
    case 'query_performance': {
      const sql = 'SELECT * FROM daily_performance ORDER BY trade_date DESC LIMIT $1';
      return (await db.query(sql, [input.days || 7])).rows;
    }
    case 'query_agent_metrics': {
      let sql = 'SELECT * FROM agent_metrics';
      const params = [];
      if (input.agent_name) { sql += ' WHERE agent_name = $1'; params.push(input.agent_name); }
      sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1);
      params.push(input.limit || 10);
      return (await db.query(sql, params)).rows;
    }
    case 'place_order':
      return await alpaca.placeOrder(input.symbol, input.qty, input.side);
    case 'place_bracket_order':
      return await alpaca.placeBracketOrder(input.symbol, input.qty, input.side, input.stop_price, input.take_profit_price);
    case 'close_position':
      return await alpaca.closePosition(input.symbol);
    case 'get_clock': {
      const resp = await fetch(`${config.ALPACA_BASE_URL}/v2/clock`, {
        headers: { 'APCA-API-KEY-ID': process.env.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET },
      });
      return await resp.json();
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

/**
 * Expire stale sessions.
 */
function cleanSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastAccess > SESSION_TTL_MS) sessions.delete(id);
  }
}

/**
 * Conversational chat with tool-use loop and session memory.
 * Claude can call Alpaca/DB tools to answer questions or take actions.
 */
async function chat(question, sessionId) {
  if (!isAvailable()) {
    throw new BudgetExhaustedError('daily budget exhausted');
  }

  cleanSessions();

  // Get or create session
  let session = sessions.get(sessionId);
  if (!session) {
    session = { messages: [], lastAccess: Date.now() };
    sessions.set(sessionId, session);
  }
  session.lastAccess = Date.now();

  // Append user message to history
  session.messages.push({ role: 'user', content: question });

  // Trim old messages if history is too long (keep system context manageable)
  while (session.messages.length > MAX_HISTORY) {
    session.messages.shift();
  }

  const anthropic = getClient();
  let totalInput = 0;
  let totalOutput = 0;
  let toolCalls = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: session.messages,
    });

    totalInput += response.usage?.input_tokens || 0;
    totalOutput += response.usage?.output_tokens || 0;

    // Check if Claude wants to use tools
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const textBlocks = response.content.filter(b => b.type === 'text').map(b => b.text).join('');

    if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
      // Final answer — save assistant response to history
      session.messages.push({ role: 'assistant', content: response.content });
      trackUsage('chat', MODEL, totalInput, totalOutput);
      return {
        answer: textBlocks,
        tokensUsed: totalInput + totalOutput,
        toolCalls,
      };
    }

    // Execute tool calls — add to session history
    session.messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const toolBlock of toolUseBlocks) {
      let result;
      try {
        log(`Chat tool call: ${toolBlock.name}(${JSON.stringify(toolBlock.input)})`);
        result = await executeTool(toolBlock.name, toolBlock.input);
        toolCalls.push({ tool: toolBlock.name, input: toolBlock.input, success: true });
      } catch (err) {
        error(`Chat tool ${toolBlock.name} failed`, err);
        result = { error: err.message };
        toolCalls.push({ tool: toolBlock.name, input: toolBlock.input, success: false, error: err.message });
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolBlock.id,
        content: JSON.stringify(result),
      });
    }

    session.messages.push({ role: 'user', content: toolResults });
  }

  // Max turns reached
  trackUsage('chat', MODEL, totalInput, totalOutput);
  return {
    answer: 'I ran into the maximum number of steps. Could you try a simpler question?',
    tokensUsed: totalInput + totalOutput,
    toolCalls,
  };
}

module.exports = { chat };
