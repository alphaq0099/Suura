/**
 * A window or work area in screen coordinates.
 *
 * Mirrors Electron's `Rectangle` without importing `electron`, so the rule can
 * be exercised by the plain-Node smoke run.
 */
export interface ScreenRectangle {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Pulls a window rectangle back into a display's work area.
 *
 * The mini player remembers the normal window bounds while it is compact. If
 * the monitor that held those bounds is unplugged before it closes, restoring
 * them verbatim would put the window off-screen with no way to grab it. The
 * size only shrinks when the work area cannot hold it; otherwise the rectangle
 * keeps its size and moves the smallest distance that makes it fully visible.
 */
export function clampToWorkArea(bounds: ScreenRectangle, area: ScreenRectangle): ScreenRectangle {
  const width = Math.max(0, Math.min(bounds.width, area.width))
  const height = Math.max(0, Math.min(bounds.height, area.height))
  return {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    width,
    height
  }
}
