import type { RemoteStreamProxy } from '@engine/stream-proxy'
import type { YouTubeResolver } from '@engine/youtube-resolver'

/**
 * The streaming half of M3.
 *
 * The resolver is registered with the resolver registry and owns the stream
 * proxy the `player-stream://` protocol reads from. The history of pasted links
 * lives in `OnlineService`; this stays small so the resolver can be reached
 * without dragging the database into the streaming layer.
 */
export interface YoutubeService {
  readonly resolver: YouTubeResolver
  readonly proxy: RemoteStreamProxy
}

export function createYoutubeService(resolver: YouTubeResolver): YoutubeService {
  return { resolver, proxy: resolver.proxy }
}
