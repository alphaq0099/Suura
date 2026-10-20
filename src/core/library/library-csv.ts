import type { Track } from '@shared/types'

/**
 * A spreadsheet-friendly copy of the library.
 *
 * The BOM is deliberate: Excel on Windows reads a BOM-less UTF-8 CSV as the
 * local ANSI code page, which turns every accented artist name into mojibake.
 * Rows end in CRLF for the same reason, and fields are quoted whenever they
 * contain a comma, quote or newline (RFC 4180).
 */
const HEADER = [
  'Title',
  'Artist',
  'Album Artist',
  'Album',
  'Disc',
  'Track',
  'Year',
  'Genre',
  'Duration (seconds)',
  'Codec',
  'Bitrate (kbps)',
  'Sample Rate (Hz)',
  'Channels',
  'Size (bytes)',
  'Path',
  'Added',
  'Play Count',
  'Last Played',
  'Source',
  'Source Id',
  'Origin Kind',
  'Origin Id'
] as const

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const text = String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function isoDate(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return ''
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function durationSeconds(ms: number | null): string {
  return ms !== null && Number.isFinite(ms) ? (ms / 1000).toFixed(3) : ''
}

export function libraryCsv(tracks: Track[]): string {
  const rows = [HEADER.join(',')]

  for (const track of tracks) {
    rows.push(
      [
        track.title,
        track.artist,
        track.albumArtist,
        track.album,
        track.discNo,
        track.trackNo,
        track.year,
        track.genre,
        durationSeconds(track.durationMs),
        track.codec,
        track.bitrateKbps,
        track.sampleRate,
        track.channels,
        track.fileSize,
        track.filePath,
        isoDate(track.addedAt),
        track.playCount,
        isoDate(track.lastPlayedAt),
        track.sourceKind,
        track.sourceId,
        track.originKind,
        track.originId
      ]
        .map(cell)
        .join(',')
    )
  }

  return `\uFEFF${rows.join('\r\n')}\r\n`
}
