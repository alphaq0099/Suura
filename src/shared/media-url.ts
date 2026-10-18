/**
 * The custom `player-media://` scheme.
 *
 * Audio never reaches the renderer as a raw `file://` URL. It goes through this
 * scheme so that the main process stays the only component that touches the
 * filesystem, which lets us:
 *   - allowlist the paths that may be served (no arbitrary file reads),
 *   - implement HTTP range requests ourselves, so seeking works,
 *   - later swap the local-file branch for the yt-dlp stream proxy while the
 *     renderer keeps handing the same kind of URL to the <audio> element.
 */
export const MEDIA_SCHEME = 'player-media'
export const MEDIA_HOST = 'media'

export function buildMediaUrl(absolutePath: string): string {
  return `${MEDIA_SCHEME}://${MEDIA_HOST}/?path=${encodeURIComponent(absolutePath)}`
}

export interface ParsedMediaUrl {
  path: string
}

/** Returns null for anything that is not a well-formed player-media URL. */
export function parseMediaUrl(rawUrl: string): ParsedMediaUrl | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${MEDIA_SCHEME}:`) return null
  if (url.hostname !== MEDIA_HOST) return null
  const path = url.searchParams.get('path')
  if (!path) return null
  return { path }
}
