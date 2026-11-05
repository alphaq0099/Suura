/**
 * AcoustID: turning a Chromaprint fingerprint into a MusicBrainz recording.
 *
 * The lookup is the only way to name a file whose tags are unusable — a title
 * of "track01" and an artist of "Unknown" give the text search nothing to work
 * with, while the audio itself is unchanged. Everything here is pure so the
 * request shape and the answer parser are pinned down by `npm run smoke`
 * instead of by whichever service happened to answer today.
 *
 * An AcoustID application key is required and is the user's to supply: the
 * service asks each client to register, and an app that shipped a shared key
 * would be rate-limited into uselessness.
 */

export const ACOUSTID_LOOKUP_URL = 'https://api.acoustid.org/v2/lookup'

/** The API rejects the request with this code when the key is wrong or gone. */
export const ACOUSTID_INVALID_API_KEY = 4

/** AcoustID refuses a fingerprint it cannot read. */
export const ACOUSTID_INVALID_FINGERPRINT = 1

/** What fpcalc reports for one file. */
export interface AudioFingerprint {
  /** Whole-file length in seconds, as fpcalc measured it. */
  durationSeconds: number
  /** The base64 Chromaprint fingerprint. */
  fingerprint: string
}

/** One recording the service matched, with the score it gave it. */
export interface AcoustidMatch {
  /** The MusicBrainz recording id. */
  recordingId: string
  /** 0..1, AcoustID's own confidence in the fingerprint match. */
  score: number
  title: string | null
  artists: string[]
}

/** A key order for the Settings field; null when the text is not a key. */
export function normalizeAcoustidKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  // AcoustID issues short alphanumeric application keys. Anything with spaces
  // or punctuation is a paste accident, not a key.
  return /^[A-Za-z0-9]{8,64}$/.test(trimmed) ? trimmed : null
}

/**
 * The lookup request.
 *
 * `duration` is the whole file length fpcalc reported, not the fingerprint
 * window: AcoustID compares it with the recording length as one more signal,
 * so a rounded-down value is the honest one.
 */
export function acoustidLookupUrl(
  key: string,
  durationSeconds: number,
  fingerprint: string
): string {
  const url = new URL(ACOUSTID_LOOKUP_URL)
  url.searchParams.set('client', key)
  url.searchParams.set('duration', String(Math.max(1, Math.round(durationSeconds))))
  url.searchParams.set('fingerprint', fingerprint)
  url.searchParams.set('meta', 'recordings+releases')
  url.searchParams.set('format', 'json')
  return url.toString()
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

/** The service answered, but with an error object rather than results. */
export class AcoustidError extends Error {
  constructor(
    readonly code: number | null,
    message: string
  ) {
    super(message)
    this.name = 'AcoustidError'
  }
}

/**
 * Reads the error object AcoustID puts in a refused response.
 *
 * The service answers a bad key with HTTP 400 and a JSON body, not only with an
 * error status, so the caller has to read the body to tell "your key is wrong"
 * apart from "the service is down".
 */
export function parseAcoustidError(payload: unknown): AcoustidError | null {
  const body = asRecord(payload)
  if (asString(body?.status) !== 'error') return null
  const detail = asRecord(body?.error)
  const code = typeof detail?.code === 'number' && Number.isFinite(detail.code) ? detail.code : null
  const message = asString(detail?.message) ?? 'AcoustID returned an error.'
  return new AcoustidError(code, message)
}

/** A sentence for the review dialog, never the raw service code. */
export function describeAcoustidFailure(error: AcoustidError): string {
  if (error.code === ACOUSTID_INVALID_API_KEY) {
    return 'The AcoustID key was refused. Check it in Settings \u2192 Misc.'
  }
  if (error.code === ACOUSTID_INVALID_FINGERPRINT) {
    return 'AcoustID could not read this file\u2019s fingerprint. Try the text search instead.'
  }
  return 'AcoustID could not answer. Try again in a moment.'
}

/**
 * Reads the lookup payload into one match per MusicBrainz recording.
 *
 * A recording can appear in several results; the best score wins because the
 * score belongs to the fingerprint, not to the release it was found on. A
 * payload without recordings is an empty answer, not an error.
 */
export function parseAcoustidLookup(payload: unknown): AcoustidMatch[] {
  const body = asRecord(payload)
  const status = asString(body?.status)
  if (status !== null && status !== 'ok') {
    throw parseAcoustidError(payload) ?? new AcoustidError(null, 'AcoustID returned an error.')
  }

  const results = Array.isArray(body?.results) ? body.results : []
  const byRecording = new Map<string, AcoustidMatch>()

  for (const entry of results) {
    const result = asRecord(entry)
    if (!result) continue
    const score =
      typeof result.score === 'number' && Number.isFinite(result.score)
        ? Math.max(0, Math.min(1, result.score))
        : 0
    const recordings = Array.isArray(result.recordings) ? result.recordings : []

    for (const value of recordings) {
      const recording = asRecord(value)
      const recordingId = asString(recording?.id)
      if (!recordingId) continue

      const artists: string[] = []
      for (const entryArtist of Array.isArray(recording?.artists) ? recording.artists : []) {
        const name = asString(asRecord(entryArtist)?.name)
        if (name && !artists.includes(name)) artists.push(name)
      }

      const previous = byRecording.get(recordingId)
      if (previous && previous.score >= score) continue
      byRecording.set(recordingId, {
        recordingId,
        score,
        title: asString(recording?.title),
        artists
      })
    }
  }

  return [...byRecording.values()].sort((left, right) => right.score - left.score)
}
