import { BrowserWindow, screen, type Rectangle } from 'electron'

/**
 * A compact mode for the one real window.
 *
 * The player deliberately keeps a single renderer: a second BrowserWindow would
 * either duplicate the audio element or need a remote-control protocol just to
 * share a queue. Shrinking the existing window and letting the renderer swap to
 * a compact layout keeps playback, the queue and the keyboard shortcuts exactly
 * where they already are.
 *
 * The normal minimum size (940x580) is larger than the mini player, so it has to
 * be lowered while mini and restored when the full UI comes back. Bounds are
 * remembered too: exiting mini returns the window to the size and place it had
 * before, not to a default rectangle.
 */

const NORMAL_MIN_WIDTH = 940
const NORMAL_MIN_HEIGHT = 580
const MINI_WIDTH = 440
const MINI_HEIGHT = 190
const MINI_MIN_WIDTH = 380
const MINI_MIN_HEIGHT = 150

interface MiniState {
  normalBounds: Rectangle
  wasMaximized: boolean
  wasFullScreen: boolean
  wasAlwaysOnTop: boolean
}

const miniStates = new WeakMap<BrowserWindow, MiniState>()

export function isMiniPlayer(window: BrowserWindow): boolean {
  return miniStates.has(window)
}

/**
 * Enters or leaves mini mode. Returns the state the window is now in.
 *
 * Entering is idempotent: a tray click that races a renderer click must not
 * overwrite the saved normal bounds with the already-shrunk rectangle.
 */
export function setMiniPlayer(window: BrowserWindow, enabled: boolean): boolean {
  if (window.isDestroyed()) return false
  const active = miniStates.has(window)

  if (enabled && !active) {
    const current = window.getBounds()
    const normalBounds = window.getNormalBounds()
    // `getNormalBounds` is already the restore rectangle while maximised, but
    // reading it explicitly documents the intent and avoids saving a maximised
    // rectangle on a platform that reports one.
    const wasMaximized = window.isMaximized()
    const wasFullScreen = window.isFullScreen()
    miniStates.set(window, {
      normalBounds: wasMaximized || wasFullScreen ? normalBounds : current,
      wasMaximized,
      wasFullScreen,
      wasAlwaysOnTop: window.isAlwaysOnTop()
    })

    if (wasFullScreen) window.setFullScreen(false)
    if (wasMaximized) window.unmaximize()
    window.setMinimumSize(MINI_MIN_WIDTH, MINI_MIN_HEIGHT)
    window.setMaximizable(false)
    // Stay above the work the listener is doing: a mini player that hides
    // behind the browser is not a mini player. The normal window never sets
    // always-on-top, so restoring false is the same as restoring its default.
    window.setAlwaysOnTop(true, 'floating')

    const display = screen.getDisplayMatching(current)
    const width = Math.min(MINI_WIDTH, display.workArea.width)
    const height = Math.min(MINI_HEIGHT, display.workArea.height)
    window.setBounds(
      {
        x: Math.round(display.workArea.x + (display.workArea.width - width) / 2),
        y: Math.round(display.workArea.y + (display.workArea.height - height) / 2),
        width,
        height
      },
      true
    )
    return true
  }

  if (!enabled && active) {
    const state = miniStates.get(window)
    miniStates.delete(window)
    window.setAlwaysOnTop(state?.wasAlwaysOnTop ?? false)
    window.setMaximizable(true)
    window.setMinimumSize(NORMAL_MIN_WIDTH, NORMAL_MIN_HEIGHT)
    if (state) window.setBounds(state.normalBounds, true)
    if (state?.wasMaximized) window.maximize()
    if (state?.wasFullScreen) window.setFullScreen(true)
    return false
  }

  return active
}
