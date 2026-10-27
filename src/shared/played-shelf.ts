import type { AlbumSummary, Track } from './types'

/** One card on Home's Recently played shelf. */
export type PlayedShelfEntry =
  | { kind: 'album'; at: number; album: AlbumSummary }
  | { kind: 'track'; at: number; track: Track }

/**
 * Merges played albums with played tracks that have no album tag.
 *
 * Recently played is an album shelf, so a file without an album tag never
 * appears there even though its play count and timestamp are recorded. Those
 * singles are the one case where a track card is the honest representation;
 * every track that belongs to an album stays represented by its album card, so
 * the shelf never shows the same listen twice.
 */
export function mergePlayedShelf(
  albums: readonly AlbumSummary[],
  tracks: readonly Track[],
  limit = 12
): PlayedShelfEntry[] {
  const entries: PlayedShelfEntry[] = []

  for (const album of albums) {
    if (album.lastPlayedAt === null) continue
    entries.push({ kind: 'album', at: album.lastPlayedAt, album })
  }

  for (const track of tracks) {
    if (track.lastPlayedAt === null) continue
    if (track.album !== null && track.album.trim().length > 0) continue
    entries.push({ kind: 'track', at: track.lastPlayedAt, track })
  }

  entries.sort((left, right) => right.at - left.at)
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 12
  return entries.slice(0, safeLimit)
}
