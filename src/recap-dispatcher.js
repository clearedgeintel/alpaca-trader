/**
 * recap-dispatcher.js
 * -----------------------------------------------------------------------------
 * End-of-day delivery for the full structured recap. Distinct from
 * daily-digest (one-line Slack summary) — this is the rich HTML + markdown
 * version that powers the /recap dashboard page.
 *
 * Three deliveries, all opt-in:
 *   1. Markdown file dropped to RECAP_FILE_DIR/YYYY-MM-DD.md  (always on by
 *      default; set RECAP_FILE_DIR=off to disable)
 *   2. HTML email via SMTP                                   (off until you
 *      set SMTP_HOST + RECAP_EMAIL_TO)
 *   3. Slack/Telegram digest                                 (handled by the
 *      existing daily-digest module — this dispatcher doesn't touch alerts)
 *
 * Fires once per ET trading day at RECAP_DISPATCH_TIME_ET (default 16:10,
 * five minutes after the digest so daily_performance has likely settled).
 * Idempotent within the same day via lastSentDate.
 *
 * Env vars:
 *   RECAP_FILE_DIR              default: ./recaps   ("off" disables)
 *   RECAP_DISPATCH_TIME_ET      default: 16:10
 *   SMTP_HOST                   no default          (required for email)
 *   SMTP_PORT                   default: 587
 *   SMTP_USER                   no default
 *   SMTP_PASS                   no default
 *   SMTP_SECURE                 default: false      ("true" → TLS on connect)
 *   SMTP_FROM                   default: SMTP_USER  (sender address)
 *   RECAP_EMAIL_TO              no default          (comma-separated)
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { DateTime } = require('luxon');
const db = require('./db');
const alpaca = require('./alpaca');
const recapLib = require('./lib/market-recap');
const { log, error, warn } = require('./logger');

let lastSentDate = null;
let _nodemailer = null; // lazy require so tests / no-SMTP installs don't pull it

function configuredHourMinute() {
  const raw = process.env.RECAP_DISPATCH_TIME_ET || '16:10';
  const [h, m] = raw.split(':').map(Number);
  return {
    hour: Number.isFinite(h) ? h : 16,
    minute: Number.isFinite(m) ? m : 10,
  };
}

function fileDir() {
  const raw = process.env.RECAP_FILE_DIR;
  if (raw === 'off') return null;
  return path.resolve(raw || 'recaps');
}

function emailConfigured() {
  return !!(process.env.SMTP_HOST && process.env.RECAP_EMAIL_TO);
}

/**
 * Build the recap for a given ET date, with the same enrichment the
 * /api/recap endpoint does (market snapshots + news). Pulled into its own
 * function so the dispatcher and the manual "run now" path use the same
 * code path.
 */
async function buildEnrichedRecap(dateEt) {
  const report = await recapLib.generateRecap({ from: dateEt, to: dateEt, db });
  try {
    const tickerSymbols = ['SPY', 'QQQ', 'IWM', 'DIA'];
    const snaps = await alpaca.getMultiSnapshots(tickerSymbols);
    report.marketSummary.indexes = tickerSymbols
      .map((sym) => {
        const s = snaps[sym];
        if (!s) return null;
        const close = Number(s.price ?? s.latestTrade?.p ?? s.minuteBar?.c);
        const prev = Number(s.prevClose ?? s.previousDailyBar?.c);
        const changePct = prev && close ? ((close - prev) / prev) * 100 : 0;
        return { symbol: sym, close, prevClose: prev, changePct };
      })
      .filter(Boolean);
  } catch (e) { /* enrichment optional */ }
  try {
    const news = await alpaca.getNews(8);
    report.news.headlines = (news || []).map((n) => ({
      headline: n.headline, source: n.source, symbols: n.symbols || [], time: n.created_at, url: n.url,
    }));
  } catch (e) { /* silent */ }
  return report;
}

/**
 * Drop the markdown to disk. Returns the absolute path written, or null
 * when RECAP_FILE_DIR=off.
 */
async function writeMarkdownFile(report, dateEt) {
  const dir = fileDir();
  if (!dir) return null;
  await fs.mkdir(dir, { recursive: true });
  const md = recapLib.formatAsMarkdown(report);
  const filePath = path.join(dir, `${dateEt}.md`);
  await fs.writeFile(filePath, md, 'utf8');
  return filePath;
}

/**
 * Send the HTML recap via SMTP when configured. Returns the messageId on
 * success, null when SMTP isn't set up, throws on configured-but-failed.
 */
async function sendEmail(report, dateEt) {
  if (!emailConfigured()) return null;
  if (!_nodemailer) _nodemailer = require('nodemailer');

  const transporter = _nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: (process.env.SMTP_SECURE || 'false') === 'true',
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });

  const to = process.env.RECAP_EMAIL_TO.split(',').map((s) => s.trim()).filter(Boolean);
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@localhost';
  const subject = `Daily Recap — ${dateEt} — ${report.headline.netPnl >= 0 ? '+' : '−'}$${Math.abs(report.headline.netPnl).toLocaleString()} net, ${(report.headline.winRate * 100).toFixed(0)}% win`;

  const info = await transporter.sendMail({
    from,
    to,
    subject,
    html: recapLib.formatAsHtml(report),
    // Plain-text fallback for clients that prefer text.
    text: recapLib.formatAsMarkdown(report),
  });
  return info.messageId;
}

/**
 * Generate the recap, drop the file, send the email. Safe to call manually.
 * Records lastSentDate on success so the scheduler doesn't double-fire.
 */
async function dispatchRecap(dateEt = null) {
  const targetDate = dateEt || DateTime.now().setZone('America/New_York').toFormat('yyyy-MM-dd');
  try {
    const report = await buildEnrichedRecap(targetDate);
    const filePath = await writeMarkdownFile(report, targetDate);
    if (filePath) log(`Recap markdown written: ${filePath}`);

    if (emailConfigured()) {
      try {
        const messageId = await sendEmail(report, targetDate);
        if (messageId) log(`Recap email sent (messageId=${messageId})`);
      } catch (mailErr) {
        // Email failure shouldn't block the file drop — log + continue.
        error('Recap email failed', mailErr);
      }
    } else {
      log('Recap email skipped — SMTP_HOST or RECAP_EMAIL_TO not set');
    }

    lastSentDate = targetDate;
    return { dateEt: targetDate, filePath, emailSent: emailConfigured() };
  } catch (err) {
    error('dispatchRecap failed', err);
    throw err;
  }
}

function shouldFireNow(now = DateTime.now().setZone('America/New_York')) {
  const todayET = now.toFormat('yyyy-MM-dd');
  if (lastSentDate === todayET) return false;
  const { hour, minute } = configuredHourMinute();
  const target = now.set({ hour, minute, second: 0, millisecond: 0 });
  // Weekends off (no trading data to recap).
  if (now.weekday > 5) return false;
  return now >= target;
}

function startRecapScheduler(intervalMs = 5 * 60 * 1000) {
  // Surface what's configured at boot so the operator knows what to expect.
  const dir = fileDir();
  log(`Recap dispatcher: file drop ${dir ? `→ ${dir}` : 'disabled'}, email ${emailConfigured() ? `→ ${process.env.RECAP_EMAIL_TO}` : 'not configured'}`);
  if (!dir && !emailConfigured()) {
    warn('Recap dispatcher: no delivery channels configured (RECAP_FILE_DIR + SMTP_HOST/RECAP_EMAIL_TO). Scheduler will still run but produce no output.');
  }
  return setInterval(() => {
    if (shouldFireNow()) {
      dispatchRecap().catch((err) => error('Recap scheduler tick failed', err));
    }
  }, intervalMs);
}

module.exports = {
  dispatchRecap,
  buildEnrichedRecap,
  writeMarkdownFile,
  sendEmail,
  shouldFireNow,
  startRecapScheduler,
  emailConfigured,
  _resetForTests: () => { lastSentDate = null; },
};
