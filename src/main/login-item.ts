import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Logger } from '@core/logging/logger'

/**
 * The "start when I sign in" switch is the one preference that lives outside the
 * config file, because each desktop keeps its own autostart list. Windows uses a
 * `Run` value, Linux a desktop entry in `~/.config/autostart`.
 *
 * Two rules keep that safe:
 *
 * - Only a packaged build may write the entry. In development and in the
 *   self-test the executable is `electron.exe` (or the Electron binary inside
 *   `node_modules`), so registering it would leave a broken autostart item on
 *   the developer's machine.
 * - The config is the source of truth. This runs at launch as well as on every
 *   change, so a reinstall rebuilds the entry and turning the switch off removes
 *   it even if the list was edited by hand.
 *
 * The calls are synchronous on purpose: one small file, written at startup or
 * when the switch moves, and the caller is a settings listener with nowhere to
 * put a rejected promise.
 *
 * Returns whether the OS was actually changed, which the self-test logs without
 * asserting: an unpackaged run must not fail because it refused to write.
 */
export function applyStartOnLogin(enabled: boolean, log: Logger): boolean {
  if (!app.isPackaged) {
    log.debug('start at sign-in left alone in an unpackaged build', { enabled })
    return false
  }
  if (process.platform === 'win32') return applyWindows(enabled, log)
  if (process.platform === 'linux') return applyLinux(enabled, log)
  return false
}

function applyWindows(enabled: boolean, log: Logger): boolean {
  const current = app.getLoginItemSettings().openAtLogin
  if (current === enabled) return false
  app.setLoginItemSettings({ openAtLogin: enabled })
  log.info('start at sign-in changed', { platform: 'win32', enabled })
  return true
}

/**
 * The desktop entry's `Exec` value.
 *
 * An AppImage runs from a temporary mount that disappears at reboot, so
 * `app.getPath('exe')` would name a path that no longer exists. Electron exports
 * the outer `.AppImage` path as `APPIMAGE`, which is the one to register.
 */
function launchCommand(): string {
  const exe = process.env.APPIMAGE ?? app.getPath('exe')
  // Desktop Entry spec: quote the argument and escape the four characters that
  // are special inside a quoted string.
  return `"${exe.replace(/(["`$\\])/g, '\\$1')}"`
}

function autostartDirectory(): string {
  const configHome = process.env.XDG_CONFIG_HOME?.trim()
  return join(configHome && configHome.length > 0 ? configHome : join(homedir(), '.config'), 'autostart')
}

function desktopEntry(): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Suura',
    'Comment=Desktop music player',
    `Exec=${launchCommand()}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n')
}

function applyLinux(enabled: boolean, log: Logger): boolean {
  const file = join(autostartDirectory(), 'suura.desktop')
  if (!enabled) {
    if (!existsSync(file)) return false
    rmSync(file, { force: true })
    log.info('start at sign-in changed', { platform: 'linux', enabled })
    return true
  }

  const content = desktopEntry()
  const current = existsSync(file) ? readFileSync(file, 'utf8') : null
  if (current === content) return false
  mkdirSync(autostartDirectory(), { recursive: true })
  writeFileSync(file, content, { mode: 0o644 })
  log.info('start at sign-in changed', { platform: 'linux', enabled })
  return true
}
