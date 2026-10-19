import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow } from 'electron'
import { registerIpcHandlers } from './ipc'
import { installArtworkProtocolHandler } from './artwork-protocol'
import { registerMediaKeys } from './media-keys'
import { installMediaProtocolHandler } from './media-protocol'
import { registerPrivilegedSchemes } from './schemes'
import { installStreamProtocolHandler } from './stream-protocol'
import { runScaleCheck, seedScaleLibrary } from './scale-check'
import { runSelfTest } from './selftest'
import { createContainer, type AppContainer } from './services/container'
import { createMainWindow } from './window'

// `npm run selftest` drives an end-to-end check and exits with a status code.
// `npm run scale` measures the M1 size target against a real 10,000-track
// library. Neither may read or write the real one, so both run against a
// throwaway userData directory that is deleted afterwards.
const SELFTEST = process.argv.includes('--selftest')
const SCALE = process.argv.includes('--scale')
const HEADLESS = SELFTEST || SCALE
let headlessDataDir: string | null = null

if (HEADLESS) {
  headlessDataDir = join(tmpdir(), `player-${SELFTEST ? 'selftest' : 'scale'}-${Date.now()}`)
  app.setPath('userData', headlessDataDir)
}

// Must run before the app is ready, or the custom schemes are treated as opaque
// non-standard ones and <audio> will not stream from player-media://.
registerPrivilegedSchemes()

// Grouping id for the Windows taskbar and for notifications (M2).
app.setAppUserModelId('com.player.desktop')

let container: AppContainer | null = null
let releaseMediaKeys: (() => void) | null = null

async function shutdownHeadlessDirectory(): Promise<void> {
  if (!headlessDataDir) return
  await rm(headlessDataDir, { recursive: true, force: true }).catch(() => undefined)
}

function start(): void {
  app
    .whenReady()
    .then(async () => {
      const appContainer = createContainer()
      container = appContainer

      installMediaProtocolHandler({
        isPathAllowed: (filePath) => appContainer.library.isPathAllowed(filePath),
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
      const windowStartedAt = Date.now()
      const window = createMainWindow(appContainer.log.child('window'))

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
            appContainer.log.info('scale check complete', { failures })
            setTimeout(() => {
              void shutdownHeadlessDirectory().finally(() => app.exit(failures === 0 ? 0 : 1))
            }, 200)
          })
        })
        return
      }

      // Grabbing the media keys is global, so it is skipped under --selftest to
      // keep the run from stealing them from whatever is actually playing.
      releaseMediaKeys = registerMediaKeys(appContainer.log.child('media-keys'))

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow(appContainer.log.child('window'))
      })
    })
    .catch((error: unknown) => {
      // Without a window there is nowhere to show this, so it goes to the log file
      // and stderr, and the process exits non-zero rather than hanging invisibly.
      console.error('Failed to start Player:', error)
      container?.log.error('startup failed', error)
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
    if (!existing) return
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })

  start()
}

app.on('will-quit', () => {
  releaseMediaKeys?.()
  releaseMediaKeys = null
  container?.dispose()
  container = null
})
