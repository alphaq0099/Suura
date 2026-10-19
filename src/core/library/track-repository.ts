import type { LibraryStats, ListTracksQuery, SourceKind, Track, TrackPage, TrackSortField } from '@shared/types'
import { isPathInside, normalizePath } from './content-key'
import type { SqlDatabase } from '../db/driver'

export interface TrackRow {
  id: number
  source_kind: string
  source_id: string | null
  content_key: string
  title: string
  artist: string | null
  album_artist: string | null
  album: string | null
  track_no: number | null
  disc_no: number | null
  year: number | null
  genre: string | null
  duration_ms: number | null
  codec: string | null
  bitrate_kbps: number | null
  sample_rate: number | null
  channels: number | null
  file_size: number | null
  file_mtime_ms: number | null
  file_path: string | null
  artwork_key: string | null
  added_at: number
  updated_at: number
  play_count: number
  last_played_at: number | null
}

export interface TrackWriteInput {
  contentKey: string
  sourceKind: SourceKind
  sourceId: string | null
  title: string
  artist: string | null
  albumArtist: string | null
  album: string | null
  trackNo: number | null
  discNo: number | null
  year: number | null
  genre: string | null
  durationMs: number | null
  codec: string | null
  bitrateKbps: number | null
  sampleRate: number | null
  channels: number | null
  fileSize: number | null
  fileMtimeMs: number | null
  filePath: string | null
}

export interface ExistingFileState {
  id: number
  fileSize: number | null
  fileMtimeMs: number | null
}

/**
 * The artwork bookkeeping for one track.
 *
 * `artworkKey` is the raw column, so `null` ("never looked at") and `''` ("no
 * cover in this file") stay distinguishable; see the migration comment.
 */
export interface ArtworkState {
  id: number
  artworkKey: string | null
  filePath: string | null
  album: string | null
  albumArtist: string | null
}

/** Counts from a completed scan, kept for diagnostics and for the tests. */
export interface ScanRunSummary {
  id: number
  folder: string | null
  startedAt: number
  finishedAt: number | null
  indexed: number
  updated: number
  skipped: number
  failed: number
  pruned: number
}

const TRACK_COLUMN_NAMES = [
  'id',
  'source_kind',
  'source_id',
  'content_key',
  'title',
  'artist',
  'album_artist',
  'album',
  'track_no',
  'disc_no',
  'year',
  'genre',
  'duration_ms',
  'codec',
  'bitrate_kbps',
  'sample_rate',
  'channels',
  'file_size',
  'file_mtime_ms',
  'file_path',
  'artwork_key',
  'added_at',
  'updated_at',
  'play_count',
  'last_played_at'
] as const

/**
 * The track column list, optionally qualified for a join (`trackColumns('t')`).
 *
 * Exported because the playlist queries join tracks, and a second hand-written
 * copy of this list would silently lose a column the first time one is added.
 */
export function trackColumns(alias = ''): string {
  const prefix = alias.length > 0 ? `${alias}.` : ''
  return TRACK_COLUMN_NAMES.map((name) => prefix + name).join(', ')
}

const TRACK_COLUMNS = trackColumns()

const DEFAULT_ORDER = `
  CASE WHEN artist IS NULL OR artist = '' THEN 1 ELSE 0 END, artist COLLATE NOCASE,
  CASE WHEN album IS NULL OR album = '' THEN 1 ELSE 0 END, album COLLATE NOCASE,
  disc_no, track_no, title COLLATE NOCASE
`

/**
 * Whitelisted sort columns.
 *
 * The value is pasted straight into `ORDER BY`, so it must never come from the
 * renderer: `sanitizeListQuery` narrows the input to these keys first, and this
 * map is the only thing that ever reaches SQL.
 */
const SORT_COLUMNS: Record<TrackSortField, string> = {
  title: 'title COLLATE NOCASE',
  artist: "artist COLLATE NOCASE, album COLLATE NOCASE, disc_no, track_no",
  album: "album COLLATE NOCASE, disc_no, track_no",
  duration: 'duration_ms',
  year: 'year, album COLLATE NOCASE, disc_no, track_no',
  added: 'added_at',
  played: 'last_played_at'
}

/**
 * Builds the ORDER BY clause for a query.
 *
 * `id` is always appended: without a total order, two rows with equal sort keys
 * can come back in a different order for each page, which makes paging skip or
 * duplicate rows.
 */
function buildOrder(query: ListTracksQuery): string {
  const field = query.sort
  if (!field) return DEFAULT_ORDER
  const column = SORT_COLUMNS[field]
  if (!column) return DEFAULT_ORDER
  const direction = query.direction === 'desc' ? 'DESC' : 'ASC'
  return `${column} ${direction}, id ASC`
}

/**
 * Turns free text into an FTS5 query.
 *
 * Everything that is not a letter, a number or whitespace is dropped, so user
 * input such as `AC/DC - "Back in Black"` can never be interpreted as FTS5
 * syntax. Terms become prefix matches joined with AND.
 */
export function buildFtsQuery(input: string): string | null {
  const cleaned = input.replace(/[^\p{L}\p{N}\s]/gu, ' ')
  const terms = cleaned.split(/\s+/).filter(Boolean).slice(0, 8)
  if (terms.length === 0) return null
  return terms.map((term) => `"${term}"*`).join(' AND ')
}

/** Maps a joined `tracks` row into the shape the rest of the app speaks. */
export function mapTrackRow(row: TrackRow): Track {
  return {
    id: row.id,
    sourceKind: row.source_kind === 'youtube' ? 'youtube' : 'local',
    sourceId: row.source_id,
    title: row.title,
    artist: row.artist,
    albumArtist: row.album_artist,
    album: row.album,
    trackNo: row.track_no,
    discNo: row.disc_no,
    year: row.year,
    genre: row.genre,
    durationMs: row.duration_ms,
    codec: row.codec,
    bitrateKbps: row.bitrate_kbps,
    sampleRate: row.sample_rate,
    channels: row.channels,
    fileSize: row.file_size,
    filePath: row.file_path,
    // The '' sentinel is an implementation detail of the artwork cache; the rest
    // of the app only needs to know whether there is something to display.
    artworkKey: row.artwork_key && row.artwork_key.length > 0 ? row.artwork_key : null,
    addedAt: row.added_at,
    playCount: row.play_count,
    lastPlayedAt: row.last_played_at
  }
}

export class TrackRepository {
  constructor(private readonly db: SqlDatabase) {}

  getById(id: number): Track | null {
    const row = this.db.prepare(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE id = ?`).get<TrackRow>(id)
    return row ? mapTrackRow(row) : null
  }

  list(query: ListTracksQuery = {}): TrackPage {
    const limit = Math.min(Math.max(query.limit ?? 5000, 1), 50000)
    const offset = Math.max(query.offset ?? 0, 0)
    const ftsQuery = query.search ? buildFtsQuery(query.search) : null
    const order = buildOrder(query)

    if (ftsQuery) {
      const where = 'WHERE id IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ?)'
      const rows = this.db
        .prepare(`SELECT ${TRACK_COLUMNS} FROM tracks ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
        .all<TrackRow>(ftsQuery, limit, offset)
      const total = this.db
        .prepare(`SELECT COUNT(*) AS total FROM tracks ${where}`)
        .get<{ total: number }>(ftsQuery)
      return { tracks: rows.map(mapTrackRow), total: total?.total ?? 0 }
    }

    const rows = this.db
      .prepare(`SELECT ${TRACK_COLUMNS} FROM tracks ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all<TrackRow>(limit, offset)
    const total = this.db.prepare('SELECT COUNT(*) AS total FROM tracks').get<{ total: number }>()
    return { tracks: rows.map(mapTrackRow), total: total?.total ?? 0 }
  }

  stats(): LibraryStats {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS tracks,
           COUNT(DISTINCT CASE WHEN artist IS NOT NULL AND artist <> '' THEN artist END) AS artists,
           COUNT(DISTINCT CASE WHEN album IS NOT NULL AND album <> ''
             THEN artist || char(31) || album END) AS albums,
           COALESCE(SUM(file_size), 0) AS totalBytes
         FROM tracks`
      )
      .get<{ tracks: number; artists: number; albums: number; totalBytes: number }>()

    return {
      tracks: row?.tracks ?? 0,
      artists: row?.artists ?? 0,
      albums: row?.albums ?? 0,
      totalBytes: row?.totalBytes ?? 0,
      lastScanAt: this.lastScanAt()
    }
  }

  /** Existing rows for a set of paths, used for the size+mtime fast path. */
  existingFileState(keys: string[]): Map<string, ExistingFileState> {
    const result = new Map<string, ExistingFileState>()
    for (const chunk of chunked(keys, 400)) {
      const placeholders = chunk.map(() => '?').join(', ')
      const rows = this.db
        .prepare(
          `SELECT id, content_key, file_size, file_mtime_ms FROM tracks WHERE content_key IN (${placeholders})`
        )
        .all<{ id: number; content_key: string; file_size: number | null; file_mtime_ms: number | null }>(
          ...chunk
        )
      for (const row of rows) {
        result.set(row.content_key, {
          id: row.id,
          fileSize: row.file_size,
          fileMtimeMs: row.file_mtime_ms
        })
      }
    }
    return result
  }

  insert(input: TrackWriteInput, now: number): number {
    const result = this.db
      .prepare(
        `INSERT INTO tracks (
           source_kind, source_id, content_key, title, artist, album_artist, album,
           track_no, disc_no, year, genre, duration_ms, codec, bitrate_kbps,
           sample_rate, channels, file_size, file_mtime_ms, file_path, added_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.sourceKind,
        input.sourceId,
        input.contentKey,
        input.title,
        input.artist,
        input.albumArtist,
        input.album,
        input.trackNo,
        input.discNo,
        input.year,
        input.genre,
        input.durationMs,
        input.codec,
        input.bitrateKbps,
        input.sampleRate,
        input.channels,
        input.fileSize,
        input.fileMtimeMs,
        input.filePath,
        now,
        now
      )
    return result.lastInsertRowid
  }

  update(id: number, input: TrackWriteInput, now: number): void {
    this.db
      .prepare(
        `UPDATE tracks SET
           title = ?, artist = ?, album_artist = ?, album = ?, track_no = ?, disc_no = ?,
           year = ?, genre = ?, duration_ms = ?, codec = ?, bitrate_kbps = ?, sample_rate = ?,
           channels = ?, file_size = ?, file_mtime_ms = ?, file_path = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.title,
        input.artist,
        input.albumArtist,
        input.album,
        input.trackNo,
        input.discNo,
        input.year,
        input.genre,
        input.durationMs,
        input.codec,
        input.bitrateKbps,
        input.sampleRate,
        input.channels,
        input.fileSize,
        input.fileMtimeMs,
        input.filePath,
        now,
        id
      )
  }

  /**
   * Applies a batch of inserts/updates in a single transaction.
   *
   * The scanner calls this per batch of files so that a large scan does not pay
   * one fsync per track.
   */
  writeBatch(
    entries: Array<{ existingId: number | null; input: TrackWriteInput }>,
    now: number
  ): { inserted: number; updated: number } {
    let inserted = 0
    let updated = 0
    this.db.transaction(() => {
      for (const entry of entries) {
        if (entry.existingId === null) {
          this.insert(entry.input, now)
          inserted += 1
        } else {
          this.update(entry.existingId, entry.input, now)
          updated += 1
        }
      }
    })
    return { inserted, updated }
  }

  /**
   * Deletes local rows inside `folders` that were not present in this scan.
   *
   * Loads the candidate rows rather than filtering in SQL, because SQL LIKE
   * cannot express "inside this directory" safely with Windows separators.
   * Only `content_key`, `file_path` and `id` are read, so this stays cheap.
   */
  pruneMissing(folders: string[], seenKeys: Set<string>): number {
    if (folders.length === 0) return 0
    const candidates = this.db
      .prepare(`SELECT id, content_key, file_path FROM tracks WHERE source_kind = 'local'`)
      .all<{ id: number; content_key: string; file_path: string | null }>()

    const staleIds = candidates
      .filter((row) => {
        if (seenKeys.has(row.content_key)) return false
        if (!row.file_path) return false
        return folders.some((folder) => isPathInside(folder, row.file_path as string))
      })
      .map((row) => row.id)

    return this.deleteByIds(staleIds)
  }

  deleteByIds(ids: number[]): number {
    let deleted = 0
    for (const chunk of chunked(ids, 400)) {
      const placeholders = chunk.map(() => '?').join(', ')
      deleted += this.db.prepare(`DELETE FROM tracks WHERE id IN (${placeholders})`).run(...chunk).changes
    }
    return deleted
  }

  incrementPlayCount(id: number, now: number): void {
    this.db
      .prepare('UPDATE tracks SET play_count = play_count + 1, last_played_at = ? WHERE id = ?')
      .run(now, id)
  }

  // --- library folders -----------------------------------------------------

  addLibraryFolder(folder: string): void {
    this.db
      .prepare('INSERT INTO library_folders (path, added_at) VALUES (?, ?) ON CONFLICT(path) DO NOTHING')
      .run(normalizePath(folder), Date.now())
  }

  removeLibraryFolder(folder: string): void {
    this.db.prepare('DELETE FROM library_folders WHERE path = ?').run(normalizePath(folder))
  }

  listLibraryFolders(): string[] {
    return this.db
      .prepare('SELECT path FROM library_folders ORDER BY path')
      .all<{ path: string }>()
      .map((row) => row.path)
  }

  markFolderScanned(folder: string, at: number): void {
    this.db
      .prepare('UPDATE library_folders SET last_scan_at = ? WHERE path = ?')
      .run(at, normalizePath(folder))
  }

  // --- scan runs -----------------------------------------------------------

  startScanRun(folder: string | null): number {
    return this.db
      .prepare('INSERT INTO scan_runs (folder, started_at) VALUES (?, ?)')
      .run(folder, Date.now()).lastInsertRowid
  }

  finishScanRun(
    runId: number,
    counts: { indexed: number; updated: number; skipped: number; failed: number; pruned: number }
  ): void {
    this.db
      .prepare(
        `UPDATE scan_runs SET finished_at = ?, indexed = ?, updated = ?, skipped = ?, failed = ?, pruned = ?
         WHERE id = ?`
      )
      .run(Date.now(), counts.indexed, counts.updated, counts.skipped, counts.failed, counts.pruned, runId)
  }

  lastScanAt(): number | null {
    const row = this.db
      .prepare('SELECT MAX(finished_at) AS finished_at FROM scan_runs')
      .get<{ finished_at: number | null }>()
    return row?.finished_at ?? null
  }

  /**
   * Counts from the most recent scan.
   *
   * Exposed because "how many files were skipped as unchanged" is the property
   * that keeps rescans cheap, and it is otherwise invisible from the outside.
   */
  lastScanRun(): ScanRunSummary | null {
    const row = this.db
      .prepare(
        `SELECT id, folder, started_at, finished_at, indexed, updated, skipped, failed, pruned
         FROM scan_runs ORDER BY id DESC LIMIT 1`
      )
      .get<{
        id: number
        folder: string | null
        started_at: number
        finished_at: number | null
        indexed: number
        updated: number
        skipped: number
        failed: number
        pruned: number
      }>()
    if (!row) return null
    return {
      id: row.id,
      folder: row.folder,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      indexed: row.indexed,
      updated: row.updated,
      skipped: row.skipped,
      failed: row.failed,
      pruned: row.pruned
    }
  }

  /** Convenience for the media layer: resolve a content key without a full row. */
  pathForTrack(id: number): string | null {
    const row = this.db.prepare('SELECT file_path FROM tracks WHERE id = ?').get<{ file_path: string | null }>(id)
    return row?.file_path ?? null
  }

  // --- artwork -------------------------------------------------------------

  /** Everything the artwork service needs to decide what to do for one track. */
  artworkState(id: number): ArtworkState | null {
    const row = this.db
      .prepare('SELECT id, artwork_key, file_path, album, album_artist FROM tracks WHERE id = ?')
      .get<{
        id: number
        artwork_key: string | null
        file_path: string | null
        album: string | null
        album_artist: string | null
      }>(id)
    if (!row) return null
    return {
      id: row.id,
      artworkKey: row.artwork_key,
      filePath: row.file_path,
      album: row.album,
      albumArtist: row.album_artist
    }
  }

  /**
   * Records the artwork outcome for a track: a cache key, or '' for "none".
   *
   * Deliberately not an `update()` call — artwork is written far more often than
   * tags, and routing it through the tag write would bump `updated_at` and make
   * the scan's change detection think the row had been touched.
   */
  setArtworkKey(id: number, key: string): void {
    this.db.prepare('UPDATE tracks SET artwork_key = ? WHERE id = ?').run(key, id)
  }

  /** A key already known for an album, so its other tracks need no extraction. */
  artworkKeyForAlbum(album: string, albumArtist: string | null): string | null {
    const row = this.db
      .prepare(
        `SELECT artwork_key FROM tracks
          WHERE album = ? AND album_artist IS ? AND artwork_key IS NOT NULL AND artwork_key <> ''
          LIMIT 1`
      )
      .get<{ artwork_key: string }>(album, albumArtist)
    return row?.artwork_key ?? null
  }
}

function chunked<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}
