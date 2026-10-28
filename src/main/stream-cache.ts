import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import type { SqlDatabase } from '@core/db/driver'
import { isPathInside, normalizePath } from '@core/library/content-key'
import type { Logger } from '@core/logging/logger'
import { freeBytesFor } from '@core/disk-space'
import { buildMediaUrl } from '@shared/media-url'
import { isYouTubeVideoId } from '@shared/youtube'
import type {
  AppSettings,
  CacheEntry,
  CacheStats,
  ResolvedSource
} from '@shared/types'

/** What a resolver knows about the media behind a video. */
export interface CacheSource {
  url: string
  headers: Record<string, string>
  mimeType: string
  /** yt-dlp's estimate, when the resolver already has it. */
  sizeHint: number | null
}

export interface StreamCacheDeps {
  db: SqlDatabase
  /** `paths.cache/stream`; the only directory this class writes to. */
  root: string
  settings: Pick<{ get(): AppSettings }, 'get'>
  log: Logger
  /** Injected by tests so a cache test never touches the network. */
  fetch?: typeof fetch
  freeBytes?: (path: string) => Promise<number | null>
  now?: () => number
}

interface CacheRow {
  video_id: string
  path: string
  size_bytes: number
  complete: number
  pinned: number
  mime_type: string
  created_at: number
  last_used_at: number
}

const COLUMNS = `video_id, path, size_bytes, complete, pinned, mime_type, created_at, last_used_at`

/**
 * A partially written file is never a valid cache entry.
 *
 * One download may take a few minutes on a slow connection. This is a ceiling,
 * not an expected duration; the user can always play the stream while the copy
 * is being fetched.
 */
const CACHE_TIMEOUT_MS = 10 * 60_000

/** Keep this much room free even when the size hint is unknown. */
const CACHE_FREE_RESERVE_BYTES = 96 * 1024 * 1024

/** Janitor cadence. Eviction is also enforced after every completed warm. */
const JANITOR_INTERVAL_MS = 60 * 60_000

const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'opus',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/wav': 'wav'
}

/** A stable file extension for a response MIME type. */
export function extensionForAudioMime(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? ''
  return EXTENSION_BY_MIME[base] ?? 'webm'
}

function mapRow(row: CacheRow): CacheEntry {
  return {
    videoId: row.video_id,
    sizeBytes: row.size_bytes,
    mimeType: row.mime_type,
    pinned: row.pinned === 1,
    complete: row.complete === 1,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at
  }
}

/**
 * The offline cache for YouTube streams.
 *
 * A cached file is a *copy*, not a library row: the library keeps its own saved
 * files and its own lifecycle, and conflating the two would make Clear cache
 * delete things the user explicitly saved. The cache is best-effort by design.
 * Playback never waits for a warm; a failed download just means the next play
 * streams again.
 *
 * Files are written to `<root>/<videoId>.<ext>.part` and renamed only after the
 * response ends, so a crash mid-download leaves something the next start-up can
 * identify and delete. The database row is written after the rename for the same
 * reason: a row always points at a complete file.
 */
export class StreamCache {
  readonly root: string
  private readonly db: SqlDatabase
  private readonly deps: StreamCacheDeps
  private readonly jobs = new Map<string, Promise<CacheEntry | null>>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly abort = new AbortController()
  private janitor: NodeJS.Timeout | null = null
  /** Bumped by `clear` so a download that was already in flight cannot win. */
  private epoch = 0
  private initialized = false

  constructor(deps: StreamCacheDeps) {
    this.deps = deps
    this.db = deps.db
    this.root = normalizePath(deps.root)
  }

  /** Creates the directory, reconciles rows with disk and starts the janitor. */
  init(): void {
    if (this.initialized) return
    this.initialized = true
    mkdirSync(this.root, { recursive: true })
    this.reconcile()
    this.prune()
    this.janitor = setInterval(() => {
      try {
        this.prune()
      } catch (error) {
        this.deps.log.warn('cache prune failed', { error })
      }
    }, JANITOR_INTERVAL_MS)
    this.janitor.unref?.()
  }

  dispose(): void {
    this.abort.abort()
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
    this.jobs.clear()
    if (this.janitor) clearInterval(this.janitor)
    this.janitor = null
  }

  get(videoId: string): CacheEntry | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM cache_entries WHERE video_id = ?`)
      .get<CacheRow>(videoId)
    return row ? mapRow(row) : null
  }

  list(limit = 200): CacheEntry[] {
    const count = Math.min(1000, Math.max(1, Math.round(limit)))
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM cache_entries
         WHERE complete = 1
         ORDER BY last_used_at DESC, video_id ASC
         LIMIT ?`
      )
      .all<CacheRow>(count)
      .map(mapRow)
  }

  stats(): CacheStats {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS entries,
                COALESCE(SUM(size_bytes), 0) AS bytes,
                COALESCE(SUM(pinned), 0) AS pinned
         FROM cache_entries
         WHERE complete = 1`
      )
      .get<{ entries: number; bytes: number; pinned: number }>()
    return {
      entries: row?.entries ?? 0,
      pinnedEntries: row?.pinned ?? 0,
      bytes: row?.bytes ?? 0,
      budgetBytes: this.budgetBytes()
    }
  }

  /**
   * A playable source for a cached video, or null.
   *
   * Missing files are removed here rather than in a background sweep so a stale
   * row can never make the player show a cache hit it cannot serve.
   */
  cachedSource(videoId: string): ResolvedSource | null {
    const entry = this.get(videoId)
    if (!entry || !entry.complete) return null
    const path = this.storedPath(videoId)
    if (!path || !this.isCacheFile(path) || !existsSync(path)) {
      this.deleteEntry(videoId, path)
      return null
    }
    return this.sourceFor(videoId, path, entry.mimeType)
  }

  /** Records a use so LRU eviction keeps what is actually being played. */
  touch(videoId: string): void {
    this.db
      .prepare('UPDATE cache_entries SET last_used_at = ? WHERE video_id = ?')
      .run(this.now(), videoId)
  }

  /**
   * Starts (or joins) a background copy of one stream.
   *
   * Returns the entry when the copy finishes, or null when it was skipped or
   * failed. Callers do not await this on the playback path.
   */
  warm(videoId: string, source: CacheSource): Promise<CacheEntry | null> {
    if (!isYouTubeVideoId(videoId)) return Promise.resolve(null)
    if (this.abort.signal.aborted) return Promise.resolve(null)

    const existing = this.get(videoId)
    if (existing?.complete) {
      const path = this.storedPath(videoId)
      if (path && this.isCacheFile(path) && existsSync(path)) {
        this.touch(videoId)
        return Promise.resolve(existing)
      }
      this.deleteEntry(videoId, path)
    }

    const running = this.jobs.get(videoId)
    if (running) return running

    const job = this.download(videoId, source).finally(() => {
      if (this.jobs.get(videoId) === job) this.jobs.delete(videoId)
    })
    this.jobs.set(videoId, job)
    return job
  }

  setPinned(videoId: string, pinned: boolean): CacheStats {
    this.db
      .prepare('UPDATE cache_entries SET pinned = ? WHERE video_id = ?')
      .run(pinned ? 1 : 0, videoId)
    return this.stats()
  }

  /**
   * Applies the visible age and size policy right now.
   *
   * "Clean now" must mean the same thing the hourly janitor does, not a second
   * implementation with different rules. It is therefore bounded by the user's
   * settings and leaves pinned entries alone; a full wipe is still `clear`.
   */
  cleanNow(): CacheStats {
    this.reconcile()
    this.prune()
    return this.stats()
  }

  /**
   * Removes every entry and in-flight copy.
   *
   * A file currently open by the player cannot be unlinked on Windows. In that
   * case its row is kept so the cache does not claim to be smaller than it is;
   * the next start-up reconcile will remove it once nothing holds the handle.
   */
  clear(): CacheStats {
    this.epoch += 1
    for (const controller of this.controllers.values()) controller.abort()
    this.controllers.clear()
    this.jobs.clear()

    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM cache_entries`)
      .all<CacheRow>()
    for (const row of rows) {
      // A corrupt row outside the cache root has no file this class may touch,
      // but it still belongs to the cache ledger and must not survive a clear.
      if (!this.isCacheFile(row.path)) {
        this.deleteEntry(row.video_id, null)
        continue
      }
      if (this.removeFile(row.path)) {
        this.deleteEntry(row.video_id, row.path)
      }
    }
    return this.stats()
  }

  isPathAllowed(filePath: string): boolean {
    return this.isCacheFile(filePath)
  }

  /**
   * The file behind a complete entry, for main-only actions such as Reveal.
   *
   * The renderer never receives this path: it is resolved here, checked against
   * the cache root and the file system, and handed straight to Explorer.
   */
  filePath(videoId: string): string | null {
    const entry = this.get(videoId)
    if (!entry?.complete) return null
    const path = this.storedPath(videoId)
    if (!path || !this.isCacheFile(path) || !existsSync(path)) {
      this.deleteEntry(videoId, path)
      return null
    }
    return path
  }

  /**
   * Deletes one cache entry.
   *
   * This is the same safety rule as `clear`: only a file inside the cache root
   * may be unlinked. A file the player still holds open cannot be removed on
   * Windows, so its row stays and the call resolves false rather than pretending
   * the space was freed.
   */
  remove(videoId: string): boolean {
    const entry = this.get(videoId)
    if (!entry) return false
    const path = this.storedPath(videoId)
    if (!path || !this.isCacheFile(path)) {
      this.deleteEntry(videoId, null)
      return true
    }
    if (!this.removeFile(path)) return false
    this.db.prepare('DELETE FROM cache_entries WHERE video_id = ?').run(videoId)
    return true
  }

  private async download(videoId: string, source: CacheSource): Promise<CacheEntry | null> {
    const epoch = this.epoch
    const controller = new AbortController()
    this.controllers.set(videoId, controller)
    const timer = setTimeout(() => controller.abort(), CACHE_TIMEOUT_MS)
    timer.unref?.()
    const signal = AbortSignal.any([this.abort.signal, controller.signal])

    const extension = extensionForAudioMime(source.mimeType)
    const partial = join(this.root, `${videoId}.${extension}.part`)
    const final = join(this.root, `${videoId}.${extension}`)

    try {
      mkdirSync(this.root, { recursive: true })
      const free = await (this.deps.freeBytes ?? freeBytesFor)(this.root)
      const needed = (source.sizeHint ?? 0) + CACHE_FREE_RESERVE_BYTES
      if (free !== null && free < needed) {
        this.deps.log.info('cache skipped: not enough free space', {
          videoId,
          free,
          needed
        })
        return null
      }

      // A leftover with the target name is not in the database (the row would
      // have been reused above), so it is an orphan from an interrupted rename.
      rmSync(final, { force: true })
      rmSync(partial, { force: true })

      const response = await (this.deps.fetch ?? fetch)(source.url, {
        headers: source.headers,
        redirect: 'follow',
        signal
      })
      if (!response.ok || !response.body) {
        throw new Error(`Upstream answered ${response.status} ${response.statusText}`)
      }

      await pipeline(
        Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>),
        createWriteStream(partial, { flags: 'w' })
      )

      // `clear` ran while the response was streaming. The bytes on disk belong
      // to a cache generation the user asked to discard.
      if (epoch !== this.epoch) {
        rmSync(partial, { force: true })
        return null
      }

      const bytes = statSync(partial).size
      if (bytes <= 0) throw new Error('Upstream returned an empty file')

      rmSync(final, { force: true })
      // The rename is the commit point: until it succeeds there is no entry.
      renameSync(partial, final)

      const now = this.now()
      const path = normalizePath(final)
      this.db
        .prepare(
          `INSERT INTO cache_entries
             (video_id, path, size_bytes, complete, pinned, mime_type, created_at, last_used_at)
           VALUES (?, ?, ?, 1, 0, ?, ?, ?)
           ON CONFLICT(video_id) DO UPDATE SET
             path = excluded.path,
             size_bytes = excluded.size_bytes,
             complete = 1,
             mime_type = excluded.mime_type,
             last_used_at = excluded.last_used_at`
        )
        .run(videoId, path, bytes, source.mimeType, now, now)

      this.enforceBudget()
      this.enforceAge()
      return this.get(videoId)
    } catch (error) {
      if (!signal.aborted) {
        this.deps.log.warn('cache download failed', { videoId, error })
      }
      rmSync(partial, { force: true })
      return null
    } finally {
      clearTimeout(timer)
      if (this.controllers.get(videoId) === controller) this.controllers.delete(videoId)
    }
  }

  /**
   * Makes disk agree with the database after an unclean shutdown.
   *
   * A row whose file is gone is dropped, a surviving file's size is refreshed,
   * `.part` files are deleted, and files no row refers to are removed. The cache
   * directory is app-owned, so it is safe to treat unknown files as leftovers.
   */
  private reconcile(): void {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM cache_entries`)
      .all<CacheRow>()
    const known = new Set<string>()

    for (const row of rows) {
      if (!this.isCacheFile(row.path)) {
        this.deleteEntry(row.video_id, null)
        continue
      }
      try {
        const stat = statSync(row.path)
        if (!stat.isFile()) throw new Error('not a file')
        if (stat.size !== row.size_bytes) {
          this.db
            .prepare('UPDATE cache_entries SET size_bytes = ? WHERE video_id = ?')
            .run(stat.size, row.video_id)
        }
        known.add(normalizePath(row.path))
      } catch {
        this.deleteEntry(row.video_id, row.path)
      }
    }

    let names: string[]
    try {
      names = readdirSync(this.root)
    } catch {
      return
    }
    for (const name of names) {
      const filePath = join(this.root, name)
      if (name.endsWith('.part') || !known.has(normalizePath(filePath))) {
        this.removeFile(filePath)
      }
    }
  }

  /** Age first, then size; both skip pinned entries. */
  private prune(): void {
    this.enforceAge()
    this.enforceBudget()
  }

  private enforceAge(): void {
    const days = Math.max(1, this.deps.settings.get().retention.cacheMaxAgeDays)
    const cutoff = this.now() - days * 24 * 60 * 60_000
    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM cache_entries
         WHERE complete = 1 AND pinned = 0 AND last_used_at < ?
         ORDER BY last_used_at ASC`
      )
      .all<CacheRow>(cutoff)
    for (const row of rows) {
      if (this.removeFile(row.path)) this.deleteEntry(row.video_id, row.path)
    }
  }

  /**
   * Evicts least-recently-used unpinned entries until the cache fits.
   *
   * Pinned entries count towards the budget but are never chosen for eviction.
   * That means a user who pins more than the budget can exceed it; the UI shows
   * the real number instead of silently discarding something explicitly kept.
   */
  private enforceBudget(): void {
    let bytes = this.stats().bytes
    const budget = this.budgetBytes()
    if (bytes <= budget) return

    const rows = this.db
      .prepare(
        `SELECT ${COLUMNS} FROM cache_entries
         WHERE complete = 1 AND pinned = 0
         ORDER BY last_used_at ASC, created_at ASC`
      )
      .all<CacheRow>()
    for (const row of rows) {
      if (bytes <= budget) break
      if (!this.removeFile(row.path)) continue
      this.deleteEntry(row.video_id, row.path)
      bytes -= row.size_bytes
    }
  }

  private budgetBytes(): number {
    return Math.max(0, this.deps.settings.get().retention.cacheBudgetMb) * 1024 * 1024
  }

  private sourceFor(videoId: string, filePath: string, mimeType: string): ResolvedSource {
    this.touch(videoId)
    return {
      url: buildMediaUrl(filePath),
      expiresAt: null,
      mimeType,
      resolverId: 'stream-cache'
    }
  }

  /** The stored path, or null when the row disappeared. */
  private storedPath(videoId: string): string | null {
    const row = this.db
      .prepare('SELECT path FROM cache_entries WHERE video_id = ?')
      .get<{ path: string }>(videoId)
    return row?.path ?? null
  }

  private deleteEntry(videoId: string, filePath: string | null): void {
    this.db.prepare('DELETE FROM cache_entries WHERE video_id = ?').run(videoId)
    // A corrupt row must not turn a cache sweep into an arbitrary file delete,
    // and a directory or locked file must not stop the row from being dropped.
    if (filePath && this.isCacheFile(filePath)) this.removeFile(filePath)
  }

  private removeFile(filePath: string): boolean {
    if (!this.isCacheFile(filePath)) return false
    try {
      rmSync(filePath, { force: true })
      return true
    } catch (error) {
      this.deps.log.warn('could not remove cache file', { filePath, error })
      return false
    }
  }

  /** Inside the cache root and not the root itself. */
  private isCacheFile(filePath: string): boolean {
    const normalized = normalizePath(filePath)
    return normalized !== this.root && isPathInside(this.root, normalized)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}
