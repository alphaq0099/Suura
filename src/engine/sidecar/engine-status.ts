import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Logger } from '@core/logging/logger'
import type { EngineSettings, EngineStatus, ExecutableStatus } from '@shared/types'
import { probeExecutable } from './locate'

/**
 * Reports whether the yt-dlp engine's dependencies are present and runnable.
 *
 * Nothing in M0.5 uses yt-dlp to play music. This exists so the riskiest part of
 * the roadmap (ROADMAP.md §6.4) is visible from day one: if the user's yt-dlp is
 * missing, too old, or shadowed by a broken wrapper, the settings screen says so
 * instead of the first M3 playback attempt failing mysteriously.
 */
export async function getEngineStatus(engine: EngineSettings): Promise<EngineStatus> {
  const [ytDlp, ffmpeg] = await Promise.all([
    probeExecutable('yt-dlp', { configuredDir: engine.binDir }),
    // ffmpeg prints its banner to stdout and expects a flag, not --version alone.
    probeExecutable('ffmpeg', { configuredDir: engine.binDir, versionArgs: ['-version'] })
  ])

  return {
    ytDlp,
    ffmpeg,
    ready: ytDlp.found && ffmpeg.found
  }
}

/**
 * How long a saved probe is considered current.
 *
 * The saved answer is always returned immediately. After this age a fresh probe
 * runs in the background, so an updated yt-dlp shows its new version without
 * making the user wait for two child processes.
 */
const REFRESH_AFTER_MS = 5 * 60_000
const CACHE_VERSION = 1

interface EngineStatusCacheEntry {
  version: number
  /** The engine folder the probe was taken with; a change invalidates it. */
  binDir: string | null
  checkedAt: number
  status: EngineStatus
}

export interface EngineStatusCacheOptions {
  /** Where the last probe is kept, normally `engine-status.json` in userData. */
  file: string
  log: Logger
  now?: () => number
  /** Overridable so the smoke test can count probes without spawning binaries. */
  probe?: (engine: EngineSettings) => Promise<EngineStatus>
}

function isExecutableStatus(value: unknown): value is ExecutableStatus {
  if (!value || typeof value !== 'object') return false
  const status = value as Record<string, unknown>
  return typeof status.name === 'string' && typeof status.found === 'boolean'
}

function isCacheEntry(value: unknown): value is EngineStatusCacheEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  if (entry.version !== CACHE_VERSION) return false
  if (entry.binDir !== null && typeof entry.binDir !== 'string') return false
  if (typeof entry.checkedAt !== 'number' || !Number.isFinite(entry.checkedAt)) return false
  const status = entry.status as Record<string, unknown> | null
  if (!status || typeof status !== 'object') return false
  return (
    typeof status.ready === 'boolean' &&
    isExecutableStatus(status.ytDlp) &&
    isExecutableStatus(status.ffmpeg)
  )
}

/**
 * Remembers the last executable probe so Settings opens without waiting.
 *
 * `yt-dlp --version` and `ffmpeg -version` cost a few seconds together on a
 * cold machine, and the old code paid that every time the user opened Settings
 * for the first time in a run. The answer is now saved to userData: the first
 * read after a restart returns it instantly, and a stale one is refreshed in
 * the background. Only an explicit Refresh, or a changed engine folder, waits
 * for the binaries.
 */
export class EngineStatusCache {
  private entry: EngineStatusCacheEntry | null = null
  private loaded = false
  private inFlight: Promise<EngineStatus> | null = null

  constructor(private readonly deps: EngineStatusCacheOptions) {}

  async get(engine: EngineSettings, options: { force?: boolean } = {}): Promise<EngineStatus> {
    const cached = this.read(engine)
    if (cached && !options.force) {
      if (this.now() - cached.checkedAt > REFRESH_AFTER_MS) {
        void this.probe(engine).catch(() => undefined)
      }
      return cached.status
    }
    return this.probe(engine)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private read(engine: EngineSettings): EngineStatusCacheEntry | null {
    if (!this.loaded) {
      this.loaded = true
      this.entry = this.readFile()
    }
    const entry = this.entry
    if (!entry) return null
    if (entry.version !== CACHE_VERSION) return null
    // The saved paths and versions belong to the folder they were found in.
    if (entry.binDir !== (engine.binDir ?? null)) return null
    return entry
  }

  private readFile(): EngineStatusCacheEntry | null {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.deps.file, 'utf8'))
      return isCacheEntry(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  private probe(engine: EngineSettings): Promise<EngineStatus> {
    if (this.inFlight) return this.inFlight
    const probe = this.deps.probe ?? getEngineStatus
    const work = probe(engine)
      .then((status) => {
        const entry: EngineStatusCacheEntry = {
          version: CACHE_VERSION,
          binDir: engine.binDir ?? null,
          checkedAt: this.now(),
          status
        }
        this.entry = entry
        this.loaded = true
        this.writeFile(entry)
        this.deps.log.debug('engine status probed', { ready: status.ready })
        return status
      })
      .finally(() => {
        this.inFlight = null
      })
    this.inFlight = work
    return work
  }

  private writeFile(entry: EngineStatusCacheEntry): void {
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true })
      const temporary = `${this.deps.file}.tmp`
      writeFileSync(temporary, JSON.stringify(entry), 'utf8')
      renameSync(temporary, this.deps.file)
    } catch (error) {
      this.deps.log.warn('could not save the engine probe', error)
    }
  }
}
