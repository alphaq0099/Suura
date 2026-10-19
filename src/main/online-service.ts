import type { Logger } from '@core/logging/logger'
import type { OnlineRepository } from '@core/library/online-repository'
import type { YouTubeResolver } from '@engine/youtube-resolver'
import type { OnlineTrack } from '@shared/types'
import { youtubeThumbnailCandidates, youtubeWatchUrl } from '@shared/youtube'
import type { ArtworkService } from './artwork-service'

export interface OnlineService {
  /**
   * Every remembered link, newest activity first.
   *
   * A row whose cached thumbnail has been evicted reports no artwork rather than
   * a key that no longer resolves, so the view shows the placeholder instead of a
   * broken image.
   */
  list(): OnlineTrack[]
  /** Validates and resolves a pasted link, remembers it, and returns its row. */
  addLink(input: string): Promise<OnlineTrack>
  /** Records that a link has just been played. */
  touch(videoId: string): void
  remove(id: number): void
  /** Forgets every link. Returns how many were removed. */
  clear(): number
  /**
   * The cached cover for a history row, downloading it on the first ask.
   *
   * A stream track is not a `tracks` row, so the usual artwork lookup has nothing
   * to go on: it carries the negation of its history row's id, and this is where
   * that lookup lands. Fetching here rather than in `addLink` keeps a paste from
   * waiting on an image CDN, and it is what puts a picture on rows added while the
   * WebP thumbnails could not be decoded.
   */
  artworkFor(id: number): Promise<string | null>
}

/** A thumbnail is decoration: cap each attempt so a hung CDN cannot stall a cover indefinitely. */
const THUMBNAIL_TIMEOUT_MS = 2_500
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024

/**
 * The Online history: links the user pasted, and the one place that turns a link
 * into a remembered row.
 *
 * Playback is not this service's job — it only warms the resolver cache on the
 * way through, so pressing play on the row right after pasting is instant. Saving
 * a row to the library is M4 and will grow next to it.
 */
export function createOnlineService(deps: {
  resolver: YouTubeResolver
  repo: OnlineRepository
  artwork: ArtworkService
  log: Logger
  /** Called after any change, so the main process can push a refresh. */
  onChange?: () => void
  now?: () => number
}): OnlineService {
  const withArtwork = (entry: OnlineTrack): OnlineTrack => {
    if (!entry.artworkKey) return entry
    return deps.artwork.pathFor(entry.artworkKey) ? entry : { ...entry, artworkKey: null }
  }

  /**
   * Thumbnail downloads in flight, keyed by video.
   *
   * A row is drawn in the history and again in the player bar, and the same link
   * can be playing while its row is on screen, so without this the same picture
   * would be fetched twice.
   */
  const pendingArtwork = new Map<string, Promise<string | null>>()

  const downloadArtwork = (videoId: string): Promise<string | null> => {
    const existing = pendingArtwork.get(videoId)
    if (existing) return existing
    const work = cacheThumbnail(videoId, deps.artwork, deps.log).finally(() => pendingArtwork.delete(videoId))
    pendingArtwork.set(videoId, work)
    return work
  }

  return {
    list() {
      return deps.repo.list().map(withArtwork)
    },

    async addLink(input) {
      // Validation and resolution live in the resolver, so a bad link is refused
      // with the same message the player already knows how to show.
      const link = await deps.resolver.resolveLink(input)

      const entry = deps.repo.upsert(
        {
          videoId: link.track.sourceId,
          title: link.track.title,
          artist: link.track.artist,
          // Album fields arrive with playlist/album import (M5). A single watch
          // link carries no album, and inventing one would be worse than null.
          album: null,
          durationMs: link.track.durationMs,
          sourceUrl: youtubeWatchUrl(link.track.sourceId),
          // Left null: the cover is fetched the first time the row is drawn, so a
          // slow image CDN never holds up the row appearing after the resolve.
          artworkKey: null
        },
        deps.now?.() ?? Date.now()
      )
      deps.onChange?.()
      // A re-paste keeps the cover cached by the earlier row, so the answer still
      // goes through the missing-file check that `list()` applies.
      return withArtwork(entry)
    },

    async artworkFor(id) {
      const entry = deps.repo.get(id)
      if (!entry) return null
      if (entry.artworkKey && deps.artwork.pathFor(entry.artworkKey)) return entry.artworkKey

      const key = await downloadArtwork(entry.videoId)
      if (key) {
        deps.repo.setArtworkKey(entry.videoId, key)
        deps.onChange?.()
      }
      return key
    },

    touch(videoId) {
      deps.repo.touch(videoId, deps.now?.() ?? Date.now())
      deps.onChange?.()
    },

    remove(id) {
      deps.repo.remove(id)
      deps.onChange?.()
    },

    clear() {
      const removed = deps.repo.clear()
      if (removed > 0) deps.onChange?.()
      return removed
    }
  }
}

/**
 * Downloads the best still for a video into the artwork cache.
 *
 * Best effort on purpose: a row is still worth having without a picture, so a
 * timeout, a 404 or an image this build cannot decode just leaves the key null
 * rather than failing the request. The candidate list exists because the WebP
 * still that `yt-dlp` reports cannot be decoded by Electron's `nativeImage`; the
 * caller walks the JPEG variants until one sticks.
 */
async function cacheThumbnail(videoId: string, artwork: ArtworkService, log: Logger): Promise<string | null> {
  for (const url of youtubeThumbnailCandidates(videoId)) {
    const key = await fetchImage(url, artwork, log)
    if (key) return key
  }
  return null
}

/** One candidate: fetched, size-checked and decoded, or null. */
async function fetchImage(url: string, artwork: ArtworkService, log: Logger): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(THUMBNAIL_TIMEOUT_MS) })
    // A missing `maxresdefault` is not a clean 404: YouTube answers with a
    // decodable 120x90 placeholder and a failing status, so the status matters.
    if (!response.ok) return null

    const mime = response.headers.get('content-type') ?? ''
    if (!mime.startsWith('image/')) return null

    const declared = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_THUMBNAIL_BYTES) return null

    const data = Buffer.from(await response.arrayBuffer())
    if (data.length === 0 || data.length > MAX_THUMBNAIL_BYTES) return null

    // `cacheRemote` returns null when the bytes do not decode, which is what lets
    // the caller fall through to the next candidate.
    return await artwork.cacheRemote(data, mime)
  } catch (error) {
    log.debug('thumbnail could not be cached', { error })
    return null
  }
}
