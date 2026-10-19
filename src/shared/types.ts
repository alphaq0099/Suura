/**
 * Domain types shared by the main process, the preload bridge and the renderer.
 *
 * This file must stay free of any Node or Electron import so the renderer can
 * include it without pulling in platform code.
 */

/** Where a track's audio comes from. `youtube` arrives in M3. */
export type SourceKind = 'local' | 'youtube'

/**
 * What happens to the bytes of a remote track. See ROADMAP.md §2.2.
 * `stream` is the default on purpose: nothing is written to disk unless asked.
 */
export type RetentionMode = 'stream' | 'cache' | 'keep'

export type ThemeMode = 'system' | 'light' | 'dark'

export type RepeatMode = 'off' | 'all' | 'one'

/** Mirrors ROADMAP.md §6.3. Unused until the yt-dlp engine lands in M3. */
export type QualityTier = 'best' | 'high' | 'balanced' | 'data-saver'

/**
 * Outline of every piece of cover art: the library rows, the player bar tile and
 * the full-window player.
 */
export type ArtworkShape = 'square' | 'circle'

/**
 * How artwork fills its box.
 *
 * `cover` crops to a square, which is what most players do and what keeps the
 * grid tidy; `contain` gives the box the cover's own proportions instead so
 * nothing is ever cut off. Neither is right for everyone, which is why it is a
 * setting rather than a decision made here.
 */
export type ArtworkFit = 'cover' | 'contain'

/**
 * How much of the player window's artwork band the cover may fill. A preset
 * rather than a pixel size, because the band is whatever the window leaves over:
 * a fixed size is too small on a big screen and does not fit on a short one.
 */
export type ArtworkSize = 'small' | 'medium' | 'large' | 'xlarge'

/**
 * What a click on a library row does.
 *
 * `nothing` is deliberately offered: "click to select" is a preference, and
 * someone who only ever wants the keyboard or the hover play button should be
 * able to turn it off rather than work around it.
 */
export type LibraryClickAction = 'nothing' | 'select' | 'play' | 'select-play'

/** A single playable item. Local files populate `filePath`; remote tracks will not. */
export interface Track {
  id: number
  sourceKind: SourceKind
  /** YouTube video id, or null for local files. */
  sourceId: string | null
  title: string
  artist: string | null
  albumArtist: string | null
  album: string | null
  trackNo: number | null
  discNo: number | null
  year: number | null
  genre: string | null
  durationMs: number | null
  codec: string | null
  bitrateKbps: number | null
  sampleRate: number | null
  channels: number | null
  fileSize: number | null
  /** Absolute path. Only meaningful for `local` tracks. */
  filePath: string | null
  /**
   * Cover-art cache key, or null when there is none to show (either the file has
   * no embedded picture, or it has not been looked at yet). Pass it to
   * `buildArtworkUrl` to get a URL for an <img>.
   */
  artworkKey: string | null
  addedAt: number
  playCount: number
  lastPlayedAt: number | null
}

export interface LibraryStats {
  tracks: number
  artists: number
  albums: number
  totalBytes: number
  lastScanAt: number | null
}

export interface Playlist {
  id: number
  name: string
  createdAt: number
  updatedAt: number
  /**
   * How many tracks are in it. Carried on the playlist itself so the sidebar can
   * show the count for every playlist without loading any of their contents.
   */
  trackCount: number
}

/**
 * One row of a playlist, in playlist order.
 *
 * The id is the *entry's* id, not the track's: the same track may sit in several
 * playlists, and removing or moving one has to name which of them it means.
 */
export interface PlaylistItem {
  id: number
  track: Track
}

export interface PlaylistDetail {
  playlist: Playlist
  items: PlaylistItem[]
}

/** What adding tracks did, so the UI can say "3 added, 2 already there". */
export interface AddTracksOutcome {
  detail: PlaylistDetail | null
  added: number
  skipped: number
}

/**
 * What the renderer writes down about playback, and all it writes down.
 *
 * Only ids, so a queue survives a rescan that rewrites rows (a moved file keeps
 * its row and its id). Repeat and shuffle are not here: they are settings, which
 * are already persisted, and two sources of truth for one switch is how they end
 * up disagreeing.
 */
export interface PlaybackSnapshot {
  /** Track ids in queue order. */
  trackIds: number[]
  /** Position of the current track in `trackIds`, or -1 when nothing is current. */
  index: number
  positionMs: number
}

/**
 * A snapshot with its rows read back, ready to be put in the queue.
 *
 * Tracks that are no longer in the library are already gone, and `index` has
 * been moved to a track that still exists, so the renderer needs no rule of its
 * own about holes.
 */
export interface SavedPlayback {
  tracks: Track[]
  index: number
  positionMs: number
}

export interface ScanProgress {
  phase: 'enumerating' | 'reading' | 'done'
  /** Files discovered on disk that look like audio. */
  filesSeen: number
  /** Rows created this run. */
  indexed: number
  /** Rows whose tags changed this run. */
  updated: number
  /** Files whose size+mtime matched the database, so tags were not re-read. */
  skipped: number
  /** Files that could not be read or parsed. */
  failed: number
  /** Rows deleted because the file no longer exists. */
  pruned: number
  currentFile: string | null
  folder: string | null
  startedAt: number
  finishedAt: number | null
}

export interface RetentionSettings {
  mode: RetentionMode
  /** Hard ceiling for `cache` mode, in megabytes. */
  cacheBudgetMb: number
  /** Entries older than this are evicted even if under the size budget. */
  cacheMaxAgeDays: number
  /** Where `keep` mode writes files. Null means the default music folder. */
  downloadFolder: string | null
  qualityTier: QualityTier
}

export interface EngineSettings {
  /** Folder holding yt-dlp(.exe) and ffmpeg(.exe). Null means "search PATH". */
  binDir: string | null
  autoUpdate: boolean
  /** Max concurrent downloads. Resolver concurrency is capped separately. */
  downloadConcurrency: number
  /** e.g. "chrome", "edge", "firefox". Null disables cookie import. */
  cookiesFromBrowser: string | null
}

export interface VisualSettings {
  artworkShape: ArtworkShape
  artworkFit: ArtworkFit
  artworkSize: ArtworkSize
}

/**
 * How the interface responds to the mouse. Both gestures are configurable
 * because the two conventions are both widespread — a library that selects on
 * click (Explorer) and one that plays on click (every streaming player) — and
 * whichever someone is used to, the other feels broken.
 */
export interface InteractionSettings {
  librarySingleClick: LibraryClickAction
  libraryDoubleClick: LibraryClickAction
}

/**
 * How much the library is trusted to keep itself up to date.
 */
export interface LibrarySettings {
  /**
   * Watch the folders and re-scan when files appear, change or disappear. Worth
   * turning off for a library on a slow or networked drive, where watching costs
   * more than the occasional manual scan.
   */
  watchForChanges: boolean
}

export interface AppSettings {
  libraryFolders: string[]
  volume: number
  repeat: RepeatMode
  shuffle: boolean
  theme: ThemeMode
  library: LibrarySettings
  visuals: VisualSettings
  interaction: InteractionSettings
  retention: RetentionSettings
  engine: EngineSettings
}

/** Absolute locations the app reads and writes. Surfaced in Settings for debugging. */
export interface AppPaths {
  userData: string
  config: string
  database: string
  logs: string
  cache: string
  downloads: string
}

export interface ListTracksQuery {
  /** Full-text search across title/artist/album/albumArtist/genre. */
  search?: string
  /** Sort field. Anything else falls back to the default artist/album/track order. */
  sort?: TrackSortField
  direction?: SortDirection
  limit?: number
  offset?: number
}

/** Sortable columns. Kept in one place so the SQL, the IPC boundary and the UI agree. */
export type TrackSortField = 'title' | 'artist' | 'album' | 'duration' | 'year' | 'added' | 'played'

export type SortDirection = 'asc' | 'desc'

/**
 * A page of tracks plus the size of the whole result set.
 *
 * `total` is what lets the list render a correctly sized scrollbar and a
 * "showing 400 of 12 318" footer while only a page of rows has been transferred.
 */
export interface TrackPage {
  tracks: Track[]
  /** Rows matching the query, ignoring limit/offset. */
  total: number
}

export interface ResolvedSource {
  /** A URL the renderer can hand straight to an <audio> element. */
  url: string
  /** Epoch ms after which `url` is expected to stop working, or null if it never expires. */
  expiresAt: number | null
  mimeType: string | null
  /** Which resolver produced this, for logging and for the future UI source badge. */
  resolverId: string
}

/** Health of an external engine binary (yt-dlp, ffmpeg). Used by Settings in M0.5. */
export interface ExecutableStatus {
  name: string
  found: boolean
  path: string | null
  version: string | null
  source: 'configured' | 'path' | 'well-known' | null
  error: string | null
}

export interface EngineStatus {
  ytDlp: ExecutableStatus
  ffmpeg: ExecutableStatus
  /** True when every binary the engine needs was located. */
  ready: boolean
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K]
}
