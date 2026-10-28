import type { LibraryFilter, LocalLibraryFilter, ResolvableTrack, Track } from './types'
import { isYouTubeVideoId } from './youtube'

/**
 * How far back "Recently added" looks.
 *
 * A date window rather than "the last N rows" because the chip has to mean the
 * same thing on a 20-track library and a 50 000-track one. Thirty days is long
 * enough to survive a holiday and short enough that the view empties itself
 * instead of becoming a second All.
 */
export const RECENTLY_ADDED_DAYS = 30

/** What the main process accepts as a filter over the `tracks` table. */
export const LOCAL_LIBRARY_FILTERS: readonly LocalLibraryFilter[] = [
  'all',
  'recent',
  'most-played',
  'never-played'
]

/**
 * The allowlist check for the IPC boundary.
 *
 * `streams` is deliberately absent: it is answered from the online history in
 * the renderer, never by a query over the `tracks` table.
 */
export function isLocalLibraryFilter(value: unknown): value is LocalLibraryFilter {
  return typeof value === 'string' && (LOCAL_LIBRARY_FILTERS as readonly string[]).includes(value)
}

/**
 * The stream that replaces a local track whose file is gone.
 *
 * A removed download keeps its row so playlists and the queue do not lose an
 * entry. Resolving playback through the YouTube origin is the only honest
 * fallback: pretending the missing file still exists would fail every time,
 * while falling back to a live stream keeps the item playable. A local row
 * without a valid origin has no fallback and is left to report the missing
 * file.
 */
export function streamFallbackFor(track: Track): ResolvableTrack | null {
  if (track.missingAt === null && track.filePath) return null
  if (
    track.sourceKind === 'youtube' &&
    track.sourceId &&
    isYouTubeVideoId(track.sourceId)
  ) {
    return { id: track.id, sourceKind: 'youtube', sourceId: track.sourceId, filePath: null }
  }
  const originId = track.originKind === 'youtube' ? track.originId : null
  if (!originId || !isYouTubeVideoId(originId)) return null
  return { id: track.id, sourceKind: 'youtube', sourceId: originId, filePath: null }
}

export interface LibraryFilterOption {
  value: LibraryFilter
  label: string
  /** The row tooltip: what the view contains and how it is ordered. */
  hint: string
}

export const LIBRARY_FILTER_OPTIONS: readonly LibraryFilterOption[] = [
  { value: 'all', label: 'All', hint: 'Every track in your folders' },
  {
    value: 'recent',
    label: 'Recently added',
    hint: `Tracks added in the last ${RECENTLY_ADDED_DAYS} days, newest first`
  },
  {
    value: 'most-played',
    label: 'Most played',
    hint: 'Tracks with a completed listen, most played first'
  },
  {
    value: 'never-played',
    label: 'Never played',
    hint: 'Tracks that have not had a completed listen yet'
  },
  {
    value: 'streams',
    label: 'YouTube',
    hint: 'Links you have played from YouTube; nothing is on disk unless you save it'
  }
]

/** The epoch-ms boundary used by the Recently added view and its count. */
export function recentlyAddedCutoff(now = Date.now()): number {
  return now - RECENTLY_ADDED_DAYS * 24 * 60 * 60 * 1000
}
