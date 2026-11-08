import { app } from 'electron'
import type { Logger } from '@core/logging/logger'

/**
 * The "start with Windows" switch is the one preference that lives outside the
 * config file. Windows keeps its own sign-in entry, and Electron writes it under
 * the app's name pointing at the executable that is running.
 *
 * Two rules keep that safe:
 *
 * - Only a packaged build may touch the registry. In development and in the
 *   self-test the executable is electron.exe, so registering it would leave a
 *   broken autostart item on the developer's machine.
 * - The config is the source of truth. This runs at launch as well as on every
 *   change, so a reinstall rebuilds the entry and turning the switch off removes
 *   it even if the registry was edited by hand.
 *
 * Returns whether the OS was actually changed, which the self-test logs without
 * asserting: an unpackaged run must not fail because it refused to write.
 */
export function applyStartOnLogin(enabled: boolean, log: Logger): boolean {
  if (process.platform !== 'win32') return false
  if (!app.isPackaged) {
    log.debug('start with Windows left alone in an unpackaged build', { enabled })
    return false
  }
  const current = app.getLoginItemSettings().openAtLogin
  if (current === enabled) return false
  app.setLoginItemSettings({ openAtLogin: enabled })
  log.info('start with Windows changed', { enabled })
  return true
}
