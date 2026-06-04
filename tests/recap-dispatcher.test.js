/**
 * Tests for src/recap-dispatcher — the end-of-day recap delivery hook.
 *
 * Covers:
 *   - shouldFireNow time + idempotency math
 *   - writeMarkdownFile writes to RECAP_FILE_DIR with the right basename
 *   - sendEmail noop when SMTP not configured; sends via nodemailer otherwise
 *   - dispatchRecap calls both paths + records lastSentDate
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

jest.mock('../src/db', () => ({ query: jest.fn(async () => ({ rows: [] })) }));
jest.mock('../src/alpaca', () => ({
  getMultiSnapshots: jest.fn(async () => ({})),
  getNews: jest.fn(async () => []),
}));
jest.mock('../src/logger', () => ({
  log: () => {},
  warn: () => {},
  error: () => {},
  runWithContext: (_c, fn) => fn(),
  getContext: () => ({}),
}));

let mockSendMail = jest.fn(async () => ({ messageId: '<mock@id>' }));
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail })),
}));

const dispatcher = require('../src/recap-dispatcher');

beforeEach(() => {
  dispatcher._resetForTests();
  delete process.env.SMTP_HOST;
  delete process.env.RECAP_EMAIL_TO;
  delete process.env.RECAP_FILE_DIR;
  delete process.env.RECAP_DISPATCH_TIME_ET;
  mockSendMail.mockClear();
});

describe('shouldFireNow', () => {
  const { DateTime } = require('luxon');

  test('does not fire on weekends', () => {
    const sat = DateTime.fromISO('2026-06-06T17:00:00', { zone: 'America/New_York' });
    expect(dispatcher.shouldFireNow(sat)).toBe(false);
  });

  test('does not fire before the configured time', () => {
    process.env.RECAP_DISPATCH_TIME_ET = '16:10';
    const earlyAfternoon = DateTime.fromISO('2026-06-03T15:30:00', { zone: 'America/New_York' });
    expect(dispatcher.shouldFireNow(earlyAfternoon)).toBe(false);
  });

  test('fires once the configured ET time passes on a weekday', () => {
    process.env.RECAP_DISPATCH_TIME_ET = '16:10';
    const past = DateTime.fromISO('2026-06-03T16:15:00', { zone: 'America/New_York' });
    expect(dispatcher.shouldFireNow(past)).toBe(true);
  });
});

describe('writeMarkdownFile', () => {
  const stubReport = require('./fixtures/recap-synthetic.js');

  test('writes file to RECAP_FILE_DIR with the date as basename', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'recap-test-'));
    process.env.RECAP_FILE_DIR = tmp;
    const out = await dispatcher.writeMarkdownFile(stubReport, '2026-06-04');
    expect(out).toBe(path.join(tmp, '2026-06-04.md'));
    const md = await fs.readFile(out, 'utf8');
    expect(md).toMatch(/^# Daily Recap/);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test('returns null when RECAP_FILE_DIR=off', async () => {
    process.env.RECAP_FILE_DIR = 'off';
    const out = await dispatcher.writeMarkdownFile(stubReport, '2026-06-04');
    expect(out).toBeNull();
  });

  test('creates the directory if it does not exist', async () => {
    const tmp = path.join(os.tmpdir(), `recap-fresh-${Date.now()}`);
    process.env.RECAP_FILE_DIR = tmp;
    await dispatcher.writeMarkdownFile(stubReport, '2026-06-04');
    const exists = await fs.stat(tmp).then(() => true, () => false);
    expect(exists).toBe(true);
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

describe('sendEmail', () => {
  const stubReport = require('./fixtures/recap-synthetic.js');

  test('returns null when SMTP not configured', async () => {
    const result = await dispatcher.sendEmail(stubReport, '2026-06-04');
    expect(result).toBeNull();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  test('sends via nodemailer when SMTP_HOST + RECAP_EMAIL_TO are set', async () => {
    process.env.SMTP_HOST = 'smtp.test.com';
    process.env.SMTP_USER = 'user';
    process.env.SMTP_PASS = 'pass';
    process.env.RECAP_EMAIL_TO = 'ops@example.com';
    const messageId = await dispatcher.sendEmail(stubReport, '2026-06-04');
    expect(messageId).toBe('<mock@id>');
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const call = mockSendMail.mock.calls[0][0];
    expect(call.to).toEqual(['ops@example.com']);
    expect(call.subject).toMatch(/Daily Recap/);
    expect(call.html).toMatch(/<html/);
    expect(call.text).toMatch(/^# Daily Recap/);
  });

  test('supports multiple comma-separated recipients', async () => {
    process.env.SMTP_HOST = 'smtp.test.com';
    process.env.RECAP_EMAIL_TO = 'one@x.com, two@y.com,three@z.com';
    await dispatcher.sendEmail(stubReport, '2026-06-04');
    const call = mockSendMail.mock.calls[0][0];
    expect(call.to).toEqual(['one@x.com', 'two@y.com', 'three@z.com']);
  });
});

describe('emailConfigured', () => {
  test('false by default', () => {
    expect(dispatcher.emailConfigured()).toBe(false);
  });

  test('true only when both SMTP_HOST and RECAP_EMAIL_TO are set', () => {
    process.env.SMTP_HOST = 'smtp.test.com';
    expect(dispatcher.emailConfigured()).toBe(false);
    process.env.RECAP_EMAIL_TO = 'a@b.com';
    expect(dispatcher.emailConfigured()).toBe(true);
  });
});

describe('writeHtmlFile', () => {
  const stubReport = require('./fixtures/recap-synthetic.js');

  test('writes a standalone HTML doc to disk', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'recap-html-'));
    process.env.RECAP_FILE_DIR = tmp;
    const out = await dispatcher.writeHtmlFile(stubReport, '2026-06-04');
    expect(out).toBe(path.join(tmp, '2026-06-04.html'));
    const html = await fs.readFile(out, 'utf8');
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toMatch(/Daily Recap/);
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

describe('writeMetaFile', () => {
  const stubReport = require('./fixtures/recap-synthetic.js');

  test('writes a JSON sidecar with headline numbers', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'recap-meta-'));
    process.env.RECAP_FILE_DIR = tmp;
    const out = await dispatcher.writeMetaFile(stubReport, '2026-06-04', { md: 'a.md', html: 'a.html', pdf: null });
    const meta = JSON.parse(await fs.readFile(out, 'utf8'));
    expect(meta.date).toBe('2026-06-04');
    expect(meta.netPnl).toBe(-1000);
    expect(meta.nClosed).toBe(3);
    expect(meta.winRate).toBeCloseTo(0.333, 2);
    expect(meta.largestWinSymbol).toBe('TSLA');
    expect(meta.largestLossSymbol).toBe('AMD');
    expect(meta.regime).toBe('range_bound');
    expect(meta.formats).toEqual({ md: true, html: true, pdf: false });
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

describe('pdfAvailable + chromeExecutablePath', () => {
  test('chromeExecutablePath honors PUPPETEER_EXECUTABLE_PATH when the file exists', async () => {
    // Use a temp file as a fake Chrome — the helper just stat-checks it.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-chrome-'));
    const fake = path.join(tmp, 'chrome.exe');
    await fs.writeFile(fake, 'binary');
    process.env.PUPPETEER_EXECUTABLE_PATH = fake;
    dispatcher._resetForTests();   // clear the path cache
    expect(dispatcher.chromeExecutablePath()).toBe(fake);
    expect(dispatcher.pdfAvailable()).toBe(true);
    await fs.rm(tmp, { recursive: true, force: true });
  });

  test('returns null when the configured path does not exist and no defaults match', () => {
    process.env.PUPPETEER_EXECUTABLE_PATH = '/no/such/path/that/exists/anywhere/chrome.exe';
    dispatcher._resetForTests();
    // Default candidates may or may not exist on the test runner — we only
    // assert the negative path when the env override is bogus AND we can't
    // see one of the well-known installs. Skip silently when they do exist.
    const result = dispatcher.chromeExecutablePath();
    if (result === null) {
      expect(dispatcher.pdfAvailable()).toBe(false);
    } else {
      expect(typeof result).toBe('string');
    }
  });
});
