import type { OnlinePlaylist, OnlinePlaylistItem, OnlineTrack, StreamPlay, Track } from './types'

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
    artist: entry.artist ?? entry.channel,
    albumArtist: entry.artist ?? entry.channel,
    album: entry.album,
    trackNo: null,
    discNo: null,
    trackTotal: null,
    discTotal: null,
    year: null,
    genre: null,
    durationMs: entry.durationMs,
    codec: null,
    bitrateKbps: null,
    sampleRate: null,
    channels: null,
    fileSize: null,
    missingAt: null,
    filePath: null,
    artworkKey: entry.artworkKey,
    replayGainDb: null,
    replayGainPeak: null,
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
 * Played-stream cards get a third negative range, below the playlist range.
 *
 * A card on Recently played stands for a past listen, not for a live queue item;
 * the imported entry (or history row) it came from may be gone. The row id in
 * `stream_plays` is the stable identity, so replaying the card can count another
 * listen without inventing a copy of the video in either history.
 */
const STREAM_PLAY_TRACK_ID_OFFSET = 2_000_000

/**
 * True for a queue row that came from an imported playlist.
 *
 * The main process uses this to tell the two kinds of stream track apart: a
 * history row is a link the user added, and playing it is activity worth logging;
 * a playlist entry already lives in its list, so playing it must not also drop a
 * copy into the history.
 */
export function isImportedPlaylistTrackId(id: number): boolean {
  return id <= -PLAYLIST_TRACK_ID_OFFSET && id > -STREAM_PLAY_TRACK_ID_OFFSET
}

/** True for a card that represents a past stream listen. */
export function isStreamPlayTrackId(id: number): boolean {
  return id <= -STREAM_PLAY_TRACK_ID_OFFSET
}

/** The imported entry id behind a queue row, for the metadata lookup. */
export function importedPlaylistItemId(trackId: number): number {
  return -trackId - PLAYLIST_TRACK_ID_OFFSET
}

/** The stream-play row behind a Recently played card. */
export function streamPlayRowId(trackId: number): number {
  return -trackId - STREAM_PLAY_TRACK_ID_OFFSET
}

/**
 * A counted stream listen as a card track.
 *
 * The negative id is set apart from both other stream ranges so the main process
 * can recognise a replay from Home: it touches the same play row instead of
 * trying to treat the card as a history link or a playlist entry.
 */
export function streamPlayToTrack(play: StreamPlay): Track {
  return {
    id: -(STREAM_PLAY_TRACK_ID_OFFSET + play.id),
    sourceKind: 'youtube',
    sourceId: play.videoId,
    originKind: null,
    originId: null,
    title: play.title,
    artist: play.artist,
    albumArtist: play.artist,
    album: play.album,
    trackNo: null,
    discNo: null,
    trackTotal: null,
    discTotal: null,
    year: null,
    genre: null,
    durationMs: play.durationMs,
    codec: null,
    bitrateKbps: null,
    sampleRate: null,
    channels: null,
    fileSize: null,
    missingAt: null,
    filePath: null,
    artworkKey: null,
    replayGainDb: null,
    replayGainPeak: null,
    addedAt: play.addedAt,
    playCount: play.playCount,
    lastPlayedAt: play.lastPlayedAt
  }
}

/**
 * The art a list card can show when it has no cover of its own.
 *
 * A playlist or mix has no sleeve; its first entry's still is the closest thing
 * to a face. The synthetic entry exists only to reach the same artwork path a
 * row uses — it is never queued or stored, so its placeholder id is harmless.
 */
export function onlinePlaylistArtworkTrack(playlist: OnlinePlaylist): Track | null {
  if (playlist.coverKey || !playlist.firstVideoId) return null
  return onlinePlaylistItemToTrack(
    {
      id: 0,
      playlistId: playlist.id,
      position: 0,
      videoId: playlist.firstVideoId,
      title: playlist.title,
      artist: playlist.owner,
      album: null,
      durationMs: null
    },
    playlist
  )
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
    trackTotal: null,
    discTotal: null,
    year: null,
    genre: null,
    durationMs: item.durationMs,
    codec: null,
    bitrateKbps: null,
    sampleRate: null,
    channels: null,
    fileSize: null,
    missingAt: null,
    filePath: null,
    // An album's rows all show the sleeve. A plain playlist's cover is one video's
    // still blown up, so each row keeps its own and asks for it lazily instead.
    artworkKey: album ? playlist.coverKey : null,
    replayGainDb: null,
    replayGainPeak: null,
    addedAt: playlist.importedAt,
    playCount: 0,
    lastPlayedAt: null
  }
}
