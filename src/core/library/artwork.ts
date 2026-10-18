import { createHash } from 'node:crypto'
import { loadMetadataParser } from './metadata'

/**
 * Embedded cover art, extracted from a file's tags.
 *
 * Reading the picture is a separate concern from reading the tags: a scan wants
 * duration and text and nothing else (`skipCovers: true`), while artwork is only
 * needed for the handful of albums that are actually on screen. That is why this
 * is a second parse of the same file rather than another field on
 * `ExtractedMetadata`.
 */
export interface EmbeddedArtwork {
  data: Uint8Array
  mime: string
}

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp'
}

/** Null for a format we would not know how to serve or decode. */
export function extensionForMime(mime: string): string | null {
  return EXTENSION_BY_MIME[mime.trim().toLowerCase()] ?? null
}

/**
 * A cache file name: the content hash plus an extension.
 *
 * Content addressing is doing two jobs here. Identical covers collapse to one
 * file no matter how many tracks embed them, and the hash can be served with
 * `immutable` caching because the bytes behind a key can never change.
 */
export function artworkKeyFor(data: Uint8Array, extension: string): string {
  return `${createHash('sha1').update(data).digest('hex')}${extension}`
}

/**
 * Returns the first embedded picture, or null when the file has none.
 *
 * Throws if the file cannot be parsed at all; callers treat that as "no
 * artwork" rather than letting a single bad file break the view.
 */
export async function extractArtwork(filePath: string): Promise<EmbeddedArtwork | null> {
  const parseFile = await loadMetadataParser()
  const parsed = await parseFile(filePath, { skipCovers: false, duration: false })
  const picture = parsed.common.picture?.[0]
  if (!picture || picture.data.length === 0) return null
  return { data: picture.data, mime: picture.format }
}
