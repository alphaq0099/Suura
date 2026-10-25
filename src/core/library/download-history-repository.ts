import type { SqlDatabase } from '../db/driver'
import {
  DOWNLOAD_STATUSES,
  type DownloadHistoryItem,
  type DownloadProgress,
  type DownloadStatus,
  type SaveToLibraryRequest
} from '@shared/types'

interface DownloadHistoryRow {
  video_id: string
  title: string
  artist: string | null
  album: string | null
  status: string
  percent: number | null
  error: string | null
  track_id: number | null
  created_at: number
  updated_at: number
}

const COLUMNS = `video_id, title, artist, album, status, percent, error, track_id, created_at, updated_at`

function toStatus(value: string): DownloadStatus {
  return DOWNLOAD_STATUSES.includes(value as DownloadStatus) ? (value as DownloadStatus) : 'failed'
}

function mapRow(row: DownloadHistoryRow): DownloadHistoryItem {
  return {
    videoId: row.video_id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    status: toStatus(row.status),
    percent: row.percent,
    error: row.error,
    trackId: row.track_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * Every save the app has attempted, keyed by video.
 *
 * The in-memory `useDownloads` mirror is enough while the window is open, but a
 * save that fails at night and is retried the next morning needs a home that
 * outlives the process. This table is that home. It deliberately has no foreign
 * key to `tracks`: a failed save has no row, and a retry must remain possible
 * after the user removes the library row.
 */
export class DownloadHistoryRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** Newest activity first. The list is a screen, so it is always bounded. */
  list(limit = 200): DownloadHistoryItem[] {
    const count = Math.min(1000, Math.max(1, Math.round(limit)))
    return this.db
      .prepare(
        `SELECT ${COLUMNS} FROM download_history
         ORDER BY updated_at DESC, video_id ASC
         LIMIT ?`
      )
      .all<DownloadHistoryRow>(count)
      .map(mapRow)
  }

  get(videoId: string): DownloadHistoryItem | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM download_history WHERE video_id = ?`)
      .get<DownloadHistoryRow>(videoId)
    return row ? mapRow(row) : null
  }

  /**
   * Writes the latest state.
   *
   * The request is only present at the start of a save (and on a retry), so an
   * update without it keeps the existing titles. `track_id` follows the same
   * rule: a later failure must not erase the row id a finished save produced.
   */
  record(progress: DownloadProgress, request: SaveToLibraryRequest | null, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO download_history
           (video_id, title, artist, album, status, percent, error, track_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(video_id) DO UPDATE SET
           title    = COALESCE(NULLIF(excluded.title, ''), download_history.title),
           artist   = COALESCE(excluded.artist, download_history.artist),
           album    = COALESCE(excluded.album, download_history.album),
           status   = excluded.status,
           percent  = excluded.percent,
           error    = excluded.error,
           track_id = COALESCE(excluded.track_id, download_history.track_id),
           updated_at = excluded.updated_at`
      )
      .run(
        progress.videoId,
        request?.title ?? '',
        request?.artist ?? null,
        request?.album ?? null,
        progress.status,
        progress.percent,
        progress.error,
        progress.trackId,
        now,
        now
      )
  }

  /**
   * Turns rows left mid-flight by a crash into failures.
   *
   * Called once at start-up, before any new save can be queued. Without it a
   * row would sit at "downloading 37%" forever and the saves panel would offer
   * a Cancel that has nothing to cancel.
   */
  markInterrupted(now = Date.now()): number {
    return this.db
      .prepare(
        `UPDATE download_history
         SET status = 'failed',
             error = COALESCE(error, 'The app closed before this save finished.'),
             percent = NULL,
             updated_at = ?
         WHERE status IN ('queued', 'downloading', 'finishing', 'indexing')`
      )
      .run(now).changes
  }

  remove(videoId: string): void {
    this.db.prepare('DELETE FROM download_history WHERE video_id = ?').run(videoId)
  }
}
