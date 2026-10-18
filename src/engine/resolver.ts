import type { ResolvedSource, Track } from '@shared/types'

/**
 * What a resolver can actually do.
 *
 * The renderer is expected to read this and hide or disable features a backend
 * cannot support. That matters on Android, where the yt-dlp sidecar does not
 * exist and the remote resolver will have a different capability set.
 */
export interface ResolverCapabilities {
  /** Can produce a URL that plays without downloading the whole file first. */
  streaming: boolean
  /** Can search a remote catalogue by text. */
  search: boolean
  /** Can write a permanent local file. */
  download: boolean
}

/**
 * The seam between "the app" and "where audio comes from".
 *
 * `LocalFileResolver` implements it today. `YtDlpResolver` (M3) and an Android
 * resolver (M8) implement the same interface, which is what keeps the port from
 * becoming a rewrite.
 */
export interface MediaResolver {
  readonly id: string
  readonly capabilities: ResolverCapabilities
  canResolve(track: Track): boolean
  resolve(track: Track): Promise<ResolvedSource>
}

export class ResolverRegistry {
  private readonly resolvers: MediaResolver[] = []

  constructor(private readonly onWarn: (message: string, details?: unknown) => void = () => undefined) {}

  register(resolver: MediaResolver): void {
    this.resolvers.push(resolver)
  }

  list(): Array<{ id: string; capabilities: ResolverCapabilities }> {
    return this.resolvers.map((resolver) => ({ id: resolver.id, capabilities: resolver.capabilities }))
  }

  /** First registered resolver that claims the track wins. Order is priority. */
  forTrack(track: Track): MediaResolver | null {
    return this.resolvers.find((resolver) => resolver.canResolve(track)) ?? null
  }

  async resolve(track: Track): Promise<ResolvedSource> {
    const resolver = this.forTrack(track)
    if (!resolver) {
      throw new Error(`No resolver can play this track (source: ${track.sourceKind}).`)
    }
    const started = Date.now()
    const source = await resolver.resolve(track)
    this.onWarn('resolved track', { trackId: track.id, resolver: resolver.id, durationMs: Date.now() - started })
    return source
  }
}
