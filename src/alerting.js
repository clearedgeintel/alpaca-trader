/**
 * Multi-channel alerter.
 *
 * Replaces the simple Slack+Telegram posting that used to live inside
 * `logger.alert`. Now:
 *   - Multiple channels (Slack, Telegram, Discord, generic webhook).
 *   - Severity levels: info | warn | critical.
 *   - Per-channel minimum severity so a noisy Slack doesn't receive
 *     every INFO while Telegram-for-the-boss only pages on critical.
 *   - Dedup window so a storm of identical errors (e.g. Alpaca down
 *     for 10 minutes) sends one alert, not 600.
 *   - In-memory history ring buffer so the dashboard can show recent
 *     alerts without another DB table.
 *
 * Channels are configured via env vars. Anything not configured is
 * silently skipped. Fully opt-in:
 *
 *   SLACK_WEBHOOK_URL          — Slack incoming webhook URL
 *   SLACK_ALERT_MIN            — min severity (info|warn|critical, default warn)
 *
 *   TELEGRAM_BOT_TOKEN
 *   TELEGRAM_CHAT_ID
 *   TELEGRAM_ALERT_MIN         — default critical
 *
 *   DISCORD_WEBHOOK_URL
 *   DISCORD_ALERT_MIN          — default warn
 *
 *   WEBHOOK_URL                — generic webhook (POSTs JSON body)
 *   WEBHOOK_ALERT_MIN          — default info
 */

const { log, error, getContext } = require('./logger');

// Severity ordering — higher number = more severe
const SEVERITY_LEVELS = { info: 0, warn: 1, critical: 2 };

// Dedup: if the SAME (severity, title) alert is sent within this window,
// subsequent copies are suppressed. Prevents a storm of identical errors
// from paging on every occurrence.
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

// In-memory history ring buffer. Surface via /api/alerts/history.
const HISTORY_MAX = 100;

const dedupCache = new Map(); // key = `${severity}:${title}` -> timestamp
const history = [];

function minSev(envVar, fallback = 'warn') {
  const v = (process.env[envVar] || fallback).toLowerCase();
  return v in SEVERITY_LEVELS ? v : fallback;
}

function passesFilter(sev, minSev) {
  return SEVERITY_LEVELS[sev] >= SEVERITY_LEVELS[minSev];
}

function isDedup(key) {
  const prev = dedupCache.get(key);
  if (prev && Date.now() - prev < DEDUP_WINDOW_MS) return true;
  dedupCache.set(key, Date.now());
  // Opportunistic cleanup — keep the map small
  if (dedupCache.size > 500) {
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    for (const [k, t] of dedupCache) {
      if (t < cutoff) dedupCache.delete(k);
    }
  }
  return false;
}

// ------------------- Channel adapters -------------------
// Each adapter returns a function async (alert) => void. If the channel
// isn't configured (env vars missing), returns null. The registerChannels
// helper assembles the active set at import time so alerts() can fan out
// cheaply on every call.

function slackAdapter() {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return null;
  const minimum = minSev('SLACK_ALERT_MIN', 'warn');
  return {
    name: 'slack',
    minimum,
    async send(alert) {
      const emoji = alert.severity === 'critical' ? '🚨' : alert.severity === 'warn' ? '⚠️' : 'ℹ️';
      const text = `${emoji} *${alert.title}*\n${alert.message}`;
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
    },
  };
}

function telegramAdapter() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;
  const minimum = minSev('TELEGRAM_ALERT_MIN', 'critical');
  return {
    name: 'telegram',
    minimum,
    async send(alert) {
      const emoji = alert.severity === 'critical' ? '🚨' : alert.severity === 'warn' ? '⚠️' : 'ℹ️';
      const text = `${emoji} *${alert.title}*\n${alert.message}`;
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
      });
    },
  };
}

function discordAdapter() {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url) return null;
  const minimum = minSev('DISCORD_ALERT_MIN', 'warn');
  return {
    name: 'discord',
    minimum,
    async send(alert) {
      const colorBySev = { info: 0x3498db, warn: 0xf1c40f, critical: 0xe74c3c };
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [
            {
              title: alert.title,
              description: alert.message,
              color: colorBySev[alert.severity] || 0x95a5a6,
              timestamp: new Date().toISOString(),
              footer: { text: `Alpaca Trader · ${alert.severity}` },
            },
          ],
        }),
      });
    },
  };
}

function webhookAdapter() {
  const url = process.env.WEBHOOK_URL;
  if (!url) return null;
  const minimum = minSev('WEBHOOK_ALERT_MIN', 'info');
  return {
    name: 'webhook',
    minimum,
    async send(alert) {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alert),
      });
    },
  };
}

// Assembled at startup so alert() doesn't walk env on every call.
let channels = null;
function initChannels() {
  channels = [slackAdapter(), telegramAdapter(), discordAdapter(), webhookAdapter()].filter(Boolean);
}
initChannels();

// ------------------- Public API -------------------

/**
 * Emit an alert to every configured channel whose minimum severity
 * allows it. Deduped by (severity, title) within a 5-min window.
 *
 * @param {Object} opts
 * @param {'info'|'warn'|'critical'} opts.severity
 * @param {string} opts.title
 * @param {string} [opts.message]
 * @param {Object} [opts.metadata]  Extra fields passed to webhook/log
 */
async function alert({ severity = 'warn', title, message = '', metadata = {} }) {
  if (!(severity in SEVERITY_LEVELS)) severity = 'warn';
  if (!title) return;

  const key = `${severity}:${title}`;
  const suppressed = isDedup(key);

  const entry = {
    severity,
    title,
    message,
    metadata: { ...metadata, ...getContext() },
    timestamp: new Date().toISOString(),
    suppressed,
  };

  // Always log locally and always add to history — dedup only blocks outbound sends
  log(`[alert ${severity}] ${title}${message ? ': ' + message : ''}${suppressed ? ' (deduped)' : ''}`);
  history.push(entry);
  if (history.length > HISTORY_MAX) history.shift();

  if (suppressed) return;

  // Fan out to channels whose min-severity allows this alert
  await Promise.allSettled(
    channels
      .filter((ch) => passesFilter(severity, ch.minimum))
      .map((ch) => ch.send(entry).catch((err) => error(`Alert channel ${ch.name} failed`, err))),
  );
}

// Severity-shorthand helpers — cleaner call sites
const info = (title, message, metadata) => alert({ severity: 'info', title, message, metadata });
const warn = (title, message, metadata) => alert({ severity: 'warn', title, message, metadata });
const critical = (title, message, metadata) => alert({ severity: 'critical', title, message, metadata });

/**
 * Return channel registration state (for settings UI + health endpoint).
 */
function getChannels() {
  return channels.map((ch) => ({ name: ch.name, minimum: ch.minimum }));
}

/**
 * Recent alert history (newest first, capped at HISTORY_MAX).
 */
function getHistory(limit = 50) {
  return history.slice(-limit).reverse();
}

/**
 * Test send — fires a labeled info alert to every channel regardless of
 * its minimum-severity filter. Used by the settings UI's "Test send"
 * button to verify channel configs without having to trigger a real event.
 */
async function testSend(channelName = null) {
  const selected = channelName ? channels.filter((c) => c.name === channelName) : channels;
  const entry = {
    severity: 'info',
    title: 'Test alert',
    message: `Test alert from Alpaca Auto Trader at ${new Date().toISOString()}`,
    metadata: { test: true },
    timestamp: new Date().toISOString(),
  };
  await Promise.allSettled(
    selected.map((ch) => ch.send(entry).catch((err) => error(`Test send to ${ch.name} failed`, err))),
  );
  return { sentTo: selected.map((ch) => ch.name) };
}

module.exports = {
  alert,
  info,
  warn,
  critical,
  getChannels,
  getHistory,
  testSend,
  // exported for tests
  _reset: () => {
    dedupCache.clear();
    history.length = 0;
  },
  _initChannels: initChannels,
  SEVERITY_LEVELS,
};
