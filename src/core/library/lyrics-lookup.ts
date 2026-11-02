import { candidatesFromLrclib, rankLyricsCandidates } from '@shared/lyrics'
import type {
  LyricsCandidate,
  LyricsLookupQuery,
  LyricsLookupResult,
  LyricsProvider as LyricsProviderName
} from '@shared/types'
import type { Logger } from '@core/logging/logger'
import { RequestScheduler } from '@core/scheduling/request-scheduler'
import { withProviderRetry } from '@core/scheduling/provider-retry'

/**
 * The services the finder asks, and the merge in front of them.
 *
 * LRCLIB is keyless, community-run and the only source that returns timed LRC,
 * so it is asked first and its matches win a tie. Genius fills the gap when
 * LRCLIB has nothing or is down: it has the words for far more songs, but only
 * as plain text. Both are asked in parallel, and one being unavailable never
 * hides the other's answer.
 *
 * Neither client is allowed to throw at the caller: a service that is down is a
 * sentence in the finder, not a failed panel. The exact endpoints and the page
 * parsing live with the providers; the ranking rules are pure and shared.
 */

export const LRCLIB_API_URL = 'https://lrclib.net/api'

const LRCLIB_USER_AGENT = 'Suura/0.1.0 ( https://github.com/suura-player/suura )'
const LOOKUP_TIMEOUT_MS = 8_000

/** What one provider answered, before the merge. */
export interface LyricsProviderAnswer {
  candidates: LyricsCandidate[]
  /** False when the service failed; an empty answer is still `true`. */
  ok: boolean
  /** A user-facing sentence when `ok` is false. */
  message: string | null
}

export interface LyricsProvider {
  readonly name: LyricsProviderName
  lookup(query: LyricsLookupQuery): Promise<LyricsProviderAnswer>
}

/** What `LyricsService` holds: one lookup over every provider. */
export interface LyricsLookup {
  lookup(query: LyricsLookupQuery): Promise<LyricsLookupResult>
}

export interface LyricsLookupOptions {
  log: Logger
  /** Injected by the smoke test and the self-test so no request leaves the app. */
  fetch?: typeof fetch
  timeoutMs?: number
  /**
   * Replaces the provider's own pacing. The smoke test injects a pass-through
   * so a batch of lookups does not wait out the real gaps; production leaves it
   * unset and gets the scheduler below.
   */
  schedule?: LyricsSchedule
}

/**
 * Runs one whole lookup inside the provider's budget.
 *
 * The unit is the lookup, not the HTTP call: LRCLIB's exact-then-search pair is
 * one conversation with the service, and Genius's search plus its three pages
 * is another. Pacing the whole thing keeps a batch from stacking conversations
 * while letting the calls inside one lookup run together.
 */
export type LyricsSchedule = <T>(work: () => Promise<T>) => Promise<T>

/** How many lookups LRCLIB may run at once, and the gap between starts. */
const LRCLIB_PACING = { maxConcurrent: 2, minGapMs: 200, jitterMs: 100 } as const

/** A status a provider answered with, so the sentence can name the reason. */
export class LyricsHttpError extends Error {
  constructor(readonly status: number) {
    super(`lyrics provider answered ${status}`)
    this.name = 'LyricsHttpError'
  }
}

/** The provider's name as a person reads it. */
export function lyricsProviderLabel(provider: LyricsProviderName): string {
  return provider === 'genius' ? 'Genius' : 'LRCLIB'
}

/** A user-facing sentence: the URL and the status live in the log. */
export function describeLyricsFailure(provider: LyricsProviderName, error: unknown): string {
  const label = lyricsProviderLabel(provider)
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `${label} took too long to answer.`
  }
  if (error instanceof LyricsHttpError) {
    if (error.status === 429) return `${label} is rate-limiting requests. Try again in a moment.`
    if (error.status >= 500) return `${label} is temporarily unavailable.`
  }
  return `${label} could not be reached.`
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

interface Answer {
  ok: boolean
  status: number
  body: unknown
}

/**
 * LRCLIB: the timed source.
 *
 * The exact endpoint is asked first because it is the cheapest answer: one
 * request when the title, artist and length line up. A miss falls back to the
 * search endpoint, which is fuzzier but returns several releases to choose
 * from. A 404 is a miss, not a failure; a 5xx or a timeout is a failure the
 * finder can report while Genius still answers.
 */
export function createLyricsLookup(options: LyricsLookupOptions): LyricsProvider {
  const request = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? LOOKUP_TIMEOUT_MS
  const scheduler = new RequestScheduler(LRCLIB_PACING)
  const schedule: LyricsSchedule =
    options.schedule ?? (<T>(work: () => Promise<T>) => scheduler.schedule(work))

  const getJson = async (url: string): Promise<Answer> => {
    // A 429 here is the service's own pace, and it governs the rest of the
    // batch too: the scheduler holds every later LRCLIB lookup for the wait.
    const response = await withProviderRetry(
      () =>
        request(url, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            Accept: 'application/json',
            'User-Agent': LRCLIB_USER_AGENT
          }
        }),
      { onCooldown: (ms) => scheduler.pause(ms) }
    )
    if (!response.ok) return { ok: false, status: response.status, body: null }
    return { ok: true, status: response.status, body: (await response.json()) as unknown }
  }

  return {
    name: 'lrclib',
    async lookup(query) {
      if (query.title.trim().length === 0) {
        return { candidates: [], ok: true, message: null }
      }

      try {
        return await schedule(async () => {
          const exact = await getJson(lrclibGetUrl(query))
          if (exact.ok) {
            const candidates = rankLyricsCandidates(query, candidatesFromLrclib(exact.body))
            if (candidates.length > 0) {
              options.log.debug('lrclib exact match', { count: candidates.length })
              return { candidates, ok: true, message: null }
            }
          }

          const search = await getJson(lrclibSearchUrl(query))
          if (!search.ok) {
            // 4xx other than 429 means "no such track", which is a valid answer.
            if (search.status >= 500 || search.status === 429) {
              throw new LyricsHttpError(search.status)
            }
            return { candidates: [], ok: true, message: null }
          }
          const candidates = rankLyricsCandidates(query, candidatesFromLrclib(search.body))
          options.log.debug('lrclib search answered', { count: candidates.length })
          return { candidates, ok: true, message: null }
        })
      } catch (error) {
        options.log.debug('lrclib lookup failed', { error })
        return { candidates: [], ok: false, message: describeLyricsFailure('lrclib', error) }
      }
    }
  }
}

export interface LyricsFinderOptions {
  log: Logger
  /** In the order their reports are listed; the merge itself is by score. */
  providers: LyricsProvider[]
}

/**
 * Runs every provider at once and merges what came back.
 *
 * A provider that throws is reported rather than allowed to fail the lookup:
 * the whole point of asking two services is that one can be down. `message` is
 * only set when every provider failed, because an empty answer from a working
 * service is a normal "nothing found".
 */
export function createLyricsFinder(options: LyricsFinderOptions): LyricsLookup {
  return {
    async lookup(query) {
      if (query.title.trim().length === 0) {
        return { query, candidates: [], providers: [], message: null }
      }

      const answers = await Promise.all(
        options.providers.map(async (provider) => {
          try {
            return { provider, answer: await provider.lookup(query) }
          } catch (error) {
            options.log.debug('lyrics provider threw', { provider: provider.name, error })
            return {
              provider,
              answer: {
                candidates: [],
                ok: false,
                message: describeLyricsFailure(provider.name, error)
              } satisfies LyricsProviderAnswer
            }
          }
        })
      )

      const reports = answers.map(({ provider, answer }) => ({
        provider: provider.name,
        ok: answer.ok,
        message: answer.message,
        count: answer.candidates.length
      }))
      const merged = answers.flatMap(({ answer }) => answer.candidates)
      const candidates = rankLyricsCandidates(query, merged)
      const failed = reports.filter((report) => !report.ok)
      const message =
        reports.length > 0 && failed.length === reports.length
          ? 'No lyrics service could be reached.'
          : null
      options.log.debug('lyrics lookup answered', {
        candidates: candidates.length,
        providers: reports.map((report) => `${report.provider}:${report.ok ? report.count : 'failed'}`)
      })
      return { query, candidates, providers: reports, message }
    }
  }
}
