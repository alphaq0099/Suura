import type { TrackTagFields } from './types'

/**
 * Bounds for a tag edit, as the renderer sends it.
 *
 * The renderer is not trusted with the shape of the write: a runaway lyric or a
 * year of `99999` would be written into the file itself, and the file is the
 * source of truth afterwards. Kept pure so the limits are pinned down in
 * `npm run smoke`.
 *
 * A key that is absent stays absent ("leave it alone"), `null` or blank text
 * clears the field, and a number is always a whole number in range.
 */
export const TAG_TEXT_LIMITS = {
  title: 500,
  artist: 500,
  albumArtist: 500,
  album: 500,
  genre: 200,
  lyrics: 100_000
} as const

export type TagTextField = keyof typeof TAG_TEXT_LIMITS

export const TAG_POSITION_FIELDS = ['trackNo', 'trackTotal', 'discNo', 'discTotal'] as const

export const TAG_POSITION_MAX = 999
export const TAG_YEAR_MIN = 1000
export const TAG_YEAR_MAX = 3000

/**
 * The shape of an artwork cache key.
 *
 * Keys are hashes the artwork service generated, and they are used as file
 * names, so nothing else may get through: a key is 40 hex characters and a
 * known image extension, exactly.
 */
export const ARTWORK_KEY_PATTERN = /^[0-9a-f]{40}\.(jpg|png|webp|gif|bmp)$/

export function sanitizeArtworkKey(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error('Invalid artwork key.')
  const key = value.trim()
  if (key.length === 0) return null
  if (!ARTWORK_KEY_PATTERN.test(key)) throw new Error('Invalid artwork key.')
  return key
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface SanitizeTagOptions {
  /**
   * Allow a patch with no text fields at all.
   *
   * The artwork picker can change only the cover, and that is still a write the
   * user asked for. Every other caller keeps the stricter rule.
   */
  allowEmpty?: boolean
}

export function sanitizeTagFields(value: unknown, options: SanitizeTagOptions = {}): TrackTagFields {
  if (!isPlainObject(value)) throw new Error('Malformed tag fields.')
  const fields: TrackTagFields = {}
  let count = 0

  for (const [name, limit] of Object.entries(TAG_TEXT_LIMITS) as Array<[TagTextField, number]>) {
    if (!(name in value)) continue
    const raw = value[name]
    if (raw === null) {
      fields[name] = null
      count += 1
      continue
    }
    if (typeof raw !== 'string') throw new Error(`Invalid ${name} tag.`)
    if (raw.length > limit) {
      throw new Error(`The ${name} tag is too long (${limit} characters at most).`)
    }
    // CRLF would be written into the file as-is, and every reader would then
    // disagree about the number of lines.
    const text = raw.replace(/\r\n?/g, '\n').trim()
    fields[name] = text.length > 0 ? text : null
    count += 1
  }

  for (const name of TAG_POSITION_FIELDS) {
    if (!(name in value)) continue
    const raw = value[name]
    if (raw === null) {
      fields[name] = null
      count += 1
      continue
    }
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > TAG_POSITION_MAX) {
      throw new Error(`The ${name} tag must be a whole number from 1 to ${TAG_POSITION_MAX}.`)
    }
    fields[name] = raw
    count += 1
  }

  if ('year' in value) {
    const raw = value.year
    if (raw === null) {
      fields.year = null
    } else {
      if (
        typeof raw !== 'number' ||
        !Number.isInteger(raw) ||
        raw < TAG_YEAR_MIN ||
        raw > TAG_YEAR_MAX
      ) {
        throw new Error(
          `The year tag must be a whole number from ${TAG_YEAR_MIN} to ${TAG_YEAR_MAX}.`
        )
      }
      fields.year = raw
    }
    count += 1
  }

  if (count === 0 && !options.allowEmpty) throw new Error('No tag fields were given.')
  return fields
}
