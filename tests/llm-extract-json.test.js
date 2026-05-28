/**
 * Coverage for extractJson's synthetic-close recovery. The function is
 * private to llm.js — we import the module and exercise it through
 * askJson with a stubbed response, which is the same path agents hit.
 *
 * The TA "verdicts" shape that prompted this test:
 *   { "verdicts": { "AAPL": {...}, "MSFT": {...}, "GOOG": {...
 * Inter-symbol commas live at depth=2 (inside "verdicts"), so the
 * first recovery attempt that only tracked depth=1 commas could never
 * salvage these — every cycle threw and Quant fell back to HOLD@0.30.
 */

// Mock metrics + alerting before requiring llm.js so module init doesn't
// pull external dependencies.
jest.mock('../src/metrics', () => ({
  llmCallsTotal: { inc: () => {} },
  llmTokensTotal: { inc: () => {} },
  llmCostUsdTotal: { inc: () => {} },
  llmJsonRetriesTotal: { inc: () => {} },
}));
jest.mock('../src/alerting', () => ({
  warn: () => {},
  critical: () => {},
}));
jest.mock('../src/logger', () => ({
  log: () => {},
  warn: () => {},
  error: () => {},
  runWithContext: (_c, fn) => fn(),
  newCorrelationId: () => 'test',
  getContext: () => ({}),
}));

// Replace the Anthropic client with one that returns canned text so we
// drive extractJson directly via askJson.
let cannedResponseText = '';
jest.mock('@anthropic-ai/sdk', () => {
  return function Anthropic() {
    return {
      messages: {
        create: async () => ({
          content: [{ type: 'text', text: cannedResponseText }],
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
      },
    };
  };
});

process.env.ANTHROPIC_API_KEY = 'test-key';
const llm = require('../src/agents/llm');

describe('extractJson synthetic-close recovery', () => {
  test('truncated TA verdicts at depth 2 — salvages complete entries', async () => {
    // Two complete verdicts, third truncated mid-string. Built via
    // concatenation so the file itself stays syntactically valid.
    cannedResponseText =
      '{ "verdicts": {' +
      '"AAPL": { "signal": "BUY", "confidence": 0.7 },' +
      '"MSFT": { "signal": "HOLD", "confidence": 0.5 },' +
      '"GOOG": { "signal": "SE';

    const result = await llm.askJson({
      agentName: 'test-ta',
      systemPrompt: 'test',
      userMessage: 'test',
      retryOnce: false,
    });

    expect(result.data).not.toBeNull();
    expect(result.data.verdicts).toBeDefined();
    expect(result.data.verdicts.AAPL).toEqual({ signal: 'BUY', confidence: 0.7 });
    expect(result.data.verdicts.MSFT).toEqual({ signal: 'HOLD', confidence: 0.5 });
    expect(result.data.verdicts.GOOG).toBeUndefined();
  });

  test('truncated array — recovery maximally salvages (complete + partial)', async () => {
    // Recovery walks back to the deepest safe comma. For arrays of
    // multi-field objects this means a partial trailing object IS
    // included (missing some fields). That's intentional — Zod
    // passthrough() + agent field-level fallbacks tolerate partial
    // objects, and salvaging more is strictly better than throwing.
    cannedResponseText =
      '{"alerts": [' +
      '{"symbol": "AAPL", "impact": "bullish"},' +
      '{"symbol": "MSFT", "impact": "bea';

    const result = await llm.askJson({
      agentName: 'test-news',
      systemPrompt: 'test',
      userMessage: 'test',
      retryOnce: false,
    });

    expect(result.data).not.toBeNull();
    expect(result.data.alerts).toHaveLength(2);
    expect(result.data.alerts[0]).toEqual({ symbol: 'AAPL', impact: 'bullish' });
    // 2nd element is partial — has symbol but `impact` was truncated mid-string
    expect(result.data.alerts[1]).toEqual({ symbol: 'MSFT' });
  });

  test('complete JSON — passes through untouched', async () => {
    cannedResponseText = '{"verdicts": {"AAPL": {"signal": "BUY"}}}';

    const result = await llm.askJson({
      agentName: 'test',
      systemPrompt: 'test',
      userMessage: 'test',
      retryOnce: false,
    });

    expect(result.data).toEqual({ verdicts: { AAPL: { signal: 'BUY' } } });
  });

  test('truncation before any comma — falls through to error with diagnostic', async () => {
    // Single-entry truncation can't be recovered.
    cannedResponseText = '{"verdicts": {"AAPL": {"signal": "BUY';

    const result = await llm.askJson({
      agentName: 'test',
      systemPrompt: 'test',
      userMessage: 'test',
      retryOnce: false,
    });

    expect(result.data).toBeNull();
    expect(result.parseError).toMatch(/unclosed brackets/);
    expect(result.parseError).toMatch(/ends:/);
  });
});
