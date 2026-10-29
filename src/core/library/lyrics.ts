import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { isSyncedLyrics } from '@shared/lyrics'
import { loadMetadataParser } from './metadata'

/**
 * Finding lyrics that are already on disk.
 *
 * Two places can hold them: a tag inside the file, or a `.lrc` next to it. The
 * file is the source of truth, so this reads it on demand rather than trusting
 * a cached copy; the database only remembers what was found and the user's
 * timing correction.
 *
 * The formats differ in what they call the tag, and some of them hide the text
 * from `common.lyrics` (an ID3 `TXXX:USLT` written by ffmpeg, for one), so the
 * native frames are checked as well. That fallback is the same one the tag
 * writer uses to verify its own output.
 */

export interface FoundLyrics {
  text: string
  language: string | null
  synced: boolean
  /** Which of the two on-disk places it came from. */
  source: 'embedded' | 'sidecar'
}

type ParsedTags = Awaited<ReturnType<Awaited<ReturnType<typeof loadMetadataParser>>>>
type LyricsEntry = NonNullable<ParsedTags['common']['lyrics']>[number]

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text.length > 0 ? text : null
}

/**
 * LRC rebuilt from the parser's per-line timestamps.
 *
 * `music-metadata` parses a string lyric tag (Vorbis `LYRICS`, MP4 `©lyr`) into
 * `syncText` and leaves `text` as the lines with the timestamps stripped. The
 * timings are the part worth keeping, so they are put back into LRC.
 */
function lrcFromSyncText(
  lines: ReadonlyArray<{ timestamp?: number; text: string }>
): string {
  return lines
    .map((line) => {
      const centis = Math.max(0, Math.round((line.timestamp ?? 0) / 10))
      const minutes = Math.floor(centis / 6000)
      const seconds = Math.floor((centis % 6000) / 100)
      const fraction = centis % 100
      return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(
        fraction
      ).padStart(2, '0')}]${line.text}`
    })
    .join('\n')
}

function textOfEntry(entry: LyricsEntry): string | null {
  // `timeStampFormat` follows the ID3 spec: 0 is not synchronised, 1 is an MPEG
  // frame number, 2 is milliseconds. Only the last one can become a time; a
  // frame number needs the file's frame rate, which the tag does not carry, so
  // those lines are shown untimed rather than guessed at.
  if (entry.syncText && entry.syncText.length > 0) {
    if (entry.timeStampFormat === 2) return clean(lrcFromSyncText(entry.syncText))
    return clean(entry.syncText.map((line) => line.text).join('\n'))
  }
  return clean(entry.text)
}

/**
 * The file's own lyrics, from the parser's common view first and from the raw
 * frames second.
 */
export function embeddedLyricsOf(parsed: ParsedTags): FoundLyrics | null {
  for (const entry of parsed.common.lyrics ?? []) {
    const text = textOfEntry(entry)
    if (!text) continue
    return {
      text,
      language: clean(entry.language),
      synced: isSyncedLyrics(text),
      source: 'embedded'
    }
  }

  const raw = firstRawLyrics(parsed.native)
  if (!raw) return null
  return {
    text: raw.text,
    language: clean(raw.language),
    synced: isSyncedLyrics(raw.text),
    source: 'embedded'
  }
}

interface RawLyrics {
  text: string
  language: string | null
}

/**
 * The exact lyrics text from the container's own tag, whichever frame this
 * format uses. `TXXX:USLT` is included so a file written by ffmpeg earlier can
 * still be read.
 */
function firstRawLyrics(native: unknown): RawLyrics | null {
  if (!native || typeof native !== 'object') return null
  for (const frames of Object.values(native as Record<string, unknown>)) {
    if (!Array.isArray(frames)) continue
    for (const frame of frames) {
      if (!frame || typeof frame !== 'object') continue
      const { id, value } = frame as { id?: unknown; value?: unknown }
      if (typeof id !== 'string') continue
      if (id === 'USLT' || id === 'SYLT') {
        if (value && typeof value === 'object') {
          const { text, language } = value as { text?: unknown; language?: unknown }
          if (typeof text === 'string' && text.length > 0) {
            return { text, language: typeof language === 'string' ? language : null }
          }
        }
        continue
      }
      if (id === 'LYRICS' || id === 'UNSYNCEDLYRICS' || id === '©lyr' || id === 'TXXX:USLT') {
        if (typeof value === 'string' && value.length > 0) return { text: value, language: null }
      }
    }
  }
  return null
}

/**
 * The same lookup as `firstRawLyrics`, reduced to the text. Kept exported from
 * `tag-writer` for the write verification, which only cares about the value.
 */
export function rawLyricsOf(native: unknown): string | null {
  return firstRawLyrics(native)?.text ?? null
}

/**
 * Reads a `.lrc` beside the track.
 *
 * The name is the audio file's own base name, which is the convention every
 * player and every lyric downloader follows. A missing or empty sidecar is not
 * an error: most files have none.
 */
export async function sidecarLyricsOf(filePath: string): Promise<FoundLyrics | null> {
  const target = join(dirname(filePath), `${basename(filePath, extname(filePath))}.lrc`)
  let buffer: Buffer
  try {
    buffer = await readFile(target)
  } catch {
    return null
  }
  const text = clean(decodeLyricsFile(buffer))
  if (!text) return null
  return { text, language: null, synced: isSyncedLyrics(text), source: 'sidecar' }
}

/**
 * LRC files are plain text, but "plain" covers UTF-8 with or without a BOM and
 * UTF-16 in both byte orders. Windows editors still produce UTF-16 LE without a
 * BOM, and a file full of Bengali lyrics has no NUL bytes to spot it by, so the
 * guess uses the ASCII parts (timestamps, digits, brackets) and, failing that,
 * whether the bytes are valid UTF-8 at all.
 */
export function decodeLyricsFile(buffer: Buffer): string {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return buffer.subarray(3).toString('utf8')
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.subarray(2).toString('utf16le')
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return swap16(buffer.subarray(2)).toString('utf16le')
  }

  const guess = utf16Guess(buffer)
  if (guess === 'le') return evenBody(buffer).toString('utf16le')
  if (guess === 'be') return swap16(evenBody(buffer)).toString('utf16le')

  // No BOM and no UTF-16 pattern: it is UTF-8 unless the bytes are not valid
  // UTF-8 at all. An even-length file that fails that test is almost certainly
  // UTF-16 LE, because that is what the editors on this platform write.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    if (buffer.length % 2 === 0) return buffer.toString('utf16le')
    return buffer.toString('utf8')
  }
}

/** Drops a trailing half code unit, which a UTF-16 file should not have. */
function evenBody(buffer: Buffer): Buffer {
  return buffer.length % 2 === 1 ? buffer.subarray(0, buffer.length - 1) : buffer
}

function swap16(buffer: Buffer): Buffer {
  return Buffer.from(evenBody(buffer)).swap16()
}

/**
 * Which UTF-16 byte order the file is in, judged by where its NUL bytes are.
 *
 * In UTF-16 an ASCII character is `X 0` (LE) or `0 X` (BE); in UTF-8 there are
 * no NUL bytes in a lyrics file at all. A clear majority on one side is enough,
 * and requiring at least two of them keeps a single stray NUL in a UTF-8 file
 * from reinterpreting the whole thing.
 */
function utf16Guess(buffer: Buffer): 'le' | 'be' | null {
  const probe = buffer.subarray(0, Math.min(buffer.length, 512))
  let evenZeros = 0
  let oddZeros = 0
  for (let index = 0; index < probe.length; index += 2) {
    if (probe[index] === 0) evenZeros += 1
    if (probe[index + 1] === 0) oddZeros += 1
  }
  if (oddZeros >= 2 && oddZeros > evenZeros * 2) return 'le'
  if (evenZeros >= 2 && evenZeros > oddZeros * 2) return 'be'
  return null
}
