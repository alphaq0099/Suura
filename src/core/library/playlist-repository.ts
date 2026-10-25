import type { Playlist, PlaylistDetail, PlaylistItem } from '@shared/types'
import { mapTrackRow, trackColumns, type TrackRow } from './track-repository'
import type { SqlDatabase } from '../db/driver'

/**
 * The gap between two neighbouring entries.
 *
 * A playlist is hand-ordered, and the honest model for "drop this row between
 * those two" is a number that sits between theirs — which only works if there is
 * room. Spreading entries 1024 apart means ten successive drops into the same
 * place before the gaps run out, which no one does by hand; when it does happen
 * the playlist is renumbered in one transaction. The alternative, a dense
 * 0..n-1 sequence, rewrites every row below the drop on every drop.
 */
export const POSITION_GAP = 1024

interface PlaylistRow {
  id: number
  name: string
  created_at: number
  updated_at: number
  sort_order: number
  track_count: number
}

export interface PositionedItem {
  id: number
  position: number
}

/**
 * An entry that can still be played.
 *
 * A downloaded YouTube track whose file was removed keeps its row and its
 * playlist entry, and plays from the stream through `origin_id`. Other missing
 * rows stay hidden: they have no source to fall back to.
 */
const PLAYABLE_ROW = `(
  t.missing_at IS NULL OR
  (t.source_kind = 'local' AND t.origin_kind = 'youtube' AND t.origin_id IS NOT NULL AND length(t.origin_id) = 11)
)`

const PLAYLIST_COLUMNS = `
  p.id, p.name, p.created_at, p.updated_at, p.sort_order,
  (SELECT COUNT(*) FROM playlist_items i
   JOIN tracks t ON t.id = i.track_id AND ${PLAYABLE_ROW}
   WHERE i.playlist_id = p.id) AS track_count
`

function mapPlaylist(row: PlaylistRow): Playlist {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    trackCount: row.track_count
  }
}

/**
 * Playlist rows and entries.
 *
 * Everything here is deliberately mechanical: ordering *policy* (what index a
 * drop lands on, when gaps have to be renumbered) lives in `PlaylistService`,
 * and this class is the part that touches SQL.
 */
export class PlaylistRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** Playlists in sidebar order, newest last, each with its entry count. */
  list(): Playlist[] {
    return this.db
      .prepare(`SELECT ${PLAYLIST_COLUMNS} FROM playlists p ORDER BY p.sort_order, p.id`)
      .all<PlaylistRow>()
      .map(mapPlaylist)
  }

  get(id: number): Playlist | null {
    const row = this.db.prepare(`SELECT ${PLAYLIST_COLUMNS} FROM playlists p WHERE p.id = ?`).get<PlaylistRow>(id)
    return row ? mapPlaylist(row) : null
  }

  /**
   * The id of the playlist with this name, or null.
   *
   * Compared with `COLLATE NOCASE` so it agrees with the unique index that
   * enforces it — "Chill" and "chill" are one playlist, and the check has to see
   * that before the insert does.
   */
  idForName(name: string): number | null {
    const row = this.db.prepare('SELECT id FROM playlists WHERE name = ? COLLATE NOCASE').get<{ id: number }>(name)
    return row?.id ?? null
  }

  create(name: string, now: number): number {
    const last = this.db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS last FROM playlists').get<{ last: number }>()
    return this.db
      .prepare('INSERT INTO playlists (name, created_at, updated_at, sort_order) VALUES (?, ?, ?, ?)')
      .run(name, now, now, (last?.last ?? 0) + 1).lastInsertRowid
  }

  rename(id: number, name: string, now: number): void {
    this.db.prepare('UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?').run(name, now, id)
  }

  /** Deletes the playlist. Its entries go with it, through the foreign key. */
  delete(id: number): void {
    this.db.prepare('DELETE FROM playlists WHERE id = ?').run(id)
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM playlists').get<{ total: number }>()
    return row?.total ?? 0
  }

  detail(id: number): PlaylistDetail | null {
    const playlist = this.get(id)
    if (!playlist) return null
    return { playlist, items: this.items(id) }
  }

  /** The playlist's tracks in playlist order, joined in one query. */
  items(playlistId: number): PlaylistItem[] {
    const rows = this.db
      .prepare(
        `SELECT i.id AS item_id, ${trackColumns('t')}
         FROM playlist_items i
         JOIN tracks t ON t.id = i.track_id
         WHERE i.playlist_id = ? AND ${PLAYABLE_ROW}
         ORDER BY i.position, i.id`
      )
      .all<TrackRow & { item_id: number }>(playlistId)
    return rows.map((row) => ({ id: row.item_id, track: mapTrackRow(row) }))
  }

  /** Entry ids and their positions, in order: what the ordering logic works from. */
  positionedItems(playlistId: number): PositionedItem[] {
    return this.db
      .prepare('SELECT id, position FROM playlist_items WHERE playlist_id = ? ORDER BY position, id')
      .all<PositionedItem>(playlistId)
  }

  /** Entry ids for a set of tracks, so repeated adds can be skipped up front. */
  trackIdsIn(playlistId: number): Set<number> {
    const rows = this.db
      .prepare('SELECT track_id FROM playlist_items WHERE playlist_id = ?')
      .all<{ track_id: number }>(playlistId)
    return new Set(rows.map((row) => row.track_id))
  }

  /** Position past the last entry, for an append. */
  nextPosition(playlistId: number): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(position), 0) AS last FROM playlist_items WHERE playlist_id = ?')
      .get<{ last: number }>(playlistId)
    return (row?.last ?? 0) + POSITION_GAP
  }

  /**
   * Adds a track at a position. Returns false when it was already in the
   * playlist: adding the same track twice means "make sure it is in there", which
   * is what the unique index and `OR IGNORE` express.
   */
  addTrack(playlistId: number, trackId: number, position: number, now: number): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO playlist_items (playlist_id, track_id, position, added_at) VALUES (?, ?, ?, ?)')
      .run(playlistId, trackId, position, now)
    if (result.changes === 0) return false
    this.touch(playlistId, now)
    return true
  }

  setPosition(itemId: number, position: number): void {
    this.db.prepare('UPDATE playlist_items SET position = ? WHERE id = ?').run(position, itemId)
  }

  /** Rewrites positions as 1, 1+GAP, 1+2*GAP... in the order given. */
  renumber(orderedItemIds: number[]): void {
    const statement = this.db.prepare('UPDATE playlist_items SET position = ? WHERE id = ?')
    orderedItemIds.forEach((itemId, index) => {
      statement.run((index + 1) * POSITION_GAP, itemId)
    })
  }

  removeItems(itemIds: number[], now: number): number {
    if (itemIds.length === 0) return 0
    // The playlist ids have to be read *before* the rows go, or there is nothing
    // left to say whose timestamp to bump.
    const playlistIds = new Set<number>()
    for (const itemId of itemIds) {
      const playlistId = this.playlistIdForItem(itemId)
      if (playlistId !== null) playlistIds.add(playlistId)
    }
    const statement = this.db.prepare('DELETE FROM playlist_items WHERE id = ?')
    let removed = 0
    for (const itemId of itemIds) {
      removed += statement.run(itemId).changes
    }
    if (removed > 0) {
      const touch = this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?')
      for (const playlistId of playlistIds) touch.run(now, playlistId)
    }
    return removed
  }

  clearItems(playlistId: number, now: number): number {
    const removed = this.db.prepare('DELETE FROM playlist_items WHERE playlist_id = ?').run(playlistId).changes
    if (removed > 0) this.touch(playlistId, now)
    return removed
  }

  /** The playlist an entry belongs to, so a mutation can bump its updated_at. */
  playlistIdForItem(itemId: number): number | null {
    const row = this.db.prepare('SELECT playlist_id FROM playlist_items WHERE id = ?').get<{ playlist_id: number }>(itemId)
    return row?.playlist_id ?? null
  }

  touch(playlistId: number, now: number): void {
    this.db.prepare('UPDATE playlists SET updated_at = ? WHERE id = ?').run(now, playlistId)
  }

  /**
   * Runs `fn` in one transaction. Removals touch several rows — the entry, the
   * playlist's timestamp — and a half-applied move leaves the order wrong.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)
  }
}
