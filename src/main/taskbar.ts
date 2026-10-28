import type { BrowserWindow } from 'electron'
import { EVENT_CHANNELS, type TaskbarState } from '@shared/ipc'
import { taskbarControls } from '@shared/taskbar'
import type { Logger } from '@core/logging/logger'
import { broadcast } from './broadcast'
import { taskbarIcon } from './taskbar-icons'

/**
 * Writes the Windows taskbar thumbnail toolbar for one window.
 *
 * This is the one system surface Electron exposes directly, unlike SMTC which
 * goes through the renderer's Media Session. Every click is broadcast on the
 * same `playerCommand` channel as the media keys, so the window does not need a
 * second command path.
 */
export function applyTaskbarControls(
  window: BrowserWindow,
  state: TaskbarState,
  log?: Logger
): boolean {
  if (process.platform !== 'win32') return false
  if (window.isDestroyed()) return false

  const buttons = taskbarControls(state.hasTrack, state.isPlaying).map((control) => ({
    icon: taskbarIcon(
      control.id === 'play-pause' ? (state.isPlaying ? 'pause' : 'play') : control.id
    ),
    tooltip: control.tooltip,
    click: () => broadcast(EVENT_CHANNELS.playerCommand, control.command)
  }))

  try {
    return window.setThumbarButtons(buttons)
  } catch (error) {
    // A thumbnail toolbar is a nicety. A shell that refuses it must not break
    // playback or spam the renderer with a failed state update.
    log?.warn('taskbar thumbnail buttons were not applied', { error })
    return false
  }
}
