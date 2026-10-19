import { randomUUID } from 'node:crypto'
import type { Logger } from '@core/logging/logger'

/** A resolved CDN URL and everything needed to ask for it again. */
export interface UpstreamMedia {
  url: string
  headers: Record<string, string>
  mimeType: string
  expiresAt: number
}

export interface StreamRequest {
  range: string | null
  method: string
}

/** Asked when the CDN refuses a URL. Null means the video could not be re-resolved. */
export type RefreshUpstream = (videoId: string) => Promise<UpstreamMedia | null>

/** Response headers worth passing through. Everything else is hop-by-hop or unsafe. */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified'
] as const

const FORBIDDEN_UPSTREAM_STATUSES = new Set([401, 403, 410])

/**
 * The HTTP side of remote playback.
 *
 * It does three things a plain URL cannot:
 * - keeps the signed URL and its headers in the main process,
 * - translates the renderer's Range requests to the CDN and the answer back,
 * - re-resolves once when the CDN answers 403, which is what an expired URL
 *   looks like to an <audio> element.
 *
 * It deliberately knows nothing about Electron, so smoke tests can point it at
 * a local HTTP server and check the range/retry behaviour without a window.
 */
export class RemoteStreamProxy {
  private readonly entries = new Map<string, { videoId: string; upstream: UpstreamMedia }>()
  /** One token per video, so a re-resolve never changes the URL the element holds. */
  private readonly tokens = new Map<string, string>()

  constructor(
    private readonly refresh: RefreshUpstream,
    private readonly log: Logger
  ) {}

  /** Registers (or updates) the upstream for a video and returns its stable token. */
  register(videoId: string, upstream: UpstreamMedia): string {
    let token = this.tokens.get(videoId)
    if (!token) {
      token = randomUUID()
      this.tokens.set(videoId, token)
      // A long session can paste a lot of links; old entries are cheap to drop.
      while (this.tokens.size > 200) {
        const oldest = this.tokens.keys().next().value
        if (oldest === undefined) break
        const oldToken = this.tokens.get(oldest)
        this.tokens.delete(oldest)
        if (oldToken) this.entries.delete(oldToken)
      }
    }
    this.entries.set(token, { videoId, upstream })
    return token
  }

  async handle(token: string, request: StreamRequest): Promise<Response> {
    const entry = this.entries.get(token)
    if (!entry) return textResponse(404, 'Unknown stream.')

    let response: Response
    try {
      response = await this.fetchUpstream(entry.upstream, request)
    } catch (error) {
      this.log.warn('stream fetch failed', { error })
      return textResponse(502, 'The stream could not be reached.')
    }

    if (FORBIDDEN_UPSTREAM_STATUSES.has(response.status)) {
      const firstStatus = response.status
      await response.body?.cancel().catch(() => undefined)
      this.log.info('stream URL refused, re-resolving', { videoId: entry.videoId, status: firstStatus })

      const refreshed = await this.refresh(entry.videoId).catch((error: unknown) => {
        this.log.warn('stream re-resolve failed', { error })
        return null
      })
      if (refreshed) {
        entry.upstream = refreshed
        try {
          response = await this.fetchUpstream(refreshed, request)
        } catch (error) {
          this.log.warn('stream fetch failed after re-resolve', { error })
          return textResponse(502, 'The stream could not be reached.')
        }
      }
    }

    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => undefined)
      this.log.warn('stream upstream error', { videoId: entry.videoId, status: response.status })
      return textResponse(502, 'The stream was refused.')
    }

    const headers = new Headers()
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name)
      if (value) headers.set(name, value)
    }
    if (!headers.has('content-type')) headers.set('content-type', entry.upstream.mimeType)
    // Signed URLs are per-session; a cached body would outlive its signature.
    headers.set('cache-control', 'no-store')

    if (request.method === 'HEAD') {
      await response.body?.cancel().catch(() => undefined)
      return new Response(null, { status: response.status, headers })
    }

    return new Response(response.body, { status: response.status, headers })
  }

  private fetchUpstream(upstream: UpstreamMedia, request: StreamRequest): Promise<Response> {
    const headers: Record<string, string> = { ...upstream.headers, 'Accept-Encoding': 'identity' }
    if (request.range) headers.Range = request.range
    return fetch(upstream.url, {
      method: 'GET',
      headers,
      redirect: 'follow'
    })
  }
}

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  })
}
