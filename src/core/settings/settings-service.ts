import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { DEFAULT_PLAYLIST_INDEX_WIDTH } from '@shared/playlists'
import type { AppSettings, DeepPartial } from '@shared/types'
import type { Logger } from '../logging/logger'

/**
 * Defaults matter more than they look: `retention.mode: 'stream'` and a bounded
 * cache are deliberate product decisions (ROADMAP.md §2.2 / §13), not accidents.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  libraryFolders: [],
  volume: 0.8,
  repeat: 'off',
  shuffle: false,
  theme: 'system',
  // Watching is on by default: a library that quietly misses the album you just
  // copied in is the thing people notice, and the scan it triggers is cheap
  // because unchanged files are never opened.
  library: {
    watchForChanges: true
  },
  playlists: {
    indexWidth: DEFAULT_PLAYLIST_INDEX_WIDTH
  },
  // Square + cropped is the default because it is what the library rows and the
  // bar have always looked like; `contain` is there for anyone who would rather
  // never see a cover cut off, and it is a setting rather than a constant for
  // exactly that reason. Medium is bigger than the old fixed 420px cap: the cover
  // is the point of the player window, and at the old size it read as a thumbnail
  // on anything larger than a laptop.
  visuals: {
    artworkShape: 'square',
    artworkFit: 'cover',
    artworkSize: 'medium'
  },
  // Explorer's convention, and what this app has always done: a click selects,
  // a double click plays. Any other pairing is one dropdown away.
  interaction: {
    librarySingleClick: 'select',
    libraryDoubleClick: 'play'
  },
  retention: {
    mode: 'stream',
    cacheBudgetMb: 5120,
    cacheMaxAgeDays: 30,
    downloadFolder: null,
    // Opus is what YouTube delivers, so saving it is a remux instead of a
    // re-encode. MP3 and M4A are a setting away for players that need them.
    downloadFormat: 'opus',
    qualityTier: 'high'
  },
  engine: {
    binDir: null,
    autoUpdate: true,
    downloadConcurrency: 2,
    cookiesFromBrowser: null,
    // Big enough for a double album, small enough that a queue stays a queue.
    importLimit: 200,
    // A mix never ends, so its "length" is whatever this says.
    mixLimit: 50
  }
}

/** Deep merge limited to plain objects; arrays and primitives replace wholesale. */
export function mergeSettings(base: AppSettings, patch: DeepPartial<AppSettings>): AppSettings {
  const merge = (target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> => {
    const result: Record<string, unknown> = { ...target }
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue
      const current = result[key]
      if (isPlainObject(value) && isPlainObject(current)) {
        result[key] = merge(current, value)
      } else {
        result[key] = value
      }
    }
    return result
  }
  return merge(base as unknown as Record<string, unknown>, patch as Record<string, unknown>) as unknown as AppSettings
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class SettingsService {
  private current: AppSettings
  private readonly listeners = new Set<(settings: AppSettings) => void>()

  constructor(
    private readonly file: string,
    private readonly log: Logger
  ) {
    this.current = this.read()
  }

  get(): AppSettings {
    return this.current
  }

  update(patch: DeepPartial<AppSettings>): AppSettings {
    const next = mergeSettings(this.current, patch)
    if (JSON.stringify(next) === JSON.stringify(this.current)) return this.current
    this.current = next
    this.write(next)
    for (const listener of this.listeners) {
      try {
        listener(next)
      } catch (error) {
        this.log.warn('settings listener threw', error)
      }
    }
    return next
  }

  onChange(listener: (settings: AppSettings) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private read(): AppSettings {
    try {
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as DeepPartial<AppSettings>
      return mergeSettings(DEFAULT_SETTINGS, parsed)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        this.log.warn('config unreadable, falling back to defaults', error)
      }
      return structuredClone(DEFAULT_SETTINGS)
    }
  }

  /** Write to a temp file then rename, so a crash mid-write cannot corrupt config. */
  private write(settings: AppSettings): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temp = `${this.file}.tmp`
      writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      renameSync(temp, this.file)
    } catch (error) {
      this.log.error('failed to persist settings', error)
    }
  }
}
