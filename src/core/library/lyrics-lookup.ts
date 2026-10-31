import { candidatesFromLrclib, rankLyricsCandidates } from '@shared/lyrics'
import type { LyricsLookupQuery, LyricsLookupResult } from '@shared/types'
import type { Logger } from '@core/logging/logger'

/**
 * The one public lyrics service the finder asks.
 *
 * LRCLIB is keyless and community-run, which is why it is the first source: the
 * finder has to work on a fresh install with nothing to configure. Their API
 * asks clients to identify themselves, so every request carries the project's
 * User-Agent rather than the Electron default.
 *
 * The exact endpoint is asked first because it is the cheapest answer: one
 * request when the title, artist and length line up. A miss falls back to the
 * search endpoint, which is fuzzier but returns several releases to choose
 * from. Neither endpoint is allowed to throw at the caller: a service that is
 * down is a sentence in the finder, not a failed panel.
 */

export const LRCLIB_API_URL = 'https://lrclib.net/api'

const LRCLIB_USER_AGENT = 'Suura/0.1.0 ( https://github.com/suura-player/suura )'
const LOOKUP_TIMEOUT_MS = 8_000

export interface LyricsLookup {
  lookup(query: LyricsLookupQuery): Promise<LyricsLookupResult>
}

export interface LyricsLookupOptions {
  log: Logger
  /** Injected by the smoke test and the self-test so no request leaves the app. */
  fetch?: typeof fetch
  timeoutMs?: number
}

/** The title without the bracketed noise a download often adds. */
function searchTitle(title: string): string {
  const cleaned = title
    .replace(/\((?:[^()]*)\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return (cleaned.length > 0 ? cleaned : title.trim()).slice(0, 200)
}

function queryText(value: string | null): string | null {
  const text = value?.trim()
  return text && text.length > 0 ? text.slice(0, 200) : null
}

export function lrclibGetUrl(query: LyricsLookupQuery): string {
  const url = new URL(`${LRCLIB_API_URL}/get`)
  url.searchParams.set('track_name', searchTitle(query.title))
  const artist = queryText(query.artist)
  if (artist) url.searchParams.set('artist_name', artist)
  const album = queryText(query.album)
  if (album) url.searchParams.set('album_name', album)
  if (query.durationMs && query.durationMs > 0) {
    url.searchParams.set('duration', String(Math.round(query.durationMs / 1000)))
  }
  return url.toString()
}

export function lrclibSearchUrl(query: LyricsLookupQuery): string {
  const url = new URL(`${LRCLIB_API_URL}/search`)
  url.searchParams.set('track_name', searchTitle(query.title))
  const artist = queryText(query.artist)
  if (artist) url.searchParams.set('artist_name', artist)
  return url.toString()
}

/** A user-facing sentence: the URL and the status live in the log. */
function describeFailure(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'LRCLIB took too long to answer.'
  }
  return 'LRCLIB could not be reached.'
}

interface Answer {
  ok: boolean
  status: number
  body: unknown
}

export function createLyricsLookup(options: LyricsLookupOptions): LyricsLookup {
  const request = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? LOOKUP_TIMEOUT_MS

  const getJson = async (url: string): Promise<Answer> => {
    const response = await request(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'application/json',
        'User-Agent': LRCLIB_USER_AGENT
      }
    })
    if (!response.ok) return { ok: false, status: response.status, body: null }
    return { ok: true, status: response.status, body: (await response.json()) as unknown }
  }

  return {
    async lookup(query) {
      if (query.title.trim().length === 0) {
        return { query, candidates: [], message: null }
      }

      try {
        const exact = await getJson(lrclibGetUrl(query))
        if (exact.ok) {
          const candidates = rankLyricsCandidates(query, candidatesFromLrclib(exact.body))
          if (candidates.length > 0) {
            options.log.debug('lrclib exact match', { count: candidates.length })
            return { query, candidates, message: null }
          }
        }

        const search = await getJson(lrclibSearchUrl(query))
        if (!search.ok && search.status >= 500) {
          throw new Error(`LRCLIB answered ${search.status}`)
        }
        const candidates = search.ok
          ? rankLyricsCandidates(query, candidatesFromLrclib(search.body))
          : []
        options.log.debug('lrclib search answered', { count: candidates.length })
        return { query, candidates, message: null }
      } catch (error) {
        options.log.debug('lrclib lookup failed', { error })
        return { query, candidates: [], message: describeFailure(error) }
      }
    }
  }
}
