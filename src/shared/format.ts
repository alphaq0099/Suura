/** Small display helpers shared by the renderer. No Node imports. */

/** 215000 -> "3:35". Returns "--:--" for unknown durations. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return '--:--'
  const totalSeconds = Math.floor(ms / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '--'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex]}`
}

export function formatBitrate(kbps: number | null | undefined): string {
  if (!kbps) return '--'
  return `${Math.round(kbps)} kbps`
}

/**
 * Short label for a codec string: "MPEG-4/AAC" -> "AAC".
 *
 * music-metadata reports codecs the way containers name them, which is mostly
 * too long for a table column. Unknown codecs are passed through untouched.
 */
export function formatCodec(codec: string | null | undefined): string {
  if (!codec) return '--'
  const normalized = codec.toLowerCase()
  if (normalized.includes('flac')) return 'FLAC'
  if (normalized.includes('alac')) return 'ALAC'
  if (normalized.includes('opus')) return 'Opus'
  if (normalized.includes('vorbis')) return 'Vorbis'
  // Checked before the generic MPEG case: "MPEG-4/AAC" contains both.
  if (normalized.includes('aac') || normalized.includes('mp4a') || normalized.includes('mpeg-4')) return 'AAC'
  if (normalized.includes('mpeg')) return 'MP3'
  if (normalized.includes('pcm') || normalized.includes('wav')) return 'PCM'
  return codec
}

/** "AAC · 421 kbps", or a dash when nothing is known. */
export function formatAudioSummary(codec: string | null | undefined, kbps: number | null | undefined): string {
  const parts = [formatCodec(codec), formatBitrate(kbps)].filter((part) => part && part !== '--')
  return parts.join(' · ') || '—'
}

export function formatCount(value: number): string {
  return value.toLocaleString()
}

export function formatTimestamp(epochMs: number | null | undefined): string {
  if (!epochMs) return 'never'
  return new Date(epochMs).toLocaleString()
}
