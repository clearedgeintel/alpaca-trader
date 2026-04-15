/**
 * Simple TTL + LRU cache for datasource calls.
 *
 * Polygon's free tier is 5 calls/min, so caching EOD-stable data
 * (ticker details, dividends, market status) is essential — the
 * same symbol gets hit many times per cycle across agents.
 */

const MAX_ENTRIES = 500;

class TtlCache {
  constructor(defaultTtlMs = 5 * 60 * 1000) {
    this.map = new Map();
    this.defaultTtlMs = defaultTtlMs;
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Re-insert to bump LRU order
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs) {
    const expiresAt = Date.now() + (ttlMs ?? this.defaultTtlMs);
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt });
    // LRU eviction
    while (this.map.size > MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  clear() { this.map.clear(); }
  size() { return this.map.size; }
}

module.exports = { TtlCache };
