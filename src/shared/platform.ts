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
