import type { OnlineTrack, Track } from './types'

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
