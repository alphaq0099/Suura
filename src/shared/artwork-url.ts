/**
 * The custom `player-art://` scheme.
 *
 * Album art never reaches the renderer as a raw `file://` URL, for the same
 * reason audio does not: the main process stays the only component that touches
 * the filesystem, and the handler is the allowlist.
 *
 * A URL carries a *cache key* rather than a path. Keys are content hashes (see
 * `artworkKeyFor` in the core), which is what makes the response immutable and
 * lets two tracks that share a cover share one file on disk.
 */
export const ARTWORK_SCHEME = 'player-art'
export const ARTWORK_HOST = 'art'

export function buildArtworkUrl(key: string): string {
  return `${ARTWORK_SCHEME}://${ARTWORK_HOST}/${encodeURIComponent(key)}`
}

export interface ParsedArtworkUrl {
  key: string
}

/** Returns null for anything that is not a well-formed player-art URL. */
export function parseArtworkUrl(rawUrl: string): ParsedArtworkUrl | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${ARTWORK_SCHEME}:`) return null
  if (url.hostname !== ARTWORK_HOST) return null
  const key = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  if (key.length === 0) return null
  return { key }
}
