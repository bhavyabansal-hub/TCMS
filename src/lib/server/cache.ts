// Generic in-process TTL cache — the app's shared caching primitive.
//
// DESIGN PRINCIPLES (why it is built this way):
//   - SINGLETON: one Map per runtime, cached on globalThis (same pattern as
//     the Prisma singleton in src/lib/db.ts) so Next.js dev hot-reload can
//     never duplicate the store or leak stale entries across reloads.
//   - LOAD-SAFE: withCache() coalesces concurrent misses behind ONE loader
//     promise — a burst of dashboard hits triggers exactly one aggregate
//     query set, not one per request.
//   - CORRECTNESS: loaders that THROW are never cached, so a transient DB
//     error cannot stick for a whole TTL window.
//   - BOUNDED MEMORY: MAX_ENTRIES cap (oldest expiry evicted first) means
//     unbounded key diversity (e.g. per-user keys) cannot grow the map.
//   - INVALIDATION: invalidateCache(prefix) lets write paths drop related
//     keys synchronously instead of waiting out the TTL.
//
// USAGE: read paths wrap their loader — withCache(key, ttlMs, loader);
// write paths call invalidateCache(prefix). See logActivity (src/lib/activity.ts)
// for the central write-side hook that keeps the stats aggregates fresh.

const MAX_ENTRIES = 500

interface CacheEntry {
  value: unknown
  expiresAt: number
}

const globalForCache = globalThis as unknown as {
  __tcmsCacheStore?: Map<string, CacheEntry>
  __tcmsCacheInflight?: Map<string, Promise<unknown>>
}

// Singleton store + in-flight loader map (both survive dev hot reload).
const store = globalForCache.__tcmsCacheStore ?? new Map<string, CacheEntry>()
const inflight = globalForCache.__tcmsCacheInflight ?? new Map<string, Promise<unknown>>()
globalForCache.__tcmsCacheStore = store
globalForCache.__tcmsCacheInflight = inflight

/** Reads a live (non-expired) entry; expired entries are dropped lazily. */
export function cacheGet<T>(key: string): T | undefined {
  const entry = store.get(key)
  if (!entry) return undefined
  if (Date.now() >= entry.expiresAt) {
    store.delete(key)
    return undefined
  }
  return entry.value as T
}

/** Writes an entry with a TTL; evicts the soonest-to-expire entry at cap. */
export function cacheSet(key: string, value: unknown, ttlMs: number): void {
  if (store.size >= MAX_ENTRIES && !store.has(key)) {
    let oldestKey: string | null = null
    let oldestExpiry = Infinity
    for (const [k, v] of store) {
      if (v.expiresAt < oldestExpiry) {
        oldestExpiry = v.expiresAt
        oldestKey = k
      }
    }
    if (oldestKey) store.delete(oldestKey)
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs })
}

/** Drops every key starting with the prefix; returns how many were removed. */
export function invalidateCache(prefix: string): number {
  let removed = 0
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key)
      removed++
    }
  }
  return removed
}

/**
 * Read-through cached loader: cache hit -> stored value; miss -> ONE shared
 * loader call (concurrent callers await the same promise). Successful results
 * are stored for ttlMs; a throwing loader propagates and caches nothing.
 */
export async function withCache<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
  const hit = cacheGet<T>(key)
  if (hit !== undefined) return hit

  const pending = inflight.get(key) as Promise<T> | undefined
  if (pending) return pending

  const promise = (async () => {
    const value = await loader()
    cacheSet(key, value, ttlMs)
    return value
  })().finally(() => {
    inflight.delete(key)
  })

  inflight.set(key, promise)
  return promise
}
