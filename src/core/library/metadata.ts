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
  year: number | null
  genre: string | null
  durationMs: number | null
  codec: string | null
  bitrateKbps: number | null
  sampleRate: number | null
  channels: number | null
}

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

  return {
    title: clean(common.title) ?? titleFromFilename(filePath),
    artist,
    // A missing album-artist falls back to the track artist, which is what every
    // other player does and avoids "Unknown Artist" appearing next to real names.
    albumArtist: clean(common.albumartist) ?? artist,
    album: clean(common.album),
    trackNo: common.track?.no ?? null,
    discNo: common.disk?.no ?? null,
    year: common.year ?? null,
    genre: clean(genre),
    durationMs: typeof format.duration === 'number' ? Math.round(format.duration * 1000) : null,
    codec: clean(format.codec),
    bitrateKbps: typeof format.bitrate === 'number' ? Math.round(format.bitrate / 1000) : null,
    sampleRate: format.sampleRate ?? null,
    channels: format.numberOfChannels ?? null
  }
}
