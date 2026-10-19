import type { Logger } from '@core/logging/logger'
import type { RemoteStreamProxy } from '@engine/stream-proxy'
import type { YouTubeResolver } from '@engine/youtube-resolver'
import type { Track } from '@shared/types'
import type { ArtworkService } from './artwork-service'

export interface YoutubeService {
  /** Registered with the resolver registry; also owns the stream proxy. */
  readonly resolver: YouTubeResolver
  readonly proxy: RemoteStreamProxy
  /** Resolves a pasted link into a session-only track with a cached thumbnail. */
  addLink(input: string): Promise<Track>
}

/** A thumbnail is decoration; cap the wait so a slow image CDN cannot delay playback. */
const THUMBNAIL_TIMEOUT_MS = 2_500
const MAX_THUMBNAIL_BYTES = 4 * 1024 * 1024

/**
 * Turns a resolved link into something the queue can hold.
 *
 * Stream tracks get negative ids. They are not rows in the library, and using a
 * positive number would let a play count or artwork lookup hit an unrelated
 * local file. SQLite updates against a negative id simply match nothing, which
 * is the behaviour we want until M5 gives remote tracks real rows.
 */
export function createYoutubeService(deps: {
  resolver: YouTubeResolver
  artwork: ArtworkService
  log: Logger
}): YoutubeService {
  let nextStreamId = -1

  return {
    resolver: deps.resolver,
    proxy: deps.resolver.proxy,

    async addLink(input) {
      const link = await deps.resolver.resolveLink(input)
      const artworkKey = link.track.thumbnailUrl
        ? await cacheThumbnail(link.track.thumbnailUrl, deps.artwork, deps.log)
        : null

      return {
        id: nextStreamId--,
        sourceKind: 'youtube',
        sourceId: link.track.sourceId,
        title: link.track.title,
        artist: link.track.artist,
        albumArtist: link.track.artist,
        album: null,
        trackNo: null,
        discNo: null,
        year: null,
        genre: null,
        durationMs: link.track.durationMs,
        codec: link.track.codec,
        bitrateKbps: link.track.bitrateKbps,
        sampleRate: link.track.sampleRate,
        channels: link.track.channels,
        fileSize: link.track.fileSize,
        filePath: null,
        artworkKey,
        addedAt: Date.now(),
        playCount: 0,
        lastPlayedAt: null
      }
    }
  }
}

async function cacheThumbnail(url: string, artwork: ArtworkService, log: Logger): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(THUMBNAIL_TIMEOUT_MS) })
    if (!response.ok) return null

    const mime = response.headers.get('content-type') ?? ''
    if (!mime.startsWith('image/')) return null

    const declared = Number(response.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_THUMBNAIL_BYTES) return null

    const data = Buffer.from(await response.arrayBuffer())
    if (data.length === 0 || data.length > MAX_THUMBNAIL_BYTES) return null

    return await artwork.cacheRemote(data, mime)
  } catch (error) {
    log.debug('thumbnail could not be cached', { error })
    return null
  }
}
