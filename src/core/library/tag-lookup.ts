import { candidatesFromItunes, candidatesFromMusicBrainz, rankCandidates } from '@shared/auto-tag'
import type { TagCandidate, TagLookupQuery, TagLookupResult, TagProviderReport } from '@shared/types'
import type { Logger } from '@core/logging/logger'
import { RequestScheduler } from '@core/scheduling/request-scheduler'

/**
 * The two public metadata services the tag finder asks.
 *
 * Both are keyless, which is the point: the finder has to work on a fresh
 * install with nothing to configure, and a failed lookup has to be a sentence
 * rather than a settings page. Each provider is asked independently, so one
 * being down still leaves the other's matches in the review dialog.
 */

export const ITUNES_SEARCH_URL = 'https://itunes.apple.com/search'
export const MUSICBRAINZ_RECORDING_URL = 'https://musicbrainz.org/ws/2/recording'

/**
 * MusicBrainz asks clients to identify themselves. The address is the project,
 * not a person: it exists so their operators can find who is calling.
 */
const MUSICBRAINZ_USER_AGENT = 'Suura/0.1.0 ( https://github.com/suura-player/suura )'

/** Their published limit is one request per second per client. */
const MUSICBRAINZ_GAP_MS = 1_100

const LOOKUP_TIMEOUT_MS = 8_000
const LOOKUP_LIMIT = 12

export interface TagLookup {
  lookup(query: TagLookupQuery): Promise<TagLookupResult>
}

export interface TagLookupOptions {
  log: Logger
  /** Injected by the self-test so the review dialog can be driven offline. */
  fetch?: typeof fetch
  timeoutMs?: number
  /** Replaces the iTunes pacing; the smoke tests pass a pass-through. */
  schedule?: TagSchedule
}

/**
 * Runs one whole iTunes lookup inside the service's budget.
 *
 * MusicBrainz serialises itself below, because its rule is one request a
 * second. iTunes publishes no such rule, but a batch of five hundred tracks
 * must not arrive as five hundred searches in a burst either, so it is paced
 * here: two at a time, a short gap between starts.
 */
export type TagSchedule = <T>(work: () => Promise<T>) => Promise<T>

const ITUNES_PACING = { maxConcurrent: 2, minGapMs: 200, jitterMs: 100 } as const

/** The text both search APIs are given: the title without its bracketed noise. */
export function searchTerm(query: TagLookupQuery): string {
  const title = query.title
    .replace(/\((?:[^()]*)\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const artist = query.artist?.trim() ?? ''
  return [title, artist].filter((part) => part.length > 0).join(' ').slice(0, 200)
}

/** Lucene syntax, quoted so a colon or a dash in a title is not an operator. */
export function musicBrainzQuery(query: TagLookupQuery): string {
  const escape = (value: string): string => value.replace(/[\\"]/g, '\\$&')
  const title = query.title
    .replace(/\((?:[^()]*)\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const parts = [`recording:"${escape(title)}"`]
  const artist = query.artist?.trim()
  if (artist) parts.push(`artist:"${escape(artist)}"`)
  return parts.join(' AND ')
}

export function itunesUrl(query: TagLookupQuery): string {
  const url = new URL(ITUNES_SEARCH_URL)
  url.searchParams.set('term', searchTerm(query))
  url.searchParams.set('media', 'music')
  url.searchParams.set('entity', 'song')
  url.searchParams.set('limit', String(LOOKUP_LIMIT))
  return url.toString()
}

export function musicBrainzUrl(query: TagLookupQuery): string {
  const url = new URL(MUSICBRAINZ_RECORDING_URL)
  url.searchParams.set('query', musicBrainzQuery(query))
  url.searchParams.set('fmt', 'json')
  url.searchParams.set('limit', String(LOOKUP_LIMIT))
  url.searchParams.set('inc', 'artist-credits releases')
  return url.toString()
}

function report(
  provider: TagProviderReport['provider'],
  count: number,
  message: string | null = null
): TagProviderReport {
  return { provider, ok: message === null, message, count }
}

/** A user-facing sentence: the URL and the status live in the log. */
function describeFailure(error: unknown, name: string): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `${name} took too long to answer.`
  }
  return `${name} could not be reached.`
}

interface ProviderAnswer {
  candidates: TagCandidate[]
  report: TagProviderReport
}

export function createTagLookup(options: TagLookupOptions): TagLookup {
  const request = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? LOOKUP_TIMEOUT_MS
  const scheduler = new RequestScheduler(ITUNES_PACING)
  const itunesSchedule: TagSchedule =
    options.schedule ?? (<T>(work: () => Promise<T>) => scheduler.schedule(work))

  const getJson = async (url: string, headers: Record<string, string> = {}): Promise<unknown> => {
    const response = await request(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json', ...headers }
    })
    if (!response.ok) throw new Error(`the service answered ${response.status}`)
    return (await response.json()) as unknown
  }

  // MusicBrainz is serialised across lookups, not just within one: two quick
  // edits would otherwise break the one-request-a-second rule and get the app
  // blocked. The chain never rejects, so one failure does not stall the next.
  let musicBrainzChain: Promise<unknown> = Promise.resolve()
  let musicBrainzLastAt = 0

  const musicBrainzJson = (url: string): Promise<unknown> => {
    const run = musicBrainzChain.then(async () => {
      const wait = Math.max(0, musicBrainzLastAt + MUSICBRAINZ_GAP_MS - Date.now())
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      musicBrainzLastAt = Date.now()
      return getJson(url, { 'User-Agent': MUSICBRAINZ_USER_AGENT })
    })
    musicBrainzChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  const lookupItunes = async (query: TagLookupQuery): Promise<ProviderAnswer> => {
    try {
      const candidates = candidatesFromItunes(await itunesSchedule(() => getJson(itunesUrl(query))))
      options.log.debug('itunes lookup answered', { count: candidates.length })
      return { candidates, report: report('itunes', candidates.length) }
    } catch (error) {
      options.log.debug('itunes lookup failed', { error })
      return { candidates: [], report: report('itunes', 0, describeFailure(error, 'iTunes')) }
    }
  }

  const lookupMusicBrainz = async (query: TagLookupQuery): Promise<ProviderAnswer> => {
    try {
      const candidates = candidatesFromMusicBrainz(await musicBrainzJson(musicBrainzUrl(query)))
      options.log.debug('musicbrainz lookup answered', { count: candidates.length })
      return { candidates, report: report('musicbrainz', candidates.length) }
    } catch (error) {
      options.log.debug('musicbrainz lookup failed', { error })
      return {
        candidates: [],
        report: report('musicbrainz', 0, describeFailure(error, 'MusicBrainz'))
      }
    }
  }

  return {
    async lookup(query) {
      if (query.title.trim().length === 0) {
        return {
          query,
          candidates: [],
          providers: [report('itunes', 0), report('musicbrainz', 0)]
        }
      }

      const [itunes, musicbrainz] = await Promise.all([
        lookupItunes(query),
        lookupMusicBrainz(query)
      ])

      return {
        query,
        candidates: rankCandidates(query, [...itunes.candidates, ...musicbrainz.candidates]),
        providers: [itunes.report, musicbrainz.report]
      }
    }
  }
}
