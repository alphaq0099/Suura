import { BrowserWindow } from 'electron'

/**
 * Pushes an event to every live renderer.
 *
 * Looked up at call time rather than captured, so the container can be built
 * before any window exists without a circular dependency.
 */
export function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send(channel, payload)
    }
  }
}
