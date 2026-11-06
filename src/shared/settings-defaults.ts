import { DEFAULT_APPEARANCE } from './appearance'
import { DEFAULT_AUDIO_SETTINGS } from './audio'
import { DEFAULT_PLAYLIST_INDEX_WIDTH } from './playlists'
import type {
  AppSettings,
  DeepPartial,
  DownloadFormat,
  QualityTier,
  RetentionMode,
  UpdateChannel
} from './types'
import { DEFAULT_PO_TOKEN_PROVIDER_URL } from './youtube'

/** The retention modes the app actually implements, for IPC and config checks. */
export const RETENTION_MODES: readonly RetentionMode[] = ['stream', 'cache', 'keep']
export const QUALITY_TIERS: readonly QualityTier[] = ['best', 'high', 'balanced', 'data-saver']
export const DOWNLOAD_FORMATS: readonly DownloadFormat[] = ['opus', 'mp3', 'm4a']
export const UPDATE_CHANNELS: readonly UpdateChannel[] = ['stable', 'beta']

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
  // Both effects are off by default. Bypassing the audio graph entirely is the
  // most faithful playback path, and normalization has nothing to apply until a
  // library has actually been analysed.
  audio: {
    equalizer: {
      ...DEFAULT_AUDIO_SETTINGS.equalizer,
      bands: [...DEFAULT_AUDIO_SETTINGS.equalizer.bands]
    },
    normalization: { ...DEFAULT_AUDIO_SETTINGS.normalization }
  },
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
    libraryDoubleClick: 'play',
    // Five percent per wheel notch is fine-grained enough to tune and large
    // enough that crossing the bar does not take a dozen gestures.
    volumeWheelStep: 5
  },
  // `last` keeps the app where the user left it. The first-run scan still
  // happens even when scanOnLaunch is off, so a new library is never empty by
  // accident. Resume is off: restoring the queue should not start playback.
  startup: {
    view: 'last',
    scanOnLaunch: true,
    resumePlayback: false
  },
  // Closing the window quits unless the user asks otherwise. Hiding to the tray
  // is convenient while music plays, but a process that survives a close is a
  // surprise if it was not chosen.
  desktop: {
    closeToTray: false
  },
  // Ten automatic copies is roughly a month of daily launches without letting
  // the backups folder grow without bound.
  backups: {
    retentionCount: 10
  },
  // Crash reports are local-only and opt-in. Off is the honest default: a
  // diagnostic file is still a file about the user's session, so writing one is
  // their choice.
  diagnostics: {
    crashReports: false
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
    cookieBrowserProfile: null,
    // A file is the fallback of last resort: an exported cookies.txt works
    // where yt-dlp cannot read the browser's own store.
    cookiesFile: null,
    cookieFallback: 'off',
    // The provider is external by design. These defaults point at its standard
    // local port but leave both the switch and the command empty.
    poTokenEnabled: false,
    poTokenProviderUrl: DEFAULT_PO_TOKEN_PROVIDER_URL,
    poTokenProviderCommand: null,
    poTokenAutoStart: false,
    // One resolve ahead is what makes Next feel instant; the cost is one extra
    // sidecar start per track, which can be turned off on a metered connection.
    prefetchNext: true,
    // Big enough for a double album, small enough that a queue stays a queue.
    importLimit: 200,
    // A mix never ends, so its "length" is whatever this says.
    mixLimit: 50
  },
  // Fingerprint matching is dormant until the user supplies their own AcoustID
  // application key. The text search works without any setup.
  metadata: {
    acoustidKey: null
  },
  // Suura ships with its own published feed, so updates work without setup.
  // Clearing the field in Settings -> About sets this to null and the app
  // stops contacting any update host. Stable is the safe default.
  update: {
    channel: 'stable',
    feedUrl: 'https://pub-f78cb36c07324422ba352033e3d71909.r2.dev',
    autoCheck: true,
    lastCheckAt: null
  }
}

/**
 * What "Reset preferences" writes.
 *
 * Deliberately not `DEFAULT_SETTINGS`: resetting a preference should never
 * forget the folders someone chose. Library folders are the media allowlist,
 * and the engine/download folders plus the provider command are locations, not
 * tastes. The last engine update timestamp is operational state too, so it
 * stays put.
 */
export const DEFAULT_PREFERENCE_PATCH: DeepPartial<AppSettings> = {
  volume: DEFAULT_SETTINGS.volume,
  repeat: DEFAULT_SETTINGS.repeat,
  shuffle: DEFAULT_SETTINGS.shuffle,
  theme: DEFAULT_SETTINGS.theme,
  audio: {
    equalizer: {
      ...DEFAULT_SETTINGS.audio.equalizer,
      bands: [...DEFAULT_SETTINGS.audio.equalizer.bands]
    },
    normalization: { ...DEFAULT_SETTINGS.audio.normalization }
  },
  library: {
    watchForChanges: DEFAULT_SETTINGS.library.watchForChanges
  },
  playlists: {
    indexWidth: DEFAULT_SETTINGS.playlists.indexWidth
  },
  visuals: { ...DEFAULT_SETTINGS.visuals },
  interaction: { ...DEFAULT_SETTINGS.interaction },
  startup: { ...DEFAULT_SETTINGS.startup },
  desktop: { ...DEFAULT_SETTINGS.desktop },
  backups: { ...DEFAULT_SETTINGS.backups },
  diagnostics: { ...DEFAULT_SETTINGS.diagnostics },
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
    cookieBrowserProfile: DEFAULT_SETTINGS.engine.cookieBrowserProfile,
    cookieFallback: DEFAULT_SETTINGS.engine.cookieFallback,
    poTokenEnabled: DEFAULT_SETTINGS.engine.poTokenEnabled,
    poTokenProviderUrl: DEFAULT_SETTINGS.engine.poTokenProviderUrl,
    poTokenAutoStart: DEFAULT_SETTINGS.engine.poTokenAutoStart,
    prefetchNext: DEFAULT_SETTINGS.engine.prefetchNext,
    importLimit: DEFAULT_SETTINGS.engine.importLimit,
    mixLimit: DEFAULT_SETTINGS.engine.mixLimit
  }
}

export type PreferenceSection = 'general' | 'playback' | 'streaming' | 'appearance'

/**
 * Per-section reset patches. These deliberately mirror the preferences in each
 * section rather than everything the full reset touches: resetting General must
 * not silently change the player volume, click behaviour or the saved-file
 * format.
 */
export const SECTION_PREFERENCE_PATCHES: Record<PreferenceSection, DeepPartial<AppSettings>> = {
  general: {
    startup: {
      view: DEFAULT_SETTINGS.startup.view,
      scanOnLaunch: DEFAULT_SETTINGS.startup.scanOnLaunch
    },
    desktop: { ...DEFAULT_SETTINGS.desktop },
    library: {
      watchForChanges: DEFAULT_SETTINGS.library.watchForChanges
    },
    playlists: {
      indexWidth: DEFAULT_SETTINGS.playlists.indexWidth
    }
  },
  playback: {
    audio: {
      equalizer: {
        ...DEFAULT_SETTINGS.audio.equalizer,
        bands: [...DEFAULT_SETTINGS.audio.equalizer.bands]
      },
      normalization: { ...DEFAULT_SETTINGS.audio.normalization }
    },
    interaction: { ...DEFAULT_SETTINGS.interaction },
    startup: {
      resumePlayback: DEFAULT_SETTINGS.startup.resumePlayback
    }
  },
  streaming: {
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
      cookieBrowserProfile: DEFAULT_SETTINGS.engine.cookieBrowserProfile,
      cookieFallback: DEFAULT_SETTINGS.engine.cookieFallback,
      poTokenEnabled: DEFAULT_SETTINGS.engine.poTokenEnabled,
      poTokenProviderUrl: DEFAULT_SETTINGS.engine.poTokenProviderUrl,
      poTokenAutoStart: DEFAULT_SETTINGS.engine.poTokenAutoStart,
      prefetchNext: DEFAULT_SETTINGS.engine.prefetchNext,
      importLimit: DEFAULT_SETTINGS.engine.importLimit,
      mixLimit: DEFAULT_SETTINGS.engine.mixLimit
    }
  },
  appearance: { ...DEFAULT_APPEARANCE }
}
