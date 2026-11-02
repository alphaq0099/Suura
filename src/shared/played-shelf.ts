import type { AlbumSummary, Track } from './types'

/** One card on Home's Recently played or Recently added shelf. */
export type ShelfEntry =
  | { kind: 'album'; at: number; album: AlbumSummary }
  | { kind: 'track'; at: number; track: Track }

function limitOf(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 12
}

/**
 * Merges album cards with track cards, newest first.
 *
 * `atOf` is the timestamp that decides the order, and `include` is where the
 * caller states which tracks are already represented by an album card. The
 * shelves share this loop so "newest first" and the limit cannot drift apart.
 *
 * A release with exactly one file is a track, not an album: its album summary
 * is skipped and its track card represents it, so a lone newly added song
 * offers the track actions instead of an album page with one row. The album
 * stays if its track was not passed in, so a caller that does not fetch tracks
 * separately still shows the release rather than losing it.
 */
function mergeShelf(
  atOf: (value: AlbumSummary | Track) => number | null,
  include: (track: Track) => boolean,
  albums: readonly AlbumSummary[],
  tracks: readonly Track[],
  limit: number
): ShelfEntry[] {
  const entries: ShelfEntry[] = []
  // A missing timestamp must not become `undefined`: the sort compares numbers,
  // and one `undefined` turns the whole comparison into NaN, which leaves the
  // shelf in insertion order instead of newest first.
  const usable = (at: number | null | undefined): at is number =>
    typeof at === 'number' && Number.isFinite(at)
  const trackIds = new Set(tracks.map((track) => track.id))
  const singleAlbumTracks = new Set(
    albums.filter((album) => album.trackCount === 1).map((album) => album.trackId)
  )

  for (const album of albums) {
    if (album.trackCount === 1 && trackIds.has(album.trackId)) continue
    const at = atOf(album)
    if (!usable(at)) continue
    entries.push({ kind: 'album', at, album })
  }

  for (const track of tracks) {
    const at = atOf(track)
    if (!usable(at)) continue
    if (!include(track) && !singleAlbumTracks.has(track.id)) continue
    entries.push({ kind: 'track', at, track })
  }

  entries.sort((left, right) => right.at - left.at)
  return entries.slice(0, limitOf(limit))
}

/**
 * Merges played albums, played albumless tracks and played streams.
 *
 * Recently played is an album shelf, so a file without an album tag never
 * appears there even though its play count and timestamp are recorded. Those
 * singles are the one case where a track card is the honest representation;
 * every track that belongs to an album stays represented by its album card, so
 * the shelf never shows the same listen twice. A release with a single file
 * also becomes its track card, because there is no album to open.
 *
 * A stream is different: it has no row in the local library at all, and its
 * YouTube album tag does not place it on the album shelf. It is always its own
 * card. A downloaded copy is deduplicated by video id so a saved stream does not
 * appear twice after the download is played.
 */
export function mergePlayedShelf(
  albums: readonly AlbumSummary[],
  tracks: readonly Track[],
  streams: readonly Track[] = [],
  limit = 12
): ShelfEntry[] {
  const downloaded = new Set(
    tracks
      .map((track) => (track.originKind === 'youtube' ? track.originId : null))
      .filter((id): id is string => Boolean(id))
  )
  const seenStreams = new Set<string>()

  const uniqueStreams = streams.filter((track) => {
    const videoId = track.sourceKind === 'youtube' ? track.sourceId : null
    if (!videoId) return false
    if (downloaded.has(videoId) || seenStreams.has(videoId)) return false
    seenStreams.add(videoId)
    return true
  })

  return mergeShelf(
    (value) => value.lastPlayedAt,
    (track) =>
      track.sourceKind === 'youtube' || track.album === null || track.album.trim().length === 0,
    albums,
    [...tracks, ...uniqueStreams],
    limit
  )
}

/**
 * Merges recently added albums with newly added files that have no album tag.
 *
 * Recently added is built from album summaries, so a single with no album tag
 * was invisible there for the same reason it was invisible on Recently played.
 * Albums keep their card and albumless files get a track card, newest first. A
 * release with one file is a track card too, so a lone added song offers the
 * track actions rather than an album page with one row.
 */
export function mergeAddedShelf(
  albums: readonly AlbumSummary[],
  tracks: readonly Track[],
  limit = 12
): ShelfEntry[] {
  return mergeShelf(
    (value) => value.addedAt,
    (track) => track.album === null || track.album.trim().length === 0,
    albums,
    tracks,
    limit
  )
}
