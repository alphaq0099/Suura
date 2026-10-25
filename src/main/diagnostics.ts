import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'

/**
 * The log bundle written by **Save diagnostics**.
 *
 * This deliberately lives outside `ipc.ts` so the smoke test can exercise the
 * byte-level tail reader without an Electron window. The renderer supplies the
 * short app/path summary; the main process owns the log read and the file write.
 */

/** Keep the bundle small enough to paste into a support message. */
export const DIAGNOSTICS_LOG_TAIL_BYTES = 256 * 1024
/** A hostile or accidental renderer string cannot bloat the bundle. */
export const DIAGNOSTICS_SUMMARY_LIMIT = 16 * 1024

export interface LogTail {
  text: string
  /** Full file size in bytes. */
  size: number
  /** Bytes actually included. */
  included: number
  truncated: boolean
  missing: boolean
  error: string | null
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/**
 * Reads the end of a log file, never throwing.
 *
 * A truncated tail starts on a line boundary so the first line in the bundle is
 * not a fragment. A missing file is a normal first-run state, not an error the
 * UI has to handle.
 */
export function readLogTail(filePath: string, maxBytes = DIAGNOSTICS_LOG_TAIL_BYTES): LogTail {
  const limit = Number.isFinite(maxBytes)
    ? Math.max(0, Math.floor(maxBytes))
    : DIAGNOSTICS_LOG_TAIL_BYTES
  let handle: number | null = null
  try {
    const stats = statSync(filePath)
    if (!stats.isFile()) {
      return {
        text: '',
        size: 0,
        included: 0,
        truncated: false,
        missing: true,
        error: 'Not a regular file.'
      }
    }
    if (stats.size === 0 || limit === 0) {
      return {
        text: '',
        size: stats.size,
        included: 0,
        truncated: false,
        missing: false,
        error: null
      }
    }

    const start = Math.max(0, stats.size - limit)
    const length = stats.size - start
    const buffer = Buffer.alloc(length)
    handle = openSync(filePath, 'r')
    let read = 0
    while (read < length) {
      const chunk = readSync(handle, buffer, read, length - read, start + read)
      if (chunk <= 0) break
      read += chunk
    }

    let text = buffer.subarray(0, read).toString('utf8')
    if (start > 0) {
      const newline = text.indexOf('\n')
      // The first line is usually a fragment when the cut is mid-file. Drop it;
      // an enormous single line yields no safe tail at all.
      text = newline >= 0 ? text.slice(newline + 1) : ''
    }

    return {
      text,
      size: stats.size,
      included: read,
      truncated: start > 0,
      missing: false,
      error: null
    }
  } catch (cause) {
    return {
      text: '',
      size: 0,
      included: 0,
      truncated: false,
      missing: true,
      error: messageOf(cause)
    }
  } finally {
    if (handle !== null) {
      try {
        closeSync(handle)
      } catch {
        // Nothing useful to do while reporting a failure.
      }
    }
  }
}

/** Normalises the renderer-provided summary before it reaches a file. */
export function sanitizeDiagnosticsSummary(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\0/g, '')
    .slice(0, DIAGNOSTICS_SUMMARY_LIMIT)
    .trim()
}

export interface DiagnosticsBundleInput {
  summary: string
  logPath: string
  log: LogTail
  /** Injectable clock for tests. */
  generatedAt?: Date
}

/**
 * Formats one plain-text bundle. It is local and user-initiated: nothing here
 * uploads, and no cookies or account credentials are collected.
 */
export function buildDiagnosticsBundle(input: DiagnosticsBundleInput): string {
  const generatedAt = (input.generatedAt ?? new Date()).toISOString()
  const summary = sanitizeDiagnosticsSummary(input.summary)
  const status = input.log.missing
    ? `not available${input.log.error ? ` (${input.log.error})` : ''}`
    : input.log.truncated
      ? `last ${input.log.included} of ${input.log.size} bytes`
      : `${input.log.size} bytes`

  return [
    'Player diagnostics',
    `Generated: ${generatedAt}`,
    'Review this file before sharing it: it can contain local file paths and recent log lines.',
    '',
    '--- app summary ---',
    summary || '(not provided)',
    '',
    '--- log ---',
    `File: ${input.logPath}`,
    `Status: ${status}`,
    '',
    input.log.text.trimEnd() || '(no log lines)',
    ''
  ].join('\n')
}

/** Writes one bundle and reports the exact byte length for the log. */
export async function writeDiagnosticsFile(
  target: string,
  input: DiagnosticsBundleInput
): Promise<{ content: string; bytes: number }> {
  const content = buildDiagnosticsBundle(input)
  await writeFile(target, content, 'utf8')
  return { content, bytes: Buffer.byteLength(content, 'utf8') }
}
