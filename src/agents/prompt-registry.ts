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

export {};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('../db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { log, error } = require('../logger');

interface PromptEntry {
  id: string;
  version: string;
  prompt: string;
  loadedAt: number;
}

interface PromptListRow {
  id: string;
  agent_name: string;
  version: string;
  is_active: boolean;
  is_shadow: boolean;
  notes: string | null;
  created_at: string | Date;
  prompt_length: number;
}

const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const SHADOW_AUTO_EXPIRY_MS = 48 * 60 * 60 * 1000; // 48h — prevents forgotten shadow from doubling LLM cost indefinitely
let cache: Map<string, PromptEntry> = new Map();
let shadowCache: Map<string, PromptEntry> = new Map();
let shadowSetAt: Map<string, number> = new Map();
let lastRefresh = 0;
let refreshing = false;

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const result = await db.query(
      `SELECT id, agent_name, version, prompt, is_active, is_shadow
         FROM prompt_versions
        WHERE is_active = true OR is_shadow = true`,
    );
    const nextActive: Map<string, PromptEntry> = new Map();
    const nextShadow: Map<string, PromptEntry> = new Map();
    for (const row of result.rows) {
      const entry: PromptEntry = {
        id: row.id,
        version: row.version,
        prompt: row.prompt,
        loadedAt: Date.now(),
      };
      if (row.is_active) nextActive.set(row.agent_name, entry);
      if (row.is_shadow) nextShadow.set(row.agent_name, entry);
    }
    cache = nextActive;
    shadowCache = nextShadow;
    lastRefresh = Date.now();
  } catch (err: any) {
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

async function ensureFresh(): Promise<void> {
  if (Date.now() - lastRefresh > REFRESH_INTERVAL_MS) {
    await refresh();
  }
}

function getActive(agentName: string, fallback: string): string {
  if (Date.now() - lastRefresh > REFRESH_INTERVAL_MS) {
    ensureFresh().catch(() => {});
  }
  const entry = cache.get(agentName);
  return entry?.prompt || fallback;
}

function getActiveVersion(agentName: string): string {
  return cache.get(agentName)?.version || 'hardcoded';
}

function getActiveId(agentName: string): string | null {
  return cache.get(agentName)?.id || null;
}

async function activate(agentName: string, version: string, promptText: string, notes: string | null = null): Promise<void> {
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

function getShadow(agentName: string): string | null {
  // Global kill switch — flipping SHADOW_MODE_GLOBAL_DISABLE in Settings
  // immediately drops all shadow LLM calls without touching any prompt
  // rows. Re-enable instantly. Lazy require to avoid circular import.
  try {
    const runtimeConfig = require('../runtime-config');
    if (runtimeConfig.get('SHADOW_MODE_GLOBAL_DISABLE')) return null;
  } catch {
    /* runtime-config unavailable (test env) — fall through */
  }
  const entry = shadowCache.get(agentName);
  if (!entry) return null;
  // Auto-expiry: if shadow has been active > 48h, clear it to stop doubling LLM cost
  const setTime = shadowSetAt.get(agentName) || entry.loadedAt;
  if (Date.now() - setTime > SHADOW_AUTO_EXPIRY_MS) {
    log(`Prompt registry: shadow for ${agentName} auto-expired after 48h`);
    clearShadow(agentName).catch(() => {});
    return null;
  }
  return entry.prompt;
}

function getShadowMeta(agentName: string): { id: string; version: string } | null {
  const entry = shadowCache.get(agentName);
  if (!entry) return null;
  return { id: entry.id, version: entry.version };
}

async function setShadow(agentName: string, version: string): Promise<void> {
  await db.query(`UPDATE prompt_versions SET is_shadow = (version = $2) WHERE agent_name = $1`, [agentName, version]);
  shadowSetAt.set(agentName, Date.now());
  await refresh();
  log(`Prompt registry: set shadow for ${agentName} version=${version} (auto-expires in 48h)`);
}

async function clearShadow(agentName: string): Promise<void> {
  await db.query(`UPDATE prompt_versions SET is_shadow = false WHERE agent_name = $1`, [agentName]);
  shadowSetAt.delete(agentName);
  await refresh();
  log(`Prompt registry: cleared shadow for ${agentName}`);
}

async function list(agentName?: string): Promise<PromptListRow[]> {
  if (agentName) {
    const result = await db.query(
      `SELECT id, agent_name, version, is_active, is_shadow, notes, created_at,
              LENGTH(prompt) AS prompt_length
         FROM prompt_versions
        WHERE agent_name = $1
        ORDER BY created_at DESC`,
      [agentName],
    );
    return result.rows;
  }
  const result = await db.query(
    `SELECT id, agent_name, version, is_active, is_shadow, notes, created_at,
            LENGTH(prompt) AS prompt_length
       FROM prompt_versions
      ORDER BY agent_name, created_at DESC`,
  );
  return result.rows;
}

module.exports = {
  getActive,
  getActiveVersion,
  getActiveId,
  getShadow,
  getShadowMeta,
  activate,
  setShadow,
  clearShadow,
  list,
  refresh,
};
