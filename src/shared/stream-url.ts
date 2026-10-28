/**
 * The custom `player-stream://` scheme.
 *
 * A resolved YouTube URL is signed, expires in a few hours and only works with
 * the HTTP headers the resolver saw. Handing it to the renderer would mean
 * either leaking those headers into the page or watching playback fail with a
 * bare 403. Instead the main process keeps the upstream URL in memory and gives
 * the <audio> element an opaque, stable token. The token is also what makes a
 * transparent re-resolve possible: the URL the element holds never changes.
 */
export const STREAM_SCHEME = 'player-stream'
export const STREAM_HOST = 'stream'

/** Tokens are generated with `crypto.randomUUID()`, never by the renderer. */
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function buildStreamUrl(token: string): string {
  return `${STREAM_SCHEME}://${STREAM_HOST}/${token}`
}

export interface ParsedStreamUrl {
  token: string
}

/** Returns null for anything that is not a well-formed player-stream URL. */
export function parseStreamUrl(rawUrl: string): ParsedStreamUrl | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${STREAM_SCHEME}:`) return null
  if (url.hostname !== STREAM_HOST) return null
  const token = url.pathname.replace(/^\/+/, '')
  if (!TOKEN.test(token)) return null
  return { token }
}
