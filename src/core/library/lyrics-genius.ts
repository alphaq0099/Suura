import {
  GENIUS_PAGE_LIMIT,
  geniusCandidate,
  geniusHits,
  geniusSearchUrl,
  lyricsFromGeniusHtml
} from '@shared/genius'
import { rankLyricsCandidates } from '@shared/lyrics'
import type { LyricsCandidate } from '@shared/types'
import type { Logger } from '@core/logging/logger'
import {
  describeLyricsFailure,
  LyricsHttpError,
  type LyricsProvider,
  type LyricsProviderAnswer,
  type LyricsSchedule
} from './lyrics-lookup'
import { RequestScheduler } from '@core/scheduling/request-scheduler'

/**
 * Genius: the plain-text source.
 *
 * Their API needs a token and does not return lyrics, so this asks the public
 * search endpoint their site uses and reads the few best song pages. Only pages
 * on genius.com are fetched, whatever the payload says, and the search hits are
 * scored before any page is opened: three page requests per lookup is the
 * budget, not one per result.
 *
 * The pages are HTML, so the words are extracted by the pure parser in
 * `@shared/genius`. A page that no longer matches the shape simply contributes
 * nothing; the other provider still answers.
 */

const GENIUS_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Suura/0.1.0'

/** One deadline covers the search and every page it leads to. */
const GENIUS_LOOKUP_TIMEOUT_MS = 12_000

export interface GeniusProviderOptions {
  log: Logger
  /** Injected by the smoke test and the self-test so no request leaves the app. */
  fetch?: typeof fetch
  timeoutMs?: number
  /** Replaces the provider's own pacing; see `LyricsSchedule`. */
  schedule?: LyricsSchedule
}

/**
 * Genius is stricter than LRCLIB: one lookup at a time, a full second between
 * starts, and a little jitter so a batch does not march in lockstep. The budget
 * wraps the whole lookup, so the search and the three pages it opens still run
 * together rather than each paying the gap.
 */
const GENIUS_PACING = { maxConcurrent: 1, minGapMs: 1_000, jitterMs: 250 } as const

export function createGeniusProvider(options: GeniusProviderOptions): LyricsProvider {
  const request = options.fetch ?? fetch
  const timeoutMs = options.timeoutMs ?? GENIUS_LOOKUP_TIMEOUT_MS
  const scheduler = new RequestScheduler(GENIUS_PACING)
  const schedule: LyricsSchedule =
    options.schedule ?? (<T>(work: () => Promise<T>) => scheduler.schedule(work))

  return {
    name: 'genius',
    async lookup(query): Promise<LyricsProviderAnswer> {
      if (query.title.trim().length === 0) {
        return { candidates: [], ok: true, message: null }
      }

      try {
        return await schedule(async (): Promise<LyricsProviderAnswer> => {
          const signal = AbortSignal.timeout(timeoutMs)
          const search = await request(geniusSearchUrl(query), {
            signal,
            headers: { Accept: 'application/json', 'User-Agent': GENIUS_USER_AGENT }
          })
          if (!search.ok) throw new LyricsHttpError(search.status)

          const hits = geniusHits(await search.json())
          if (hits.length === 0) {
            options.log.debug('genius search found nothing')
            return { candidates: [], ok: true, message: null }
          }

          // Score before opening pages: the search endpoint is fuzzy, and the
          // top hit is nearly always the song, so three pages cover a miss.
          const shortlist = rankLyricsCandidates(
            query,
            hits.map((hit) => geniusCandidate(hit, 'pending'))
          ).slice(0, GENIUS_PAGE_LIMIT)
          if (shortlist.length === 0) {
            options.log.debug('genius hits were all too far from the query')
            return { candidates: [], ok: true, message: null }
          }

          const pages = await Promise.all(
            shortlist.map(async (candidate): Promise<LyricsCandidate | null> => {
              const url = candidate.url
              if (!url) return null
              try {
                const page = await request(url, {
                  signal,
                  headers: { Accept: 'text/html', 'User-Agent': GENIUS_USER_AGENT }
                })
                if (!page.ok) {
                  options.log.debug('genius page failed', { url, status: page.status })
                  return null
                }
                const text = lyricsFromGeniusHtml(await page.text())
                if (!text) {
                  options.log.debug('genius page had no lyrics', { url })
                  return null
                }
                return { ...candidate, text, synced: false }
              } catch (error) {
                options.log.debug('genius page threw', { url, error })
                return null
              }
            })
          )

          const candidates = rankLyricsCandidates(
            query,
            pages.filter((candidate): candidate is LyricsCandidate => candidate !== null)
          )
          options.log.debug('genius answered', { hits: hits.length, candidates: candidates.length })
          return { candidates, ok: true, message: null }
        })
      } catch (error) {
        options.log.debug('genius lookup failed', { error })
        return { candidates: [], ok: false, message: describeLyricsFailure('genius', error) }
      }
    }
  }
}
