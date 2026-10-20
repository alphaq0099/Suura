/**
 * A short-lived cache for read-only network results.
 *
 * Search and channel pages are a burst of metadata requests; asking YouTube the
 * same question twice within a few minutes is both slow and unnecessary. The
 * cache also has single-flight semantics: two views asking for the same page at
 * the same time share one sidecar run rather than starting two.
 *
 * Only successful results are stored. A failure is usually the network or a bot
 * check, and caching that would make the next attempt fail without trying.
 */

export interface AsyncTtlCacheOptions {
  ttlMs: number
  maxEntries: number
  now?: () => number
}

interface CacheEntry<V> {
  value: V
  expiresAt: number
}

export class AsyncTtlCache<V> {
  private readonly ttlMs: number
  private readonly maxEntries: number
  private readonly now: () => number
  private readonly entries = new Map<string, CacheEntry<V>>()
  private readonly pending = new Map<string, Promise<V>>()

  constructor(options: AsyncTtlCacheOptions) {
    this.ttlMs = Math.max(0, options.ttlMs)
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries))
    this.now = options.now ?? Date.now
  }

  /**
   * Returns a fresh value, shares an in-flight load, or starts one.
   *
   * The key is a string because every caller here is a small, explicit request
   * key; keeping the generic narrow avoids a serialisation rule nobody needs.
   */
  get(key: string, load: () => Promise<V>): Promise<V> {
    const now = this.now()
    const cached = this.entries.get(key)
    if (cached && cached.expiresAt > now) return Promise.resolve(cached.value)
    if (cached) this.entries.delete(key)

    const existing = this.pending.get(key)
    if (existing) return existing

    const work = Promise.resolve()
      .then(load)
      .then((value) => {
        this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs })
        while (this.entries.size > this.maxEntries) {
          const oldest = this.entries.keys().next().value
          if (oldest === undefined) break
          this.entries.delete(oldest)
        }
        return value
      })
      .finally(() => {
        this.pending.delete(key)
      })

    this.pending.set(key, work)
    return work
  }

  /** Clears cached values; in-flight loads still finish for their callers. */
  clear(): void {
    this.entries.clear()
  }

  /** Drops one key, for a re-import or a test. */
  invalidate(key: string): void {
    this.entries.delete(key)
  }

  get size(): number {
    return this.entries.size
  }

  get inFlight(): number {
    return this.pending.size
  }
}
