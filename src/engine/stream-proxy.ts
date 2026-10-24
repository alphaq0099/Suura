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

export interface StreamProxyOptions {
  /** Attempts per request, including the first. */
  attempts?: number
  /** Delay before the first retry; doubles from there. */
  retryDelayMs?: number
  maxRetryDelayMs?: number
  /** How long to wait for response headers. The body is deliberately not timed. */
  headerTimeoutMs?: number
  /** Longest a token is refused after its request budget is spent. */
  maxCooldownMs?: number
  /** Minimum gap between two re-resolves of the same video. */
  refreshCooldownMs?: number
  /** A URL this close to expiry is refreshed in the background. */
  expiryMarginMs?: number
  /** Injectable for tests. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  random?: () => number
}

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

/** Upstream answers that are worth asking again without re-resolving. */
const RETRYABLE_UPSTREAM_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504])

const DEFAULT_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 300
const DEFAULT_MAX_RETRY_DELAY_MS = 2_000
const DEFAULT_HEADER_TIMEOUT_MS = 20_000
const DEFAULT_MAX_COOLDOWN_MS = 8_000
const DEFAULT_REFRESH_COOLDOWN_MS = 20_000
const DEFAULT_EXPIRY_MARGIN_MS = 30_000

interface Entry {
  videoId: string
  upstream: UpstreamMedia
  /** Consecutive failed request cycles; drives the cooldown length. */
  failures: number
  /** No upstream request is made before this time. */
  retryAt: number
  /** Held from the start of a request cycle until its headers arrive. */
  probing: Promise<void> | null
  /** A re-resolve that other callers can join instead of starting their own. */
  refreshing: Promise<UpstreamMedia | null> | null
  lastRefreshAt: number
}

/** All callers waiting on the same token are refused instead of hammering the CDN. */
class StreamCoolDown extends Error {
  constructor(readonly retryAfterMs: number) {
    super('The stream is reconnecting.')
  }
}

/** A refusal that is not a transport failure (an HTTP status, or a failed refresh). */
class StreamUnavailable extends Error {
  constructor(
    message: string,
    readonly status: 502 | 503,
    readonly transient: boolean
  ) {
    super(message)
  }
}

/**
 * The HTTP side of remote playback.
 *
 * It does four things a plain URL cannot:
 * - keeps the signed URL and its headers in the main process,
 * - translates the renderer's Range requests to the CDN and the answer back,
 * - retries a request a small number of times, with backoff, while the network
 *   is coming back,
 * - re-resolves a URL that expired or that the CDN refuses.
 *
 * The distinction that matters is *transport* failure versus a refusal. A
 * dropped connection is not a dead link: the element should retry, and the URL
 * may still be good. An HTTP 403 is a dead link and only a new resolve helps.
 * Treating both the same way is what left the player permanently stuck after a
 * brief interruption: the old code retried the old URL at Chromium's pace and
 * never asked for a new one.
 *
 * It deliberately knows nothing about Electron, so smoke tests can point it at
 * a local HTTP server and check the range/retry behaviour without a window.
 */
export class RemoteStreamProxy {
  private readonly entries = new Map<string, Entry>()
  /** One token per video, so a re-resolve never changes the URL the element holds. */
  private readonly tokens = new Map<string, string>()
  private readonly attempts: number
  private readonly retryDelayMs: number
  private readonly maxRetryDelayMs: number
  private readonly headerTimeoutMs: number
  private readonly maxCooldownMs: number
  private readonly refreshCooldownMs: number
  private readonly expiryMarginMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number

  constructor(
    private readonly refresh: RefreshUpstream,
    private readonly log: Logger,
    options: StreamProxyOptions = {}
  ) {
    this.attempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_ATTEMPTS))
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS)
    this.maxRetryDelayMs = Math.max(this.retryDelayMs, options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS)
    this.headerTimeoutMs = Math.max(1_000, options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS)
    this.maxCooldownMs = Math.max(this.retryDelayMs, options.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS)
    this.refreshCooldownMs = Math.max(0, options.refreshCooldownMs ?? DEFAULT_REFRESH_COOLDOWN_MS)
    this.expiryMarginMs = Math.max(0, options.expiryMarginMs ?? DEFAULT_EXPIRY_MARGIN_MS)
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.random = options.random ?? Math.random
  }

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

    const existing = this.entries.get(token)
    if (existing) {
      // A new signed URL is a fresh start. Re-registering the same stale URL
      // must not clear the cooldown, or a renderer retry could undo the backoff.
      if (existing.upstream.url !== upstream.url || existing.upstream.expiresAt !== upstream.expiresAt) {
        existing.failures = 0
        existing.retryAt = 0
      }
      existing.upstream = upstream
    } else {
      this.entries.set(token, {
        videoId,
        upstream,
        failures: 0,
        retryAt: 0,
        probing: null,
        refreshing: null,
        lastRefreshAt: 0
      })
    }
    return token
  }

  async handle(token: string, request: StreamRequest): Promise<Response> {
    const entry = this.entries.get(token)
    if (!entry) return textResponse(404, 'Unknown stream.')

    try {
      const response = await this.withProbe(entry, () => this.fetchEntry(entry, request))
      return this.toResponse(entry, response, request)
    } catch (error) {
      if (error instanceof StreamCoolDown) {
        // Chromium re-asks within milliseconds after a failed media response.
        // Answering from the cooldown keeps that from becoming a request storm.
        return textResponse(503, 'The stream is reconnecting.', error.retryAfterMs)
      }

      if (error instanceof StreamUnavailable) {
        if (error.transient) return this.failTransient(entry, request, error.message)
        this.log.warn('stream refused', { videoId: entry.videoId, status: error.status, message: error.message })
        return textResponse(error.status, error.message)
      }

      return this.failTransient(entry, request, 'The stream could not be reached.', error)
    }
  }

  /** Shared failure path: backoff, one diagnostic line, and a possible new URL. */
  private failTransient(entry: Entry, request: StreamRequest, message: string, cause?: unknown): Response {
    const retryAfterMs = this.noteFailure(entry)
    this.log.warn('stream fetch failed', {
      videoId: entry.videoId,
      range: request.range,
      attempts: this.attempts,
      failures: entry.failures,
      retryInMs: retryAfterMs,
      error: cause
    })

    // One failed cycle is often just the outage itself. Waiting for a second one
    // means the network has had a chance to come back before spending 7-10 s and
    // a YouTube request on a new resolve.
    if (entry.failures >= 2) void this.refreshEntry(entry)

    return textResponse(503, message, retryAfterMs)
  }

  /** Runs one request cycle per token at a time, and honours an active cooldown. */
  private async withProbe<T>(entry: Entry, work: () => Promise<T>): Promise<T> {
    while (entry.probing) await entry.probing.catch(() => undefined)

    const wait = entry.retryAt - this.now()
    if (wait > 0) throw new StreamCoolDown(wait)

    let release!: () => void
    entry.probing = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      return await work()
    } finally {
      entry.probing = null
      release()
    }
  }

  private async fetchEntry(entry: Entry, request: StreamRequest): Promise<Response> {
    await this.ensureFresh(entry)

    let response = await this.fetchWithRetry(entry, request)

    if (FORBIDDEN_UPSTREAM_STATUSES.has(response.status)) {
      await cancelBody(response)
      this.log.info('stream URL refused, re-resolving', { videoId: entry.videoId, status: response.status })

      const refreshed = await this.refreshEntry(entry)
      if (!refreshed) {
        throw new StreamUnavailable('The stream was refused.', 502, false)
      }
      response = await this.fetchWithRetry(entry, request)
    }

    if (!response.ok && response.status !== 206) {
      const status = response.status
      const transient = RETRYABLE_UPSTREAM_STATUSES.has(status)
      await cancelBody(response)
      this.log.warn('stream upstream error', { videoId: entry.videoId, status })
      throw new StreamUnavailable('The stream was refused.', transient ? 503 : 502, transient)
    }

    this.noteSuccess(entry)
    return response
  }

  /**
   * A signed URL is refreshed just before it dies, and awaited once it has.
   *
   * Serving a URL that is already past its expiry only guarantees a 403 and a
   * second round trip; refreshing first turns "the song died mid-way" into a
   * short pause. The margin is small enough that the common case (a URL with
   * most of an hour left) never touches the network here.
   */
  private async ensureFresh(entry: Entry): Promise<void> {
    const expiresAt = entry.upstream.expiresAt
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) return

    const remaining = expiresAt - this.now()
    if (remaining > this.expiryMarginMs) return

    if (remaining <= 0) {
      const refreshed = await this.refreshEntry(entry)
      if (!refreshed) throw new StreamUnavailable('The stream link expired.', 503, true)
      return
    }

    // Background: this request can still be served with the current URL.
    void this.refreshEntry(entry)
  }

  private async fetchWithRetry(entry: Entry, request: StreamRequest): Promise<Response> {
    let lastError: unknown = null

    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      if (attempt > 1) await this.sleep(this.delayFor(attempt - 1))

      let response: Response
      try {
        response = await this.fetchOnce(entry.upstream, request)
      } catch (error) {
        lastError = error
        if (attempt === this.attempts) break
        continue
      }

      if (RETRYABLE_UPSTREAM_STATUSES.has(response.status) && attempt < this.attempts) {
        await cancelBody(response)
        continue
      }
      return response
    }

    throw lastError ?? new Error('The stream could not be reached.')
  }

  private fetchOnce(upstream: UpstreamMedia, request: StreamRequest): Promise<Response> {
    const headers: Record<string, string> = { ...upstream.headers, 'Accept-Encoding': 'identity' }
    if (request.range) headers.Range = request.range

    // Time only the wait for headers. An AbortSignal.timeout would also cut the
    // body off mid-song, which is precisely the failure being fixed.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.headerTimeoutMs)
    return fetch(upstream.url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal
    }).finally(() => clearTimeout(timer))
  }

  /** Joins an in-flight re-resolve, or starts one when the cooldown allows it. */
  private refreshEntry(entry: Entry): Promise<UpstreamMedia | null> {
    if (entry.refreshing) return entry.refreshing

    const now = this.now()
    if (now - entry.lastRefreshAt < this.refreshCooldownMs) return Promise.resolve(null)
    entry.lastRefreshAt = now

    const work = this.refresh(entry.videoId)
      .then((upstream) => {
        if (upstream) {
          entry.upstream = upstream
          // The new link deserves an immediate try rather than inheriting the
          // backoff that belonged to the dead one.
          entry.failures = 0
          entry.retryAt = 0
        }
        return upstream
      })
      .catch((error: unknown) => {
        this.log.warn('stream re-resolve failed', { videoId: entry.videoId, error })
        return null
      })
      .finally(() => {
        entry.refreshing = null
      })

    entry.refreshing = work
    return work
  }

  private noteFailure(entry: Entry): number {
    entry.failures += 1
    const cooldown = Math.min(this.retryDelayMs * 2 ** (entry.failures - 1), this.maxCooldownMs)
    entry.retryAt = this.now() + cooldown
    return cooldown
  }

  private noteSuccess(entry: Entry): void {
    entry.failures = 0
    entry.retryAt = 0
  }

  private delayFor(retry: number): number {
    const base = Math.min(this.retryDelayMs * 2 ** (retry - 1), this.maxRetryDelayMs)
    // A little jitter keeps a queue of interrupted players from retrying in lockstep.
    return Math.round(base * (0.8 + this.random() * 0.4))
  }

  private toResponse(entry: Entry, response: Response, request: StreamRequest): Response {
    const headers = new Headers()
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name)
      if (value) headers.set(name, value)
    }
    if (!headers.has('content-type')) headers.set('content-type', entry.upstream.mimeType)
    // Signed URLs are per-session; a cached body would outlive its signature.
    headers.set('cache-control', 'no-store')

    if (request.method === 'HEAD') {
      void cancelBody(response)
      return new Response(null, { status: response.status, headers })
    }

    return new Response(response.body, { status: response.status, headers })
  }
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

function textResponse(status: number, message: string, retryAfterMs = 0): Response {
  const headers: Record<string, string> = {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store'
  }
  if (retryAfterMs > 0) headers['retry-after'] = String(Math.max(1, Math.ceil(retryAfterMs / 1000)))
  return new Response(message, { status, headers })
}
