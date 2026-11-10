/**
 * Platform facts the main process and the tests must agree on.
 *
 * Kept free of Electron so the smoke suite can load it in plain Node: the
 * answer depends on the platform and the session environment, not on the app.
 */

/**
 * Whether global key grabs are possible at all.
 *
 * X11 lets a client take a key from every application. Wayland does not: the
 * compositor owns the key and there is no equivalent outside the XDG portal's
 * GlobalShortcuts interface. `XDG_SESSION_TYPE` is what the desktop sets;
 * `WAYLAND_DISPLAY` is checked as well because a nested session may leave the
 * type unset.
 */
export function hasGlobalMediaKeys(platform: string, env: Record<string, string | undefined>): boolean {
  if (platform !== 'linux') return true
  return env.XDG_SESSION_TYPE !== 'wayland' && !env.WAYLAND_DISPLAY
}

/**
 * Whether this build can replace itself with a downloaded update.
 *
 * Windows ships an NSIS installer, which electron-updater runs on quit. On
 * Linux only an AppImage can be replaced in place: the AppImage runtime sets
 * `APPIMAGE`, and electron-updater renames the new file over it. A `.deb`
 * belongs to `dpkg`, so offering an in-app update there would ask for a root
 * password and then fail against a feed that does not serve the package.
 */
export function canUpdateInPlace(platform: string, env: Record<string, string | undefined>): boolean {
  if (platform === 'win32') return true
  if (platform === 'linux') return Boolean(env.APPIMAGE)
  return false
}
