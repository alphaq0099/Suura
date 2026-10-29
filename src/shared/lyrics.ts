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
 */

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
