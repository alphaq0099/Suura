import type { TagCandidate, TagLookupQuery, TagProvider } from './types'

/**
 * Scoring a tag lookup, and turning provider payloads into candidates.
 *
 * Everything here is pure so the rules can be pinned down in `npm run smoke`:
 * "which of these two matches is better" is the whole feature, and a network
 * test could only ever say that it happened to answer today.
 *
 * The three signals are the ones a listener would use: the title, who sings it,
 * and how long it is. Duration carries real weight because it is the one field
 * YouTube cannot mangle: a title can gain "(Official Video)" and an artist can
 * gain "VEVO", but 3:32 is 3:32.
 */

/** Weights before the available signals are renormalised. */
const WEIGHTS = {
  title: 0.55,
  artist: 0.25,
  duration: 0.2
} as const

/** Below this, a result is noise rather than a wrong guess worth showing. */
const MIN_SCORE = 0.4

/** How many matches the review dialog is given to choose from. */
export const TAG_CANDIDATE_LIMIT = 5

const COMBINING_MARKS = /\p{Mn}+/gu

/**
 * Folds the noise a title or artist accumulates into one comparable form.
 *
 * Bracketed asides go first: "(Official Video)", "[HD]", "(feat. X)" and the
 * like are never part of the song's name. Diacritics are dropped so "Beyoncé"
 * and "Beyonce" match, and `&` becomes "and" because providers disagree about
 * which one they store.
 */
export function normalizeMatchText(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\((?:[^()]*)\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/** Levenshtein distance, with the two-row form so long titles stay cheap. */
export function editDistance(left: string, right: string): number {
  if (left === right) return 0
  if (left.length === 0) return right.length
  if (right.length === 0) return left.length

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  let current = new Array<number>(right.length + 1)

  for (let i = 1; i <= left.length; i += 1) {
    current[0] = i
    const code = left.charCodeAt(i - 1)
    for (let j = 1; j <= right.length; j += 1) {
      const cost = code === right.charCodeAt(j - 1) ? 0 : 1
      const deletion = (previous[j] ?? 0) + 1
      const insertion = (current[j - 1] ?? 0) + 1
      const substitution = (previous[j - 1] ?? 0) + cost
      current[j] = Math.min(deletion, insertion, substitution)
    }
    const swap = previous
    previous = current
    current = swap
  }

  return previous[right.length] ?? 0
}

/** Shared words over the average word count: word order does not matter. */
function tokenDice(left: string, right: string): number {
  const a = left.split(' ').filter(Boolean)
  const b = right.split(' ').filter(Boolean)
  if (a.length === 0 || b.length === 0) return 0

  const counts = new Map<string, number>()
  for (const token of a) counts.set(token, (counts.get(token) ?? 0) + 1)

  let shared = 0
  for (const token of b) {
    const count = counts.get(token) ?? 0
    if (count > 0) {
      shared += 1
      counts.set(token, count - 1)
    }
  }

  return (2 * shared) / (a.length + b.length)
}

/**
 * 0..1. Character distance catches a typo; word overlap catches a reordering
 * or a word added in the middle. The better of the two is the honest answer,
 * because either one can be the reason two names mean the same song.
 */
export function textSimilarity(left: string | null, right: string | null): number {
  const a = normalizeMatchText(left)
  const b = normalizeMatchText(right)
  if (a.length === 0 || b.length === 0) return 0
  if (a === b) return 1

  const characters = 1 - editDistance(a, b) / Math.max(a.length, b.length)
  return Math.max(0, Math.min(1, Math.max(characters, tokenDice(a, b))))
}

/**
 * The title as it might be written, most literal first.
 *
 * A file saved from YouTube often carries "Artist - Song (Official Video)" as
 * its title while the artist field holds the channel name, so comparing that
 * whole string to a provider's "Song" scores badly for the right file. Trying
 * the tail after the artist prefix, and after the last dash, is what makes the
 * finder useful on exactly the files this milestone exists to fix.
 */
export function titleVariants(query: TagLookupQuery): string[] {
  const variants = [query.title]
  const artist = normalizeMatchText(query.artist)
  const title = normalizeMatchText(query.title)

  if (artist.length > 0 && title.startsWith(`${artist} `)) {
    variants.push(title.slice(artist.length + 1))
  }

  const dash = query.title.lastIndexOf(' - ')
  if (dash > 0) variants.push(query.title.slice(dash + 3))

  return variants.filter(
    (variant, index) => variant.trim().length > 0 && variants.indexOf(variant) === index
  )
}

/** 0..1, or null when either side has no length to compare. */
export function durationScore(left: number | null, right: number | null): number | null {
  if (left === null || right === null || left <= 0 || right <= 0) return null
  const delta = Math.abs(left - right)
  if (delta <= 2_000) return 1
  if (delta <= 5_000) return 0.8
  if (delta <= 10_000) return 0.5
  if (delta <= 20_000) return 0.2
  return 0
}

/** The weighted match, with missing signals removed rather than scored zero. */
export function scoreCandidate(query: TagLookupQuery, candidate: TagCandidate): number {
  const variants = titleVariants(query)
  const title =
    variants.length > 0
      ? Math.max(...variants.map((variant) => textSimilarity(variant, candidate.title)))
      : 0

  const artist = query.artist
    ? Math.max(
        textSimilarity(query.artist, candidate.artist),
        textSimilarity(query.artist, candidate.albumArtist)
      )
    : null

  const duration = durationScore(query.durationMs, candidate.durationMs)

  let total = title * WEIGHTS.title
  let weight = WEIGHTS.title
  if (artist !== null) {
    total += artist * WEIGHTS.artist
    weight += WEIGHTS.artist
  }
  if (duration !== null) {
    total += duration * WEIGHTS.duration
    weight += WEIGHTS.duration
  }

  return weight > 0 ? Math.max(0, Math.min(1, total / weight)) : 0
}

export function confidenceOf(score: number): TagCandidate['confidence'] {
  if (score >= 0.85) return 'strong'
  if (score >= 0.6) return 'likely'
  return 'weak'
}

function providerOrder(provider: TagProvider): number {
  // A fingerprint match outranks a text match on a tie: the audio itself is
  // stronger evidence than a title that may have been typed by a uploader.
  if (provider === 'acoustid') return -1
  return provider === 'itunes' ? 0 : 1
}

/**
 * Scores, drops the noise, merges duplicates and keeps the best few.
 *
 * The same song often comes back twice, once per provider and once per release.
 * The key is the text a listener would see, not the provider id, because a
 * deluxe edition and the original are the same answer to "what is this file".
 */
export function rankCandidates(
  query: TagLookupQuery,
  candidates: readonly TagCandidate[],
  limit = TAG_CANDIDATE_LIMIT
): TagCandidate[] {
  const scored = candidates
    .map((candidate) => {
      // An AcoustID answer carries its own score, measured against the audio.
      // Re-scoring it against the (probably wrong) text tags would throw away
      // the one signal that made the fingerprint lookup worth doing.
      const score =
        candidate.provider === 'acoustid'
          ? Math.max(0, Math.min(1, candidate.score))
          : scoreCandidate(query, candidate)
      return { ...candidate, score, confidence: confidenceOf(score) }
    })
    .filter((candidate) => candidate.score >= MIN_SCORE)

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    return providerOrder(left.provider) - providerOrder(right.provider)
  })

  const seen = new Set<string>()
  const out: TagCandidate[] = []
  for (const candidate of scored) {
    const key = [
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

// ---- provider payloads ----------------------------------------------------

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

function positiveInteger(value: unknown): number | null {
  const number = asNumber(value)
  if (number === null) return null
  const rounded = Math.trunc(number)
  return rounded > 0 ? rounded : null
}

/** `3/12` and `"3"` both mean track three. */
function trackNumber(value: unknown): number | null {
  if (typeof value === 'number') return positiveInteger(value)
  if (typeof value !== 'string') return null
  const match = /^(\d+)/.exec(value.trim())
  return match?.[1] ? positiveInteger(Number(match[1])) : null
}

function yearOf(value: string | null): number | null {
  if (!value) return null
  const match = /^(\d{4})/.exec(value.trim())
  if (!match?.[1]) return null
  const year = Number(match[1])
  return year >= 1000 && year <= 3000 ? year : null
}

/** The 100px URL iTunes always sends, asked for at 600px instead. */
function largerItunesArtwork(url: string | null): string | null {
  if (!url) return null
  return url.replace(/\/\d+x\d+bb\./, '/600x600bb.')
}

function emptyCandidate(provider: TagProvider): TagCandidate {
  return {
    provider,
    providerId: '',
    title: '',
    artist: '',
    albumArtist: null,
    album: null,
    year: null,
    genre: null,
    trackNo: null,
    trackTotal: null,
    discNo: null,
    discTotal: null,
    durationMs: null,
    artworkUrl: null,
    score: 0,
    confidence: 'weak'
  }
}

/**
 * One row of iTunes' `results` array. A result without a title or an artist is
 * skipped: it cannot be shown in the review dialog, let alone applied.
 */
export function candidateFromItunes(value: unknown): TagCandidate | null {
  const result = asRecord(value)
  if (!result) return null

  const title = asString(result.trackName)
  const artist = asString(result.artistName)
  if (!title || !artist) return null

  const candidate = emptyCandidate('itunes')
  return {
    ...candidate,
    providerId: String(asNumber(result.trackId) ?? `${artist}\u0000${title}`),
    title,
    artist,
    albumArtist: asString(result.collectionArtistName) ?? artist,
    album: asString(result.collectionName),
    year: yearOf(asString(result.releaseDate)),
    genre: asString(result.primaryGenreName),
    trackNo: positiveInteger(result.trackNumber),
    trackTotal: positiveInteger(result.trackCount),
    discNo: positiveInteger(result.discNumber),
    discTotal: positiveInteger(result.discCount),
    durationMs: positiveInteger(result.trackTimeMillis),
    artworkUrl: largerItunesArtwork(asString(result.artworkUrl100))
  }
}

export function candidatesFromItunes(payload: unknown): TagCandidate[] {
  const body = asRecord(payload)
  const results = Array.isArray(body?.results) ? body.results : []
  return results
    .map(candidateFromItunes)
    .filter((candidate): candidate is TagCandidate => candidate !== null)
}

/** MusicBrainz credits join their names with the credit's own punctuation. */
function creditName(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  let name = ''
  for (const entry of value) {
    const credit = asRecord(entry)
    const part = asString(credit?.name) ?? asString(asRecord(credit?.artist)?.name)
    if (!part) continue
    name += part
    // The joinphrase carries its own spacing (" & ", " feat. "), so it is not
    // trimmed the way a name is: trimming turns "A & B" into "A&B".
    const join = typeof credit?.joinphrase === 'string' ? credit.joinphrase : ''
    name += join
  }
  return name.trim().length > 0 ? name.trim() : null
}

function releaseArtwork(releaseId: string | null): string | null {
  return releaseId ? `https://coverartarchive.org/release/${releaseId}/front-500` : null
}

/**
 * One recording. MusicBrainz nests the album facts under the first release,
 * which is the closest thing its response has to "the album this is on".
 */
export function candidateFromMusicBrainz(value: unknown): TagCandidate | null {
  const recording = asRecord(value)
  if (!recording) return null

  const title = asString(recording.title)
  const artist = creditName(recording['artist-credit'])
  if (!title || !artist) return null

  const releases = Array.isArray(recording.releases) ? recording.releases : []
  const release = asRecord(releases[0])
  const media = Array.isArray(release?.media) ? release.media : []
  const medium = asRecord(media[0])
  const tracks = Array.isArray(medium?.track) ? medium.track : []
  const firstTrack = asRecord(tracks[0])

  const candidate = emptyCandidate('musicbrainz')
  return {
    ...candidate,
    providerId: asString(recording.id) ?? `${artist}\u0000${title}`,
    title,
    artist,
    albumArtist: artist,
    album: asString(release?.title),
    year: yearOf(asString(release?.date)),
    genre: null,
    trackNo: trackNumber(firstTrack?.number),
    trackTotal: positiveInteger(medium?.['track-count']) ?? positiveInteger(release?.['track-count']),
    discNo: positiveInteger(medium?.position),
    discTotal: media.length > 0 ? media.length : null,
    durationMs: positiveInteger(recording.length),
    artworkUrl: releaseArtwork(asString(release?.id))
  }
}

export function candidatesFromMusicBrainz(payload: unknown): TagCandidate[] {
  const body = asRecord(payload)
  const recordings = Array.isArray(body?.recordings) ? body.recordings : []
  return recordings
    .map(candidateFromMusicBrainz)
    .filter((candidate): candidate is TagCandidate => candidate !== null)
}

// ---- fingerprint (AcoustID → MusicBrainz) ---------------------------------

/** The first genre name in a MusicBrainz genre list. */
function firstGenre(value: unknown): string | null {
  for (const entry of Array.isArray(value) ? value : []) {
    const name = asString(asRecord(entry)?.name)
    if (name) return name
  }
  return null
}

/**
 * One MusicBrainz recording that AcoustID named, with AcoustID's score.
 *
 * A recording lookup returns every release it appears on, each with its own
 * media and tracks. The release whose medium actually lists this recording is
 * the one that can supply a track number; the first release is the fallback
 * when MusicBrainz did not inline the track list. `score` stays AcoustID's own,
 * because it measured the audio rather than comparing text.
 */
export function candidateFromAcoustidRecording(
  value: unknown,
  score: number
): TagCandidate | null {
  const recording = asRecord(value)
  if (!recording) return null

  const title = asString(recording.title)
  const artist = creditName(recording['artist-credit'])
  if (!title || !artist) return null

  const recordingId = asString(recording.id)
  const releases = Array.isArray(recording.releases) ? recording.releases : []
  let release: Record<string, unknown> | null = null
  let medium: Record<string, unknown> | null = null
  let track: Record<string, unknown> | null = null
  let mediaCount = 0

  for (const entry of releases) {
    const candidate = asRecord(entry)
    if (!candidate) continue
    const media = Array.isArray(candidate.media) ? candidate.media : []
    for (const mediumEntry of media) {
      const candidateMedium = asRecord(mediumEntry)
      if (!candidateMedium) continue
      const tracks = Array.isArray(candidateMedium.track) ? candidateMedium.track : []
      for (const trackEntry of tracks) {
        const candidateTrack = asRecord(trackEntry)
        const trackRecordingId = asString(asRecord(candidateTrack?.recording)?.id)
        if (!candidateTrack || !recordingId || trackRecordingId !== recordingId) continue
        release = candidate
        medium = candidateMedium
        track = candidateTrack
        break
      }
      if (track) break
    }
    if (track) break
  }

  if (!release) {
    release = asRecord(releases[0])
    const media = Array.isArray(release?.media) ? release.media : []
    mediaCount = media.length
    medium = asRecord(media[0])
    const tracks = Array.isArray(medium?.track) ? medium.track : []
    track = asRecord(tracks[0])
  } else {
    mediaCount = Array.isArray(release.media) ? release.media.length : 0
  }

  const releaseGroup = asRecord(release?.['release-group'])
  const clamped = Math.max(0, Math.min(1, score))

  return {
    provider: 'acoustid',
    providerId: recordingId ?? `${artist}\u0000${title}`,
    title,
    artist,
    albumArtist: artist,
    album: asString(release?.title),
    year: yearOf(asString(release?.date)),
    genre: firstGenre(recording.genres) ?? firstGenre(releaseGroup?.genres),
    trackNo: trackNumber(track?.number) ?? positiveInteger(track?.position),
    trackTotal:
      positiveInteger(medium?.['track-count']) ?? positiveInteger(release?.['track-count']),
    discNo: positiveInteger(medium?.position),
    discTotal: mediaCount > 0 ? mediaCount : null,
    durationMs: positiveInteger(recording.length),
    artworkUrl: releaseArtwork(asString(release?.id)),
    score: clamped,
    confidence: confidenceOf(clamped)
  }
}
