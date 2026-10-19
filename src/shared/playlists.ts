/**
 * The list of playlists on the left of the Playlists view is resizable. These
 * bounds are shared by the drag handler, the keyboard handler and the settings
 * sanitiser, so a width that came from a config file cannot be smaller than the
 * index's own controls or wider than the pane can survive.
 */
export const PLAYLIST_INDEX_MIN = 160
export const PLAYLIST_INDEX_MAX = 520
export const DEFAULT_PLAYLIST_INDEX_WIDTH = 240

/** Clamps a stored or dragged width to the range the layout can honour. */
export function clampPlaylistIndexWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_PLAYLIST_INDEX_WIDTH
  return Math.min(PLAYLIST_INDEX_MAX, Math.max(PLAYLIST_INDEX_MIN, Math.round(width)))
}
