import { spawn, type ChildProcess } from 'node:child_process'
import { REPLAY_GAIN_TARGET_LUFS, replayGainForLufs } from '@shared/audio'
import { killTree } from './sidecar/process-tree'

/**
 * Loudness analysis for local files.
 *
 * The renderer needs one number per file, but measuring it properly means
 * decoding the whole file: EBU R128 integrated loudness is not something the
 * container header can answer. ffmpeg's `ebur128` filter does exactly that and
 * prints a small summary, which is far cheaper to parse than a JSON report and
 * is available in every build that ships the filter.
 */
export interface LoudnessMeasurement {
  integratedLufs: number
  /** dBFS, or null when the filter did not report a true peak. */
  peakDb: number | null
}

export interface ReplayGainAnalysis extends LoudnessMeasurement {
  gainDb: number
  peakDb: number | null
}

const INTEGRATED_PATTERN = /I:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*LUFS/gi
const PEAK_PATTERN = /Peak:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dBFS/gi

function lastMatch(pattern: RegExp, text: string): number | null {
  let value: number | null = null
  for (const match of text.matchAll(pattern)) {
    const parsed = Number(match[1])
    if (Number.isFinite(parsed)) value = parsed
  }
  return value
}

/**
 * Reads the summary block ffmpeg writes to stderr.
 *
 * Exported because it is the part worth testing without a subprocess: the
 * spacing and decimal places are ffmpeg's, not ours, and a parser that only
 * works on one sample is worse than no parser.
 */
export function parseEbur128Summary(output: string): LoudnessMeasurement | null {
  const integratedLufs = lastMatch(INTEGRATED_PATTERN, output)
  if (integratedLufs === null) return null
  return { integratedLufs, peakDb: lastMatch(PEAK_PATTERN, output) }
}

/** The gain in dB that brings a measured track to the ReplayGain reference. */
export function replayGainFromMeasurement(measurement: LoudnessMeasurement): ReplayGainAnalysis {
  return {
    ...measurement,
    gainDb: replayGainForLufs(measurement.integratedLufs, REPLAY_GAIN_TARGET_LUFS)
  }
}

interface AnalyzeOptions {
  signal?: AbortSignal
}

/**
 * Decodes one file and returns its ReplayGain values.
 *
 * `killTree` is used rather than `child.kill()` on Windows because ffmpeg can
 * spawn helper processes for some demuxers, and cancelling a scan must not leave
 * one behind.
 */
export function analyzeReplayGain(
  ffmpegPath: string,
  filePath: string,
  options: AnalyzeOptions = {}
): Promise<ReplayGainAnalysis> {
  const { signal } = options
  if (signal?.aborted) return Promise.reject(abortError())

  return new Promise<ReplayGainAnalysis>((resolve, reject) => {
    const args = [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'info',
      '-i',
      filePath,
      '-map',
      '0:a:0',
      '-af',
      'ebur128=peak=true',
      '-f',
      'null',
      '-'
    ]

    let child: ChildProcess
    try {
      child = spawn(ffmpegPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      })
    } catch (error) {
      reject(error)
      return
    }

    let stderr = ''
    let settled = false
    let aborted = false

    const finish = (error: Error | null, result?: ReplayGainAnalysis): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else if (result) resolve(result)
      else reject(new Error('Loudness analysis finished without a measurement.'))
    }

    const onAbort = (): void => {
      aborted = true
      killTree(child)
      finish(abortError())
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    child.stderr?.on('data', (chunk: Buffer) => {
      // ffmpeg logs one line per frame at info level. Keeping only a tail is
      // enough for the summary and bounds memory on an hours-long file.
      stderr += chunk.toString('utf8')
      if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000)
    })

    child.on('error', (error) => finish(error))

    child.on('close', (code) => {
      if (aborted || signal?.aborted) {
        finish(abortError())
        return
      }
      if (code !== 0) {
        finish(new Error(`ffmpeg could not analyse the file (exit code ${code ?? 'unknown'}).`))
        return
      }
      const measurement = parseEbur128Summary(stderr)
      if (!measurement) {
        finish(new Error('ffmpeg returned no loudness measurement.'))
        return
      }
      finish(null, replayGainFromMeasurement(measurement))
    })
  })
}

function abortError(): Error {
  const error = new Error('Loudness analysis was cancelled.')
  error.name = 'AbortError'
  return error
}
