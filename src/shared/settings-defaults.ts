import { DEFAULT_APPEARANCE } from './appearance'
import { DEFAULT_PLAYLIST_INDEX_WIDTH } from './playlists'
import type { AppSettings, DeepPartial } from './types'

/**
 * Defaults matter more than they look: `retention.mode: 'stream'` and a bounded
 * cache are deliberate product decisions (ROADMAP.md §2.2 / §13), not accidents.
 *
 * They live in `shared` so Settings can offer an honest reset without copying
 * the numbers, and so the reset cannot drift from what a first launch creates.
 */
export const DEFAULT_SETTINGS: AppSettings = {
  libraryFolders: [],
  volume: 0.8,
  repeat: 'off',
  shuffle: false,
  theme: DEFAULT_APPEARANCE.theme,
  // Watching is on by default: a library that quietly misses the album you just
  // copied in is the thing people notice, and the scan it triggers is cheap
  // because unchanged files are never opened.
  library: {
    watchForChanges: true
  },
  playlists: {
    indexWidth: DEFAULT_PLAYLIST_INDEX_WIDTH
  },
  // Midnight is the default because it is the lowest-glare choice for a player that
  // is often left open behind other work. Cream and Follow Windows are one click
  // away. Square + cropped is still what the library rows and the bar look like;
  // `contain` is there for anyone who would rather never see a cover cut off.
  // Medium is bigger than the old fixed 420px cap: the cover is the point of the
  // player window, and at the old size it read as a thumbnail on anything larger
  // than a laptop.
  visuals: { ...DEFAULT_APPEARANCE.visuals },
  // Explorer's convention, and what this app has always done: a click selects,
  // a double click plays. Any other pairing is one dropdown away.
  interaction: {
    librarySingleClick: 'select',
    libraryDoubleClick: 'play'
  },
  retention: {
    mode: 'stream',
    cacheBudgetMb: 5120,
    cacheMaxAgeDays: 30,
    downloadFolder: null,
    // Opus is what YouTube delivers, so saving it is a remux instead of a
    // re-encode. MP3 and M4A are a setting away for players that need them.
    downloadFormat: 'opus',
    qualityTier: 'high'
  },
  engine: {
    binDir: null,
    autoUpdate: true,
    lastUpdateCheckAt: null,
    downloadConcurrency: 2,
    // Off by default: reading a browser's cookies is a deliberate last resort,
    // never something the app does quietly.
    cookiesFromBrowser: null,
    // One resolve ahead is what makes Next feel instant; the cost is one extra
    // sidecar start per track, which can be turned off on a metered connection.
    prefetchNext: true,
    // Big enough for a double album, small enough that a queue stays a queue.
    importLimit: 200,
    // A mix never ends, so its "length" is whatever this says.
    mixLimit: 50
  }
}

/**
 * What "Reset preferences" writes.
 *
 * Deliberately not `DEFAULT_SETTINGS`: resetting a preference should never
 * forget the folders someone chose. Library folders are the media allowlist,
 * and the engine/download folders are locations, not tastes. The last engine
 * update timestamp is operational state too, so it stays put.
 */
export const DEFAULT_PREFERENCE_PATCH: DeepPartial<AppSettings> = {
  volume: DEFAULT_SETTINGS.volume,
  repeat: DEFAULT_SETTINGS.repeat,
  shuffle: DEFAULT_SETTINGS.shuffle,
  theme: DEFAULT_SETTINGS.theme,
  library: {
    watchForChanges: DEFAULT_SETTINGS.library.watchForChanges
  },
  playlists: {
    indexWidth: DEFAULT_SETTINGS.playlists.indexWidth
  },
  visuals: { ...DEFAULT_SETTINGS.visuals },
  interaction: { ...DEFAULT_SETTINGS.interaction },
  retention: {
    mode: DEFAULT_SETTINGS.retention.mode,
    cacheBudgetMb: DEFAULT_SETTINGS.retention.cacheBudgetMb,
    cacheMaxAgeDays: DEFAULT_SETTINGS.retention.cacheMaxAgeDays,
    downloadFormat: DEFAULT_SETTINGS.retention.downloadFormat,
    qualityTier: DEFAULT_SETTINGS.retention.qualityTier
  },
  engine: {
    autoUpdate: DEFAULT_SETTINGS.engine.autoUpdate,
    downloadConcurrency: DEFAULT_SETTINGS.engine.downloadConcurrency,
    cookiesFromBrowser: DEFAULT_SETTINGS.engine.cookiesFromBrowser,
    prefetchNext: DEFAULT_SETTINGS.engine.prefetchNext,
    importLimit: DEFAULT_SETTINGS.engine.importLimit,
    mixLimit: DEFAULT_SETTINGS.engine.mixLimit
  }
}
