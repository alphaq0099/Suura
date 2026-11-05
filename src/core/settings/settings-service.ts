import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import {
  ARTWORK_SIZES,
  HERO_SLIDE_SECONDS_MAX,
  HERO_SLIDE_SECONDS_MIN,
  ICON_SETS,
  LYRICS_ALIGNS,
  TEXT_SIZES
} from '@shared/appearance'
import { normalizeAudioSettings } from '@shared/audio'
import { normalizeAcoustidKey } from '@shared/acoustid'
import {
  DEFAULT_SETTINGS,
  DOWNLOAD_FORMATS,
  QUALITY_TIERS,
  RETENTION_MODES,
  UPDATE_CHANNELS
} from '@shared/settings-defaults'
import {
  isStartupView,
  type AppSettings,
  type ArtworkSize,
  type DeepPartial,
  type DownloadFormat,
  type IconSet,
  type LyricsAlign,
  type QualityTier,
  type RetentionMode,
  type RetentionSettings,
  type TextSize,
  type UpdateChannel,
  type UpdateSettings
} from '@shared/types'
import {
  DEFAULT_PO_TOKEN_PROVIDER_URL,
  isCookieFallbackMode,
  isSupportedCookieBrowser,
  normalizeCookieBrowserProfile,
  normalizeCookiesFile
} from '@shared/youtube'
import { normalizeUpdateFeedUrl } from '@shared/update'
import type { Logger } from '../logging/logger'

export { DEFAULT_SETTINGS } from '@shared/settings-defaults'

// Kept here so existing callers (and the smoke harness) can import it beside
// the rest of the settings normalisers.
export { normalizeUpdateFeedUrl } from '@shared/update'

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

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * Keeps the update block in the shape the updater and Settings rely on.
 */
export function normalizeUpdate(input: unknown): UpdateSettings {
  const source = isPlainObject(input) ? input : {}
  const defaults = DEFAULT_SETTINGS.update
  const channel = UPDATE_CHANNELS.includes(source.channel as UpdateChannel)
    ? (source.channel as UpdateChannel)
    : defaults.channel
  const lastCheckAt =
    typeof source.lastCheckAt === 'number' && Number.isFinite(source.lastCheckAt) && source.lastCheckAt > 0
      ? Math.round(source.lastCheckAt)
      : null
  return {
    channel,
    feedUrl: normalizeUpdateFeedUrl(source.feedUrl),
    autoCheck: source.autoCheck !== false,
    lastCheckAt
  }
}

/**
 * Keeps the retention block in the shape the downloader and cache rely on.
 *
 * A config file is external input: it can be hand-edited, brought from another
 * machine, or written by a build that had a different set of modes. Reading it
 * defensively here means no caller needs a second guard.
 */
export function normalizeRetention(input: unknown): RetentionSettings {
  const source = isPlainObject(input) ? input : {}
  const defaults = DEFAULT_SETTINGS.retention
  const mode = RETENTION_MODES.includes(source.mode as RetentionMode)
    ? (source.mode as RetentionMode)
    : defaults.mode
  const downloadFormat = DOWNLOAD_FORMATS.includes(source.downloadFormat as DownloadFormat)
    ? (source.downloadFormat as DownloadFormat)
    : defaults.downloadFormat
  const qualityTier = QUALITY_TIERS.includes(source.qualityTier as QualityTier)
    ? (source.qualityTier as QualityTier)
    : defaults.qualityTier
  const folder = typeof source.downloadFolder === 'string' ? source.downloadFolder.trim() : ''
  return {
    mode,
    cacheBudgetMb:
      typeof source.cacheBudgetMb === 'number' && Number.isFinite(source.cacheBudgetMb)
        ? clampInt(source.cacheBudgetMb, 128, 1_000_000)
        : defaults.cacheBudgetMb,
    cacheMaxAgeDays:
      typeof source.cacheMaxAgeDays === 'number' && Number.isFinite(source.cacheMaxAgeDays)
        ? clampInt(source.cacheMaxAgeDays, 1, 3650)
        : defaults.cacheMaxAgeDays,
    downloadFolder: folder.length > 0 ? folder : null,
    downloadFormat,
    qualityTier
  }
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

    // All three retention modes now have an implementation, so the stored value
    // is honoured. Normalising it still matters: a hand-edited config, or one
    // written before a mode existed, must not reach the downloader or cache
    // with a value outside the contract.
    settings = { ...settings, retention: normalizeRetention(settings.retention) }
    settings = { ...settings, update: normalizeUpdate(settings.update) }
    settings = {
      ...settings,
      metadata: {
        // A key is external input like any other field; an invalid paste is
        // stored as "not configured" rather than reaching the service.
        acoustidKey: normalizeAcoustidKey(
          isPlainObject(settings.metadata) ? settings.metadata.acoustidKey : null
        )
      }
    }

    // The old surface value described the CSS blur as "frosted", but it is an
    // accent tint rather than an album-art frost. Accept the old spelling from
    // config files written by an earlier build and normalise it on read.
    const storedSurface = (settings.visuals as { surface?: unknown }).surface
    if (storedSurface === 'frosted') {
      settings = { ...settings, visuals: { ...settings.visuals, surface: 'accented' } }
    }

    // Keep the newer appearance values in their declared ranges even if the
    // config was edited by hand. Missing keys inherit the defaults, so configs
    // written before these settings existed keep opening normally.
    const storedVisuals = (settings.visuals ?? {}) as Partial<AppSettings['visuals']>
    settings = {
      ...settings,
      visuals: {
        ...DEFAULT_SETTINGS.visuals,
        ...storedVisuals,
        playlistArtworkSize: ARTWORK_SIZES.includes(storedVisuals.playlistArtworkSize as ArtworkSize)
          ? (storedVisuals.playlistArtworkSize as ArtworkSize)
          : DEFAULT_SETTINGS.visuals.playlistArtworkSize,
        textSize: TEXT_SIZES.includes(storedVisuals.textSize as TextSize)
          ? (storedVisuals.textSize as TextSize)
          : DEFAULT_SETTINGS.visuals.textSize,
        lyricsAlign: LYRICS_ALIGNS.includes(storedVisuals.lyricsAlign as LyricsAlign)
          ? (storedVisuals.lyricsAlign as LyricsAlign)
          : DEFAULT_SETTINGS.visuals.lyricsAlign,
        iconSet: ICON_SETS.includes(storedVisuals.iconSet as IconSet)
          ? (storedVisuals.iconSet as IconSet)
          : DEFAULT_SETTINGS.visuals.iconSet,
        showAlbumColumn: storedVisuals.showAlbumColumn !== false,
        showChannelColumn: storedVisuals.showChannelColumn !== false,
        heroSlideSeconds:
          typeof storedVisuals.heroSlideSeconds === 'number' &&
          Number.isFinite(storedVisuals.heroSlideSeconds)
            ? clampInt(
                storedVisuals.heroSlideSeconds,
                HERO_SLIDE_SECONDS_MIN,
                HERO_SLIDE_SECONDS_MAX
              )
            : DEFAULT_SETTINGS.visuals.heroSlideSeconds
      }
    }

    // Equaliser bands are an array, so the deep merge cannot repair a hand-edited
    // curve with the wrong length. Normalising on read also supplies the audio
    // section to configs written before it existed.
    settings = { ...settings, audio: normalizeAudioSettings(settings.audio) }

    // A hand-edited config is still input from outside the type system. Keep the
    // reliability controls in a shape the UI and argument builders can trust.
    const engine = settings.engine
    const interaction = isPlainObject(settings.interaction)
      ? (settings.interaction as Partial<AppSettings['interaction']>)
      : DEFAULT_SETTINGS.interaction
    const startup = isPlainObject(settings.startup) ? settings.startup : DEFAULT_SETTINGS.startup
    const backups = isPlainObject(settings.backups) ? settings.backups : DEFAULT_SETTINGS.backups
    settings = {
      ...settings,
      interaction: {
        ...DEFAULT_SETTINGS.interaction,
        ...interaction,
        volumeWheelStep:
          typeof interaction.volumeWheelStep === 'number' && Number.isFinite(interaction.volumeWheelStep)
            ? clampInt(interaction.volumeWheelStep, 1, 25)
            : DEFAULT_SETTINGS.interaction.volumeWheelStep
      },
      startup: {
        // Builds before the merge offered Downloads as a launch view. It is now
        // the Saved tab inside YouTube, so an old choice opens YouTube.
        view:
          (startup.view as string | undefined) === 'downloads'
            ? 'online'
            : isStartupView(startup.view)
              ? startup.view
              : DEFAULT_SETTINGS.startup.view,
        scanOnLaunch: startup.scanOnLaunch !== false,
        resumePlayback: startup.resumePlayback === true
      },
      backups: {
        retentionCount:
          typeof backups.retentionCount === 'number' && Number.isFinite(backups.retentionCount)
            ? clampInt(backups.retentionCount, 3, 50)
            : DEFAULT_SETTINGS.backups.retentionCount
      },
      // Local crash reports are opt-in. A hand-edited `"crashReports": "yes"`
      // must not silently switch them on.
      diagnostics: {
        crashReports: isPlainObject(settings.diagnostics) && settings.diagnostics.crashReports === true
      },
      engine: {
        ...engine,
        cookiesFromBrowser: isSupportedCookieBrowser(engine.cookiesFromBrowser)
          ? engine.cookiesFromBrowser
          : null,
        cookieBrowserProfile: normalizeCookieBrowserProfile(engine.cookieBrowserProfile),
        cookiesFile: normalizeCookiesFile(engine.cookiesFile),
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
