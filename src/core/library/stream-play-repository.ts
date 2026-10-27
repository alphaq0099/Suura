import type { StreamPlay } from '@shared/types'
import type { SqlDatabase } from '../db/driver'

interface StreamPlayRow {
  id: number
  video_id: string
  title: string
  artist: string | null
  album: string | null
  duration_ms: number | null
  added_at: number
  last_played_at: number
  play_count: number
}

/** Everything needed to write or refresh a played-stream row. */
export interface StreamPlayInput {
  videoId: string
  title: string
  artist: string | null
  album: string | null
  durationMs: number | null
}

const COLUMNS = `id, video_id, title, artist, album, duration_ms, added_at, last_played_at, play_count`

/**
 * How many stream listens are kept.
 *
 * Recently played is a shelf, not an archive; the newest rows are the only ones
 * any screen asks for. Keeping a bound means a long-running session cannot grow
 * the table forever after every quick play.
 */
const STREAM_PLAY_LIMIT = 500

function mapRow(row: StreamPlayRow): StreamPlay {
  return {
    id: row.id,
    videoId: row.video_id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    durationMs: row.duration_ms,
    addedAt: row.added_at,
    lastPlayedAt: row.last_played_at,
    playCount: row.play_count
  }
}

/**
 * The listens of videos that have no `tracks` row.
 *
 * The online history answers "which links did the user add"; this table answers
 * "what was played, and when", which is what Recently played needs. A playlist
 * entry stays out of the history on purpose, so both it and a pasted link write
 * one row here instead of forking the history's meaning.
 */
export class StreamPlayRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** Newest listen first, for Home's shelf. */
  list(limit = 24): StreamPlay[] {
    const count = Math.min(STREAM_PLAY_LIMIT, Math.max(1, Math.round(limit)))
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM stream_plays
         ORDER BY last_played_at DESC, id DESC
         LIMIT ?`
      )
      .all<StreamPlayRow>(count)
      .map(mapRow)
  }

  get(id: number): StreamPlay | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM stream_plays WHERE id = ?`).get<StreamPlayRow>(id)
    return row ? mapRow(row) : null
  }

  getByVideoId(videoId: string): StreamPlay | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM stream_plays WHERE video_id = ?`)
      .get<StreamPlayRow>(videoId)
    return row ? mapRow(row) : null
  }

  /**
   * Records one counted listen.
   *
   * Identity is the video, so playing the same stream from history, from an
   * imported list or from its own Home card all lift the same row. The first
   * write sets `added_at`; later ones only move the listen time and count.
   */
  upsert(input: StreamPlayInput, now = Date.now()): StreamPlay {
    this.db
      .prepare(
        `INSERT INTO stream_plays
           (video_id, title, artist, album, duration_ms, added_at, last_played_at, play_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(video_id) DO UPDATE SET
           title          = COALESCE(NULLIF(excluded.title, ''), stream_plays.title),
           artist         = COALESCE(excluded.artist, stream_plays.artist),
           album          = COALESCE(excluded.album, stream_plays.album),
           duration_ms    = COALESCE(excluded.duration_ms, stream_plays.duration_ms),
           last_played_at = excluded.last_played_at,
           play_count     = stream_plays.play_count + 1`
      )
      .run(input.videoId, input.title, input.artist, input.album, input.durationMs, now, now)

    this.prune()
    const row = this.getByVideoId(input.videoId)
    if (!row) throw new Error('The stream play row was not written.')
    return row
  }

  /** Moves an existing row up after a replay from its own Home card. */
  touch(id: number, now = Date.now()): boolean {
    const result = this.db
      .prepare(
        `UPDATE stream_plays
         SET last_played_at = ?, play_count = play_count + 1
         WHERE id = ?`
      )
      .run(now, id)
    return result.changes > 0
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM stream_plays').get<{ count: number }>()
    return row?.count ?? 0
  }

  /** Test and maintenance helper: forgets every played stream. */
  clear(): number {
    return this.db.prepare('DELETE FROM stream_plays').run().changes
  }

  /**
   * Drops rows outside the retained window.
   *
   * Runs after each write, when there is at most one extra row to remove, so it
   * never becomes a table-wide sort on a hot path.
   */
  private prune(): void {
    this.db
      .prepare(
        `DELETE FROM stream_plays
         WHERE id NOT IN (
           SELECT id FROM stream_plays
           ORDER BY last_played_at DESC, id DESC
           LIMIT ?
         )`
      )
      .run(STREAM_PLAY_LIMIT)
  }
}
