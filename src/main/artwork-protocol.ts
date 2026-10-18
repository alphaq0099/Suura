import { readFile } from 'node:fs/promises'
import { protocol } from 'electron'
import { ARTWORK_SCHEME, parseArtworkUrl } from '@shared/artwork-url'
import type { Logger } from '@core/logging/logger'
import type { ArtworkService } from './artwork-service'

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

/**
 * Serves cached cover art to the renderer.
 *
 * Much simpler than the media protocol: an image is small and decoded whole, so
 * there are no range requests. What it does keep is the same discipline — the
 * key is validated by the service before anything touches the disk, so this
 * cannot be talked into reading an arbitrary file.
 */
export function installArtworkProtocolHandler(deps: { artwork: ArtworkService; log: Logger }): void {
  protocol.handle(ARTWORK_SCHEME, async (request) => {
    const parsed = parseArtworkUrl(request.url)
    if (!parsed) {
      deps.log.warn('malformed artwork request', { url: request.url })
      return new Response('Malformed artwork request.', { status: 400 })
    }

    const filePath = deps.artwork.pathFor(parsed.key)
    if (!filePath) {
      deps.log.warn('artwork not in cache', { key: parsed.key })
      return new Response('Not found.', { status: 404 })
    }

    let data: Buffer
    try {
      data = await readFile(filePath)
    } catch (error) {
      deps.log.warn('artwork read failed', { key: parsed.key, error })
      return new Response('Not found.', { status: 404 })
    }

    const extension = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
    return new Response(data, {
      headers: {
        'Content-Type': MIME_BY_EXTENSION[extension] ?? 'application/octet-stream',
        // A key is a content hash, so the bytes behind it can never change.
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    })
  })
}
