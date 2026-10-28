/**
 * File names for saved tracks.
 *
 * Kept in `shared/` (and free of `node:path`) so the rules can be pinned down by
 * `npm run smoke` without touching a disk. They matter more than they look: a
 * title like `AC/DC — Back in Black` must not create a folder called `AC`, and
 * `CON` is a legal album name that Windows refuses as a file.
 */

/** Windows device names, with or without an extension. */
const RESERVED = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9'
])

/** Leaves room for the artist/album folders and the extension under MAX_PATH. */
const MAX_PART_LENGTH = 96

/**
 * One path segment that Windows and every other platform will accept.
 *
 * Illegal characters become spaces rather than being deleted: `AC/DC` should read
 * as `AC DC`, not `ACDC`. Trailing dots and spaces are stripped because Windows
 * silently drops them, which would make the name on disk differ from the row.
 */
export function sanitizeFilePart(input: string, fallback: string): string {
  const cleaned = input
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, MAX_PART_LENGTH)
    .replace(/[. ]+$/g, '')
    .trim()

  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return fallback

  // `CON.txt` is just as reserved as `CON`, so the check looks at the stem.
  const stem = cleaned.split('.')[0]?.toUpperCase() ?? ''
  return RESERVED.has(stem) ? `_${cleaned}` : cleaned
}

export interface SaveNameInput {
  title: string
  artist: string | null
  album: string | null
}

/**
 * The folders and file stem for a saved track, relative to the download root.
 *
 * `Artist/Album/Title` when the album is known, `Artist/Title` otherwise. The
 * caller appends the extension and handles a name that is already taken.
 */
export function savePathParts(input: SaveNameInput): string[] {
  const artist = sanitizeFilePart(input.artist ?? '', 'Unknown artist')
  const title = sanitizeFilePart(input.title, 'Untitled')
  const album = input.album ? sanitizeFilePart(input.album, '') : ''
  return album ? [artist, album, title] : [artist, title]
}
