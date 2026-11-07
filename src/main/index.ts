import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog } from 'electron'
import { registerIpcHandlers } from './ipc'
import { installArtworkProtocolHandler } from './artwork-protocol'
import { registerMediaKeys } from './media-keys'
import { installMediaProtocolHandler } from './media-protocol'
import { registerPrivilegedSchemes } from './schemes'
import { installStreamProtocolHandler } from './stream-protocol'
import { checkScaleBudgets, runScaleCheck, seedScaleLibrary } from './scale-check'
import { runSelfTest } from './selftest'
import { createContainer, type AppContainer } from './services/container'
import { LibraryOpenCancelledError } from './db-recovery'
import { installTray, type TrayController } from './tray'
import { createMainWindow } from './window'

// `npm run selftest` drives an end-to-end check and exits with a status code.
// `npm run scale` measures the M1 size target against a real 10,000-track
// library, including cold start and first audio, which need a window.
// `npm run perf` enforces only the core budgets, so it can run on a CI machine
// with no desktop or audio device. None of them may read or write the real
// library, so all three run against a throwaway userData directory that is
// deleted afterwards.
const SELFTEST = process.argv.includes('--selftest')
const SCALE = process.argv.includes('--scale')
const PERF = process.argv.includes('--perf')
const HEADLESS = SELFTEST || SCALE || PERF
const HEADLESS_KIND = SELFTEST ? 'selftest' : SCALE ? 'scale' : 'perf'
// The automated runs drive the UI while it sits behind another window, so they
// need timers and animation frames to keep running. The real app lets Chromium
// throttle a hidden window normally; playback keeps its own timers alive.
const WINDOW_OPTIONS = { backgroundThrottling: !(SELFTEST || SCALE) }
let headlessDataDir: string | null = null

// The headless runs use throwaway settings, so an automatic `yt-dlp -U` would
// be a real network request with no lasting benefit, and it could race the
// tests that probe the binary.
if (HEADLESS) process.env.PLAYER_SKIP_ENGINE_UPDATE = '1'

if (HEADLESS) {
  headlessDataDir = join(tmpdir(), `player-${HEADLESS_KIND}-${Date.now()}`)
  app.setPath('userData', headlessDataDir)
}

// Must run before the app is ready, or the custom schemes are treated as opaque
// non-standard ones and <audio> will not stream from player-media://.
registerPrivilegedSchemes()

// Grouping id for the Windows taskbar and for notifications (M2).
app.setAppUserModelId('com.suura.desktop')

let container: AppContainer | null = null
let releaseMediaKeys: (() => void) | null = null
let tray: TrayController | null = null
/** True once the app is really leaving, so close-to-tray stops intercepting. */
let quitting = false

/**
 * Brings the one window back from the tray, the taskbar, or another launch.
 * Hidden and minimised are different states and both need undoing.
 */
function focusWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
}

async function shutdownHeadlessDirectory(): Promise<void> {
  if (!headlessDataDir) return
  // Close the database before deleting its folder: Windows refuses to remove a
  // file that is still open, and the `rm` below swallows errors, so the leak
  // would be silent. A run that opened a window still leaves Chromium's own
  // cache directories behind, because the browser process holds them until it
  // exits; `--perf`, the mode meant for CI, opens no window and removes
  // everything.
  container?.dispose()
  container = null
  await rm(headlessDataDir, { recursive: true, force: true }).catch(() => undefined)
}

function start(): void {
  app
    .whenReady()
    .then(async () => {
      const appContainer = createContainer({ interactive: !HEADLESS })
      container = appContainer

      // `npm run perf` stops here: the budgets below are about the core, so it
      // opens no window, grabs no media keys and needs no audio device. That is
      // what makes it safe to run on a CI machine, and why it exits non-zero on
      // a miss instead of leaving a number in a log for someone to notice.
      if (PERF) {
        const summary = await seedScaleLibrary(appContainer)
        const failures = checkScaleBudgets(summary)
        appContainer.log.info('perf check complete', { failures })
        await shutdownHeadlessDirectory()
        app.exit(failures === 0 ? 0 : 1)
        return
      }

      installMediaProtocolHandler({
        isPathAllowed: (filePath) =>
          appContainer.library.isPathAllowed(filePath) ||
          appContainer.streamCache.isPathAllowed(filePath),
        log: appContainer.log.child('media')
      })

      installArtworkProtocolHandler({
        artwork: appContainer.artwork,
        log: appContainer.log.child('artwork')
      })

      installStreamProtocolHandler({
        proxy: appContainer.youtube.proxy,
        log: appContainer.log.child('stream')
      })

      registerIpcHandlers(appContainer)

      // Built before the window exists on purpose: the first paint is then a
      // cold start against a full library, which is the number being measured.
      const scale = SCALE ? await seedScaleLibrary(appContainer) : null
      // `npm run scale` enforces the core budgets as well, so the manual run and
      // the headless CI run agree about what "fast enough" means.
      const coreFailures = scale ? checkScaleBudgets(scale) : 0
      const windowStartedAt = Date.now()
      const window = createMainWindow(appContainer.log.child('window'), {
        ...WINDOW_OPTIONS,
        crashes: appContainer.crashes
      })

      if (!HEADLESS) {
        tray = installTray({ window, log: appContainer.log.child('tray') })
        window.on('close', (event) => {
          if (quitting || !tray) return
          if (!appContainer.settings.get().desktop.closeToTray) return
          event.preventDefault()
          window.hide()
        })
      }

      if (SELFTEST) {
        window.webContents.once('did-finish-load', () => {
          void runSelfTest(window, appContainer).then(async (failures) => {
            appContainer.log.info('selftest complete', { failures })
            // Let the log flush, then tear down and report.
            setTimeout(() => {
              void shutdownHeadlessDirectory().finally(() => app.exit(failures === 0 ? 0 : 1))
            }, 200)
          })
        })
        return
      }

      if (scale) {
        const summary = scale
        window.webContents.once('did-finish-load', () => {
          void runScaleCheck(window, windowStartedAt, summary).then((failures) => {
            const total = failures + coreFailures
            appContainer.log.info('scale check complete', { failures: total, coreFailures })
            setTimeout(() => {
              void shutdownHeadlessDirectory().finally(() => app.exit(total === 0 ? 0 : 1))
            }, 200)
          })
        })
        return
      }

      // Grabbing the media keys is global, so it is skipped under --selftest to
      // keep the run from stealing them from whatever is actually playing.
      releaseMediaKeys = registerMediaKeys(appContainer.log.child('media-keys'))

      app.on('activate', () => {
        const [existing] = BrowserWindow.getAllWindows()
        if (existing) focusWindow(existing)
        else
          createMainWindow(appContainer.log.child('window'), {
            ...WINDOW_OPTIONS,
            crashes: appContainer.crashes
          })
      })
    })
    .catch((error: unknown) => {
      // The user answered "Quit" in the damaged-library dialog. That is a
      // decision, not a failure, so it leaves without an error box.
      if (error instanceof LibraryOpenCancelledError) {
        app.exit(0)
        return
      }
      // Without a window there is nowhere to show this, so it goes to the log file
      // and stderr, and the process exits non-zero rather than hanging invisibly.
      console.error('Failed to start Suura:', error)
      container?.log.error('startup failed', error)
      if (!HEADLESS) {
        dialog.showErrorBox(
          'Suura could not open its library',
          error instanceof Error ? error.message : String(error)
        )
      }
      app.exit(1)
    })
}

if (HEADLESS) {
  // A single-instance lock would make the self-test a no-op whenever the real app
  // happens to be open.
  start()
} else if (!app.requestSingleInstanceLock()) {
  // A second launch would open the same SQLite file and the same log; focus the
  // existing window instead of starting a rival process.
  app.quit()
} else {
  app.on('second-instance', () => {
    const [existing] = BrowserWindow.getAllWindows()
    if (existing) focusWindow(existing)
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  start()
}

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  releaseMediaKeys?.()
  releaseMediaKeys = null
  tray?.destroy()
  tray = null
  container?.dispose()
  container = null
})
