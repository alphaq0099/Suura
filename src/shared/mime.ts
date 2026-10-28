/** Extensions the library scanner treats as audio. */
export const AUDIO_EXTENSIONS: readonly string[] = [
  '.mp3',
  '.m4a',
  '.m4b',
  '.aac',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.wav',
  '.wave',
  '.wma',
  '.aiff',
  '.aif',
  '.aifc',
  '.ape',
  '.wv',
  '.mpc',
  '.spx'
]

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.spx': 'audio/ogg',
  '.wav': 'audio/wav',
  '.wave': 'audio/wav',
  // Cached YouTube audio keeps the container the CDN delivered. It is not a
  // library extension (scanner lists do not include it), only a media-protocol
  // content type, because the cache is app-owned and never scanned.
  '.webm': 'audio/webm',
  '.wma': 'audio/x-ms-wma',
  '.aiff': 'audio/aiff',
  '.aif': 'audio/aiff',
  '.aifc': 'audio/aiff',
  '.ape': 'audio/x-ape',
  '.wv': 'audio/x-wavpack',
  '.mpc': 'audio/x-musepack'
}

export function extensionOf(filePath: string): string {
  const idx = filePath.lastIndexOf('.')
  if (idx < 0) return ''
  return filePath.slice(idx).toLowerCase()
}

export function isAudioFile(filePath: string): boolean {
  return AUDIO_EXTENSIONS.includes(extensionOf(filePath))
}

export function mimeForExtension(filePath: string): string {
  return MIME_BY_EXTENSION[extensionOf(filePath)] ?? 'application/octet-stream'
}
