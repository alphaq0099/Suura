import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { DEFAULT_SETTINGS } from '@shared/settings-defaults'
import type { AppSettings, DeepPartial } from '@shared/types'
import type { Logger } from '../logging/logger'

export { DEFAULT_SETTINGS } from '@shared/settings-defaults'

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
    let settings: AppSettings
    try {
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as DeepPartial<AppSettings>
      settings = mergeSettings(DEFAULT_SETTINGS, parsed)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        this.log.warn('config unreadable, falling back to defaults', error)
      }
      return structuredClone(DEFAULT_SETTINGS)
    }

    // Offline caching is deliberately disabled until its own phase. A config
    // written by an earlier build may still say `cache`; keeping it would make
    // the app claim a behaviour it does not have, so the mode is pinned to
    // stream-only on every read. The budget fields stay in the file untouched,
    // ready for the phase that implements them.
    if (settings.retention.mode !== 'stream') {
      settings = { ...settings, retention: { ...settings.retention, mode: 'stream' } }
    }
    return settings
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
