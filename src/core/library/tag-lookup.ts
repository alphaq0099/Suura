import { candidatesFromItunes, candidatesFromMusicBrainz, candidateFromAcoustidRecording, rankCandidates } from '@shared/auto-tag'
import {
  AcoustidError,
  acoustidLookupUrl,
  describeAcoustidFailure,
  parseAcoustidError,
  parseAcoustidLookup,
  type AudioFingerprint
} from '@shared/acoustid'
import type { TagCandidate, TagLookupQuery, TagLookupResult, TagProviderReport } from '@shared/types'
import type { Logger } from '@core/logging/logger'
import { RequestScheduler } from '@core/scheduling/request-scheduler'
import { withProviderRetry } from '@core/scheduling/provider-retry'

/**
 * The two public metadata services the tag finder asks.
 *
 * Both are keyless, which is the point: the finder has to work on a fresh
 * install with nothing to configure, and a failed lookup has to be a sentence
 * rather than a settings page. Each provider is asked independently, so one
 * being down still leaves the other's matches in the review dialog.
 *
 * A batch asks these services hundreds of times, so each provider is paced, and
 * a "slow down" answer is obeyed once (`provider-retry.ts`): the request waits
 * out `Retry-After`, the provider's whole queue waits with it, and a second
 * refusal becomes the sentence the review dialog shows.
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

/**
 * Below this an AcoustID answer is noise. The service's score measures the
 * fingerprint, so this is not the weight of a text match; 0.4 is the same
 * floor the review dialog uses and only saves MusicBrainz requests.
 */
const MIN_FINGERPRINT_SCORE = 0.4

export interface TagLookup {
  lookup(query: TagLookupQuery): Promise<TagLookupResult>
  /**
   * Reads the file's audio fingerprint and asks AcoustID what it is.
   *
   * Separate from `lookup` on purpose: a batch must stay on the keyless text
   * services, and a fingerprint costs one fpcalc run plus a key the user may
   * not have configured. It is the fallback for a file whose tags are useless.
   */
  lookupFingerprint(query: TagLookupQuery, filePath: string): Promise<TagLookupResult>
}

export interface TagLookupOptions {
  log: Logger
  /** Injected by the self-test so the review dialog can be driven offline. */
  fetch?: typeof fetch
  timeoutMs?: number
  /** Replaces the iTunes pacing; the smoke tests pass a pass-through. */
  schedule?: TagSchedule
  /** The user's AcoustID key, or null when fingerprint lookup is unconfigured. */
  getAcoustidKey?: () => string | null
  /** Runs fpcalc; supplied by the main process so this module stays network-only. */
  fingerprint?: (filePath: string) => Promise<AudioFingerprint>
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

/**
 * One recording by id, with the release and media facts a track number needs.
 *
 * AcoustID names a recording, not a release, so this second lookup is what
 * turns "this is the right song" into "it is track 4 of 12 on disc 1".
 */
export function musicBrainzRecordingUrl(recordingId: string): string {
  const url = new URL(`${MUSICBRAINZ_RECORDING_URL}/${encodeURIComponent(recordingId)}`)
  url.searchParams.set('fmt', 'json')
  url.searchParams.set('inc', 'artist-credits releases release-groups genres media')
  return url.toString()
}

function report(
  provider: TagProviderReport['provider'],
  count: number,
  message: string | null = null
): TagProviderReport {
  return { provider, ok: message === null, message, count }
}

/** A status a provider answered with, so the sentence can name the reason. */
export class TagHttpError extends Error {
  constructor(readonly status: number) {
    super(`tag provider answered ${status}`)
    this.name = 'TagHttpError'
  }
}

/** A user-facing sentence: the URL and the status live in the log. */
function describeFailure(error: unknown, name: string): string {
  if (error instanceof AcoustidError) return describeAcoustidFailure(error)
  if (error instanceof Error && error.name === 'FpcalcError') return error.message
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `${name} took too long to answer.`
  }
  if (error instanceof TagHttpError && error.status === 429) {
    return `${name} is rate-limiting requests. Try again in a moment.`
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

  const getJson = async (
    url: string,
    headers: Record<string, string> = {},
    cooldown?: (ms: number) => void
  ): Promise<unknown> => {
    const response = await withProviderRetry(
      () =>
        request(url, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { Accept: 'application/json', ...headers }
        }),
      { onCooldown: cooldown }
    )
    if (!response.ok) {
      // AcoustID explains a refused request in the body even when the status is
      // 400. Reading it lets a wrong key say "check the key" instead of the
      // generic "could not be reached" a bare status would produce.
      if (response.status === 400) {
        let body: unknown = null
        try {
          body = await response.json()
        } catch {
          // A plain-text or empty 400 keeps the status-only failure below.
        }
        const detail = parseAcoustidError(body)
        if (detail) throw detail
      }
      throw new TagHttpError(response.status)
    }
    return (await response.json()) as unknown
  }

  // MusicBrainz is serialised across lookups, not just within one: two quick
  // edits would otherwise break the one-request-a-second rule and get the app
  // blocked. The chain never rejects, so one failure does not stall the next.
  // A 429 pushes the whole queue back as well as the request that saw it.
  let musicBrainzChain: Promise<unknown> = Promise.resolve()
  let musicBrainzLastAt = 0
  let musicBrainzResumeAt = 0

  const musicBrainzJson = (url: string): Promise<unknown> => {
    const run = musicBrainzChain.then(async () => {
      const wait = Math.max(
        0,
        musicBrainzLastAt + MUSICBRAINZ_GAP_MS - Date.now(),
        musicBrainzResumeAt - Date.now()
      )
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      musicBrainzLastAt = Date.now()
      return getJson(url, { 'User-Agent': MUSICBRAINZ_USER_AGENT }, (ms) => {
        musicBrainzResumeAt = Math.max(musicBrainzResumeAt, Date.now() + ms)
      })
    })
    musicBrainzChain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  const lookupItunes = async (query: TagLookupQuery): Promise<ProviderAnswer> => {
    try {
      const candidates = candidatesFromItunes(
        await itunesSchedule(() =>
          getJson(itunesUrl(query), {}, (ms) => scheduler.pause(ms))
        )
      )
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

  const lookupFingerprint = async (
    query: TagLookupQuery,
    filePath: string
  ): Promise<TagLookupResult> => {
    const empty = (message: string | null, ok = message === null): TagLookupResult => ({
      query,
      candidates: [],
      providers: [report('acoustid', 0, ok ? null : message)]
    })

    const key = options.getAcoustidKey?.() ?? null
    if (!key) {
      return empty(
        'Add your AcoustID key in Settings \u2192 Misc to match a file by its fingerprint.'
      )
    }
    if (!options.fingerprint) {
      return empty('Fingerprint lookup is not available in this build.')
    }

    let fingerprint: AudioFingerprint
    try {
      fingerprint = await options.fingerprint(filePath)
    } catch (error) {
      options.log.debug('fingerprint failed', { error })
      return empty(describeFailure(error, 'fpcalc'))
    }

    try {
      const matches = parseAcoustidLookup(
        await getJson(acoustidLookupUrl(key, fingerprint.durationSeconds, fingerprint.fingerprint))
      )
      // Three is enough to cover a compilation and a single edit without
      // turning a fingerprint into a MusicBrainz crawl.
      const chosen = matches.filter((match) => match.score >= MIN_FINGERPRINT_SCORE).slice(0, 3)
      const candidates: TagCandidate[] = []
      let lastFailure: unknown = null

      for (const match of chosen) {
        try {
          const recording = await musicBrainzJson(
            musicBrainzRecordingUrl(match.recordingId)
          )
          const candidate = candidateFromAcoustidRecording(recording, match.score)
          if (candidate) candidates.push(candidate)
        } catch (error) {
          lastFailure = error
          options.log.debug('musicbrainz recording lookup failed', {
            recordingId: match.recordingId,
            error
          })
        }
      }

      if (chosen.length > 0 && candidates.length === 0 && lastFailure !== null) {
        return {
          query,
          candidates: [],
          providers: [report('acoustid', 0, describeFailure(lastFailure, 'MusicBrainz'))]
        }
      }

      options.log.debug('fingerprint lookup answered', {
        matches: matches.length,
        chosen: chosen.length,
        candidates: candidates.length
      })
      return {
        query,
        candidates: rankCandidates(query, candidates),
        providers: [report('acoustid', candidates.length)]
      }
    } catch (error) {
      options.log.debug('acoustid lookup failed', { error })
      return {
        query,
        candidates: [],
        providers: [report('acoustid', 0, describeFailure(error, 'AcoustID'))]
      }
    }
  }

  return {
    lookupFingerprint,
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
