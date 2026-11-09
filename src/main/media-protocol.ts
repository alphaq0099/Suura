import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { MEDIA_SCHEME, parseMediaUrl } from '@shared/media-url'
import { mimeForExtension } from '@shared/mime'
import { parseRangeHeader } from '@shared/range'
import type { Logger } from '@core/logging/logger'

export interface MediaProtocolDeps {
  /** Allowlist check. Without it this protocol would read any file on disk. */
  isPathAllowed(filePath: string): boolean
  log: Logger
}

/**
 * Serves local audio to the renderer.
 *
 * Range support is implemented by hand rather than delegated to `net.fetch` so
 * that seeking behaviour is explicit and testable, and so this handler can grow
 * into the yt-dlp stream proxy in M3 without the renderer noticing.
 */
export function installMediaProtocolHandler(deps: MediaProtocolDeps): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const parsed = parseMediaUrl(request.url)
    if (!parsed) {
      return new Response('Malformed media request.', { status: 400 })
    }

    // Canonicalise once, then use the same string for the allowlist, `stat` and
    // the read. A URL may still contain `..`, and on Unix `stat` resolves each
    // segment in turn: `sub/../song.flac` fails when `sub` does not exist, even
    // though the file it names does.
    const filePath = resolve(parsed.path)
    if (!deps.isPathAllowed(filePath)) {
      deps.log.warn('blocked media request outside the library', { filePath })
      return new Response('Forbidden.', { status: 403 })
    }

    let info
    try {
      info = await stat(filePath)
    } catch {
      return new Response('Not found.', { status: 404 })
    }
    if (!info.isFile()) {
      return new Response('Not a file.', { status: 404 })
    }

    const totalSize = info.size
    const baseHeaders: Record<string, string> = {
      'Content-Type': mimeForExtension(filePath),
      'Accept-Ranges': 'bytes',
      // Web Audio reads the element's decoded samples. A cross-origin media
      // element without CORS is deliberately silenced by Chromium when a
      // MediaElementAudioSourceNode is attached, so the renderer sets
      // crossOrigin and this protocol answers for it.
      'Access-Control-Allow-Origin': '*',
      // The renderer must not serve a stale body after the file changes on disk.
      'Cache-Control': 'no-store'
    }

    const rangeHeader = request.headers.get('Range')
    if (rangeHeader) {
      const range = parseRangeHeader(rangeHeader, totalSize)
      if (!range) {
        return new Response(null, {
          status: 416,
          headers: { ...baseHeaders, 'Content-Range': `bytes */${totalSize}` }
        })
      }
      const body = request.method === 'HEAD' ? null : toWebStream(filePath, range.start, range.end)
      return new Response(body, {
        status: 206,
        headers: {
          ...baseHeaders,
          'Content-Range': `bytes ${range.start}-${range.end}/${totalSize}`,
          'Content-Length': String(range.end - range.start + 1)
        }
      })
    }

    const body = request.method === 'HEAD' ? null : toWebStream(filePath, 0, undefined)
    return new Response(body, {
      status: 200,
      headers: { ...baseHeaders, 'Content-Length': String(totalSize) }
    })
  })
}

/**
 * The body type the global `Response` constructor accepts.
 *
 * Written this way rather than as `BodyInit` because that name comes from the DOM
 * lib, which the main process does not load: it has Node's fetch types instead.
 */
type ResponseBody = ConstructorParameters<typeof Response>[0]

function toWebStream(filePath: string, start: number, end: number | undefined): ResponseBody {
  const stream = createReadStream(filePath, end === undefined ? { start } : { start, end })
  // Node's ReadableStream is structurally compatible with the body Node's fetch
  // accepts, but the two lib types do not unify.
  return Readable.toWeb(stream) as unknown as ResponseBody
}
