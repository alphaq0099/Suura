import type { LibraryStats, ListTracksQuery, SourceKind, Track, TrackPage, TrackSortField } from '@shared/types'
import { recentlyAddedCutoff } from '@shared/library'
import { isPathInside, localContentKey, normalizePath } from './content-key'
import type { SqlDatabase, SqlParam } from '../db/driver'

export interface TrackRow {
  id: number
  source_kind: string
  source_id: string | null
  origin_kind: string | null
  origin_id: string | null
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
  missing_at: number | null
  file_hash: string | null
  artwork_key: string | null
  added_at: number
  updated_at: number
  play_count: number
  last_played_at: number | null
  replay_gain_db: number | null
  replay_gain_peak: number | null
}

/** A local file waiting for loudness analysis. */
export interface ReplayGainCandidate {
  id: number
  filePath: string
  title: string
  artist: string | null
}

export interface ReplayGainStats {
  /** Playable local rows. */
  total: number
  /** Rows that already have a measured gain. */
  analyzed: number
}

export interface TrackWriteInput {
  contentKey: string
  sourceKind: SourceKind
  sourceId: string | null
  /** Where the file came from; null for an ordinary local file. */
  originKind: SourceKind | null
  originId: string | null
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
  'origin_kind',
  'origin_id',
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
  'missing_at',
  'file_hash',
  'artwork_key',
  'added_at',
  'updated_at',
  'play_count',
  'last_played_at',
  'replay_gain_db',
  'replay_gain_peak'
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
  if (!field) {
    // A smart view with no column chosen has an order of its own: newest first
    // for Recently added, and most-played first for the play-count view. A
    // column click still wins, so the header remains the way to re-sort.
    if (query.filter === 'recent') return 'added_at DESC, id ASC'
    if (query.filter === 'most-played') {
      return 'play_count DESC, COALESCE(last_played_at, 0) DESC, id ASC'
    }
    return DEFAULT_ORDER
  }
  const column = SORT_COLUMNS[field]
  if (!column) return DEFAULT_ORDER
  const direction = query.direction === 'desc' ? 'DESC' : 'ASC'
  return `${column} ${direction}, id ASC`
}

/**
 * The WHERE clause and its bound values for a list query.
 *
 * Every fragment here is a constant chosen by the switch, never a string from
 * the renderer; `sanitizeListQuery` narrows `filter` to these names first.
 */
function buildFilter(query: ListTracksQuery): { where: string; params: SqlParam[] } {
  // Missing rows stay in the table so their history and playlist entries can be
  // repaired, but every normal list is a list of playable things.
  const conditions: string[] = ['missing_at IS NULL']
  const params: SqlParam[] = []

  const ftsQuery = query.search ? buildFtsQuery(query.search) : null
  if (ftsQuery) {
    conditions.push('id IN (SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH ?)')
    params.push(ftsQuery)
  }

  switch (query.filter) {
    case 'recent':
      conditions.push('added_at >= ?')
      params.push(recentlyAddedCutoff())
      break
    case 'most-played':
      conditions.push('play_count > 0')
      break
    case 'never-played':
      conditions.push('play_count = 0')
      break
    default:
      break
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params
  }
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
    originKind: row.origin_kind === 'youtube' ? 'youtube' : null,
    originId: row.origin_id,
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
    missingAt: row.missing_at,
    filePath: row.file_path,
    // The '' sentinel is an implementation detail of the artwork cache; the rest
    // of the app only needs to know whether there is something to display.
    artworkKey: row.artwork_key && row.artwork_key.length > 0 ? row.artwork_key : null,
    addedAt: row.added_at,
    playCount: row.play_count,
    lastPlayedAt: row.last_played_at,
    replayGainDb: row.replay_gain_db ?? null,
    replayGainPeak: row.replay_gain_peak ?? null
  }
}

export class TrackRepository {
  constructor(private readonly db: SqlDatabase) {}

  getById(id: number): Track | null {
    const row = this.db.prepare(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE id = ?`).get<TrackRow>(id)
    return row ? mapTrackRow(row) : null
  }

  /**
   * The row for a file path, using the same normalisation as the scanner.
   *
   * Playlists store paths as text, and a path copied from another machine can
   * differ in case or separators from the one the scanner stored. The content
   * key is already the normalised identity, so there is one answer rather than
   * a second comparison that can disagree with deduplication.
   */
  findByFilePath(filePath: string): Track | null {
    const row = this.db
      .prepare(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE content_key = ? AND missing_at IS NULL`)
      .get<TrackRow>(localContentKey(filePath))
    return row ? mapTrackRow(row) : null
  }

  /** The library row for a video, if that video has already been saved. */
  findByOrigin(originKind: SourceKind, originId: string): Track | null {
    const row = this.db
      .prepare(
        `SELECT ${TRACK_COLUMNS} FROM tracks
         WHERE origin_kind = ? AND origin_id = ? AND missing_at IS NULL
         ORDER BY id ASC LIMIT 1`
      )
      .get<TrackRow>(originKind, originId)
    return row ? mapTrackRow(row) : null
  }

  /**
   * Which of these origin ids already have a row.
   *
   * The Online views ask this for a whole page at once so a list of 200 tracks
   * costs one query rather than 200. The caller only needs the ids, not the rows.
   */
  savedOrigins(originKind: SourceKind, originIds: string[]): Set<string> {
    const found = new Set<string>()
    const unique = [...new Set(originIds)].filter((id) => id.length > 0)
    for (let at = 0; at < unique.length; at += 400) {
      const batch = unique.slice(at, at + 400)
      const placeholders = batch.map(() => '?').join(', ')
      const rows = this.db
        .prepare(
          `SELECT DISTINCT origin_id FROM tracks
           WHERE origin_kind = ? AND origin_id IN (${placeholders}) AND missing_at IS NULL`
        )
        .all<{ origin_id: string | null }>(originKind, ...batch)
      for (const row of rows) if (row.origin_id) found.add(row.origin_id)
    }
    return found
  }

  /**
   * Records where a file came from without touching anything a tag owns.
   *
   * The scanner normally learns the origin from the file's own comment, but the
   * downloader knows it first-hand and must not depend on a tag being present.
   */
  setOrigin(id: number, originKind: SourceKind | null, originId: string | null): void {
    this.db.prepare('UPDATE tracks SET origin_kind = ?, origin_id = ? WHERE id = ?').run(originKind, originId, id)
  }

  /**
   * The tracks for a list of ids, in the order the ids were given.
   *
   * `IN` returns rows in whatever order SQLite likes, so the caller's order is
   * restored here. Ids that no longer exist are dropped rather than returned as
   * holes: every caller is reconstructing a queue or a playlist, and a hole is
   * not something either can hold. Batched because a queue can be long enough
   * to exceed SQLite's bound-parameter limit.
   */
  byIds(ids: number[]): Track[] {
    if (ids.length === 0) return []
    const found = new Map<number, Track>()
    const unique = [...new Set(ids)]

    for (let at = 0; at < unique.length; at += 500) {
      const batch = unique.slice(at, at + 500)
      const placeholders = batch.map(() => '?').join(', ')
      const rows = this.db
        .prepare(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE id IN (${placeholders})`)
        .all<TrackRow>(...batch)
      for (const row of rows) found.set(row.id, mapTrackRow(row))
    }

    return ids.flatMap((id) => {
      const track = found.get(id)
      return track ? [track] : []
    })
  }

  /**
   * Every row, for a data export.
   *
   * Deliberately not `list({ limit: 50000 })`: a cap that silently drops the
   * tail of a library is the one thing an export must never do. The UI already
   * pages through the same table, so this is only paid for when the user asks
   * for a CSV, and the whole result is held in memory once.
   */
  allForExport(): Track[] {
    return this.db
      .prepare(`SELECT ${TRACK_COLUMNS} FROM tracks WHERE missing_at IS NULL ORDER BY ${DEFAULT_ORDER}, id`)
      .all<TrackRow>()
      .map(mapTrackRow)
  }

  list(query: ListTracksQuery = {}): TrackPage {
    const limit = Math.min(Math.max(query.limit ?? 5000, 1), 50000)
    const offset = Math.max(query.offset ?? 0, 0)
    const order = buildOrder(query)
    const { where, params } = buildFilter(query)

    const rows = this.db
      .prepare(`SELECT ${TRACK_COLUMNS} FROM tracks ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all<TrackRow>(...params, limit, offset)
    const total = this.db
      .prepare(`SELECT COUNT(*) AS total FROM tracks ${where}`)
      .get<{ total: number }>(...params)
    return { tracks: rows.map(mapTrackRow), total: total?.total ?? 0 }
  }

  stats(): LibraryStats {
    const cutoff = recentlyAddedCutoff()
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS tracks,
           COUNT(DISTINCT CASE WHEN artist IS NOT NULL AND artist <> '' THEN artist END) AS artists,
           COUNT(DISTINCT CASE WHEN album IS NOT NULL AND album <> ''
             THEN artist || char(31) || album END) AS albums,
           COALESCE(SUM(file_size), 0) AS totalBytes,
           COALESCE(SUM(CASE WHEN added_at >= ? THEN 1 ELSE 0 END), 0) AS recentTracks,
           COALESCE(SUM(CASE WHEN play_count > 0 THEN 1 ELSE 0 END), 0) AS playedTracks,
           COALESCE(SUM(CASE WHEN play_count = 0 THEN 1 ELSE 0 END), 0) AS unplayedTracks,
           (SELECT COUNT(*) FROM tracks WHERE missing_at IS NOT NULL) AS missingTracks
         FROM tracks
         WHERE missing_at IS NULL`
      )
      .get<{
        tracks: number
        artists: number
        albums: number
        totalBytes: number
        recentTracks: number
        playedTracks: number
        unplayedTracks: number
        missingTracks: number
      }>(cutoff)

    return {
      tracks: row?.tracks ?? 0,
      artists: row?.artists ?? 0,
      albums: row?.albums ?? 0,
      totalBytes: row?.totalBytes ?? 0,
      lastScanAt: this.lastScanAt(),
      recentTracks: row?.recentTracks ?? 0,
      playedTracks: row?.playedTracks ?? 0,
      unplayedTracks: row?.unplayedTracks ?? 0,
      missingTracks: row?.missingTracks ?? 0
    }
  }

  /**
   * Playable local files that have no measured gain yet.
   *
   * The scan is deliberately incremental: rerunning it after a few new files
   * arrive only decodes those files, not the whole library. A changed file is
   * cleared by `update`, so it rejoins this list automatically.
   */
  replayGainCandidates(): ReplayGainCandidate[] {
    return this.db
      .prepare(
        `SELECT id, file_path, title, artist
           FROM tracks
          WHERE source_kind = 'local'
            AND missing_at IS NULL
            AND file_path IS NOT NULL
            AND replay_gain_db IS NULL
          ORDER BY id`
      )
      .all<{ id: number; file_path: string; title: string; artist: string | null }>()
      .map((row) => ({
        id: row.id,
        filePath: row.file_path,
        title: row.title,
        artist: row.artist
      }))
  }

  /** How much of the local library has a measured gain. */
  replayGainStats(): ReplayGainStats {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN replay_gain_db IS NOT NULL THEN 1 ELSE 0 END), 0) AS analyzed
           FROM tracks
          WHERE source_kind = 'local' AND missing_at IS NULL AND file_path IS NOT NULL`
      )
      .get<{ total: number; analyzed: number }>()
    return { total: row?.total ?? 0, analyzed: row?.analyzed ?? 0 }
  }

  /** Stores one analysis result. Values are already converted from LUFS. */
  setReplayGain(id: number, gainDb: number, peakDb: number | null): void {
    this.db
      .prepare(`UPDATE tracks SET replay_gain_db = ?, replay_gain_peak = ? WHERE id = ?`)
      .run(gainDb, peakDb, id)
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
           source_kind, source_id, origin_kind, origin_id, content_key, title, artist, album_artist, album,
           track_no, disc_no, year, genre, duration_ms, codec, bitrate_kbps,
           sample_rate, channels, file_size, file_mtime_ms, file_path, added_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.sourceKind,
        input.sourceId,
        input.originKind,
        input.originId,
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
           origin_kind = ?, origin_id = ?,
           title = ?, artist = ?, album_artist = ?, album = ?, track_no = ?, disc_no = ?,
           year = ?, genre = ?, duration_ms = ?, codec = ?, bitrate_kbps = ?, sample_rate = ?,
           channels = ?, file_size = ?, file_mtime_ms = ?, file_path = ?,
           replay_gain_db = NULL, replay_gain_peak = NULL,
           missing_at = NULL, file_hash = NULL, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.originKind,
        input.originId,
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
   * Marks local rows inside `folders` that were not present in this scan, and
   * clears the mark when a missing file is seen again.
   *
   * Rows are kept rather than deleted: the next scan may be a moved folder, and
   * a row is the only thing that still knows the playlist entries and play
   * count. Loads candidates rather than filtering in SQL, because SQL LIKE
   * cannot express "inside this directory" safely with Windows separators.
   */
  markMissing(folders: string[], seenKeys: Set<string>, now: number): number {
    if (folders.length === 0) return 0
    const candidates = this.db
      .prepare(
        `SELECT id, content_key, file_path, missing_at FROM tracks WHERE source_kind = 'local'`
      )
      .all<{ id: number; content_key: string; file_path: string | null; missing_at: number | null }>()

    const newlyMissing: number[] = []
    const restored: number[] = []
    for (const row of candidates) {
      if (!row.file_path) continue
      if (!folders.some((folder) => isPathInside(folder, row.file_path as string))) continue
      if (seenKeys.has(row.content_key)) {
        if (row.missing_at !== null) restored.push(row.id)
      } else if (row.missing_at === null) {
        newlyMissing.push(row.id)
      }
    }

    this.db.transaction(() => {
      for (const chunk of chunked(newlyMissing, 400)) {
        const placeholders = chunk.map(() => '?').join(', ')
        this.db.prepare(`UPDATE tracks SET missing_at = ? WHERE id IN (${placeholders})`).run(now, ...chunk)
      }
      for (const chunk of chunked(restored, 400)) {
        const placeholders = chunk.map(() => '?').join(', ')
        this.db.prepare(`UPDATE tracks SET missing_at = NULL WHERE id IN (${placeholders})`).run(...chunk)
      }
    })
    return newlyMissing.length
  }

  /** Rows the user explicitly discarded by removing their library folder. */
  deleteInFolders(folders: string[]): number {
    if (folders.length === 0) return 0
    const candidates = this.db
      .prepare(`SELECT id, file_path FROM tracks WHERE source_kind = 'local'`)
      .all<{ id: number; file_path: string | null }>()
    const ids = candidates
      .filter((row) => row.file_path && folders.some((folder) => isPathInside(folder, row.file_path as string)))
      .map((row) => row.id)
    return this.deleteByIds(ids)
  }

  /** Missing local rows, in the order they were last seen. */
  missingTracks(): Track[] {
    return this.db
      .prepare(
        `SELECT ${TRACK_COLUMNS} FROM tracks
         WHERE source_kind = 'local' AND missing_at IS NOT NULL
         ORDER BY missing_at, id`
      )
      .all<TrackRow>()
      .map(mapTrackRow)
  }

  /** The stat/hash facts relocation needs, without exposing them on Track. */
  missingFileStates(): Array<{
    id: number
    filePath: string
    fileSize: number | null
    fileMtimeMs: number | null
    fileHash: string | null
  }> {
    return this.db
      .prepare(
        `SELECT id, file_path, file_size, file_mtime_ms, file_hash FROM tracks
         WHERE source_kind = 'local' AND missing_at IS NOT NULL AND file_path IS NOT NULL
         ORDER BY missing_at, id`
      )
      .all<{
        id: number
        file_path: string
        file_size: number | null
        file_mtime_ms: number | null
        file_hash: string | null
      }>()
      .map((row) => ({
        id: row.id,
        filePath: row.file_path,
        fileSize: row.file_size,
        fileMtimeMs: row.file_mtime_ms,
        fileHash: row.file_hash
      }))
  }

  /** Present local rows whose hash has not been computed, or was invalidated. */
  localTracksAwaitingHash(): Track[] {
    return this.db
      .prepare(
        `SELECT ${TRACK_COLUMNS} FROM tracks
         WHERE source_kind = 'local' AND missing_at IS NULL AND file_hash IS NULL AND file_path IS NOT NULL
         ORDER BY id`
      )
      .all<TrackRow>()
      .map(mapTrackRow)
  }

  setFileHash(id: number, fileHash: string): void {
    this.db.prepare('UPDATE tracks SET file_hash = ? WHERE id = ?').run(fileHash, id)
  }

  /** Present local rows that share a full-file hash, newest groups first. */
  duplicateGroups(): Array<{ hash: string; tracks: Track[] }> {
    const rows = this.db
      .prepare(
        `SELECT ${TRACK_COLUMNS} FROM tracks
         WHERE source_kind = 'local' AND missing_at IS NULL AND file_hash IS NOT NULL
         ORDER BY file_hash, added_at, id`
      )
      .all<TrackRow>()
    const groups = new Map<string, Track[]>()
    for (const row of rows) {
      const hash = row.file_hash as string
      const list = groups.get(hash) ?? []
      list.push(mapTrackRow(row))
      groups.set(hash, list)
    }
    return [...groups.entries()]
      .filter(([, tracks]) => tracks.length > 1)
      .map(([hash, tracks]) => ({ hash, tracks }))
  }

  /**
   * Folds duplicate rows into a keeper without losing what the duplicates knew.
   *
   * Playlist entries are copied first, so the unique index decides whether a
   * list already had the keeper. Play counts add up, the earliest add date and
   * latest play date win, and a missing cover/origin is adopted. This method
   * only changes rows; DataCareService deletes the redundant file after it
   * returns, so a failed merge never loses the file.
   */
  mergeDuplicates(keeperId: number, duplicateIds: number[], now: number): number {
    const ids = [...new Set(duplicateIds)].filter((id) => id !== keeperId)
    if (ids.length === 0) return 0
    this.db.transaction(() => {
      const keeper = this.db
        .prepare('SELECT id, file_hash FROM tracks WHERE id = ? AND missing_at IS NULL')
        .get<{ id: number; file_hash: string | null }>(keeperId)
      if (!keeper) throw new Error('The track to keep is no longer in the library.')
      if (!keeper.file_hash) throw new Error('That track has not been fingerprinted yet.')

      for (const duplicateId of ids) {
        const duplicate = this.db
          .prepare('SELECT id, file_hash FROM tracks WHERE id = ? AND missing_at IS NULL')
          .get<{ id: number; file_hash: string | null }>(duplicateId)
        if (!duplicate) continue
        if (duplicate.file_hash !== keeper.file_hash) {
          throw new Error('Those tracks are not identical copies, so they were left alone.')
        }
        this.foldRow(keeperId, duplicateId, now)
      }
    })
    return ids.length
  }

  /**
   * Points a missing row at a file that was found elsewhere, keeping its id.
   *
   * When the scanner already indexed the new path, that second row is folded
   * into the missing one first and removed, so playlist entries and play state
   * keep pointing at the row that had the history.
   */
  relocateTrack(
    missingId: number,
    targetId: number | null,
    input: { filePath: string; fileSize: number; fileMtimeMs: number },
    now: number
  ): void {
    this.db.transaction(() => {
      const missing = this.db
        .prepare('SELECT id FROM tracks WHERE id = ? AND missing_at IS NOT NULL')
        .get<{ id: number }>(missingId)
      if (!missing) throw new Error('That missing track was already repaired.')
      if (targetId !== null && targetId !== missingId) {
        const target = this.db
          .prepare('SELECT id FROM tracks WHERE id = ? AND missing_at IS NULL')
          .get<{ id: number }>(targetId)
        if (target) this.foldRow(missingId, targetId, now)
      }
      this.db
        .prepare(
          `UPDATE tracks SET
             content_key = ?, file_path = ?, file_size = ?, file_mtime_ms = ?,
             missing_at = NULL, file_hash = NULL, updated_at = ?
           WHERE id = ?`
        )
        .run(localContentKey(input.filePath), input.filePath, input.fileSize, input.fileMtimeMs, now, missingId)
    })
  }

  /** Copy one row's history into another, then delete the first. */
  private foldRow(keeperId: number, duplicateId: number, now: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO playlist_items (playlist_id, track_id, position, added_at)
         SELECT playlist_id, ?, position, added_at FROM playlist_items WHERE track_id = ?`
      )
      .run(keeperId, duplicateId)
    this.db
      .prepare(
        `UPDATE playlists SET updated_at = ?
         WHERE id IN (SELECT playlist_id FROM playlist_items WHERE track_id = ?)`
      )
      .run(now, duplicateId)
    this.db
      .prepare(
        `UPDATE tracks SET
           play_count = play_count + (SELECT play_count FROM tracks WHERE id = ?),
           last_played_at = CASE
             WHEN last_played_at IS NULL THEN (SELECT last_played_at FROM tracks WHERE id = ?)
             WHEN (SELECT last_played_at FROM tracks WHERE id = ?) IS NULL THEN last_played_at
             ELSE MAX(last_played_at, (SELECT last_played_at FROM tracks WHERE id = ?))
           END,
           added_at = MIN(added_at, (SELECT added_at FROM tracks WHERE id = ?)),
           origin_kind = COALESCE(origin_kind, (SELECT origin_kind FROM tracks WHERE id = ?)),
           origin_id = COALESCE(origin_id, (SELECT origin_id FROM tracks WHERE id = ?)),
           artwork_key = COALESCE(artwork_key, (SELECT artwork_key FROM tracks WHERE id = ?)),
           updated_at = ?
         WHERE id = ?`
      )
      .run(
        duplicateId,
        duplicateId,
        duplicateId,
        duplicateId,
        duplicateId,
        duplicateId,
        duplicateId,
        duplicateId,
        now,
        keeperId
      )
    // The foreign key cascades any playlist entries that could not be copied,
    // and the FTS delete trigger keeps search in step.
    this.db.prepare('DELETE FROM tracks WHERE id = ?').run(duplicateId)
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
