import { join } from 'node:path'
import { BrowserWindow, nativeTheme, shell } from 'electron'
import type { Logger } from '@core/logging/logger'
import type { CrashReporter } from './crash-reports'

/**
 * The single application window.
 *
 * Renderer security posture: context isolation on, node integration off and the
 * renderer sandboxed. The preload bridge is the only way the UI can reach the
 * main process, and it only pulls `electron` plus the shared channel constants.
 */
export interface MainWindowOptions {
  /**
   * Keep timers and animation frames running while the window is hidden.
   *
   * Only the self-test and scale runs need this: they drive the UI while it is
   * behind another window, and a throttled renderer would make those checks
   * time out. The real app lets Chromium throttle normally, which is what keeps
   * a minimised player from costing a core.
   */
  backgroundThrottling?: boolean
  /** Records renderer crashes locally when the user has opted in. */
  crashes?: CrashReporter
}

/**
 * Opens a web link in the real browser and nothing else.
 *
 * `shell.openExternal` will happily hand any scheme — `file:`, `ms-settings:`,
 * a registered protocol handler — to Windows. Only http(s) is a link the UI
 * should be able to produce, so everything else is dropped.
 */
function openExternalSafely(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(url)
  } catch {
    // A malformed URL never reaches the shell.
  }
}

export function createMainWindow(log: Logger, options: MainWindowOptions = {}): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 940,
    minHeight: 580,
    show: false,
    title: 'Suura',
    // The container has already applied the saved theme to nativeTheme, so the
    // window's first paint matches the palette instead of flashing dark over a
    // cream desktop.
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1016' : '#f2ece1',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Playback is always click-initiated today, but this keeps a future
      // "resume on launch" or tray-triggered play from being blocked.
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: options.backgroundThrottling ?? true
    }
  })

  window.once('ready-to-show', () => window.show())

  // A renderer that fails to load, crashes, or whose preload threw produces a
  // blank window with nothing in the log. These handlers turn that into a
  // diagnosable error, which is worth the few lines.
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    log.error('renderer failed to load', { errorCode, errorDescription, validatedUrl })
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    log.error('renderer process gone', { reason: details.reason, exitCode: details.exitCode })
    // A normal teardown is not a crash and should not leave a report behind.
    if (details.reason === 'clean-exit') return
    options.crashes?.record({
      kind: 'renderer',
      reason: details.reason,
      exitCode: details.exitCode
    })
  })
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    log.error('preload script threw', { preloadPath, error })
  })

  // Links in the UI open in the real browser, never in an app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })

  // The app is a single page, so any navigation away from it is either a bug or
  // an injected link. Allow the page to reload itself; send web links out and
  // drop everything else.
  window.webContents.on('will-navigate', (event, url) => {
    if (url === window.webContents.getURL()) return
    event.preventDefault()
    openExternalSafely(url)
  })

  // The UI needs no device permission at all: clipboard access goes through IPC
  // and playback is a local file or stream. Denying by default means a bug or a
  // stray page cannot reach the camera, the microphone or the location.
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => {
    callback(false)
  })
  window.webContents.session.setPermissionCheckHandler(() => false)

  // electron-vite sets this in dev; production loads the built HTML.
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (devServerUrl) {
    log.info('loading renderer from dev server', { devServerUrl })
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}
