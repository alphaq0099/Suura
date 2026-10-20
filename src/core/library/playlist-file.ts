import { basename, dirname, extname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PlaylistDetail, PlaylistFileFormat } from '@shared/types'
import { youtubeWatchUrl } from '@shared/youtube'

/** Marker that lets us recognise our own JSON without guessing from field names. */
export const PLAYLIST_JSON_FORMAT = 'player-playlist'
export const PLAYLIST_JSON_VERSION = 1

/** Refuse a file no real playlist needs; this also bounds memory before parsing. */
export const MAX_PLAYLIST_FILE_BYTES = 10 * 1024 * 1024

/** One import creates at most this many entries, so a malformed file cannot stall the UI. */
export const MAX_PLAYLIST_ENTRIES = 50_000

/**
 * One entry read from an M3U/M3U8 or JSON playlist.
 *
 * `path` is always absolute. Relative M3U entries are resolved against the
 * playlist's own folder, because that is what a portable playlist means. A URL
 * is kept as-is; only YouTube URLs can currently be matched to the library.
 */
export interface PlaylistTransferEntry {
  path: string | null
  url: string | null
  title: string | null
  artist: string | null
  album: string | null
  durationMs: number | null
}

export interface ParsedPlaylistFile {
  format: PlaylistFileFormat
  name: string
  entries: PlaylistTransferEntry[]
}

function emptyEntry(): PlaylistTransferEntry {
  return { path: null, url: null, title: null, artist: null, album: null, durationMs: null }
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/\0/g, '').trim()
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = oneLine(value)
  return text.length > 0 ? text : null
}

function durationOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.round(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The format implied by a file extension, or a readable refusal. */
export function playlistFormatFromPath(filePath: string): PlaylistFileFormat {
  const extension = extname(filePath).toLowerCase()
  if (extension === '.json') return 'json'
  if (extension === '.m3u') return 'm3u'
  if (extension === '.m3u8') return 'm3u8'
  throw new Error('Choose an .m3u, .m3u8 or .json playlist file.')
}

function fallbackName(filePath: string): string {
  return oneLine(basename(filePath, extname(filePath))) || 'Imported playlist'
}

/** `file://` URLs are common in exported M3Us; decode them when they are local. */
function pathFromFileUrl(value: string): string | null {
  try {
    return fileURLToPath(value)
  } catch {
    return null
  }
}

function locationFromLine(line: string, baseDirectory: string): Pick<PlaylistTransferEntry, 'path' | 'url'> {
  if (/^https?:\/\//i.test(line) || /^www\./i.test(line)) {
    return { path: null, url: line }
  }

  if (/^file:\/\//i.test(line)) {
    const decoded = pathFromFileUrl(line)
    if (decoded) return { path: decoded, url: null }
    return { path: null, url: line }
  }

  return { path: isAbsolute(line) ? line : resolve(baseDirectory, line), url: null }
}

function parseExtinf(line: string): Pick<PlaylistTransferEntry, 'title' | 'artist' | 'durationMs'> {
  const payload = line.slice('#EXTINF:'.length).trim()
  const comma = payload.indexOf(',')
  const durationText = comma >= 0 ? payload.slice(0, comma).trim() : payload.trim()
  const label = comma >= 0 ? oneLine(payload.slice(comma + 1)) : ''
  const seconds = Number.parseFloat(durationText)
  const result: Pick<PlaylistTransferEntry, 'title' | 'artist' | 'durationMs'> = {
    title: null,
    artist: null,
    durationMs: Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : null
  }

  if (label.length > 0) {
    // Extended M3U labels are conventionally "Artist - Title". The split is
    // only a hint for the JSON export; matching still uses the path.
    const separator = label.indexOf(' - ')
    if (separator > 0) {
      result.artist = label.slice(0, separator).trim() || null
      result.title = label.slice(separator + 3).trim() || null
    } else {
      result.title = label
    }
  }
  return result
}

function parseM3U(text: string, filePath: string, format: 'm3u' | 'm3u8'): ParsedPlaylistFile {
  const baseDirectory = dirname(filePath)
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  const entries: PlaylistTransferEntry[] = []
  let name = ''
  let pending = emptyEntry()

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line.length === 0) continue

    if (line.startsWith('#')) {
      const upper = line.toUpperCase()
      if (upper.startsWith('#PLAYLIST:')) {
        name = oneLine(line.slice('#PLAYLIST:'.length))
      } else if (upper.startsWith('#EXTINF:')) {
        pending = { ...pending, ...parseExtinf(line) }
      } else if (upper.startsWith('#EXTART:')) {
        pending.artist = stringOrNull(line.slice('#EXTART:'.length))
      } else if (upper.startsWith('#EXTALB:')) {
        pending.album = stringOrNull(line.slice('#EXTALB:'.length))
      }
      continue
    }

    if (entries.length >= MAX_PLAYLIST_ENTRIES) {
      throw new Error(`This playlist has more than ${MAX_PLAYLIST_ENTRIES} entries.`)
    }
    entries.push({ ...pending, ...locationFromLine(line, baseDirectory) })
    pending = emptyEntry()
  }

  return {
    format,
    name: name.length > 0 ? name : fallbackName(filePath),
    entries
  }
}

function entryFromJson(value: unknown): PlaylistTransferEntry {
  if (!isRecord(value)) return emptyEntry()
  return {
    path: stringOrNull(value.path),
    url: stringOrNull(value.url),
    title: stringOrNull(value.title),
    artist: stringOrNull(value.artist),
    album: stringOrNull(value.album),
    durationMs: durationOrNull(value.durationMs)
  }
}

function parseJson(text: string, filePath: string): ParsedPlaylistFile {
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('This playlist file is not valid JSON.')
  }
  if (!isRecord(data)) throw new Error('This is not a Player playlist JSON file.')
  if (data.format !== PLAYLIST_JSON_FORMAT) {
    throw new Error('This is not a Player playlist JSON file.')
  }
  if (typeof data.version === 'number' && data.version > PLAYLIST_JSON_VERSION) {
    throw new Error('This playlist was created by a newer version of Player.')
  }
  if (!Array.isArray(data.entries)) {
    throw new Error('This playlist JSON file has no entries.')
  }
  if (data.entries.length > MAX_PLAYLIST_ENTRIES) {
    throw new Error(`This playlist has more than ${MAX_PLAYLIST_ENTRIES} entries.`)
  }

  return {
    format: 'json',
    name: stringOrNull(data.name) ?? fallbackName(filePath),
    entries: data.entries.map(entryFromJson)
  }
}

/** Parses a local playlist file. The extension decides the grammar. */
export function parsePlaylistFile(text: string, filePath: string): ParsedPlaylistFile {
  const format = playlistFormatFromPath(filePath)
  if (format === 'json') return parseJson(text, filePath)
  return parseM3U(text, filePath, format)
}

function m3uLocation(detail: PlaylistDetail, index: number): string | null {
  const track = detail.items[index]?.track
  if (!track) return null
  if (track.filePath) return track.filePath
  if (track.originKind === 'youtube' && track.originId) return youtubeWatchUrl(track.originId)
  return null
}

/**
 * Writes an extended M3U. The same text is valid as `.m3u` and `.m3u8`; the
 * extension is what tells other players that the bytes are UTF-8.
 */
export function exportPlaylistM3U(detail: PlaylistDetail): string {
  const lines = ['#EXTM3U', `#PLAYLIST:${oneLine(detail.playlist.name)}`]
  detail.items.forEach((item, index) => {
    const location = m3uLocation(detail, index)
    if (!location) return
    const track = item.track
    const label = track.artist ? `${track.artist} - ${track.title}` : track.title
    const seconds =
      track.durationMs !== null && track.durationMs > 0 ? Math.round(track.durationMs / 1000) : -1
    lines.push(`#EXTINF:${seconds},${oneLine(label)}`)
    if (track.album) lines.push(`#EXTALB:${oneLine(track.album)}`)
    if (track.artist) lines.push(`#EXTART:${oneLine(track.artist)}`)
    lines.push(oneLine(location))
  })
  return `${lines.join('\r\n')}\r\n`
}

/** Writes the documented, versioned JSON snapshot. */
export function exportPlaylistJson(detail: PlaylistDetail): string {
  const entries = detail.items.map((item) => {
    const track = item.track
    return {
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationMs: track.durationMs,
      path: track.filePath,
      url:
        track.originKind === 'youtube' && track.originId
          ? youtubeWatchUrl(track.originId)
          : null
    }
  })

  return `${JSON.stringify(
    {
      format: PLAYLIST_JSON_FORMAT,
      version: PLAYLIST_JSON_VERSION,
      name: detail.playlist.name,
      exportedAt: new Date().toISOString(),
      entries
    },
    null,
    2
  )}\n`
}
