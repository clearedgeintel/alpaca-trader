/**
 * Simple TTL + LRU cache for datasource calls.
 */

const MAX_ENTRIES = 500;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

class TtlCache {
  private map = new Map<string, CacheEntry<unknown>>();
  private defaultTtlMs: number;

  constructor(defaultTtlMs: number = 5 * 60 * 1000) {
    this.defaultTtlMs = defaultTtlMs;
  }

  get<T = unknown>(key: string): T | undefined {
    const entry = this.map.get(key) as CacheEntry<T> | undefined;
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Re-insert to bump LRU order
    this.map.delete(key);
    this.map.set(key, entry as CacheEntry<unknown>);
    return entry.value;
  }

  set(key: string, value: unknown, ttlMs?: number): void {
    const expiresAt = Date.now() + (ttlMs ?? this.defaultTtlMs);
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt });
    // LRU eviction
    while (this.map.size > MAX_ENTRIES) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }
}

module.exports = { TtlCache };
export { TtlCache };
