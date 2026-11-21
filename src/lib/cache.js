// Tiny in-memory TTL cache with bounded size (LRU-ish: oldest-evicted when full).
export class TtlCache {
  constructor({ maxEntries = 2000 } = {}) {
    this.maxEntries = maxEntries;
    this.map = new Map(); // key -> { value, expiresAt }
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    // refresh recency
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs) {
    if (this.map.size >= this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      this.map.delete(oldestKey);
    }
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  // Memoize an async function call by key.
  async wrap(key, ttlMs, fn) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await fn();
    this.set(key, value, ttlMs);
    return value;
  }
}
