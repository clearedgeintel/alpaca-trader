/**
 * Nightly DB archiver — prunes old rows from high-volume tables so they
 * don't grow unbounded.
 *
 * What we DO archive (DELETE with per-table retention):
 *   - signals              — high-volume (every scanned bar produces one)
 *   - agent_reports        — per-cycle telemetry, superseded by the next cycle
 *   - agent_metrics        — per-cycle duration/error/token counts
 *   - sentiment_snapshots  — time series used for trend detection
 *
 * What we do NOT touch (business-critical, keep forever):
 *   - trades               — real P&L ledger
 *   - daily_performance    — aggregate historical performance
 *   - agent_decisions      — audit trail for every orchestrator action
 *   - prompt_versions      — referenced by agent_decisions.prompt_version_id
 *   - runtime_config       — live config overrides
 *   - archive_log          — our own audit trail
 *
 * Retention is tunable per table via env vars with sensible defaults.
 * Every run logs one row per table to archive_log with the cutoff
 * and the rows-deleted count.
 *
 * Safe to run concurrently (DELETE is atomic); idempotent — if nothing
 * is old enough to archive, rows_deleted = 0 and we still log a heartbeat.
 */

const db = require('./db');
const { log, error } = require('./logger');

function daysEnv(key, fallback) {
  const n = parseInt(process.env[key], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function retentionConfig() {
  return {
    signals: daysEnv('SIGNALS_RETENTION_DAYS', 90),
    agent_reports: daysEnv('AGENT_REPORTS_RETENTION_DAYS', 60),
    agent_metrics: daysEnv('AGENT_METRICS_RETENTION_DAYS', 60),
    sentiment_snapshots: daysEnv('SENTIMENT_RETENTION_DAYS', 90),
  };
}

async function archiveTable(table, days) {
  const started = Date.now();
  let rowsDeleted = 0;
  let errMsg = null;
  let cutoffAt = null;
  try {
    // Use created_at for most tables; sentiment uses captured_at.
    const tsColumn = table === 'sentiment_snapshots' ? 'captured_at' : 'created_at';
    const { rows } = await db.query(`SELECT NOW() - ($1 || ' days')::interval AS cutoff`, [String(days)]);
    cutoffAt = rows[0].cutoff;
    const del = await db.query(`DELETE FROM ${table} WHERE ${tsColumn} < $1`, [cutoffAt]);
    rowsDeleted = del.rowCount || 0;
  } catch (e) {
    errMsg = e.message;
    error(`archiver: ${table} failed`, e);
  }
  const durationMs = Date.now() - started;
  // Best-effort log — never throw from here
  try {
    await db.query(
      `INSERT INTO archive_log (table_name, rows_deleted, retention_days, cutoff_at, duration_ms, error)
       VALUES ($1, $2, $3, COALESCE($4, NOW()), $5, $6)`,
      [table, rowsDeleted, days, cutoffAt, durationMs, errMsg],
    );
  } catch (e) {
    error('archiver: failed to write archive_log row', e);
  }
  return { table, rowsDeleted, retentionDays: days, durationMs, error: errMsg, cutoffAt };
}

/**
 * Run the archiver across every tracked table. Returns per-table
 * summary + overall totals. Safe to call ad-hoc from an endpoint
 * or on a cron.
 */
async function runArchiver() {
  const cfg = retentionConfig();
  const results = [];
  let totalDeleted = 0;
  for (const [table, days] of Object.entries(cfg)) {
    const r = await archiveTable(table, days);
    results.push(r);
    totalDeleted += r.rowsDeleted;
  }
  log(`archiver: swept ${results.length} tables, deleted ${totalDeleted} rows total`);
  return { results, totalDeleted, ranAt: new Date().toISOString() };
}

/**
 * Recent archive_log entries so the UI / status endpoint can surface
 * "when did we last run and what did we drop?"
 */
async function getArchiveStatus(limit = 20) {
  try {
    const { rows } = await db.query(
      `SELECT ran_at, table_name, rows_deleted, retention_days, cutoff_at, duration_ms, error
         FROM archive_log
        ORDER BY ran_at DESC
        LIMIT $1`,
      [limit],
    );
    return { recent: rows, retention: retentionConfig() };
  } catch (err) {
    error('archiver: getArchiveStatus failed', err);
    return { recent: [], retention: retentionConfig(), error: err.message };
  }
}

/**
 * Start a daily cron — runs `runArchiver` at the configured ET hour
 * (default 02:30 ET, deep off-hours). Pattern copied from daily-digest
 * so we don't need node-cron. Fire-and-forget; errors log but don't
 * kill the interval.
 */
const { DateTime } = require('luxon');

let lastRanDate = null;

function configuredHourMinute() {
  // Format: "HH:MM" in America/New_York (default 02:30).
  const raw = process.env.ARCHIVER_TIME_ET || '02:30';
  const [h, m] = raw.split(':').map(Number);
  return { hour: Number.isFinite(h) ? h : 2, minute: Number.isFinite(m) ? m : 30 };
}

function shouldFireNow(now = DateTime.now().setZone('America/New_York')) {
  const todayET = now.toFormat('yyyy-MM-dd');
  if (lastRanDate === todayET) return false;
  const { hour, minute } = configuredHourMinute();
  const target = now.set({ hour, minute, second: 0, millisecond: 0 });
  return now >= target;
}

function startArchiverScheduler(intervalMs = 10 * 60 * 1000) {
  return setInterval(() => {
    if (shouldFireNow()) {
      const todayET = DateTime.now().setZone('America/New_York').toFormat('yyyy-MM-dd');
      lastRanDate = todayET;
      runArchiver().catch((err) => error('Archiver scheduled run failed', err));
    }
  }, intervalMs);
}

function _resetForTests() {
  lastRanDate = null;
}

module.exports = {
  runArchiver,
  getArchiveStatus,
  startArchiverScheduler,
  retentionConfig,
  shouldFireNow,
  _resetForTests,
};
