import type { SqlDatabase } from '../db/driver'
import type { PlaybackSnapshot } from '@shared/types'

interface PlayStateRow {
  queue: string
  cursor: number
  position_ms: number
  updated_at: number
}

/**
 * The last session's queue, rewritten in place.
 *
 * There is exactly one row (`id = 1`), because this is a snapshot rather than a
 * history: the only question it ever answers is "what was playing when the app
 * closed". A table of rows would invite questions it cannot answer — which of
 * them is current, how to age them out — for no benefit.
 *
 * Everything that comes back out of `read` is checked. The value is a JSON blob
 * written by an older version of the app, so it is treated the same way as any
 * other data from disk: parse it defensively, drop what does not make sense, and
 * report nothing rather than throwing at start-up.
 */
export class PlayStateRepository {
  constructor(private readonly db: SqlDatabase) {}

  read(): PlaybackSnapshot | null {
    const row = this.db
      .prepare('SELECT queue, cursor, position_ms, updated_at FROM play_state WHERE id = 1')
      .get<PlayStateRow>()

    if (!row) return null

    let parsed: unknown
    try {
      parsed = JSON.parse(row.queue)
    } catch {
      return null
    }
    if (!Array.isArray(parsed)) return null

    const trackIds = parsed.filter(
      (id): id is number => typeof id === 'number' && Number.isInteger(id) && id > 0
    )
    if (trackIds.length === 0) return null

    const index = Number.isInteger(row.cursor) ? row.cursor : -1
    const positionMs = Number.isFinite(row.position_ms) ? Math.max(0, row.position_ms) : 0

    return {
      trackIds,
      index: index >= 0 && index < trackIds.length ? index : 0,
      positionMs
    }
  }

  write(state: PlaybackSnapshot, now: number): void {
    this.db
      .prepare(
        `INSERT INTO play_state (id, queue, cursor, position_ms, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           queue = excluded.queue,
           cursor = excluded.cursor,
           position_ms = excluded.position_ms,
           updated_at = excluded.updated_at`
      )
      .run(JSON.stringify(state.trackIds), state.index, Math.round(state.positionMs), now)
  }

  clear(): void {
    this.db.prepare('DELETE FROM play_state WHERE id = 1').run()
  }
}
