export {};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const db = require('./db');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require('./config');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { log, error } = require('./logger');

type Parser = (v: any) => any;
type Overrides = Record<string, any>;

// In-memory cache of runtime overrides
let overrides: Overrides = {};
let lastRefresh = 0;
const REFRESH_INTERVAL_MS = 30 * 1000; // Refresh from DB every 30 seconds

// Keys that can be overridden at runtime (with their parsers)
const ALLOWED_KEYS: Record<string, Parser> = {
  RISK_PCT: parseFloat,
  STOP_PCT: parseFloat,
  TARGET_PCT: parseFloat,
  MAX_POS_PCT: parseFloat,
  TRAILING_ATR_MULT: parseFloat,
  PARTIAL_EXIT_PCT: parseFloat,
  PARTIAL_EXIT_TRIGGER: parseFloat,
  MAX_DRAWDOWN_PCT: parseFloat,
  CORRELATION_THRESHOLD: parseFloat,
  SCAN_INTERVAL_MS: parseInt,
  // Signal tuning — loosen these to trade more aggressively
  ORCHESTRATOR_MIN_CONFIDENCE: parseFloat,
  VOLUME_SPIKE_RATIO: parseFloat,
  // Pre-execution belt-and-suspenders: independent floor checked by
  // execution-agent so manual/chat/fallback decisions still hit a
  // sanity gate even when ORCHESTRATOR_MIN_CONFIDENCE doesn't apply.
  EXECUTION_MIN_CONFIDENCE: parseFloat,
  // Global shadow kill switch — when true, prompt-registry.getShadow()
  // returns null for every agent. Drops all shadow LLM spend within 30s
  // (runtime-config refresh) without touching any prompt rows.
  SHADOW_MODE_GLOBAL_DISABLE: (v) => v === true || v === 'true',
  // Cycle guard — set CYCLE_GUARD_ENABLED=false to disable skipping
  // entirely, or raise CYCLE_GUARD_MAX_SKIPS to skip more aggressively
  CYCLE_GUARD_ENABLED: (v) => v === 'true' || v === true,
  CYCLE_GUARD_MAX_SKIPS: parseInt,
  // IP allowlist — only honored when IP_ALLOWLIST_ENABLED is true.
  // Comma-separated string in DB → array of trimmed IPs in memory.
  IP_ALLOWLIST: (v) =>
    String(v)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  IP_ALLOWLIST_ENABLED: (v) => v === true || v === 'true',
  // CORS wiring — ship disabled. Flip after frontend origin is confirmed.
  CORS_ORIGINS: (v) =>
    String(v)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  CORS_ENABLED: (v) => v === true || v === 'true',
  WATCHLIST: (v: any) =>
    String(v)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  // LLM cost controls
  LLM_DAILY_COST_CAP_USD: parseFloat,
  LLM_DAILY_TOKEN_CAP: parseInt,
  LLM_CIRCUIT_BREAKER_FAILURES: parseInt,
  // Datasource toggles
  POLYGON_ENABLED: (v) => v === true || v === 'true',
  // Kelly sizing — off by default so operators can inspect suggestions before activating
  KELLY_ENABLED: (v) => v === true || v === 'true',
  // Smart position scaling — add to winners when profit exceeds N×ATR
  SCALE_IN_ENABLED: (v) => v === true || v === 'true',
  SCALE_IN_TRIGGER_ATR: parseFloat,
  SCALE_IN_SIZE_PCT: parseFloat,
  SCALE_IN_MAX_COUNT: parseInt,
  // Smart Order Routing — limit orders with market fallback
  SMART_ORDER_ROUTING_ENABLED: (v) => v === true || v === 'true',
  SOR_OFFSET_BPS: parseFloat,
  SOR_TIMEOUT_MS: parseInt,
  SOR_POLL_MS: parseInt,
  // Gradual live deployment ramp
  LIVE_RAMP_ENABLED: (v) => v === true || v === 'true',
  LIVE_RAMP_TIER: parseInt,
  LIVE_RAMP_AUTO_ADVANCE: (v) => v === true || v === 'true',
  // Monitoring alert thresholds
  MONITORING_ALERTS_ENABLED: (v) => v !== false && v !== 'false',
  ALERT_LLM_COST_WARN_PCT: parseFloat,
  ALERT_LLM_COST_CRIT_PCT: parseFloat,
  ALERT_SCAN_STALE_SEC: parseInt,
  ALERT_DAILY_DD_PCT: parseFloat,
  ALERT_MAX_OPEN_POSITIONS: parseInt,
  ALERT_ENV_STALE_DAYS: parseInt,
};

/** Get a config value — checks runtime overrides first, falls back to static config. */
function get(key: string): any {
  refreshIfStale();
  if (key in overrides) return overrides[key];
  return config[key];
}

/** Set a runtime config value. Persists to DB and updates cache. */
async function set(key: string, value: any): Promise<void> {
  if (!ALLOWED_KEYS[key]) {
    throw new Error(`Key "${key}" is not a runtime-configurable setting`);
  }

  const stringVal = Array.isArray(value) ? value.join(',') : String(value);

  await db.query(
    `INSERT INTO runtime_config (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, stringVal],
  );

  overrides[key] = ALLOWED_KEYS[key](stringVal);
  log(`Runtime config updated: ${key} = ${stringVal}`);
}

/** Remove a runtime override (reverts to static config value). */
async function remove(key: string): Promise<void> {
  await db.query('DELETE FROM runtime_config WHERE key = $1', [key]);
  delete overrides[key];
  log(`Runtime config removed: ${key} (reverted to default)`);
}

function getAll(): Overrides {
  refreshIfStale();
  return { ...overrides };
}

function getEffective(): Overrides {
  refreshIfStale();
  const effective: Overrides = {};
  for (const key of Object.keys(ALLOWED_KEYS)) {
    effective[key] = key in overrides ? overrides[key] : config[key];
  }
  return effective;
}

/** Load overrides from DB into memory. */
async function refresh(): Promise<void> {
  try {
    const result = await db.query('SELECT key, value FROM runtime_config');
    const newOverrides: Overrides = {};
    for (const row of result.rows) {
      if (ALLOWED_KEYS[row.key]) {
        newOverrides[row.key] = ALLOWED_KEYS[row.key](row.value);
      }
    }
    overrides = newOverrides;
    lastRefresh = Date.now();
  } catch (err) {
    error('Failed to refresh runtime config', err);
  }
}

function refreshIfStale(): void {
  if (Date.now() - lastRefresh > REFRESH_INTERVAL_MS) {
    refresh().catch(() => {});
  }
}

async function init(): Promise<void> {
  await refresh();
  const count = Object.keys(overrides).length;
  if (count > 0) {
    log(`Runtime config loaded: ${count} override(s)`);
  }
}

module.exports = { get, set, remove, getAll, getEffective, refresh, init };
