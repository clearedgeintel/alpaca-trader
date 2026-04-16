/**
 * Unit tests for the multi-channel alerter — channel registration based
 * on env vars, severity filtering, dedup window, history ring buffer,
 * and the test-send helper.
 *
 * We mock global.fetch so we can assert which channels actually sent.
 */

jest.mock('../src/logger', () => ({
  log: () => {},
  warn: () => {},
  error: () => {},
  alert: () => {},
  runWithContext: (_ctx, fn) => fn(),
  newCorrelationId: () => 'test',
  getContext: () => ({ requestId: 'req_123' }),
}));

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.resetModules();
  global.fetch = jest.fn(async () => ({ ok: true, status: 200 }));
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  process.env = { ...ORIGINAL_ENV };
});

function loadAlerting() {
  // Force re-init with current env
  return require('../src/alerting');
}

describe('channel registration via env vars', () => {
  test('no env vars → no channels', () => {
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.WEBHOOK_URL;
    const a = loadAlerting();
    expect(a.getChannels()).toEqual([]);
  });

  test('SLACK_WEBHOOK_URL registers slack channel with default min=warn', () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.WEBHOOK_URL;
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
    delete process.env.SLACK_ALERT_MIN;
    const a = loadAlerting();
    const chans = a.getChannels();
    expect(chans).toEqual([{ name: 'slack', minimum: 'warn' }]);
  });

  test('all four channels register when env is fully populated', () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
    process.env.TELEGRAM_BOT_TOKEN = 'tok';
    process.env.TELEGRAM_CHAT_ID = 'chat';
    process.env.DISCORD_WEBHOOK_URL = 'https://discord.com/test';
    process.env.WEBHOOK_URL = 'https://example.com/hook';
    const a = loadAlerting();
    const names = a
      .getChannels()
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(['discord', 'slack', 'telegram', 'webhook']);
  });

  test('per-channel minimum severity is read from env', () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
    process.env.SLACK_ALERT_MIN = 'critical';
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.WEBHOOK_URL;
    const a = loadAlerting();
    expect(a.getChannels()[0].minimum).toBe('critical');
  });
});

describe('severity filtering', () => {
  test('alert below channel minimum is not sent', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
    process.env.SLACK_ALERT_MIN = 'critical';
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DISCORD_WEBHOOK_URL;
    delete process.env.WEBHOOK_URL;
    const a = loadAlerting();

    await a.info('low priority', 'msg');
    await a.warn('medium', 'msg');
    expect(global.fetch).not.toHaveBeenCalled();

    await a.critical('high priority', 'msg');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('alert at or above channel minimum is sent', async () => {
    process.env.WEBHOOK_URL = 'https://example.com/hook';
    process.env.WEBHOOK_ALERT_MIN = 'info';
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DISCORD_WEBHOOK_URL;
    const a = loadAlerting();

    await a.info('hello', 'msg');
    await a.warn('hello2', 'msg');
    await a.critical('hello3', 'msg');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
});

describe('dedup window', () => {
  test('repeated identical (severity, title) is suppressed within window', async () => {
    process.env.WEBHOOK_URL = 'https://example.com/hook';
    process.env.WEBHOOK_ALERT_MIN = 'info';
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DISCORD_WEBHOOK_URL;
    const a = loadAlerting();
    a._reset();

    await a.warn('Same title', 'first');
    await a.warn('Same title', 'second');
    await a.warn('Same title', 'third');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    // History records all attempts including suppressed ones
    expect(a.getHistory()).toHaveLength(3);
    expect(a.getHistory().filter((h) => h.suppressed)).toHaveLength(2);
  });

  test('different titles are not deduped together', async () => {
    process.env.WEBHOOK_URL = 'https://example.com/hook';
    process.env.WEBHOOK_ALERT_MIN = 'info';
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DISCORD_WEBHOOK_URL;
    const a = loadAlerting();
    a._reset();

    await a.warn('Title A', 'msg');
    await a.warn('Title B', 'msg');
    await a.warn('Title C', 'msg');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('different severities for the same title are not deduped together', async () => {
    process.env.WEBHOOK_URL = 'https://example.com/hook';
    process.env.WEBHOOK_ALERT_MIN = 'info';
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DISCORD_WEBHOOK_URL;
    const a = loadAlerting();
    a._reset();

    await a.info('Same title', 'msg');
    await a.warn('Same title', 'msg');
    await a.critical('Same title', 'msg');
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
});

describe('history', () => {
  test('records timestamp + metadata + correlation context', async () => {
    process.env.WEBHOOK_URL = 'https://example.com/hook';
    process.env.WEBHOOK_ALERT_MIN = 'info';
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DISCORD_WEBHOOK_URL;
    const a = loadAlerting();
    a._reset();

    await a.warn('Test alert', 'a message', { symbol: 'AAPL' });
    const h = a.getHistory();
    expect(h).toHaveLength(1);
    expect(h[0].title).toBe('Test alert');
    expect(h[0].metadata.symbol).toBe('AAPL');
    expect(h[0].metadata.requestId).toBe('req_123'); // from getContext mock
    expect(h[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test('limit parameter caps the result', async () => {
    process.env.WEBHOOK_URL = 'https://example.com/hook';
    process.env.WEBHOOK_ALERT_MIN = 'info';
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DISCORD_WEBHOOK_URL;
    const a = loadAlerting();
    a._reset();

    for (let i = 0; i < 10; i++) await a.info(`alert-${i}`, 'msg');
    expect(a.getHistory(3)).toHaveLength(3);
  });
});

describe('testSend', () => {
  test('sends to all channels regardless of severity floor', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
    process.env.SLACK_ALERT_MIN = 'critical';
    process.env.WEBHOOK_URL = 'https://example.com/hook';
    process.env.WEBHOOK_ALERT_MIN = 'critical';
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DISCORD_WEBHOOK_URL;
    const a = loadAlerting();

    const result = await a.testSend();
    expect(result.sentTo.sort()).toEqual(['slack', 'webhook']);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('sends only to the named channel when one is specified', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
    process.env.WEBHOOK_URL = 'https://example.com/hook';
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DISCORD_WEBHOOK_URL;
    const a = loadAlerting();

    const result = await a.testSend('webhook');
    expect(result.sentTo).toEqual(['webhook']);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('failure isolation', () => {
  test('one channel throwing does not block other channels', async () => {
    process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/test';
    process.env.SLACK_ALERT_MIN = 'info';
    process.env.WEBHOOK_URL = 'https://example.com/hook';
    process.env.WEBHOOK_ALERT_MIN = 'info';
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DISCORD_WEBHOOK_URL;
    const a = loadAlerting();
    a._reset();

    // First fetch (slack) throws; webhook should still fire
    let calls = 0;
    global.fetch = jest.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('slack down');
      return { ok: true };
    });

    await expect(a.warn('Issue', 'message')).resolves.not.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
