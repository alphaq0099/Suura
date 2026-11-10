import { app } from 'electron'
import {
  autoUpdater,
  type AppUpdater,
  type ProgressInfo,
  type UpdateInfo
} from 'electron-updater'
import type { Logger } from '@core/logging/logger'
import type { SettingsService } from '@core/settings/settings-service'
import type { UpdateChannel, UpdateStatus } from '@shared/types'
import { canUpdateInPlace } from '@shared/platform'
import { resolveUpdateFeedUrl, updateChannelFileName } from '@shared/update'

/**
 * The app's update channel, built on electron-updater's generic provider.
 *
 * The feed is a static HTTPS folder holding `latest.yml`/`beta.yml` on Windows
 * and `latest-linux.yml`/`beta-linux.yml` on Linux, the build that file names,
 * and its blockmap. There is no update server to run: any static host works, and
 * the URL is a setting so a private mirror can be used without a rebuild.
 *
 * Three deliberate rules:
 *
 * - Nothing is checked until a feed is configured. A missing host is a clear
 *   "not configured" state, not a failed request on every launch.
 * - A check never installs anything by itself. It finds a version, the user
 *   downloads it, and "Restart and install" is the only path that quits.
 * - A build that cannot replace itself says so. A `.deb` belongs to the package
 *   manager, so the app does not offer an in-app update that would need root.
 */

/** Let the window and the first scan settle before asking the network. */
const AUTO_CHECK_DELAY_MS = 30_000
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60_000

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Maps electron-updater's codes to sentences a user can act on. */
export function describeUpdateError(error: unknown, channel: UpdateChannel, platform: string): string {
  const message = messageOf(error)
  if (message.includes('ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')) {
    const file = updateChannelFileName(channel, platform)
    return `The update feed has no ${file}. Check the feed URL and channel.`
  }
  if (message.includes('ERR_UPDATER_INVALID_UPDATE_INFO')) {
    return 'The update feed returned an unreadable release file. Check that the host serves the generated YAML unchanged.'
  }
  if (message.includes('net::') || message.includes('ENOTFOUND') || message.includes('ECONN')) {
    return 'Could not reach the update feed. Check the connection and the feed URL.'
  }
  return message
}

export interface UpdateServiceOptions {
  settings: SettingsService
  log: Logger
  onChange?: (status: UpdateStatus) => void
  /** Overridable for tests: the service must stay dormant when not packaged. */
  isPackaged?: () => boolean
  /** Overridable for tests: a `.deb` install cannot replace itself. */
  canUpdate?: () => boolean
  /** Overridable for tests so nothing is downloaded or installed. */
  updater?: AppUpdater
  now?: () => number
}

export class UpdateService {
  private readonly updater: AppUpdater
  private readonly isPackaged: () => boolean
  private readonly canUpdate: () => boolean
  private readonly now: () => number
  private status: UpdateStatus
  private configured = false
  private autoCheckTimer: ReturnType<typeof setTimeout> | null = null
  private readonly unsubscribe: () => void
  private readonly listeners: Array<() => void> = []

  constructor(private readonly deps: UpdateServiceOptions) {
    this.updater = deps.updater ?? autoUpdater
    this.isPackaged = deps.isPackaged ?? (() => app.isPackaged)
    this.canUpdate = deps.canUpdate ?? (() => canUpdateInPlace(process.platform, process.env))
    this.now = deps.now ?? Date.now
    this.status = this.disabledStatus()

    // Never download or install behind the user's back. The status event is
    // the only way a downloaded update is announced.
    this.updater.autoDownload = false
    this.updater.autoInstallOnAppQuit = false

    this.listen(updaterListener(this.updater, 'checking-for-update', () => {
      this.set({ state: 'checking', percent: null, message: 'Checking for updates…' })
    }))
    this.listen(updaterListener(this.updater, 'update-available', (info: UpdateInfo) => {
      this.set({
        state: 'available',
        availableVersion: info.version,
        percent: null,
        canInstall: false,
        message: `Suura ${info.version} is available.`
      })
    }))
    this.listen(updaterListener(this.updater, 'update-not-available', (info: UpdateInfo) => {
      this.set({
        state: 'up-to-date',
        availableVersion: null,
        percent: null,
        canInstall: false,
        message: `Suura ${info.version} is the newest version on this channel.`
      })
    }))
    this.listen(updaterListener(this.updater, 'download-progress', (progress: ProgressInfo) => {
      this.set({
        state: 'downloading',
        percent: clampPercent(progress.percent),
        message: `Downloading Suura ${this.status.availableVersion ?? ''}`.trim()
      })
    }))
    this.listen(updaterListener(this.updater, 'update-downloaded', (info: UpdateInfo) => {
      this.set({
        state: 'ready',
        availableVersion: info.version,
        percent: 100,
        canInstall: true,
        message: `Suura ${info.version} is downloaded. Restart to install it.`
      })
    }))
    this.listen(updaterListener(this.updater, 'error', (error: Error) => {
      const channel = this.deps.settings.get().update.channel
      this.set({
        state: 'error',
        percent: null,
        canInstall: false,
        message: describeUpdateError(error, channel, process.platform)
      })
    }))

    this.unsubscribe = this.deps.settings.onChange(() => this.applySettings())
    this.applySettings()
  }

  statusSnapshot(): UpdateStatus {
    return { ...this.status }
  }

  /** Settings' "Check now" and the daily automatic check. */
  async checkNow(): Promise<UpdateStatus> {
    if (!this.configured) return this.statusSnapshot()
    if (this.status.state === 'checking' || this.status.state === 'downloading' || this.status.state === 'ready') {
      return this.statusSnapshot()
    }

    this.set({ state: 'checking', percent: null, message: 'Checking for updates…' })
    try {
      const result = await this.updater.checkForUpdates()
      // Normally the event handlers have already answered. If a build does not
      // emit them, do not leave the UI on "checking".
      if (this.statusSnapshot().state === 'checking') {
        this.set({
          state: 'up-to-date',
          message: result?.updateInfo
            ? `The feed was checked; it lists version ${result.updateInfo.version}.`
            : 'No update information was returned.'
        })
      }
    } catch (error) {
      const channel = this.deps.settings.get().update.channel
      this.deps.log.warn('update check failed', error)
      this.set({
        state: 'error',
        percent: null,
        canInstall: false,
        message: describeUpdateError(error, channel, process.platform)
      })
    }

    // Record the attempt even on failure, so a host that is down is not asked
    // again on every single launch.
    this.deps.settings.update({ update: { lastCheckAt: this.now() } })
    return this.statusSnapshot()
  }

  async downloadNow(): Promise<UpdateStatus> {
    if (!this.configured) return this.statusSnapshot()
    if (this.status.state !== 'available') return this.statusSnapshot()
    this.set({
      state: 'downloading',
      percent: 0,
      message: `Downloading Suura ${this.status.availableVersion ?? ''}`.trim()
    })
    try {
      await this.updater.downloadUpdate()
      if (this.statusSnapshot().state === 'downloading') {
        this.set({ state: 'available', percent: null, message: 'The download finished without a ready signal.' })
      }
    } catch (error) {
      const channel = this.deps.settings.get().update.channel
      this.deps.log.warn('update download failed', error)
      this.set({
        state: 'error',
        percent: null,
        canInstall: false,
        message: describeUpdateError(error, channel, process.platform)
      })
    }
    return this.statusSnapshot()
  }

  /** Quits and runs the downloaded installer. Only valid in `ready`. */
  installNow(): boolean {
    if (!this.status.canInstall) return false
    this.deps.log.info('installing update', { version: this.status.availableVersion })
    this.updater.quitAndInstall(false, true)
    return true
  }

  /** Arms the one check per day, after the window has settled. */
  scheduleAutoCheck(): void {
    if (this.autoCheckTimer) return
    if (!this.isSupported()) return
    const settings = this.deps.settings.get().update
    if (!settings.autoCheck || !settings.feedUrl) return
    const last = typeof settings.lastCheckAt === 'number' ? settings.lastCheckAt : 0
    if (this.now() - last < AUTO_CHECK_INTERVAL_MS) return

    this.autoCheckTimer = setTimeout(() => {
      this.autoCheckTimer = null
      const current = this.deps.settings.get().update
      const checkedAt = typeof current.lastCheckAt === 'number' ? current.lastCheckAt : 0
      if (!current.autoCheck || !current.feedUrl) return
      if (this.now() - checkedAt < AUTO_CHECK_INTERVAL_MS) return
      void this.checkNow()
    }, AUTO_CHECK_DELAY_MS)
    this.autoCheckTimer.unref?.()
  }

  dispose(): void {
    this.unsubscribe()
    if (this.autoCheckTimer) {
      clearTimeout(this.autoCheckTimer)
      this.autoCheckTimer = null
    }
    for (const remove of this.listeners) remove()
    this.listeners.length = 0
  }

  private listen(remove: () => void): void {
    this.listeners.push(remove)
  }

  private set(patch: Partial<UpdateStatus>): void {
    this.status = { ...this.status, ...patch }
    this.deps.onChange?.(this.statusSnapshot())
  }

  /** False for a development run and for a package it cannot replace. */
  private isSupported(): boolean {
    return this.isPackaged() && this.canUpdate()
  }

  /** Why updates are off, in one sentence the About card can show. */
  private unsupportedMessage(): string {
    if (!this.isPackaged()) return 'Updates are only available in an installed build.'
    if (process.platform === 'linux') {
      return 'This build updates through your package manager. The AppImage can update in place.'
    }
    return 'This build cannot install an update in place.'
  }

  private disabledStatus(): UpdateStatus {
    const settings = this.deps.settings.get().update
    const supported = this.isSupported()
    const feedUrl = resolveUpdateFeedUrl(settings.feedUrl, settings.channel, process.platform)
    return {
      state: 'disabled',
      currentVersion: app.getVersion(),
      availableVersion: null,
      percent: null,
      feedUrl,
      message: supported
        ? feedUrl
          ? null
          : 'No update feed is configured. Set the feed URL below to enable updates.'
        : this.unsupportedMessage(),
      supported,
      canInstall: false,
      lastCheckAt: settings.lastCheckAt
    }
  }

  private applySettings(): void {
    const settings = this.deps.settings.get().update
    const supported = this.isSupported()
    const feedUrl = resolveUpdateFeedUrl(settings.feedUrl, settings.channel, process.platform)
    const base = settings.feedUrl
    const configured = supported && base !== null && feedUrl !== null

    if (configured && base) {
      try {
        this.updater.setFeedURL({
          provider: 'generic',
          url: base.replace(/\/+$/, ''),
          // electron-builder names the stable file `latest.yml`; passing
          // "stable" here would ask for a file that is never generated.
          channel: settings.channel === 'beta' ? 'beta' : 'latest'
        })
      } catch (error) {
        this.deps.log.warn('could not configure the update feed', error)
        this.configured = false
        this.status = {
          ...this.status,
          state: 'disabled',
          feedUrl,
          supported,
          canInstall: false,
          message: describeUpdateError(error, settings.channel, process.platform)
        }
        this.deps.onChange?.(this.statusSnapshot())
        return
      }
    }

    this.configured = configured
    if (!configured) {
      this.status = {
        ...this.status,
        state: 'disabled',
        feedUrl,
        supported,
        canInstall: false,
        availableVersion: null,
        percent: null,
        message: supported
          ? feedUrl
            ? null
            : 'No update feed is configured. Set the feed URL below to enable updates.'
          : this.unsupportedMessage(),
        lastCheckAt: settings.lastCheckAt
      }
      this.deps.onChange?.(this.statusSnapshot())
      return
    }

    this.status = {
      ...this.status,
      feedUrl,
      supported,
      lastCheckAt: settings.lastCheckAt,
      // Leaving "disabled" is the only state transition caused by settings.
      // A check in flight keeps its own state.
      ...(this.status.state === 'disabled'
        ? { state: 'idle' as const, message: 'Ready to check for updates.' }
        : {})
    }
    this.deps.onChange?.(this.statusSnapshot())
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

/**
 * `AppUpdater` is an EventEmitter, but its typings differ between versions and
 * the overloaded `on` confuses TypeScript when the event name is a variable.
 * This keeps the cast in one place.
 */
function updaterListener(
  updater: AppUpdater,
  event: string,
  listener: (payload: never) => void
): () => void {
  const emitter = updater as unknown as {
    on(name: string, handler: (payload: unknown) => void): void
    removeListener(name: string, handler: (payload: unknown) => void): void
  }
  const handler = (payload: unknown): void => listener(payload as never)
  emitter.on(event, handler)
  return () => emitter.removeListener(event, handler)
}
