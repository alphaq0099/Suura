import type { ReplayGainStatus } from '@shared/types'
import type { Logger } from '@core/logging/logger'
import type { SettingsService } from '@core/settings/settings-service'
import type { TrackRepository } from '@core/library/track-repository'
import { probeExecutable } from '@engine/sidecar/locate'
import { analyzeReplayGain } from '@engine/replay-gain'

/**
 * Runs a library-wide loudness scan in the background.
 *
 * A small pool, not one process per core: ffmpeg decoding is CPU-bound and a
 * scan that pegs every core makes the player stutter. Two workers use the time
 * disk reads spend blocked without competing with playback for the whole CPU.
 */
const WORKER_COUNT = 2
/** Progress is pushed at most this often, so a big scan does not flood IPC. */
const PROGRESS_INTERVAL_MS = 120

export interface ReplayGainServiceDeps {
  settings: SettingsService
  repo: TrackRepository
  log: Logger
  /** The app-managed engine folder, which may hold ffmpeg. */
  managedDir?: string | null
  onProgress?: (status: ReplayGainStatus) => void
}

export class ReplayGainService {
  private active: AbortController | null = null
  private lastProgressAt = 0
  private status: ReplayGainStatus

  constructor(private readonly deps: ReplayGainServiceDeps) {
    const stats = deps.repo.replayGainStats()
    this.status = {
      phase: 'idle',
      total: 0,
      scanned: 0,
      failed: 0,
      libraryTotal: stats.total,
      libraryAnalyzed: stats.analyzed,
      currentFile: null,
      startedAt: null,
      finishedAt: null,
      error: null
    }
  }

  getStatus(): ReplayGainStatus {
    return { ...this.status }
  }

  /**
   * Analyses every local file that has no measurement yet.
   *
   * Calling this while a scan is running is a mistake in the UI, not a second
   * scan: the renderer disables the button, and the guard here keeps a double
   * click from launching two ffmpeg pools.
   */
  async scan(): Promise<ReplayGainStatus> {
    if (this.active) throw new Error('A loudness scan is already running.')

    const candidates = this.deps.repo.replayGainCandidates()
    const stats = this.deps.repo.replayGainStats()
    const controller = new AbortController()
    this.active = controller
    this.lastProgressAt = 0
    this.status = {
      phase: 'scanning',
      total: candidates.length,
      scanned: 0,
      failed: 0,
      libraryTotal: stats.total,
      libraryAnalyzed: stats.analyzed,
      currentFile: null,
      startedAt: Date.now(),
      finishedAt: null,
      error: null
    }
    this.emit(true)

    if (candidates.length === 0) {
      this.finish('done')
      return this.getStatus()
    }

    try {
      const ffmpeg = await probeExecutable('ffmpeg', {
        configuredDir: this.deps.settings.get().engine.binDir,
        managedDir: this.deps.managedDir,
        versionArgs: ['-version']
      })
      if (!ffmpeg.found || !ffmpeg.path) {
        throw new Error(
          ffmpeg.error ??
            'ffmpeg was not found. Download the engine in Settings, or point Settings at the folder that holds it.'
        )
      }

      let cursor = 0
      const next = (): (typeof candidates)[number] | null => {
        const candidate = candidates[cursor]
        cursor += 1
        return candidate ?? null
      }

      const worker = async (): Promise<void> => {
        while (!controller.signal.aborted) {
          const candidate = next()
          if (!candidate) return

          this.status.currentFile = candidate.filePath
          this.emit()

          try {
            const analysis = await analyzeReplayGain(ffmpeg.path as string, candidate.filePath, {
              signal: controller.signal
            })
            if (controller.signal.aborted) return
            this.deps.repo.setReplayGain(candidate.id, analysis.gainDb, analysis.peakDb)
          } catch (error) {
            if (controller.signal.aborted) return
            this.status.failed += 1
            this.deps.log.warn('replay gain analysis failed', {
              file: candidate.filePath,
              error
            })
          } finally {
            if (!controller.signal.aborted) {
              this.status.scanned += 1
              this.emit()
            }
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(WORKER_COUNT, candidates.length) }, () => worker()))
      this.finish(controller.signal.aborted ? 'cancelled' : 'done')
    } catch (error) {
      if (controller.signal.aborted) {
        this.finish('cancelled')
      } else {
        this.finish('failed', errorMessage(error))
      }
      throw error
    } finally {
      this.active = null
    }

    return this.getStatus()
  }

  /** Stops the workers and the ffmpeg process they are waiting on. */
  cancel(): void {
    this.active?.abort()
  }

  dispose(): void {
    this.active?.abort()
    this.active = null
  }

  private finish(phase: 'done' | 'cancelled' | 'failed', error: string | null = null): void {
    const stats = this.deps.repo.replayGainStats()
    this.status = {
      ...this.status,
      phase,
      libraryTotal: stats.total,
      libraryAnalyzed: stats.analyzed,
      currentFile: null,
      finishedAt: Date.now(),
      error
    }
    this.emit(true)
  }

  private emit(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastProgressAt < PROGRESS_INTERVAL_MS) return
    this.lastProgressAt = now
    this.deps.onProgress?.(this.getStatus())
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
