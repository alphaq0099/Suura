import { basename, extname } from 'node:path'

/**
 * The only place that knows about the tag-reading library.
 *
 * `music-metadata` is ESM-only. The main process bundle is CommonJS, so the
 * import is dynamic and cached: that works identically from a plain Node script
 * (tools/smoke.ts) and from inside Electron's main process, and it isolates the
 * swap to one function if the dependency ever changes.
 */
type ParseFile = (typeof import('music-metadata'))['parseFile']

let parserPromise: Promise<ParseFile> | null = null

/**
 * Loads the tag parser. Exported so `artwork.ts` can reuse the same cached
 * dynamic import rather than repeating the ESM/CJS dance.
 */
export function loadMetadataParser(): Promise<ParseFile> {
  parserPromise ??= import('music-metadata').then((mod) => mod.parseFile)
  return parserPromise
}

export interface ExtractedMetadata {
  title: string
  artist: string | null
  albumArtist: string | null
  album: string | null
  trackNo: number | null
  discNo: number | null
  /** The second half of `3/12`, kept so a tag edit does not drop it. */
  trackTotal: number | null
  discTotal: number | null
  year: number | null
  genre: string | null
  durationMs: number | null
  codec: string | null
  bitrateKbps: number | null
  sampleRate: number | null
  channels: number | null
  /** A YouTube video this file was saved from, when its tags say so. */
  originKind: 'youtube' | null
  originId: string | null
}

/** A comment that is exactly a YouTube watch URL, as yt-dlp writes it. */
const YOUTUBE_WATCH_URL =
  /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{11})(?:[&?#].*)?$/

function clean(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function titleFromFilename(filePath: string): string {
  return basename(filePath, extname(filePath)).trim() || basename(filePath)
}

/**
 * Reads tags for one file. Throws if the file cannot be parsed; the scanner
 * catches and counts that as a failure rather than aborting the whole scan.
 */
export async function extractMetadata(filePath: string): Promise<ExtractedMetadata> {
  const parseFile = await loadMetadataParser()
  const parsed = await parseFile(filePath, { duration: true, skipCovers: true })

  const common = parsed.common
  const format = parsed.format

  const artist = clean(common.artist) ?? clean(common.artists?.join(', '))
  const genre = common.genre?.map((entry) => entry.trim()).filter(Boolean).join(', ')
  // MP3 writers (ffmpeg included) put a comment in `TXXX:comment`, which
  // music-metadata does not surface as `common.comment`. Checking the native
  // frames too is what keeps a saved MP3 linked to its video across a rescan.
  const originId = youtubeOriginOf(common.comment) ?? youtubeOriginOfNative(parsed.native)

  return {
    title: clean(common.title) ?? titleFromFilename(filePath),
    artist,
    // A missing album-artist falls back to the track artist, which is what every
    // other player does and avoids "Unknown Artist" appearing next to real names.
    albumArtist: clean(common.albumartist) ?? artist,
    album: clean(common.album),
    trackNo: common.track?.no ?? null,
    discNo: common.disk?.no ?? null,
    trackTotal: common.track?.of ?? null,
    discTotal: common.disk?.of ?? null,
    year: common.year ?? null,
    genre: clean(genre),
    durationMs: typeof format.duration === 'number' ? Math.round(format.duration * 1000) : null,
    codec: clean(format.codec),
    bitrateKbps: typeof format.bitrate === 'number' ? Math.round(format.bitrate / 1000) : null,
    sampleRate: format.sampleRate ?? null,
    channels: format.numberOfChannels ?? null,
    originKind: originId ? 'youtube' : null,
    originId
  }
}

/**
 * The video a saved file came from, if a tag records one.
 *
 * yt-dlp writes the canonical watch URL as a comment. Only a comment that is
 * *only* that URL counts: a normal file whose copyright note happens to link to
 * YouTube should not be claimed as a saved stream, because "already in your
 * library" would then be wrong and a re-download would silently do nothing.
 */
// Exported for the smoke tests: this is a rule, not I/O.
export function youtubeOriginOf(comments: ReadonlyArray<{ text?: string }> | undefined): string | null {
  for (const comment of comments ?? []) {
    const text = comment.text?.trim()
    if (!text) continue
    const match = YOUTUBE_WATCH_URL.exec(text)
    if (match?.[1]) return match[1]
  }
  return null
}

/**
 * The same rule applied to raw tag frames.
 *
 * `music-metadata` maps most tags onto `common`, but an ID3 `TXXX:comment` (the
 * frame ffmpeg and yt-dlp write for MP3) stays native. The URL still has to be
 * the whole value, for the same reason as above.
 */
export function youtubeOriginOfNative(native: unknown): string | null {
  if (!native || typeof native !== 'object') return null
  for (const frames of Object.values(native as Record<string, unknown>)) {
    if (!Array.isArray(frames)) continue
    for (const frame of frames) {
      if (!frame || typeof frame !== 'object') continue
      const value = (frame as { value?: unknown }).value
      if (typeof value !== 'string') continue
      const match = YOUTUBE_WATCH_URL.exec(value.trim())
      if (match?.[1]) return match[1]
    }
  }
  return null
}
