const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Alpaca Auto Trader API',
      version: '2.0.0',
      description:
        'Automated trading bot with multi-agent AI orchestration. Supports paper and live trading via Alpaca Markets.',
    },
    servers: [{ url: '/api', description: 'Local API' }],
    tags: [
      { name: 'Status', description: 'Health and status endpoints' },
      { name: 'Account', description: 'Alpaca account data' },
      { name: 'Trades', description: 'Trade management' },
      { name: 'Signals', description: 'Scanner signals' },
      { name: 'Agents', description: 'AI agent status and reports' },
      { name: 'Decisions', description: 'Orchestrator decisions' },
      { name: 'Analytics', description: 'Portfolio analytics and backtesting' },
      { name: 'Config', description: 'Configuration and strategy management' },
      { name: 'Export', description: 'Data export endpoints' },
    ],
    paths: {
      '/status': {
        get: {
          tags: ['Status'],
          summary: 'App health and market status',
          responses: { 200: { description: 'Status object with market_open flag, last_scan time, uptime' } },
        },
      },
      '/account': {
        get: {
          tags: ['Account'],
          summary: 'Live Alpaca account data',
          responses: { 200: { description: 'Portfolio value, buying power, cash' } },
        },
      },
      '/positions': {
        get: {
          tags: ['Account'],
          summary: 'Open positions from Alpaca',
          responses: { 200: { description: 'Array of position objects' } },
        },
      },
      '/trades': {
        get: {
          tags: ['Trades'],
          summary: 'All trades',
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'closed', 'cancelled'] } },
          ],
          responses: { 200: { description: 'Array of trades' } },
        },
      },
      '/trades/{id}': {
        get: {
          tags: ['Trades'],
          summary: 'Single trade detail',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Trade object' } },
        },
      },
      '/signals': {
        get: {
          tags: ['Signals'],
          summary: 'Recent scanner signals',
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } }],
          responses: { 200: { description: 'Array of signals' } },
        },
      },
      '/performance': {
        get: {
          tags: ['Analytics'],
          summary: 'Daily performance records',
          responses: { 200: { description: 'Array of daily performance rows' } },
        },
      },
      '/analytics': {
        get: {
          tags: ['Analytics'],
          summary: 'Computed portfolio metrics',
          description: 'Equity curve, drawdown, Sharpe ratio, per-symbol and per-exit-reason breakdowns',
          responses: { 200: { description: 'Analytics data object' } },
        },
      },
      '/backtest': {
        post: {
          tags: ['Analytics'],
          summary: 'Run historical backtest',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    symbols: { type: 'array', items: { type: 'string' } },
                    days: { type: 'integer', default: 90 },
                    riskPct: { type: 'number' },
                    stopPct: { type: 'number' },
                    targetPct: { type: 'number' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Backtest results with summary, trades, equity curve' } },
        },
      },
      '/agents': {
        get: {
          tags: ['Agents'],
          summary: 'All agent statuses + LLM usage',
          responses: { 200: { description: 'Agent status array and LLM usage stats' } },
        },
      },
      '/agents/risk/report': {
        get: {
          tags: ['Agents'],
          summary: 'Risk manager latest report',
          responses: { 200: { description: 'Risk report with portfolio heat, sector exposure' } },
        },
      },
      '/agents/regime/report': {
        get: {
          tags: ['Agents'],
          summary: 'Market regime classification',
          responses: { 200: { description: 'Regime report + current adjusted params' } },
        },
      },
      '/agents/technical/report': {
        get: {
          tags: ['Agents'],
          summary: 'Technical analysis reports',
          parameters: [{ name: 'symbol', in: 'query', schema: { type: 'string' } }],
          responses: { 200: { description: 'TA report for one or all symbols' } },
        },
      },
      '/agents/news/report': {
        get: {
          tags: ['Agents'],
          summary: 'News sentiment + alerts',
          responses: { 200: { description: 'News report and critical alerts' } },
        },
      },
      '/agents/screener/report': {
        get: {
          tags: ['Agents'],
          summary: 'Market screener dynamic watchlist',
          responses: { 200: { description: 'Screener report, candidates, market theme' } },
        },
      },
      '/agents/orchestrator/report': {
        get: {
          tags: ['Agents'],
          summary: 'Orchestrator current cycle report',
          responses: { 200: { description: 'Orchestrator report + live decisions' } },
        },
      },
      '/decisions': {
        get: {
          tags: ['Decisions'],
          summary: 'Recent orchestrator decisions',
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } }],
          responses: { 200: { description: 'Array of decisions' } },
        },
      },
      '/decisions/timeline': {
        get: {
          tags: ['Decisions'],
          summary: 'Decision timeline with trade outcomes',
          parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } }],
          responses: { 200: { description: 'Decisions joined with trade P&L' } },
        },
      },
      '/correlation': {
        get: {
          tags: ['Analytics'],
          summary: 'Correlation matrix for open positions',
          responses: { 200: { description: 'Correlation matrix and high-correlation pairs' } },
        },
      },
      '/config': {
        get: {
          tags: ['Config'],
          summary: 'Current runtime configuration',
          responses: { 200: { description: 'Watchlist, risk params, strategies, asset classes' } },
        },
      },
      '/strategies': {
        get: {
          tags: ['Config'],
          summary: 'Strategy assignments',
          responses: { 200: { description: 'Default strategy and per-symbol overrides' } },
        },
        put: {
          tags: ['Config'],
          summary: 'Set default strategy',
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { default: { type: 'string', enum: ['rules', 'llm', 'hybrid'] } },
                },
              },
            },
          },
          responses: { 200: { description: 'Updated default' } },
        },
      },
      '/strategies/{symbol}': {
        put: {
          tags: ['Config'],
          summary: 'Set strategy for a symbol',
          parameters: [{ name: 'symbol', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { mode: { type: 'string', enum: ['rules', 'llm', 'hybrid'] } } },
              },
            },
          },
          responses: { 200: { description: 'Updated strategy' } },
        },
        delete: {
          tags: ['Config'],
          summary: 'Remove symbol strategy override',
          parameters: [{ name: 'symbol', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Override removed' } },
        },
      },
      '/asset-classes': {
        get: {
          tags: ['Config'],
          summary: 'Asset class risk profiles',
          responses: { 200: { description: 'All asset classes with per-class params' } },
        },
      },
      '/trading-mode': {
        get: {
          tags: ['Config'],
          summary: 'Paper vs live trading mode',
          responses: { 200: { description: 'Current trading mode and Alpaca base URL' } },
        },
      },
      '/export/trades': {
        get: {
          tags: ['Export'],
          summary: 'Export trades as CSV',
          responses: { 200: { description: 'CSV file download' } },
        },
      },
      '/export/taxlots': {
        get: {
          tags: ['Export'],
          summary: 'Export FIFO tax lots as CSV',
          responses: { 200: { description: 'CSV file download' } },
        },
      },
    },
  },
  apis: [],
};

const spec = swaggerJsdoc(options);

function setupSwagger(app) {
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customCss: '.swagger-ui .topbar { display: none }',
      customSiteTitle: 'Alpaca Trader API Docs',
    }),
  );
}

module.exports = { setupSwagger };
