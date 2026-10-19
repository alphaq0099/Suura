import type { Logger } from '@core/logging/logger'
import { buildStreamUrl } from '@shared/stream-url'
import type { QualityTier, ResolvableTrack, ResolvedSource } from '@shared/types'
import { extractYouTubeVideoId, isYouTubeVideoId } from '@shared/youtube'
import type { MediaResolver, ResolverCapabilities } from './resolver'
import type { YtInfoProvider, YtMediaInfo } from './sidecar/yt-dlp'
import { RemoteStreamProxy, type UpstreamMedia } from './stream-proxy'

/**
 * What the renderer needs to create a queue row for a pasted link.
 *
 * It is deliberately not a `Track`: the id and the timestamps belong to the
 * process that owns the session, and the thumbnail is kept separate because it
 * still has to be downloaded and cached.
 */
export interface YouTubeTrackDraft {
  sourceKind: 'youtube'
  sourceId: string
  title: string
  artist: string | null
  durationMs: number | null
  codec: string | null
  bitrateKbps: number | null
  sampleRate: number | null
  channels: number | null
  fileSize: number | null
  thumbnailUrl: string | null
}

export interface ResolvedLink {
  track: YouTubeTrackDraft
  source: ResolvedSource
}

/** A resolved URL is re-resolved this long before it expires. */
const EXPIRY_MARGIN_MS = 60_000

/** Enough links for a listening session; the proxy keeps its own smaller table. */
const MAX_CACHED_VIDEOS = 100

/**
 * The yt-dlp resolver.
 *
 * The expensive part (7-10 s) happens once per video per session. Both a paste
 * and a play go through `infoFor`, so pasting warms the cache that playback
 * reads, and pressing play twice never launches two sidecars. The signed URL is
 * handed to `RemoteStreamProxy`; the renderer only ever sees an opaque token.
 */
export class YouTubeResolver implements MediaResolver {
  readonly id = 'yt-dlp'

  readonly capabilities: ResolverCapabilities = {
    streaming: true,
    search: false,
    download: false
  }

  private readonly cache = new Map<string, { info: YtMediaInfo; storedAt: number }>()
  private readonly inFlight = new Map<string, Promise<YtMediaInfo>>()
  /** Public because the main process registers its protocol handler against it. */
  readonly proxy: RemoteStreamProxy

  constructor(
    private readonly deps: {
      info: YtInfoProvider
      log: Logger
      quality: () => QualityTier
      now?: () => number
    }
  ) {
    this.proxy = new RemoteStreamProxy(async (videoId) => {
      const info = await this.infoFor(videoId, { force: true })
      return upstreamOf(info)
    }, deps.log)
  }

  canResolve(track: ResolvableTrack): boolean {
    return track.sourceKind === 'youtube' && typeof track.sourceId === 'string' && isYouTubeVideoId(track.sourceId)
  }

  async resolve(track: ResolvableTrack): Promise<ResolvedSource> {
    if (!track.sourceId) throw new Error('This stream has no video id.')
    const info = await this.infoFor(track.sourceId)
    return this.sourceFor(info)
  }

  /** Validates a pasted link, resolves it and warms the cache playback will use. */
  async resolveLink(input: string): Promise<ResolvedLink> {
    const videoId = extractYouTubeVideoId(input)
    if (!videoId) {
      throw new Error('Paste a YouTube video link, for example https://www.youtube.com/watch?v=…')
    }

    const info = await this.infoFor(videoId)
    this.deps.log.debug('resolved youtube link', {
      videoId: info.videoId,
      formatId: info.formatId,
      bitrateKbps: info.bitrateKbps
    })
    return { track: draftOf(info), source: this.sourceFor(info) }
  }

  /**
   * Resolves the video now without registering a proxy token.
   *
   * The 7-10 s sidecar run is the whole wait between two queued tracks; doing it
   * while the current one plays means pressing Next (or hitting the end) only pays
   * for the CDN round trip. No token is registered because nothing is playing yet:
   * `resolve` registers one when the track is actually reached, and it will find
   * this info already in the cache.
   */
  async prefetch(track: ResolvableTrack): Promise<void> {
    if (!track.sourceId) return
    await this.infoFor(track.sourceId)
  }

  private sourceFor(info: YtMediaInfo): ResolvedSource {
    const token = this.proxy.register(info.videoId, upstreamOf(info))
    return {
      url: buildStreamUrl(token),
      expiresAt: info.expiresAt,
      mimeType: info.mimeType,
      resolverId: this.id
    }
  }

  private infoFor(videoId: string, options: { force?: boolean } = {}): Promise<YtMediaInfo> {
    const now = this.deps.now?.() ?? Date.now()
    if (!options.force) {
      const cached = this.cache.get(videoId)
      if (cached && cached.info.expiresAt - now > EXPIRY_MARGIN_MS) return Promise.resolve(cached.info)
    }

    const pending = this.inFlight.get(videoId)
    if (pending) return pending

    const work = this.deps.info
      .fetchInfo(videoId, this.deps.quality())
      .then((info) => {
        const storedAt = this.deps.now?.() ?? Date.now()
        this.cache.set(videoId, { info, storedAt })
        while (this.cache.size > MAX_CACHED_VIDEOS) {
          const oldest = this.cache.keys().next().value
          if (oldest === undefined) break
          this.cache.delete(oldest)
        }
        return info
      })
      .finally(() => {
        this.inFlight.delete(videoId)
      })

    this.inFlight.set(videoId, work)
    return work
  }
}

function upstreamOf(info: YtMediaInfo): UpstreamMedia {
  return {
    url: info.streamUrl,
    headers: info.headers,
    mimeType: info.mimeType,
    expiresAt: info.expiresAt
  }
}

function draftOf(info: YtMediaInfo): YouTubeTrackDraft {
  return {
    sourceKind: 'youtube',
    sourceId: info.videoId,
    title: info.title,
    artist: info.artist,
    durationMs: info.durationSec === null ? null : Math.round(info.durationSec * 1000),
    codec: info.codec,
    bitrateKbps: info.bitrateKbps,
    sampleRate: info.sampleRateHz,
    channels: info.channels,
    fileSize: info.fileSize,
    thumbnailUrl: info.thumbnailUrl
  }
}
