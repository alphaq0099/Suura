import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  ACCENTS,
  APPEARANCE_CACHE_KEY,
  DENSITIES,
  MOTION_PREFERENCES,
  SURFACES,
  TEXT_SIZES
} from '@shared/appearance'
import type { AccentName, Density, MotionPreference, SurfaceStyle, TextSize } from '@shared/types'
import '@fontsource-variable/inter'
import { App } from './App'
import './styles.css'

// Paint the last palette before React and the settings IPC round-trip. Without
// this, a Cream user gets one dark frame on every launch. The cached values are
// only a hint: the real settings replace them as soon as they arrive.
try {
  const cached = JSON.parse(localStorage.getItem(APPEARANCE_CACHE_KEY) ?? 'null') as Record<string, unknown> | null
  if (cached) {
    const root = document.documentElement
    // A cached \"system\" mode still asks the OS, so a theme changed while the
    // app was closed is right on the first frame rather than after the IPC load.
    const cachedTheme =
      cached.mode === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : cached.theme
    if (cachedTheme === 'dark' || cachedTheme === 'light') root.dataset.theme = cachedTheme
    if (typeof cached.accent === 'string' && ACCENTS.includes(cached.accent as AccentName)) {
      root.dataset.accent = cached.accent
    }
    if (typeof cached.density === 'string' && DENSITIES.includes(cached.density as Density)) {
      root.dataset.density = cached.density
    }
    if (typeof cached.surface === 'string' && SURFACES.includes(cached.surface as SurfaceStyle)) {
      root.dataset.surface = cached.surface
    }
    if (typeof cached.motion === 'string' && MOTION_PREFERENCES.includes(cached.motion as MotionPreference)) {
      root.dataset.motion = cached.motion
    }
    if (typeof cached.textSize === 'string' && TEXT_SIZES.includes(cached.textSize as TextSize)) {
      root.dataset.textSize = cached.textSize
    }
  }
} catch {
  // A corrupt cache just means the first frame uses the default dark palette.
}

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root container is missing from index.html.')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
)
