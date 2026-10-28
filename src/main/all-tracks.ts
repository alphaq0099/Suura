import type {
  AllTracksFilter,
  AllTracksPage,
  AllTracksQuery,
  AllTracksRow,
  AllTracksSource,
  Track
} from '@shared/types'
import { onlineEntryToTrack, onlinePlaylistItemToTrack, streamPlayToTrack } from '@shared/online'
import type { AppContainer } from './services/container'

/** Rows per page. Big enough to scroll for a while, small enough to stay instant. */
const PAGE_LIMIT = 100

/**
 * How many rows each source contributes to one merge.
 *
 * Paging a merged feed is not the same as paging one table: the page cannot be
 * fetched with one `OFFSET`, because four lists have to be interleaved first.
 * Scanning a bounded window from each source and sorting that is exact for the
 * first few pages (any row beyond the window has at least that many rows of its
 * own source ahead of it), and `truncated` keeps the footer honest once a large
 * library runs past it.
 */
const SCAN_LIMIT = 800

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.floor(value)))
}

/**
 * When a row joined the feed, for the default "newest first" order.
 *
 * A listen is activity too: a track added last month and played this morning is
 * new to the user's attention, and the YouTube history already sorts by
 * `MAX(last_played_at, added_at)` for the same reason.
 */
function activityOf(track: Track): number {
  return Math.max(track.addedAt, track.lastPlayedAt ?? 0)
}

/** Dedupe identity: one video, or one library file. */
function identityOf(track: Track): string {
  if (track.sourceKind === 'youtube' && track.sourceId) return `youtube:${track.sourceId}`
  // A downloaded file keeps its video as an origin. It is the same song as the
  // remembered link or the listen that led to the download, and the file is the
  // version the user chose to keep, so it takes the row.
  if (track.originKind === 'youtube' && track.originId) return `youtube:${track.originId}`
  return `local:${track.id}`
}

/**
 * One deduped, newest-first list across every place a track can live.
 *
 * The order of the sources is the precedence order. A downloaded video is the
 * same song as the history row that preceded it, and the file is the version the
 * user chose to keep, so it wins; a counted listen is a better row than the
 * remembered link it came from, because replaying it updates the same play row.
 * An imported playlist entry is only reached when neither exists, which is the
 * case that list exists for.
 */
export function listAllTracks(container: AppContainer, query: AllTracksQuery = {}): AllTracksPage {
  const search = (query.search ?? '').trim()
  const filter: AllTracksFilter = query.filter ?? 'all'
  const limit = clampInt(query.limit, PAGE_LIMIT, 1, 200)
  const offset = clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER)
  // One extra row past the page is what tells the caller another page exists.
  const scan = Math.min(SCAN_LIMIT, Math.max(limit + offset + 1, 200))

  const rows: AllTracksRow[] = []
  const seen = new Set<string>()
  let truncated = false

  const add = (track: Track, source: AllTracksSource): void => {
    // "Played" is a filter on the whole merged feed, not a separate query: the
    // sources do not share a play counter, and only the merged row knows whether
    // it has a listen at all.
    if (filter === 'played' && track.lastPlayedAt === null) return
    const identity = identityOf(track)
    if (seen.has(identity)) return
    seen.add(identity)
    rows.push({ track, source })
  }

  // The library is the only source that can filter and sort in SQL, so it goes
  // first both for priority and for speed.
  const libraryPage = container.library.list({
    search: search || undefined,
    sort: filter === 'played' ? 'played' : 'added',
    direction: 'desc',
    limit: scan,
    offset: 0
  })
  for (const track of libraryPage.tracks) add(track, 'library')
  if (libraryPage.total > libraryPage.tracks.length) truncated = true

  if (filter !== 'library') {
    const plays = container.streamPlays.list(scan)
    for (const play of plays) add(streamPlayToTrack(play), 'stream')
    // `count` has a hard cap of its own, and the list can never exceed it.
    if (plays.length === scan) truncated = true

    const playlistItems = container.onlinePlaylists.search(search, scan)
    for (const { item, playlist } of playlistItems) {
      add(onlinePlaylistItemToTrack(item, playlist), 'playlist')
    }
    if (playlistItems.length >= scan) truncated = true

    // Remembered links last: almost everything they hold is already represented
    // by a downloaded file, a listen or a list entry, and the ones left are the
    // pastes that were never played.
    const links = container.onlineRepo.search(search, scan)
    for (const link of links) add(onlineEntryToTrack(link), 'youtube')
    if (links.length >= scan) truncated = true
  }

  const atOf = (row: AllTracksRow): number =>
    filter === 'played'
      ? (row.track.lastPlayedAt ?? 0)
      : filter === 'library'
        ? row.track.addedAt
        : activityOf(row.track)

  rows.sort((left, right) => atOf(right) - atOf(left) || right.track.id - left.track.id)

  const hasMore = rows.length > offset + limit
  return {
    rows: rows.slice(offset, offset + limit),
    hasMore,
    truncated
  }
}
