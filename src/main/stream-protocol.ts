import { protocol } from 'electron'
import type { Logger } from '@core/logging/logger'
import type { RemoteStreamProxy } from '@engine/stream-proxy'
import { STREAM_SCHEME, parseStreamUrl } from '@shared/stream-url'

/**
 * Serves resolved YouTube audio through `player-stream://`.
 *
 * The renderer only holds a token, so this handler is the one place an upstream
 * request can be made. The proxy could work without Electron; this is the thin
 * adapter that turns its `Response` into a protocol answer.
 */
export function installStreamProtocolHandler(deps: { proxy: RemoteStreamProxy; log: Logger }): void {
  protocol.handle(STREAM_SCHEME, async (request) => {
    const parsed = parseStreamUrl(request.url)
    if (!parsed) {
      return new Response('Malformed stream request.', { status: 400 })
    }

    try {
      return await deps.proxy.handle(parsed.token, {
        range: request.headers.get('Range'),
        method: request.method
      })
    } catch (error) {
      deps.log.warn('stream protocol handler failed', { error })
      return new Response('The stream failed.', {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' }
      })
    }
  })
}
