import { spawn, type ChildProcess } from 'node:child_process'
import type { Logger } from '@core/logging/logger'
import type { AudioFingerprint } from '@shared/acoustid'
import { locateExecutable, wellKnownDirectories } from './locate'
import { killTree } from './process-tree'

/**
 * Running `fpcalc` for one file.
 *
 * Chromaprint's `-json` mode prints `{ "duration": 212.4, "fingerprint":
 * "<base64>" }`. The duration is the file's length, not the fingerprint window,
 * which is exactly what an AcoustID lookup wants.
 *
 * fpcalc is optional in the engine manifest: streaming works without it and
 * only the fingerprint fallback needs it. A missing binary is therefore a
 * sentence about installing it, not a crash.
 */

/** A fingerprint of a whole song takes a second; a network drive may take longer. */
const DEFAULT_TIMEOUT_MS = 20_000

/** fpcalc prints a few kilobytes of base64, never a whole file. */
const MAX_STDOUT_BYTES = 1_024 * 1_024
const MAX_STDERR_BYTES = 64 * 1024

export interface FpcalcOptions {
  /** Explicit folder from settings, checked first. */
  configuredDir?: string | null
  /** The app-managed engine folder. */
  managedDir?: string | null
  timeoutMs?: number
  log?: Logger
}

/** A failure worth showing: the message is already a sentence. */
export class FpcalcError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FpcalcError'
  }
}

/** The arguments used for every lookup, exported so the smoke test pins them. */
export function fpcalcArgs(filePath: string): string[] {
  // 120 seconds is AcoustID's documented default window and the length its
  // comparison expects; the JSON mode keeps the answer machine-readable.
  return ['-json', '-length', '120', filePath]
}

/**
 * Parses one `-json` answer.
 *
 * Anything that is not a positive duration and a non-empty fingerprint is a
 * failure: sending half an answer to AcoustID would only produce a confusing
 * "no match" for a file that simply could not be read.
 */
export function parseFpcalcOutput(stdout: string): AudioFingerprint {
  const text = stdout.trim()
  if (text.length === 0) throw new FpcalcError('fpcalc returned nothing for this file.')

  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    throw new FpcalcError('fpcalc returned an answer that could not be read.')
  }

  const source =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null
  const duration = source?.duration
  const fingerprint = source?.fingerprint

  if (
    typeof duration !== 'number' ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    typeof fingerprint !== 'string' ||
    fingerprint.trim().length === 0
  ) {
    throw new FpcalcError('fpcalc could not measure this file.')
  }

  return { durationSeconds: duration, fingerprint: fingerprint.trim() }
}

/**
 * Locates fpcalc and fingerprints one file.
 *
 * The process is capped in time and output, and killed as a tree on timeout so
 * a hung decode cannot hold the lookup open. Every rejection is an
 * `FpcalcError` with a sentence the dialog can show.
 */
export function computeFingerprint(
  filePath: string,
  options: FpcalcOptions = {}
): Promise<AudioFingerprint> {
  const located = locateExecutable('fpcalc', {
    configuredDir: options.configuredDir ?? null,
    managedDir: options.managedDir ?? null,
    extraDirs: wellKnownDirectories()
  })
  if (!located) {
    return Promise.reject(
      new FpcalcError('Fingerprinting needs fpcalc. Download it from Settings \u2192 Streaming.')
    )
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<AudioFingerprint>((resolve, reject) => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let child: ChildProcess

    const finish = (error: Error | null, value?: AudioFingerprint): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else if (value) resolve(value)
    }

    try {
      child = spawn(located.path, fpcalcArgs(filePath), {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      reject(new FpcalcError('fpcalc could not be started.'))
      return
    }

    const timer = setTimeout(() => {
      killTree(child)
      finish(new FpcalcError('fpcalc took too long to read this file.'))
    }, timeoutMs)
    timer.unref?.()

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < MAX_STDOUT_BYTES) stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR_BYTES) stderr += chunk
    })

    child.on('error', (error) => {
      options.log?.debug('fpcalc failed to start', { path: located.path, error })
      finish(
        new FpcalcError(
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'fpcalc is no longer on disk. Download the engine again from Settings.'
            : 'fpcalc could not be started.'
        )
      )
    })

    child.on('close', (code) => {
      if (code !== 0) {
        options.log?.debug('fpcalc exited with a failure', {
          path: located.path,
          code,
          stderr: stderr.trim().slice(0, 500)
        })
        finish(new FpcalcError('fpcalc could not read this file. Is it a playable audio file?'))
        return
      }
      try {
        finish(null, parseFpcalcOutput(stdout))
      } catch (error) {
        finish(error instanceof Error ? error : new FpcalcError('fpcalc failed.'))
      }
    })
  })
}
