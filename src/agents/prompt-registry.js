/**
 * Prompt registry — loads active prompt per agent from the DB, falls back
 * to the hardcoded constant when no DB override exists.
 *
 * Minimal API so agent code barely changes:
 *   const prompt = await promptRegistry.getActive('technical-analysis', TA_SYSTEM_PROMPT)
 *
 * If the DB has a row with is_active = true for that agent, that row's
 * prompt text wins. Otherwise the passed fallback (the hardcoded
 * constant) is used. Cache is refreshed every 5 minutes so runtime
 * rollbacks take effect quickly without a restart.
 *
 * To add a new version (via SQL or API):
 *   INSERT INTO prompt_versions (agent_name, version, prompt, is_active, notes)
 *   VALUES ('technical-analysis', 'v2', '<new prompt>', false, 'multi-tf tighter');
 *   UPDATE prompt_versions SET is_active = false WHERE agent_name = 'technical-analysis';
 *   UPDATE prompt_versions SET is_active = true
 *     WHERE agent_name = 'technical-analysis' AND version = 'v2';
 */

const db = require('../db');
const { log, error } = require('../logger');

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
let cache = new Map(); // agent_name -> { version, prompt, loadedAt }
let lastRefresh = 0;
let refreshing = false;

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const result = await db.query(`SELECT id, agent_name, version, prompt FROM prompt_versions WHERE is_active = true`);
    const next = new Map();
    for (const row of result.rows) {
      next.set(row.agent_name, {
        id: row.id,
        version: row.version,
        prompt: row.prompt,
        loadedAt: Date.now(),
      });
    }
    cache = next;
    lastRefresh = Date.now();
  } catch (err) {
    // Table may not exist (migration not run) or DB unreachable — both are
    // non-fatal: the fallback prompts keep the system running. We only log
    // unexpected error types. Keep failure silent to avoid log noise on
    // every refresh when the DB is temporarily unavailable.
    const msg = err?.message || String(err);
    const isExpected =
      /does not exist/i.test(msg) ||
      /ECONNREFUSED/i.test(msg) ||
      /ECONNRESET/i.test(msg) ||
      err?.name === 'AggregateError';
    if (!isExpected) {
      error('Prompt registry refresh failed', err);
    }
  } finally {
    refreshing = false;
  }
}

async function ensureFresh() {
  if (Date.now() - lastRefresh > REFRESH_INTERVAL_MS) {
    await refresh();
  }
}

/**
 * Get the active prompt for an agent, falling back to the hardcoded
 * constant if no DB override exists.
 *
 * This function is sync for call-site simplicity — the refresh happens
 * as a fire-and-forget when the cache is stale. First call after restart
 * hits the fallback; subsequent calls (within 5 min) read from cache.
 */
function getActive(agentName, fallback) {
  // Non-blocking refresh when stale
  if (Date.now() - lastRefresh > REFRESH_INTERVAL_MS) {
    ensureFresh().catch(() => {});
  }
  const entry = cache.get(agentName);
  return entry?.prompt || fallback;
}

/**
 * Get the active version label for an agent (or 'hardcoded' if no
 * override). Used for telemetry so debug logs can distinguish.
 */
function getActiveVersion(agentName) {
  return cache.get(agentName)?.version || 'hardcoded';
}

/**
 * Get the active prompt_versions.id UUID for an agent, or null when
 * no DB override exists (i.e. we're running on the hardcoded fallback).
 * Used to tag agent_decisions for A/B outcome comparison.
 */
function getActiveId(agentName) {
  return cache.get(agentName)?.id || null;
}

/**
 * Set a new version as active and deactivate others for this agent.
 * Creates the row if version doesn't exist yet.
 */
async function activate(agentName, version, promptText, notes = null) {
  await db.query(
    `INSERT INTO prompt_versions (agent_name, version, prompt, is_active, notes)
     VALUES ($1, $2, $3, false, $4)
     ON CONFLICT (agent_name, version) DO UPDATE SET prompt = EXCLUDED.prompt, notes = EXCLUDED.notes`,
    [agentName, version, promptText, notes],
  );
  await db.query(`UPDATE prompt_versions SET is_active = (version = $2) WHERE agent_name = $1`, [agentName, version]);
  await refresh();
  log(`Prompt registry: activated ${agentName} version=${version}`);
}

/**
 * List all versions for an agent.
 */
async function list(agentName) {
  if (agentName) {
    const result = await db.query(
      `SELECT id, agent_name, version, is_active, notes, created_at,
              LENGTH(prompt) AS prompt_length
         FROM prompt_versions
        WHERE agent_name = $1
        ORDER BY created_at DESC`,
      [agentName],
    );
    return result.rows;
  }
  const result = await db.query(
    `SELECT id, agent_name, version, is_active, notes, created_at,
            LENGTH(prompt) AS prompt_length
       FROM prompt_versions
      ORDER BY agent_name, created_at DESC`,
  );
  return result.rows;
}

module.exports = { getActive, getActiveVersion, getActiveId, activate, list, refresh };
