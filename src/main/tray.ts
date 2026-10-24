import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import { IPC_EVENTS, type PlayerCommand } from '@shared/ipc'
import type { Logger } from '@core/logging/logger'
import { broadcast } from './broadcast'
import { TRAY_ICON_DATA_URL } from './tray-icon'

/**
 * The tray icon and its menu.
 *
 * A tray icon is the other half of close-to-tray: hiding the window is only
 * reasonable if there is an obvious way back. The menu intentionally mirrors
 * the media keys and adds only the three window actions a hidden player cannot
 * reach any other way (show, mini, quit).
 *
 * `null` means the platform refused a tray (for example, a Linux desktop with
 * no status-notifier host). The caller must then leave close-to-tray alone, or
 * closing the window would strand a running, invisible process.
 */
export interface TrayController {
  destroy(): void
}

export interface TrayOptions {
  window: BrowserWindow
  log: Logger
}

export function installTray({ window, log }: TrayOptions): TrayController | null {
  let tray: Tray
  try {
    const image = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
    if (image.isEmpty()) throw new Error('The embedded tray image could not be decoded.')
    tray = new Tray(image)
  } catch (error) {
    log.warn('tray icon is unavailable; close-to-tray stays disabled', error)
    return null
  }

  tray.setToolTip('Player')

  const send = (command: PlayerCommand): void => {
    broadcast(IPC_EVENTS.playerCommand, command)
  }

  const showWindow = (): void => {
    if (window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  const windowIsOpen = (): boolean => {
    return !window.isDestroyed() && window.isVisible() && !window.isMinimized()
  }

  const buildMenu = (): Menu => {
    const open = windowIsOpen()
    return Menu.buildFromTemplate([
      {
        label: open ? 'Hide Player' : 'Show Player',
        click: () => {
          if (window.isDestroyed()) return
          // Read the state at click time: the menu can outlive the visibility
          // that built it by a few milliseconds.
          if (windowIsOpen()) window.hide()
          else showWindow()
        }
      },
      {
        // This asks the renderer to toggle because the renderer owns the
        // compact layout. The main process only resizes in response.
        label: 'Toggle mini player',
        click: () => {
          showWindow()
          send({ type: 'mini-player' })
        }
      },
      { type: 'separator' },
      { label: 'Play / Pause', click: () => send({ type: 'play-pause' }) },
      { label: 'Previous', click: () => send({ type: 'prev' }) },
      { label: 'Next', click: () => send({ type: 'next' }) },
      { type: 'separator' },
      {
        label: 'Quit Player',
        click: () => app.quit()
      }
    ])
  }

  const refresh = (): void => {
    if (tray.isDestroyed()) return
    tray.setContextMenu(buildMenu())
  }

  // Left click is "bring it back" on Windows and most Linux trays; the context
  // menu is the right-click gesture. Double-click covers the tray hosts that do
  // not send a single click.
  tray.on('click', showWindow)
  tray.on('double-click', showWindow)
  refresh()

  // The menu's first item says Show or Hide, which is only true if it follows
  // the window. These events cover every way the window's visibility changes:
  // user close-to-tray, the menu itself, minimise and taskbar restore.
  window.on('show', refresh)
  window.on('hide', refresh)
  window.on('minimize', refresh)
  window.on('restore', refresh)

  return {
    destroy: () => {
      window.removeListener('show', refresh)
      window.removeListener('hide', refresh)
      window.removeListener('minimize', refresh)
      window.removeListener('restore', refresh)
      if (!tray.isDestroyed()) tray.destroy()
    }
  }
}
