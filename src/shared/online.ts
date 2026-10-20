import type { OnlinePlaylist, OnlinePlaylistItem, OnlineTrack, Track } from './types'

/**
 * Turns a history entry into a queue row.
 *
 * Stream rows keep negative ids, exactly as they did when they were session-only:
 * a positive id would let a play count or an artwork lookup land on an unrelated
 * local file. `-entry.id` is stable across a restart, so a restored queue still
 * names the same link — which is what lets the history and the queue agree about
 * what is playing.
 */
export function onlineEntryToTrack(entry: OnlineTrack): Track {
  return {
    id: -entry.id,
    sourceKind: 'youtube',
    sourceId: entry.videoId,
    originKind: null,
    originId: null,
    title: entry.title,
    artist: entry.artist,
    albumArtist: entry.artist,
    album: entry.album,
    trackNo: null,
    discNo: null,
    year: null,
    genre: null,
    durationMs: entry.durationMs,
    codec: null,
    bitrateKbps: null,
    sampleRate: null,
    channels: null,
    fileSize: null,
    filePath: null,
    artworkKey: entry.artworkKey,
    addedAt: entry.addedAt,
    playCount: 0,
    lastPlayedAt: entry.lastPlayedAt
  }
}

/**
 * Imported entries live in their own negative id space, far below history rows.
 *
 * A playlist entry is not a `tracks` row either, and its entry id is stable while
 * it stays in the list — unlike its position, which shifts when an earlier entry
 * is removed. The offset keeps the two kinds of stream track apart even though
 * they come from different tables that both start counting at one.
 */
const PLAYLIST_TRACK_ID_OFFSET = 1_000_000

/**
 * True for a queue row that came from an imported playlist.
 *
 * The main process uses this to tell the two kinds of stream track apart: a
 * history row is a link the user added, and playing it is activity worth logging;
 * a playlist entry already lives in its list, so playing it must not also drop a
 * copy into the history.
 */
export function isImportedPlaylistTrackId(id: number): boolean {
  return id <= -PLAYLIST_TRACK_ID_OFFSET
}

/**
 * The imported list whose tracks are the queue that is playing.
 *
 * Held by the app rather than the view that started it, so the imported card
 * that names the list — and the track it is on — still knows about it after a
 * trip to another view and back. The tracks are a snapshot, not a live read:
 * the list can be deleted while its queue is still playing.
 */
export interface PlayingList {
  title: string
  tracks: Track[]
  /**
   * The imported list's row id, when the queue came from one. The Online view
   * matches this to mark the right card; playing a hand-made playlist leaves it
   * undefined.
   */
  playlistId?: number
}

export function onlinePlaylistItemToTrack(item: OnlinePlaylistItem, playlist: OnlinePlaylist): Track {
  const album = playlist.kind === 'album'
  return {
    id: -(PLAYLIST_TRACK_ID_OFFSET + item.id),
    sourceKind: 'youtube',
    sourceId: item.videoId,
    originKind: null,
    originId: null,
    title: item.title,
    artist: item.artist,
    albumArtist: album ? (playlist.owner ?? item.artist) : item.artist,
    album: item.album,
    trackNo: null,
    discNo: null,
    year: null,
    genre: null,
    durationMs: item.durationMs,
    codec: null,
    bitrateKbps: null,
    sampleRate: null,
    channels: null,
    fileSize: null,
    filePath: null,
    // An album's rows all show the sleeve. A plain playlist's cover is one video's
    // still blown up, so each row keeps its own and asks for it lazily instead.
    artworkKey: album ? playlist.coverKey : null,
    addedAt: playlist.importedAt,
    playCount: 0,
    lastPlayedAt: null
  }
}
