import type { OnlinePlaylist, OnlinePlaylistItem, OnlinePlaylistKind } from '@shared/types'
import type { SqlDatabase } from '../db/driver'

/** Everything needed to write or refresh an imported playlist. */
export interface OnlinePlaylistInput {
  /** YouTube's list id (`PL…`, `OLAK5uy…`, `RD…`). Identity for re-imports. */
  listId: string
  kind: OnlinePlaylistKind
  title: string
  owner: string | null
  sourceUrl: string
  /** The list's own cover. Null means "no list cover"; rows fall back to stills. */
  coverKey: string | null
  /** Entries YouTube reports, or null when it reports none (a mix). */
  totalCount: number | null
}

/** One entry in source order. Positions are assigned by the repository. */
export interface OnlineItemInput {
  videoId: string
  title: string
  artist: string | null
  album: string | null
  durationMs: number | null
}

interface PlaylistRow {
  id: number
  list_id: string
  kind: string
  title: string
  owner: string | null
  source_url: string
  cover_key: string | null
  total_count: number | null
  imported_at: number
  track_count: number
}

interface ItemRow {
  id: number
  playlist_id: number
  position: number
  video_id: string
  title: string
  artist: string | null
  album: string | null
  duration_ms: number | null
}

const PLAYLIST_COLUMNS = `p.id, p.list_id, p.kind, p.title, p.owner, p.source_url, p.cover_key,
  p.total_count, p.imported_at,
  (SELECT COUNT(*) FROM online_playlist_items i WHERE i.playlist_id = p.id) AS track_count`

function mapPlaylist(row: PlaylistRow): OnlinePlaylist {
  return {
    id: row.id,
    listId: row.list_id,
    kind: row.kind === 'album' || row.kind === 'mix' ? row.kind : 'playlist',
    title: row.title,
    owner: row.owner,
    sourceUrl: row.source_url,
    coverKey: row.cover_key,
    trackCount: row.track_count,
    totalCount: row.total_count,
    importedAt: row.imported_at
  }
}

function mapItem(row: ItemRow): OnlinePlaylistItem {
  return {
    id: row.id,
    playlistId: row.playlist_id,
    position: row.position,
    videoId: row.video_id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    durationMs: row.duration_ms
  }
}

/**
 * Imported playlists and their entries.
 *
 * A snapshot, not a mirror: `upsert` replaces the whole entry list for a list id,
 * which is exactly what "import this playlist again" should do. Nothing syncs in
 * the background, so a playlist the user deleted on YouTube keeps working until
 * they re-import or remove it.
 */
export class OnlinePlaylistRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** Every imported playlist, most recently imported first. */
  list(): OnlinePlaylist[] {
    return this.db
      .prepare(`SELECT ${PLAYLIST_COLUMNS} FROM online_playlists p ORDER BY p.imported_at DESC, p.id DESC`)
      .all<PlaylistRow>()
      .map(mapPlaylist)
  }

  get(id: number): OnlinePlaylist | null {
    const row = this.db
      .prepare(`SELECT ${PLAYLIST_COLUMNS} FROM online_playlists p WHERE p.id = ?`)
      .get<PlaylistRow>(id)
    return row ? mapPlaylist(row) : null
  }

  getByListId(listId: string): OnlinePlaylist | null {
    const row = this.db
      .prepare(`SELECT ${PLAYLIST_COLUMNS} FROM online_playlists p WHERE p.list_id = ?`)
      .get<PlaylistRow>(listId)
    return row ? mapPlaylist(row) : null
  }

  /** The entries, in source order. `position` is 0-based. */
  items(playlistId: number): OnlinePlaylistItem[] {
    return this.db
      .prepare(
        `SELECT id, playlist_id, position, video_id, title, artist, album, duration_ms
         FROM online_playlist_items
         WHERE playlist_id = ?
         ORDER BY position ASC, id ASC`
      )
      .all<ItemRow>(playlistId)
      .map(mapItem)
  }

  /**
   * Writes the playlist and replaces its entries in one transaction.
   *
   * A re-import keeps the playlist's row (and therefore its place in the index),
   * moves it to the top and swaps the entries wholesale. The old cover survives a
   * pass whose cover fetch failed, the same rule the history uses for thumbnails.
   */
  upsert(input: OnlinePlaylistInput, items: readonly OnlineItemInput[], now: number): OnlinePlaylist {
    return this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO online_playlists
             (list_id, kind, title, owner, source_url, cover_key, total_count, imported_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(list_id) DO UPDATE SET
             kind        = excluded.kind,
             title       = excluded.title,
             owner       = excluded.owner,
             source_url  = excluded.source_url,
             cover_key   = COALESCE(excluded.cover_key, online_playlists.cover_key),
             total_count = excluded.total_count,
             imported_at = excluded.imported_at`
        )
        .run(
          input.listId,
          input.kind,
          input.title,
          input.owner,
          input.sourceUrl,
          input.coverKey,
          input.totalCount,
          now
        )

      const playlist = this.getByListId(input.listId)
      if (!playlist) throw new Error('The imported playlist was not written.')

      this.db.prepare('DELETE FROM online_playlist_items WHERE playlist_id = ?').run(playlist.id)
      const insert = this.db.prepare(
        `INSERT INTO online_playlist_items
           (playlist_id, position, video_id, title, artist, album, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      items.forEach((item, position) => {
        insert.run(playlist.id, position, item.videoId, item.title, item.artist, item.album, item.durationMs)
      })

      return this.get(playlist.id) ?? playlist
    })
  }

  setCoverKey(listId: string, coverKey: string): void {
    this.db.prepare('UPDATE online_playlists SET cover_key = ? WHERE list_id = ?').run(coverKey, listId)
  }

  /**
   * The first entry anywhere that holds a video.
   *
   * Used when an imported track is played for the first time: it has no history
   * row yet, and this is where the title/artist/album for that row come from.
   * Several playlists may hold it; their metadata is the same video either way.
   */
  findItemByVideo(videoId: string): OnlinePlaylistItem | null {
    const row = this.db
      .prepare(
        `SELECT id, playlist_id, position, video_id, title, artist, album, duration_ms
         FROM online_playlist_items
         WHERE video_id = ?
         ORDER BY playlist_id ASC, position ASC
         LIMIT 1`
      )
      .get<ItemRow>(videoId)
    return row ? mapItem(row) : null
  }

  /**
   * Removes one entry and closes the gap.
   *
   * Positions are renumbered rather than left with a hole because they are what
   * "Play from here" uses: a missing position would play the wrong track or stop.
   * Returns the playlist id that changed, or null when the entry was already gone.
   */
  removeItem(itemId: number): number | null {
    return this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT playlist_id FROM online_playlist_items WHERE id = ?')
        .get<{ playlist_id: number }>(itemId)
      if (!row) return null

      this.db.prepare('DELETE FROM online_playlist_items WHERE id = ?').run(itemId)
      const remaining = this.db
        .prepare(
          `SELECT id FROM online_playlist_items WHERE playlist_id = ? ORDER BY position ASC, id ASC`
        )
        .all<{ id: number }>(row.playlist_id)
      const update = this.db.prepare('UPDATE online_playlist_items SET position = ? WHERE id = ?')
      remaining.forEach((entry, position) => update.run(position, entry.id))
      return row.playlist_id
    })
  }

  delete(id: number): boolean {
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM online_playlist_items WHERE playlist_id = ?').run(id)
      return this.db.prepare('DELETE FROM online_playlists WHERE id = ?').run(id).changes > 0
    })
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM online_playlists').get<{ total: number }>()
    return row?.total ?? 0
  }
}
