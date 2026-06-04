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
const fsSync = require('node:fs');
const path = require('node:path');
const { DateTime } = require('luxon');
const db = require('./db');
const alpaca = require('./alpaca');
const recapLib = require('./lib/market-recap');
const { log, error, warn } = require('./logger');

let lastSentDate = null;
let _nodemailer = null;        // lazy require so tests / no-SMTP installs don't pull it
let _puppeteer = null;         // lazy require — only paid when first PDF is rendered
let _resolvedChromePath = undefined; // undefined = not yet tried, null = unavailable

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

/**
 * Locate a Chrome / Chromium binary for puppeteer-core. Caches the result
 * (including null) so the file-system probe runs at most once per process.
 * Honors PUPPETEER_EXECUTABLE_PATH for cloud / Docker deployments.
 */
function chromeExecutablePath() {
  if (_resolvedChromePath !== undefined) return _resolvedChromePath;
  const env = process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = [
    env,
    // Windows
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    // macOS
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    // Linux
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fsSync.statSync(p).isFile()) { _resolvedChromePath = p; return p; } } catch { /* skip */ }
  }
  _resolvedChromePath = null;
  return null;
}

/**
 * Render the HTML recap to a PDF via puppeteer-core. Letter portrait with
 * comfortable margins; tables wrap naturally. Returns the bytes written, or
 * null when Chrome isn't available — callers should fall through to the
 * HTML/markdown-only outputs in that case.
 *
 * Throws on actual puppeteer/Chrome errors (different from "no Chrome found")
 * so the dispatcher logs them visibly.
 */
async function renderPdf(html, outputPath) {
  const execPath = chromeExecutablePath();
  if (!execPath) return null;
  if (!_puppeteer) _puppeteer = require('puppeteer-core');
  const browser = await _puppeteer.launch({
    executablePath: execPath,
    headless: 'shell',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({
      path: outputPath,
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.6in', right: '0.5in', bottom: '0.6in', left: '0.5in' },
      preferCSSPageSize: false,
    });
    const { size } = await fs.stat(outputPath);
    return size;
  } finally {
    await browser.close();
  }
}

function pdfAvailable() {
  return chromeExecutablePath() !== null;
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
 * Drop the HTML companion to disk so the archive list can link to a
 * standalone printable copy without re-querying the API.
 */
async function writeHtmlFile(report, dateEt) {
  const dir = fileDir();
  if (!dir) return null;
  await fs.mkdir(dir, { recursive: true });
  const html = recapLib.formatAsHtml(report);
  const filePath = path.join(dir, `${dateEt}.html`);
  await fs.writeFile(filePath, html, 'utf8');
  return filePath;
}

/**
 * Drop the PDF when Chrome is available. Returns the path written, or null
 * when puppeteer can't find a browser binary (archive UI handles that case
 * gracefully — the row shows "PDF not generated").
 */
async function writePdfFile(report, dateEt) {
  const dir = fileDir();
  if (!dir) return null;
  if (!pdfAvailable()) return null;
  await fs.mkdir(dir, { recursive: true });
  const html = recapLib.formatAsHtml(report);
  const filePath = path.join(dir, `${dateEt}.pdf`);
  try {
    const size = await renderPdf(html, filePath);
    return size != null ? filePath : null;
  } catch (err) {
    // Don't tank the dispatch over a PDF render error — log + continue.
    error(`PDF render failed for ${dateEt}`, err);
    return null;
  }
}

/**
 * Persist a small metadata sidecar so the archive list can render headlines
 * without parsing the markdown. Path: `RECAP_FILE_DIR/YYYY-MM-DD.meta.json`.
 */
async function writeMetaFile(report, dateEt, generated) {
  const dir = fileDir();
  if (!dir) return null;
  await fs.mkdir(dir, { recursive: true });
  const meta = {
    date: dateEt,
    generatedAt: new Date().toISOString(),
    netPnl: report.headline?.netPnl ?? 0,
    nClosed: report.headline?.nClosed ?? 0,
    nOpened: report.headline?.nOpened ?? 0,
    winRate: report.headline?.winRate ?? 0,
    portfolioValue: report.meta?.portfolioValue ?? null,
    largestWinSymbol: report.headline?.largestWin?.symbol ?? null,
    largestLossSymbol: report.headline?.largestLoss?.symbol ?? null,
    regime: report.marketSummary?.regime ?? null,
    oneTradeCarriesBook: report.honestStats?.oneTradeCarriesBook ?? false,
    formats: {
      md:   !!generated.md,
      html: !!generated.html,
      pdf:  !!generated.pdf,
    },
  };
  const filePath = path.join(dir, `${dateEt}.meta.json`);
  await fs.writeFile(filePath, JSON.stringify(meta, null, 2), 'utf8');
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
 * Generate the recap, drop the file(s), send the email. Safe to call manually.
 * Records lastSentDate on success so the scheduler doesn't double-fire.
 *
 * Writes four artifacts to RECAP_FILE_DIR:
 *   YYYY-MM-DD.md         — markdown (always)
 *   YYYY-MM-DD.html       — printable HTML (always)
 *   YYYY-MM-DD.pdf        — PDF (only when Chrome available)
 *   YYYY-MM-DD.meta.json  — sidecar with headline numbers for archive listing
 *
 * Email is sent in parallel when SMTP is configured. PDF render failure
 * doesn't block the markdown/HTML drop.
 */
async function dispatchRecap(dateEt = null) {
  const targetDate = dateEt || DateTime.now().setZone('America/New_York').toFormat('yyyy-MM-dd');
  try {
    const report = await buildEnrichedRecap(targetDate);

    // Drop the rendered artifacts. Markdown + HTML are cheap and always
    // happen; PDF is gated on Chrome availability.
    const mdPath = await writeMarkdownFile(report, targetDate);
    const htmlPath = await writeHtmlFile(report, targetDate);
    const pdfPath = await writePdfFile(report, targetDate);
    if (mdPath) log(`Recap markdown written: ${mdPath}`);
    if (htmlPath) log(`Recap HTML written: ${htmlPath}`);
    if (pdfPath) log(`Recap PDF written: ${pdfPath}`);
    else if (!pdfAvailable()) log('Recap PDF skipped — Chrome not found (set PUPPETEER_EXECUTABLE_PATH to override)');

    // Meta sidecar — written last so it accurately reflects what landed.
    const metaPath = await writeMetaFile(report, targetDate, { md: mdPath, html: htmlPath, pdf: pdfPath });

    if (emailConfigured()) {
      try {
        const messageId = await sendEmail(report, targetDate);
        if (messageId) log(`Recap email sent (messageId=${messageId})`);
      } catch (mailErr) {
        error('Recap email failed', mailErr);
      }
    } else {
      log('Recap email skipped — SMTP_HOST or RECAP_EMAIL_TO not set');
    }

    lastSentDate = targetDate;
    return { dateEt: targetDate, filePath: mdPath, htmlPath, pdfPath, metaPath, emailSent: emailConfigured() };
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
  const pdfChrome = chromeExecutablePath();
  log(`Recap dispatcher: file drop ${dir ? `→ ${dir}` : 'disabled'}, PDF ${pdfChrome ? `→ ${pdfChrome}` : 'unavailable (no Chrome)'}, email ${emailConfigured() ? `→ ${process.env.RECAP_EMAIL_TO}` : 'not configured'}`);
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
  writeHtmlFile,
  writePdfFile,
  writeMetaFile,
  renderPdf,
  sendEmail,
  shouldFireNow,
  startRecapScheduler,
  emailConfigured,
  pdfAvailable,
  chromeExecutablePath,
  fileDir,
  _resetForTests: () => { lastSentDate = null; _resolvedChromePath = undefined; },
};
