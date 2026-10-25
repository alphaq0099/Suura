import { join } from 'node:path'
import { BrowserWindow, nativeTheme, shell } from 'electron'
import type { Logger } from '@core/logging/logger'

/**
 * The single application window.
 *
 * Renderer security posture: context isolation on, node integration off and the
 * renderer sandboxed. The preload bridge is the only way the UI can reach the
 * main process, and it only pulls `electron` plus the shared channel constants.
 */
export function createMainWindow(log: Logger): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 940,
    minHeight: 580,
    show: false,
    title: 'Player',
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
      autoplayPolicy: 'no-user-gesture-required'
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
  })
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    log.error('preload script threw', { preloadPath, error })
  })

  // Links in the UI open in the real browser, never in an app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

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
