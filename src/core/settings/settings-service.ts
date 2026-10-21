import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { DEFAULT_SETTINGS } from '@shared/settings-defaults'
import type { AppSettings, DeepPartial } from '@shared/types'
import {
  DEFAULT_PO_TOKEN_PROVIDER_URL,
  isCookieFallbackMode,
  isSupportedCookieBrowser,
  normalizeCookieBrowserProfile
} from '@shared/youtube'
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
    let storedEngine: Record<string, unknown> | null = null
    try {
      const raw = readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw) as DeepPartial<AppSettings>
      storedEngine = isPlainObject(parsed.engine) ? parsed.engine : null
      settings = mergeSettings(DEFAULT_SETTINGS, parsed)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        this.log.warn('config unreadable, falling back to defaults', error)
      }
      return structuredClone(DEFAULT_SETTINGS)
    }

    // Older builds had one cookie switch and applied it to every request. The
    // new model separates the browser from the trigger, so a stored browser
    // with no trigger means the old "always" behaviour. A browser chosen after
    // this migration keeps whatever trigger the new UI wrote.
    if (
      storedEngine &&
      isSupportedCookieBrowser(storedEngine.cookiesFromBrowser) &&
      storedEngine.cookieFallback === undefined
    ) {
      settings = { ...settings, engine: { ...settings.engine, cookieFallback: 'always' } }
    }

    // Offline caching is deliberately disabled until its own phase. A config
    // written by an earlier build may still say `cache`; keeping it would make
    // the app claim a behaviour it does not have, so the mode is pinned to
    // stream-only on every read. The budget fields stay in the file untouched,
    // ready for the phase that implements them.
    if (settings.retention.mode !== 'stream') {
      settings = { ...settings, retention: { ...settings.retention, mode: 'stream' } }
    }

    // The old surface value described the CSS blur as "frosted", but it is an
    // accent tint rather than an album-art frost. Accept the old spelling from
    // config files written by an earlier build and normalise it on read.
    const storedSurface = (settings.visuals as { surface?: unknown }).surface
    if (storedSurface === 'frosted') {
      settings = { ...settings, visuals: { ...settings.visuals, surface: 'accented' } }
    }

    // A hand-edited config is still input from outside the type system. Keep the
    // reliability controls in a shape the UI and argument builders can trust.
    const engine = settings.engine
    settings = {
      ...settings,
      engine: {
        ...engine,
        cookiesFromBrowser: isSupportedCookieBrowser(engine.cookiesFromBrowser)
          ? engine.cookiesFromBrowser
          : null,
        cookieBrowserProfile: normalizeCookieBrowserProfile(engine.cookieBrowserProfile),
        cookieFallback: isCookieFallbackMode(engine.cookieFallback) ? engine.cookieFallback : 'off',
        poTokenEnabled: engine.poTokenEnabled === true,
        poTokenProviderUrl:
          typeof engine.poTokenProviderUrl === 'string'
            ? engine.poTokenProviderUrl
            : DEFAULT_PO_TOKEN_PROVIDER_URL,
        poTokenProviderCommand:
          typeof engine.poTokenProviderCommand === 'string' ? engine.poTokenProviderCommand : null,
        poTokenAutoStart: engine.poTokenAutoStart === true
      }
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
