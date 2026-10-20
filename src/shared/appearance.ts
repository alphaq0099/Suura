import type {
  AccentName,
  AppSettings,
  DeepPartial,
  Density,
  MotionPreference,
  SurfaceStyle,
  ThemeMode
} from './types'

/**
 * The bounded set of appearance choices.
 *
 * These live in `shared` because the renderer draws them and the main process
 * validates them. Keeping the values here means a new accent cannot be added to
 * one side and silently rejected by the other.
 */
export const APPEARANCE_CACHE_KEY = 'player.appearance.v1'

export const THEME_MODES: readonly ThemeMode[] = ['dark', 'light', 'system']
export const ACCENTS: readonly AccentName[] = ['blue', 'teal', 'violet', 'rose', 'amber']
export const DENSITIES: readonly Density[] = ['compact', 'comfortable', 'spacious']
export const SURFACES: readonly SurfaceStyle[] = ['solid', 'frosted']
export const MOTION_PREFERENCES: readonly MotionPreference[] = ['system', 'reduced', 'full']

export interface ThemeChoice {
  value: ThemeMode
  label: string
  hint: string
}

export interface AppearanceChoice<T extends string> {
  value: T
  label: string
  hint?: string
}

export const THEME_CHOICES: readonly ThemeChoice[] = [
  { value: 'dark', label: 'Dark', hint: 'Dim and low-glare' },
  { value: 'light', label: 'Cream', hint: 'Warm off-white' },
  { value: 'system', label: 'Follow Windows', hint: 'Match Windows' }
]

/**
 * Swatches are previews, not the text colours: each accent is toned separately
 * for dark and cream in the stylesheet so it stays readable on both.
 */
export const ACCENT_CHOICES: ReadonlyArray<AppearanceChoice<AccentName> & { swatch: string }> = [
  { value: 'blue', label: 'Blue', swatch: '#6c8cff' },
  { value: 'teal', label: 'Teal', swatch: '#2fbfa9' },
  { value: 'violet', label: 'Violet', swatch: '#a78bfa' },
  { value: 'rose', label: 'Rose', swatch: '#f472b6' },
  { value: 'amber', label: 'Amber', swatch: '#e0a63b' }
]

export const DENSITY_CHOICES: readonly AppearanceChoice<Density>[] = [
  { value: 'compact', label: 'Compact', hint: 'More rows on screen' },
  { value: 'comfortable', label: 'Comfortable', hint: 'The default balance' },
  { value: 'spacious', label: 'Spacious', hint: 'Roomier rows' }
]

export const SURFACE_CHOICES: readonly AppearanceChoice<SurfaceStyle>[] = [
  { value: 'solid', label: 'Solid', hint: 'Flat, predictable panels' },
  { value: 'frosted', label: 'Frosted', hint: 'Translucent panels with blur' }
]

export const MOTION_CHOICES: readonly AppearanceChoice<MotionPreference>[] = [
  { value: 'system', label: 'Follow Windows', hint: 'Respect the system setting' },
  { value: 'reduced', label: 'Reduced', hint: 'Skip most animation' },
  { value: 'full', label: 'Full', hint: 'Always animate' }
]

/**
 * Row heights are shared because the virtualizer computes the visible window by
 * dividing the scroll offset by this number. The stylesheet reads the same
 * values from `data-density`; if the two ever disagree, rows jump while
 * scrolling.
 */
export const DENSITY_ROW_HEIGHT: Record<Density, number> = {
  compact: 32,
  comfortable: 38,
  spacious: 46
}

export const DENSITY_HEAD_HEIGHT: Record<Density, number> = {
  compact: 30,
  comfortable: 34,
  spacious: 40
}

/**
 * Reset means "put the Appearance tab back". It deliberately includes artwork
 * and player choices as well as the theme, because leaving half the tab on a
 * previous experiment would make the button misleading.
 */
export const DEFAULT_APPEARANCE = {
  theme: 'dark',
  visuals: {
    accent: 'blue',
    density: 'comfortable',
    surface: 'solid',
    motion: 'system',
    artworkShape: 'square',
    artworkFit: 'cover',
    artworkSize: 'medium',
    playerArtwork: true,
    playerAmbience: true
  }
} satisfies DeepPartial<AppSettings>

export type { AccentName, Density, MotionPreference, SurfaceStyle, ThemeMode }
