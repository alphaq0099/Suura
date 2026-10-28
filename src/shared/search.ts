import type {
  ImportedSearchResult,
  LibrarySearchResult,
  OnlinePlaylist,
  OnlinePlaylistItem,
  OnlineTrack,
  Track
} from './types'
import { onlineEntryToTrack, onlinePlaylistItemToTrack } from './online'

/** An entry found in an imported playlist, with the playlist that owns it. */
export interface PlaylistSearchMatch {
  item: OnlinePlaylistItem
  playlist: OnlinePlaylist
}

/**
 * Merges the two database-only sources into one Imported shelf.
 *
 * History comes first: it is ordered by recency, and a video the user pasted
 * should keep that identity even when the same video also sits in three
 * imported playlists. A second sighting is dropped by video id, so the shelf
 * never shows one video twice. Local files win outright: a downloaded copy of
 * a video is the thing the user can play offline, and showing both would make
 * the same song look like two different tracks.
 */
export function mergeLibrarySearch(
  local: readonly Track[],
  history: readonly OnlineTrack[],
  playlistMatches: readonly PlaylistSearchMatch[],
  limit = 50
): LibrarySearchResult {
  const cap = Math.max(1, Math.floor(limit))
  const seen = new Set<string>()
  for (const track of local) {
    if (track.originKind === 'youtube' && track.originId) seen.add(track.originId)
  }

  const imported: ImportedSearchResult[] = []
  for (const entry of history) {
    if (imported.length >= cap) break
    if (seen.has(entry.videoId)) continue
    seen.add(entry.videoId)
    imported.push({
      track: onlineEntryToTrack(entry),
      source: 'History',
      playlistId: null
    })
  }

  for (const match of playlistMatches) {
    if (imported.length >= cap) break
    if (seen.has(match.item.videoId)) continue
    seen.add(match.item.videoId)
    imported.push({
      track: onlinePlaylistItemToTrack(match.item, match.playlist),
      source: match.playlist.title,
      playlistId: match.playlist.id
    })
  }

  return { local: local.slice(0, cap), imported }
}

export interface SearchPrefetchGate {
  /** The user's existing "prefetch the next track" setting. */
  enabled: boolean
  /** True once the user has asked YouTube for this query. */
  submitted: boolean
  localCount: number
  importedCount: number
  /** The best YouTube match, or null when the shelf is empty. */
  bestVideoId: string | null
  /** A prefetch that has started and not settled. */
  inFlight: boolean
  now: number
  lastAttemptAt: number | null
  /** A bot check or cooldown has paused new attempts until this time. */
  blockedUntil: number
  cooldownMs: number
}

/**
 * Decides whether Search may warm the best YouTube match.
 *
 * A prefetch spends a real resolve, so it only happens for the case it is
 * meant to help: a query the device and the imported lists could not answer,
 * with one best match already on screen. It waits for the user to stop
 * reading, never overlaps another attempt, and stays quiet after one attempt
 * or a YouTube bot check.
 */
export function canPrefetchSearchMatch(input: SearchPrefetchGate): boolean {
  if (!input.enabled || !input.submitted) return false
  if (input.localCount > 0 || input.importedCount > 0) return false
  if (!input.bestVideoId) return false
  if (input.inFlight) return false
  if (input.now < input.blockedUntil) return false
  const cooldown = Math.max(0, input.cooldownMs)
  if (input.lastAttemptAt !== null && input.now - input.lastAttemptAt < cooldown) return false
  return true
}
