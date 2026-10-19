import type { OnlineTrack } from '@shared/types'
import type { SqlDatabase } from '../db/driver'

/**
 * How many links the Online view loads at once.
 *
 * The list is a browsing aid, not an archive: a session that has run for months
 * would otherwise transfer every link it has ever seen on each visit. Older rows
 * are still in the database and reappear the moment a newer one is removed —
 * they are only outside this page.
 */
export const ONLINE_HISTORY_LIMIT = 500

interface OnlineRow {
  id: number
  video_id: string
  title: string
  artist: string | null
  album: string | null
  duration_ms: number | null
  source_url: string
  artwork_key: string | null
  added_at: number
  last_played_at: number | null
}

/** Everything needed to write a history row. Identity is `videoId`. */
export interface OnlineInput {
  videoId: string
  title: string
  artist: string | null
  album: string | null
  durationMs: number | null
  sourceUrl: string
  artworkKey: string | null
}

const COLUMNS = `id, video_id, title, artist, album, duration_ms, source_url, artwork_key, added_at, last_played_at`

function mapRow(row: OnlineRow): OnlineTrack {
  return {
    id: row.id,
    videoId: row.video_id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    durationMs: row.duration_ms,
    sourceUrl: row.source_url,
    artworkKey: row.artwork_key,
    addedAt: row.added_at,
    lastPlayedAt: row.last_played_at
  }
}

/**
 * The Online history table.
 *
 * Mechanical by design: it stores links and orders them. Whether a resolved link
 * should replace an existing row, and what a play does to the order, are decided
 * once in `OnlineService` so the SQL here stays readable.
 */
export class OnlineRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Links ordered by their most recent activity — added or played — newest
   * first. `MAX(a, b)` here is SQLite's scalar form, not the aggregate.
   */
  list(limit = ONLINE_HISTORY_LIMIT): OnlineTrack[] {
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM online_tracks
         ORDER BY MAX(COALESCE(last_played_at, 0), added_at) DESC, id DESC
         LIMIT ?`
      )
      .all<OnlineRow>(limit)
      .map(mapRow)
  }

  get(id: number): OnlineTrack | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM online_tracks WHERE id = ?`).get<OnlineRow>(id)
    return row ? mapRow(row) : null
  }

  getByVideoId(videoId: string): OnlineTrack | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM online_tracks WHERE video_id = ?`)
      .get<OnlineRow>(videoId)
    return row ? mapRow(row) : null
  }

  /**
   * Inserts the link, or refreshes the row it already has.
   *
   * A re-paste is treated as fresh activity (`added_at` moves to now) so the row
   * surfaces at the top where the user just put it, while `last_played_at` is
   * left alone — pasting is not playing. A thumbnail that failed to fetch on this
   * pass does not erase one cached earlier.
   */
  upsert(input: OnlineInput, now: number): OnlineTrack {
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO online_tracks
             (video_id, title, artist, album, duration_ms, source_url, artwork_key, added_at, last_played_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(video_id) DO UPDATE SET
             title       = excluded.title,
             artist      = excluded.artist,
             album       = excluded.album,
             duration_ms = excluded.duration_ms,
             source_url  = excluded.source_url,
             artwork_key = COALESCE(excluded.artwork_key, online_tracks.artwork_key),
             added_at    = excluded.added_at`
        )
        .run(
          input.videoId,
          input.title,
          input.artist,
          input.album,
          input.durationMs,
          input.sourceUrl,
          input.artworkKey,
          now
        )
      const row = this.getByVideoId(input.videoId)
      if (!row) throw new Error('The online history row was not written.')
      return row
    })
  }

  /** Records that a link has just been played, which lifts it up the list. */
  touch(videoId: string, now: number): void {
    this.db.prepare('UPDATE online_tracks SET last_played_at = ? WHERE video_id = ?').run(now, videoId)
  }

  /**
   * Stores a thumbnail that was fetched after the row was written.
   *
   * Rows are added before their picture is downloaded — a paste should not wait
   * on an image CDN — so the key arrives on a later pass. That also repairs rows
   * created when thumbnails failed to decode.
   */
  setArtworkKey(videoId: string, artworkKey: string): void {
    this.db.prepare('UPDATE online_tracks SET artwork_key = ? WHERE video_id = ?').run(artworkKey, videoId)
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM online_tracks WHERE id = ?').run(id)
  }

  /**
   * Forgets the history row for each of these videos, if it has one.
   *
   * History is for links the user added. An imported list is its own home for its
   * entries, so importing it takes back any row a play had already made — without
   * touching the list, which is where those tracks still live.
   */
  removeByVideoIds(videoIds: readonly string[]): number {
    const unique = [...new Set(videoIds)].filter((id) => id.length > 0)
    let removed = 0
    for (let at = 0; at < unique.length; at += 400) {
      const batch = unique.slice(at, at + 400)
      const placeholders = batch.map(() => '?').join(', ')
      removed += this.db.prepare(`DELETE FROM online_tracks WHERE video_id IN (${placeholders})`).run(...batch).changes
    }
    return removed
  }

  clear(): number {
    return this.db.prepare('DELETE FROM online_tracks').run().changes
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM online_tracks').get<{ total: number }>()
    return row?.total ?? 0
  }
}
