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

/**
 * The container a saved file is written in.
 *
 * Opus is the source format for almost every YouTube track, so saving it costs a
 * remux rather than a re-encode. MP3 and M4A are there for players and phones that
 * will not take Opus (and both re-encode, which never adds quality — the Settings
 * text says so).
 */
export type DownloadFormat = 'opus' | 'mp3' | 'm4a'

/**
 * `dark` is the deep blue-black palette the UI calls **Midnight**, and `light`
 * is the warm cream palette the UI calls **Cream**. The stored values stay
 * `dark` and `light` so older config files keep working.
 */
export type ThemeMode = 'system' | 'light' | 'dark'

/** The five contrast-checked accent families. */
export type AccentName = 'blue' | 'teal' | 'violet' | 'rose' | 'amber'

/** How tightly rows and cards are packed. */
export type Density = 'compact' | 'comfortable' | 'spacious'

/** Solid panels, or accent-tinted translucent panels with a controlled blur. */
export type SurfaceStyle = 'solid' | 'accented'

/** Follow the OS preference, or force motion on/off. */
export type MotionPreference = 'system' | 'reduced' | 'full'

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

/**
 * A saved view of the library.
 *
 * `streams` is the YouTube history rather than a query over `tracks`: those rows
 * own no file and no local id, so the Library shows them from the history table
 * under their own chip instead of pretending they are ordinary rows.
 */
export type LibraryFilter = 'all' | 'recent' | 'most-played' | 'never-played' | 'streams'

/** The filters the `tracks` table can answer. */
export type LocalLibraryFilter = Exclude<LibraryFilter, 'streams'>

/** A single playable item. Local files populate `filePath`; remote tracks will not. */
export interface Track {
  id: number
  sourceKind: SourceKind
  /** YouTube video id, or null for local files. */
  sourceId: string | null
  /**
   * Where the file came from, when that is not the folder it sits in.
   *
   * A downloaded YouTube track is `local`: it plays from disk and survives being
   * offline. The video id lives here instead of in `sourceId`, so "already saved"
   * is a fact about the file rather than a second kind of playback.
   */
  originKind: SourceKind | null
  originId: string | null
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
  /** Epoch ms when the file was last found absent, or null while it is present. */
  missingAt: number | null
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

/**
 * The minimum a resolver needs to know about a track.
 *
 * Local tracks are resolved from their database row, so the renderer never gets
 * to name a path. A stream track has no row yet, so the id and source id travel
 * from the renderer instead. Keeping the seam this narrow means a resolver
 * cannot accidentally start trusting renderer-supplied metadata.
 */
export type ResolvableTrack = Pick<Track, 'id' | 'sourceKind' | 'sourceId' | 'filePath'>

export interface LibraryStats {
  tracks: number
  artists: number
  albums: number
  totalBytes: number
  lastScanAt: number | null
  /** Local rows added within `RECENTLY_ADDED_DAYS`. */
  recentTracks: number
  /** Local rows with at least one completed listen. */
  playedTracks: number
  /** Local rows that have never had a completed listen. */
  unplayedTracks: number
  /** Rows kept in the library whose file is currently absent. */
  missingTracks: number
}

/**
 * What a duplicate scan found.
 *
 * Only present local rows are hashed. A group is two or more rows with the same
 * full-file SHA-256, so these are byte-identical copies, not merely the same
 * song at two bitrates. `extraCopies` is what merging would remove.
 */
export interface DuplicateReport {
  groups: number
  extraCopies: number
  /** Rows that had to be read to answer this question. */
  hashed: number
}

/** What a merge removed and whether anything was found to merge. */
export interface DuplicateMergeOutcome {
  groups: number
  /** Library rows folded into their keepers. */
  removed: number
  /** Redundant files deleted after their rows were merged. */
  filesRemoved: number
  /** Files that could not be deleted; their rows are gone until the next scan. */
  fileErrors: number
}

/** What a relocation pass found in the folder the user picked. */
export interface RelocateReport {
  scanned: number
  relocated: number
  unmatched: number
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

/** The on-disk shapes a custom playlist can be exported to or imported from. */
export type PlaylistFileFormat = 'm3u' | 'm3u8' | 'json'

/**
 * What a playlist import produced.
 *
 * `added` counts rows in the new playlist. `duplicates` are entries that named a
 * track already present earlier in the same import, `missing` are paths or URLs
 * that no longer resolve to a library row, and `invalid` are entries with
 * neither a path nor a URL. Importing creates a playlist only when at least one
 * entry resolves, so an import cannot leave an empty list behind by accident.
 */
export interface PlaylistImportOutcome {
  detail: PlaylistDetail
  added: number
  duplicates: number
  missing: number
  invalid: number
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

/**
 * One link remembered in the Online history.
 *
 * A link becomes a row the moment it is pasted, before anything is resolved for
 * playback and long before it could be downloaded. It is deliberately *not* a
 * `Track`: it owns no file, no resolver session and no row in `tracks`.
 * `onlineEntryToTrack` turns it into a session track when it is played.
 */
export interface OnlineTrack {
  id: number
  videoId: string
  title: string
  artist: string | null
  album: string | null
  durationMs: number | null
  /**
   * Canonical watch URL. Kept on the row so it can be replayed from a cold
   * start, even after the audio cache has been cleared.
   */
  sourceUrl: string
  /** Cached thumbnail key, or null when the thumbnail could not be fetched. */
  artworkKey: string | null
  addedAt: number
  lastPlayedAt: number | null
}

/** Where an Online playlist came from: a hand-made list, an album, or a radio mix. */
export type OnlinePlaylistKind = 'playlist' | 'album' | 'mix'

/** One track inside an Online playlist, in source order. */
export interface OnlinePlaylistItem {
  /** The entry's own id, not a `tracks` id. */
  id: number
  playlistId: number
  position: number
  videoId: string
  title: string
  artist: string | null
  album: string | null
  durationMs: number | null
}

/**
 * A playlist imported from a link.
 *
 * A snapshot, not a mirror: importing the same list URL again replaces the items
 * in place, but nothing syncs in the background. `coverKey` is the list's own
 * cover (an album sleeve, usually), which is also what every row in an album
 * shows; a plain playlist leaves it null and each row uses its video's still.
 */
export interface OnlinePlaylist {
  id: number
  /** YouTube's list id (`PL…`, `OLAK5uy…`, `RD…`). Identity for re-imports. */
  listId: string
  kind: OnlinePlaylistKind
  title: string
  owner: string | null
  sourceUrl: string
  coverKey: string | null
  /**
   * The first entry's video id, used as the card's thumbnail when the list has
   * no cover of its own. A playlist or mix has no sleeve, but its first still
   * is still a better face than a generic note icon.
   */
  firstVideoId: string | null
  trackCount: number
  /** How many entries YouTube reports, or null when it reports none (a mix). */
  totalCount: number | null
  importedAt: number
}

export interface OnlinePlaylistDetail {
  playlist: OnlinePlaylist
  items: OnlinePlaylistItem[]
}

/**
 * One result from a YouTube search or a channel listing.
 *
 * Deliberately smaller than `OnlineTrack`: nothing is stored yet, so there is no
 * history id and no cached artwork key. The video id is enough for the view to
 * draw a still and for playback to add the link to the history.
 */
export interface YouTubeSearchResult {
  videoId: string
  title: string
  artist: string | null
  durationMs: number | null
  channelId: string | null
  channelName: string | null
}

/** A channel and the videos shown on its page. */
export interface YouTubeChannel {
  channelId: string | null
  name: string
  url: string
  entries: YouTubeSearchResult[]
}

/** Where a saved track is in its journey from YouTube to the library. */
export type DownloadStatus =
  | 'queued'
  | 'downloading'
  | 'finishing'
  | 'indexing'
  | 'saved'
  | 'failed'
  /** The user stopped it, so it is not an error to retry or explain. */
  | 'cancelled'

/**
 * One track's download, as the main process reports it.
 *
 * Keyed by video id rather than by row id because a track can be saved from the
 * Online history (which has a history id), from an imported playlist (which has
 * an entry id) or from the player bar, and all three mean the same video.
 */
export interface DownloadProgress {
  videoId: string
  status: DownloadStatus
  /** 0-100 while downloading, null when there is no meaningful fraction. */
  percent: number | null
  error: string | null
  /** The library row, once it exists. */
  trackId: number | null
}

/** What the renderer knows about a stream it wants to keep. */
export interface SaveToLibraryRequest {
  videoId: string
  /** The snapshot's title/artist/album, used for the folder and file name. */
  title: string
  artist: string | null
  album: string | null
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
  /** Rows newly marked missing because the file no longer exists. */
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
  /** Container for saved files. Opus avoids a re-encode; the others are compatibility. */
  downloadFormat: DownloadFormat
  qualityTier: QualityTier
}

/**
 * When yt-dlp may read browser cookies.
 *
 * Cookies are deliberately not a global default. `on-bot-check` keeps normal
 * requests cookie-free and spends one retry only when YouTube challenges the
 * request; `always` is the old "use cookies for every call" behaviour and is
 * kept for people who need it.
 */
export type CookieFallbackMode = 'off' | 'on-bot-check' | 'always'

/** The PO Token provider, as the main process sees it right now. */
export interface PoTokenStatus {
  /** The user switch, not whether a provider is actually reachable. */
  enabled: boolean
  /** Normalised base URL yt-dlp is told to use. */
  providerUrl: string
  /** A process this app started and is supervising. */
  managedRunning: boolean
  /** `/ping` answered at `providerUrl`. */
  serverReachable: boolean
  /** Version reported by the provider's `/ping` endpoint, when it gives one. */
  serverVersion: string | null
  /** A command is configured, even if it has not been started. */
  commandConfigured: boolean
  /** Last start/stop failure worth showing. Cleared after a successful start. */
  error: string | null
}

export interface EngineSettings {
  /** Folder holding yt-dlp(.exe) and ffmpeg(.exe). Null means "search PATH". */
  binDir: string | null
  /** Check and update the yt-dlp binary at most once a day. */
  autoUpdate: boolean
  /** Epoch ms of the last automatic update attempt. Null means never. */
  lastUpdateCheckAt: number | null
  /** Max concurrent downloads. Resolver concurrency is capped separately. */
  downloadConcurrency: number
  /**
   * Opt-in browser cookie source for yt-dlp. Null means no browser is
   * selected. `cookieFallback` decides when this source is actually read.
   */
  cookiesFromBrowser: string | null
  /** Optional Chrome/Edge/Firefox profile name or path. */
  cookieBrowserProfile: string | null
  /** Off, only after a bot check, or on every yt-dlp request. */
  cookieFallback: CookieFallbackMode
  /**
   * Ask yt-dlp's bgutil plugin to fetch PO Tokens from an external HTTP
   * provider. The app never bundles the provider or the plugin.
   */
  poTokenEnabled: boolean
  /** Base URL of the external provider. Empty means the default local URL. */
  poTokenProviderUrl: string
  /**
   * Optional command the app may run to start the provider. It is split into
   * arguments without a shell, so quoted paths work and no shell syntax does.
   */
  poTokenProviderCommand: string | null
  /** Start the configured command on launch and when the switch is enabled. */
  poTokenAutoStart: boolean
  /**
   * Resolve the next queued YouTube track while the current one plays. On by
   * default because it removes the 8 s gap between songs; off means one fewer
   * speculative request per track.
   */
  prefetchNext: boolean
  /**
   * How many tracks an imported playlist or album keeps.
   *
   * A playlist can be thousands of entries long and every one costs a queue row,
   * so an import is capped rather than silently materialising the whole thing.
   * The view says "first N of M" when the cap bites.
   */
  importLimit: number
  /**
   * How many tracks a mix keeps. A mix reports no total because it never ends,
   * so this is the whole definition of a mix import: a snapshot of N tracks.
   */
  mixLimit: number
}

export interface VisualSettings {
  accent: AccentName
  density: Density
  surface: SurfaceStyle
  motion: MotionPreference
  artworkShape: ArtworkShape
  artworkFit: ArtworkFit
  artworkSize: ArtworkSize
  /** Whether the full-window player draws the large cover. */
  playerArtwork: boolean
  /** Whether cover art tints the player bar and the full-window background. */
  playerAmbience: boolean
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
  /** How much one wheel notch changes the volume, in percent. Shift still uses 1%. */
  volumeWheelStep: number
}

/** A view the app can open at launch. `last` restores the last non-settings view. */
export const STARTUP_VIEWS = ['last', 'library', 'search', 'online', 'playlists', 'queue'] as const
export type StartupView = (typeof STARTUP_VIEWS)[number]

export function isStartupView(value: unknown): value is StartupView {
  return typeof value === 'string' && (STARTUP_VIEWS as readonly string[]).includes(value)
}

export interface StartupSettings {
  view: StartupView
  /** Scan the library once per launch, in addition to the first-run scan. */
  scanOnLaunch: boolean
  /**
   * Start playing the restored queue instead of leaving it paused. Off by
   * default: opening the app is not a request to make noise.
   */
  resumePlayback: boolean
}

/** How many automatic database copies stay on disk. */
export interface BackupSettings {
  retentionCount: number
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

/**
 * Playlists-view layout preferences. The index width lives in settings rather
 * than in component state because the view unmounts when another view is
 * opened: a hand-picked width that resets on every visit is worse than no
 * resizing at all.
 */
export interface PlaylistSettings {
  /** Width of the list of playlists, in CSS pixels. */
  indexWidth: number
}

export interface AppSettings {
  libraryFolders: string[]
  volume: number
  repeat: RepeatMode
  shuffle: boolean
  theme: ThemeMode
  library: LibrarySettings
  playlists: PlaylistSettings
  visuals: VisualSettings
  interaction: InteractionSettings
  startup: StartupSettings
  backups: BackupSettings
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
  /** Automatic and pre-restore database copies. */
  backups: string
}

export interface ListTracksQuery {
  /** Full-text search across title/artist/album/albumArtist/genre. */
  search?: string
  /** A saved local-library view. `all` and an absent filter are the same query. */
  filter?: LocalLibraryFilter
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

/** The app and runtime versions shown in About. */
export interface RuntimeInfo {
  appVersion: string
  electron: string
  chromium: string
  node: string
}

export interface EngineStatus {
  ytDlp: ExecutableStatus
  ffmpeg: ExecutableStatus
  /**
   * Present when the main process could ask the provider manager. Optional so
   * the binary probe can be tested on its own without starting a provider.
   */
  poToken?: PoTokenStatus
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
