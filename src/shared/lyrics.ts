/**
 * Reading LRC, the one lyric format every player agrees on.
 *
 * The same parser runs in the main process (to decide whether a file's lyrics
 * are timed) and in the renderer (to draw them), so there is exactly one answer
 * to "where does this line start". It is pure: no filesystem, no database.
 *
 * Only the subset players actually use is read: `[mm:ss.xx]` timestamps (two or
 * three fractional digits, `:` or `.` before them), several timestamps on one
 * line, and the `[offset:]` tag. Metadata tags (`[ar:]`, `[ti:]`, …) are not
 * lyrics and are skipped.
 *
 * The finder's payload parsing and scoring live here too. They are the same
 * kind of decision as the parser: pure rules that `npm run smoke` can pin down,
 * rather than a network test that can only say what the service answered today.
 */

import { confidenceOf, durationScore, normalizeMatchText, textSimilarity, titleVariants } from './auto-tag'
import { isGeniusUrl } from './genius'
import { TAG_TEXT_LIMITS } from './tags'
import type { LyricsCandidate, LyricsLookupQuery, LyricsProvider } from './types'

export interface LyricLine {
  /** Start of the line in the file's own timeline. */
  timeMs: number
  text: string
}

export interface ParsedLyrics {
  /** Timed lines, in time order. Empty for plain, untimed lyrics. */
  lines: LyricLine[]
  /** The file's own `[offset:]` tag in ms; positive means "later". */
  fileOffsetMs: number
}

/**
 * How far a user may shift the lyrics.
 *
 * Thirty seconds is far beyond any real drift between a file and its lyrics,
 * but it is a bounded number, and this value is written to the database from a
 * renderer message, so it still has to be bounded.
 */
export const LYRICS_OFFSET_MAX = 30_000
export const LYRICS_OFFSET_STEP = 500

const TIMESTAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const OFFSET_TAG = /^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/i

function fractionMs(digits: string | undefined): number {
  if (!digits) return 0
  if (digits.length === 3) return Number.parseInt(digits, 10)
  if (digits.length === 2) return Number.parseInt(digits, 10) * 10
  return Number.parseInt(digits, 10) * 100
}

export function parseLyrics(text: string): ParsedLyrics {
  const lines: LyricLine[] = []
  let fileOffsetMs = 0

  for (const raw of text.split(/\r?\n/)) {
    const offset = OFFSET_TAG.exec(raw)
    if (offset) {
      const value = Number.parseInt(offset[1] ?? '', 10)
      if (Number.isFinite(value)) {
        fileOffsetMs = Math.max(-LYRICS_OFFSET_MAX, Math.min(LYRICS_OFFSET_MAX, value))
      }
      continue
    }

    TIMESTAMP.lastIndex = 0
    const times: number[] = []
    let match: RegExpExecArray | null
    while ((match = TIMESTAMP.exec(raw)) !== null) {
      const minutes = Number.parseInt(match[1] ?? '', 10)
      const seconds = Number.parseInt(match[2] ?? '', 10)
      times.push((minutes * 60 + seconds) * 1000 + fractionMs(match[3]))
    }
    if (times.length === 0) continue

    // A line can carry several timestamps (`[00:10.00][00:20.00]chorus`), which
    // is how LRC repeats a chorus without repeating the words.
    const text = raw.replace(TIMESTAMP, '').trim()
    for (const timeMs of times) lines.push({ timeMs, text })
  }

  lines.sort((a, b) => a.timeMs - b.timeMs)
  return { lines, fileOffsetMs }
}

/** True when `text` carries at least one timestamp. */
export function isSyncedLyrics(text: string): boolean {
  return parseLyrics(text).lines.length > 0
}

/**
 * The line that is being sung at `positionMs`, or -1 before the first one.
 *
 * `offsetMs` is the user's correction: positive means the lyrics were early and
 * have been pushed later, so a line at 10 s becomes current at 10.5 s.
 */
export function activeLyricIndex(
  lines: readonly LyricLine[],
  positionMs: number,
  offsetMs = 0
): number {
  if (lines.length === 0) return -1
  const target = positionMs - offsetMs
  let low = 0
  let high = lines.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    const line = lines[mid]
    if (line && line.timeMs <= target) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found
}

/** "+0.5 s" / "−0.5 s" / "0.0 s", for the offset control. */
export function formatLyricsOffset(offsetMs: number): string {
  if (offsetMs === 0) return '0.0 s'
  const sign = offsetMs > 0 ? '+' : '−'
  return `${sign}${(Math.abs(offsetMs) / 1000).toFixed(1)} s`
}

/**
 * Bounds an offset arriving from the renderer.
 *
 * The value only ever reaches the database, but a stored offset outside this
 * range would make every line unreachable, so it is refused rather than clamped
 * into something the user did not ask for.
 */
export function sanitizeLyricsOffset(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    Math.abs(value) > LYRICS_OFFSET_MAX
  ) {
    throw new Error(`The lyrics offset must be a whole number of milliseconds within ±${LYRICS_OFFSET_MAX}.`)
  }
  return value
}

// ---- the finder ------------------------------------------------------------

/** Below this, a result is noise rather than a wrong guess worth showing. */
const LYRICS_MIN_SCORE = 0.4

/** How many matches the finder is given to choose from. */
export const LYRICS_CANDIDATE_LIMIT = 5

/** The same three signals the tag finder uses, for the same reasons. */
const LYRICS_WEIGHTS = {
  title: 0.55,
  artist: 0.25,
  duration: 0.2
} as const

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** LRCLIB stores a length in seconds; the rest of the app uses milliseconds. */
function secondsToMs(value: unknown): number | null {
  const seconds = asNumber(value)
  if (seconds === null || seconds <= 0) return null
  return Math.round(seconds * 1000)
}

/**
 * One row from LRCLIB's `/api/get` object or `/api/search` array.
 *
 * An instrumental has no lyrics to show, so it is not a candidate. When both
 * forms exist, the synced one wins: it is the same words with timing the player
 * can follow, and a plain copy would only be a second choice for the same song.
 */
export function candidateFromLrclib(value: unknown): LyricsCandidate | null {
  const record = asRecord(value)
  if (!record || record.instrumental === true) return null

  const title = asString(record.trackName)
  if (!title || title.length > 500) return null

  const text = asString(record.syncedLyrics) ?? asString(record.plainLyrics)
  if (!text || text.length > TAG_TEXT_LIMITS.lyrics) return null

  const id = asNumber(record.id)
  const artist = asString(record.artistName) ?? ''
  return {
    provider: 'lrclib',
    providerId: id !== null ? String(Math.trunc(id)) : `${artist}\u0000${title}`,
    title,
    artist,
    album: asString(record.albumName),
    durationMs: secondsToMs(record.duration),
    synced: isSyncedLyrics(text),
    text,
    instrumental: false,
    url: null,
    score: 0,
    confidence: 'weak'
  }
}

/**
 * The payload shapes the two endpoints return: one object for `/api/get`, an
 * array for `/api/search`. A payload that is neither simply contributes nothing.
 */
export function candidatesFromLrclib(payload: unknown): LyricsCandidate[] {
  const rows = Array.isArray(payload) ? payload : [payload]
  return rows
    .map(candidateFromLrclib)
    .filter((candidate): candidate is LyricsCandidate => candidate !== null)
}

/** The weighted match, with missing signals removed rather than scored zero. */
export function scoreLyricsCandidate(query: LyricsLookupQuery, candidate: LyricsCandidate): number {
  const variants = titleVariants(query)
  const title =
    variants.length > 0
      ? Math.max(...variants.map((variant) => textSimilarity(variant, candidate.title)))
      : 0

  const artist =
    query.artist && query.artist.trim().length > 0
      ? textSimilarity(query.artist, candidate.artist)
      : null
  const duration = durationScore(query.durationMs, candidate.durationMs)

  let total = title * LYRICS_WEIGHTS.title
  let weight = LYRICS_WEIGHTS.title
  if (artist !== null) {
    total += artist * LYRICS_WEIGHTS.artist
    weight += LYRICS_WEIGHTS.artist
  }
  if (duration !== null) {
    total += duration * LYRICS_WEIGHTS.duration
    weight += LYRICS_WEIGHTS.duration
  }

  return weight > 0 ? Math.max(0, Math.min(1, total / weight)) : 0
}

/**
 * Scores, drops the noise, merges duplicates and keeps the best few.
 *
 * Two copies of the same recording can come back from different releases, and
 * the provider id is the only stable answer to "is this the same row". When two
 * matches score the same, the synced one is more useful, so it comes first.
 */
export function rankLyricsCandidates(
  query: LyricsLookupQuery,
  candidates: readonly LyricsCandidate[],
  limit = LYRICS_CANDIDATE_LIMIT
): LyricsCandidate[] {
  const scored = candidates
    .map((candidate) => {
      const score = scoreLyricsCandidate(query, candidate)
      return { ...candidate, score, confidence: confidenceOf(score) }
    })
    .filter((candidate) => candidate.score >= LYRICS_MIN_SCORE)

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    if (left.synced !== right.synced) return left.synced ? -1 : 1
    return 0
  })

  const seen = new Set<string>()
  const out: LyricsCandidate[] = []
  for (const candidate of scored) {
    const key = [
      candidate.provider,
      candidate.providerId,
      normalizeMatchText(candidate.title),
      normalizeMatchText(candidate.artist),
      normalizeMatchText(candidate.album)
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(candidate)
    if (out.length >= limit) break
  }
  return out
}

/**
 * Bounds a match arriving back from the renderer.
 *
 * The candidate is a proposal the main process produced, but it crosses the
 * bridge, so its text is checked before it is stored or written into a file.
 * `synced` is recomputed from the text rather than trusted: the panel follows
 * timestamps, and a flag that disagrees with them would only mislead it.
 */
export function sanitizeLyricsCandidate(value: unknown): LyricsCandidate {
  const record = asRecord(value)
  if (!record) throw new Error('Malformed lyrics match.')
  const provider = record.provider
  if (provider !== 'lrclib' && provider !== 'genius') throw new Error('Unknown lyrics provider.')

  const providerId = asString(record.providerId)
  if (!providerId || providerId.length > 200) throw new Error('The lyrics match has no id.')

  const title = asString(record.title)
  if (!title) throw new Error('The lyrics match has no title.')
  if (title.length > 500) throw new Error('The lyrics match title is too long.')

  const artist = asString(record.artist) ?? ''
  if (artist.length > 500) throw new Error('The lyrics match artist is too long.')

  const album = asString(record.album)
  if (album && album.length > 500) throw new Error('The lyrics match album is too long.')

  let durationMs: number | null = null
  if (record.durationMs !== null && record.durationMs !== undefined) {
    const raw = record.durationMs
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 86_400_000) {
      throw new Error('The lyrics match has an invalid length.')
    }
    durationMs = Math.round(raw)
  }

  const rawText = asString(record.text)
  if (!rawText) throw new Error('The lyrics match has no lyrics.')
  if (rawText.length > TAG_TEXT_LIMITS.lyrics) {
    throw new Error(`The lyrics are too long (${TAG_TEXT_LIMITS.lyrics} characters at most).`)
  }
  const text = rawText.replace(/\r\n?/g, '\n')

  const rawScore = asNumber(record.score)
  const score = rawScore === null ? 0 : Math.max(0, Math.min(1, rawScore))
  const confidence =
    record.confidence === 'strong' || record.confidence === 'likely' || record.confidence === 'weak'
      ? record.confidence
      : 'weak'

  // A provider page is only useful if it is really that provider's page: the
  // link is opened in the browser, so an arbitrary URL from the renderer is
  // not something to pass along.
  let url: string | null = null
  if (provider === 'genius') {
    const rawUrl = asString(record.url)
    if (!rawUrl || rawUrl.length > 500 || !isGeniusUrl(rawUrl)) {
      throw new Error('The lyrics match has no Genius page.')
    }
    url = rawUrl
  }

  return {
    provider: provider as LyricsProvider,
    providerId,
    title,
    artist,
    album,
    durationMs,
    synced: isSyncedLyrics(text),
    text,
    instrumental: false,
    url,
    score,
    confidence
  }
}
