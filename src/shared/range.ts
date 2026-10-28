export interface ByteRange {
  start: number
  end: number
}

/**
 * Parses a single-range `bytes=` header.
 *
 * Lives here rather than next to the protocol handler so it can be tested from a
 * plain Node process, with no Electron involved.
 *
 * Returns null for anything unparseable or unsatisfiable; the caller turns that
 * into a 416. Multi-range requests are not supported: no audio element issues
 * them, and Chromium falls back to a whole-file fetch if one is refused.
 */
export function parseRangeHeader(header: string, totalSize: number): ByteRange | null {
  if (totalSize <= 0) return null

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null

  const rawStart = match[1] ?? ''
  const rawEnd = match[2] ?? ''
  if (rawStart === '' && rawEnd === '') return null

  if (rawStart === '') {
    // Suffix form: "bytes=-500" is the last 500 bytes.
    const suffixLength = Number(rawEnd)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return null
    return { start: Math.max(0, totalSize - suffixLength), end: totalSize - 1 }
  }

  const start = Number(rawStart)
  if (!Number.isFinite(start) || start >= totalSize) return null

  const end = rawEnd === '' ? totalSize - 1 : Math.min(Number(rawEnd), totalSize - 1)
  if (!Number.isFinite(end) || end < start) return null

  return { start, end }
}
