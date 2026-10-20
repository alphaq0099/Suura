/**
 * The single source of truth for the main <-> renderer contract.
 *
 * Both sides import from here, so adding a channel without wiring both ends is a
 * compile error instead of a runtime "no handler registered for ..." crash.
 */
import type {
  AddTracksOutcome,
  AppPaths,
  AppSettings,
  DeepPartial,
  DownloadProgress,
  DuplicateMergeOutcome,
  DuplicateReport,
  EngineStatus,
  LibraryStats,
  ListTracksQuery,
  OnlinePlaylist,
  RelocateReport,
  OnlinePlaylistDetail,
  OnlineTrack,
  PlaybackSnapshot,
  Playlist,
  PlaylistDetail,
  PlaylistImportOutcome,
  ResolvedSource,
  ResolvableTrack,
  SavedPlayback,
  SaveToLibraryRequest,
  ScanProgress,
  Track,
  TrackPage,
  YouTubeChannel,
  YouTubeSearchResult
} from './types'

/**
 * What the artwork lookup needs to know.
 *
 * A local track is identified by its row id. A stream is not a row, so it sends
 * its source identity too: an imported playlist entry has no history row at all
 * and its `-id` means nothing on its own.
 */
export type ArtworkRequest = number | Pick<Track, 'id' | 'sourceKind' | 'sourceId'>

/** Request/response channels, all backed by `ipcMain.handle`. */
export const IPC = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  pathsGet: 'app:paths',
  pickFolder: 'dialogs:pick-folder',
  openPath: 'shell:open-path',
  dataBackup: 'data:backup',
  dataRestore: 'data:restore',
  libraryScan: 'library:scan',
  libraryScanCancel: 'library:scan-cancel',
  libraryListTracks: 'library:list-tracks',
  libraryStats: 'library:stats',
  libraryRemoveFolder: 'library:remove-folder',
  libraryRevealTrack: 'library:reveal-track',
  libraryArtwork: 'library:artwork',
  playlistsList: 'playlists:list',
  playlistsCreate: 'playlists:create',
  playlistsRename: 'playlists:rename',
  playlistsDelete: 'playlists:delete',
  playlistsDetail: 'playlists:detail',
  playlistsAddTracks: 'playlists:add-tracks',
  playlistsRemoveItems: 'playlists:remove-items',
  playlistsMoveItem: 'playlists:move-item',
  playlistsClear: 'playlists:clear',
  playlistsExport: 'playlists:export',
  playlistsImport: 'playlists:import',
  libraryExportCsv: 'library:export-csv',
  libraryFindDuplicates: 'library:find-duplicates',
  libraryMergeDuplicates: 'library:merge-duplicates',
  libraryRelocate: 'library:relocate',
  libraryRemoveTracks: 'library:remove-tracks',
  playbackLoad: 'playback:load',
  playbackSave: 'playback:save',
  playbackClear: 'playback:clear',
  mediaResolve: 'media:resolve',
  mediaPrefetch: 'media:prefetch',
  onlineList: 'online:list',
  onlineAddLink: 'online:add-link',
  onlineRemove: 'online:remove',
  onlineClear: 'online:clear',
  onlineImport: 'online:import',
  onlineSearch: 'online:search',
  onlineChannel: 'online:channel',
  onlinePlaylists: 'online:playlists',
  onlinePlaylist: 'online:playlist',
  onlinePlaylistRename: 'online:playlist-rename',
  onlinePlaylistDelete: 'online:playlist-delete',
  onlinePlaylistRemoveItem: 'online:playlist-remove-item',
  downloadSave: 'download:save',
  downloadCancel: 'download:cancel',
  downloadSavedIds: 'download:saved-ids',
  clipboardRead: 'clipboard:read-text',
  clipboardWrite: 'clipboard:write-text',
  mediaReportPlay: 'media:report-play',
  engineStatus: 'engine:status'
} as const

/** Main -> renderer push channels. */
export const IPC_EVENTS = {
  scanProgress: 'event:scan-progress',
  libraryChanged: 'event:library-changed',
  onlineChanged: 'event:online-changed',
  downloadChanged: 'event:download-changed',
  playerCommand: 'event:player-command'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
export type IpcEventChannel = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS]

/**
 * Commands the main process can push at the player. Reserved for M2 (media keys,
 * tray menu, SMTC buttons); the renderer already handles them.
 */
export type PlayerCommand =
  | { type: 'play-pause' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'stop' }

/** Payload type for each push event, so `on()` can be strongly typed. */
export interface PlayerEvents {
  scanProgress: ScanProgress
  libraryChanged: null
  /** A link was remembered, removed or played, so the Online history moved. */
  onlineChanged: null
  /** A save started, advanced, finished or failed. */
  downloadChanged: DownloadProgress
  playerCommand: PlayerCommand
}

export type PlayerEventName = keyof PlayerEvents

/** Maps an event name to its IPC channel. */
export const EVENT_CHANNELS: Record<PlayerEventName, IpcEventChannel> = {
  scanProgress: IPC_EVENTS.scanProgress,
  libraryChanged: IPC_EVENTS.libraryChanged,
  onlineChanged: IPC_EVENTS.onlineChanged,
  downloadChanged: IPC_EVENTS.downloadChanged,
  playerCommand: IPC_EVENTS.playerCommand
}

/**
 * The object exposed on `window.player`.
 *
 * Event subscriptions are token based rather than returning an unsubscribe
 * closure, because functions returned across the contextBridge are not part of
 * the documented serialisation contract. `on` returns a numeric token and `off`
 * takes it back.
 */
export interface PlayerApi {
  getSettings(): Promise<AppSettings>
  updateSettings(patch: DeepPartial<AppSettings>): Promise<AppSettings>
  getPaths(): Promise<AppPaths>
  /** Opens the native folder picker. Resolves to null if the user cancels. */
  pickFolder(): Promise<string | null>
  openPath(target: string): Promise<void>
  /**
   * Copies the database and settings into a new backup folder the user chooses.
   *
   * Resolves to the folder, or null when the folder picker was cancelled.
   */
  backupData(): Promise<string | null>
  /**
   * Vets a backup and, after confirmation, stages it for the next start.
   *
   * Resolves true when the app is about to relaunch. It resolves false only when
   * the user cancelled; an invalid backup rejects with a readable message.
   */
  restoreData(): Promise<boolean>
  scanLibrary(folder?: string): Promise<LibraryStats>
  cancelScan(): Promise<void>
  listTracks(query?: ListTracksQuery): Promise<TrackPage>
  getStats(): Promise<LibraryStats>
  removeLibraryFolder(folder: string): Promise<AppSettings>
  revealTrack(trackId: number): Promise<void>
  /**
   * Cache key for a track's cover art, or null when it has none.
   *
   * Resolves on first call and is remembered on both sides afterwards, so the
   * renderer can call it for every row it renders without hammering the disk.
   * A stream track sends its source identity, because an imported playlist entry
   * has no history row for `-id` to point at.
   */
  getArtwork(request: ArtworkRequest): Promise<string | null>
  /** Playlists in sidebar order, each with its entry count. */
  listPlaylists(): Promise<Playlist[]>
  createPlaylist(name: string): Promise<Playlist>
  renamePlaylist(playlistId: number, name: string): Promise<Playlist>
  deletePlaylist(playlistId: number): Promise<void>
  /** A playlist's tracks in playlist order. */
  getPlaylist(playlistId: number): Promise<PlaylistDetail | null>
  /** Appends tracks, skipping ones already there. */
  addTracksToPlaylist(playlistId: number, trackIds: number[]): Promise<AddTracksOutcome>
  removePlaylistItems(playlistId: number, itemIds: number[]): Promise<PlaylistDetail | null>
  /** Moves an entry to an index in the *resulting* order. */
  movePlaylistItem(playlistId: number, itemId: number, toIndex: number): Promise<PlaylistDetail | null>
  clearPlaylist(playlistId: number): Promise<PlaylistDetail | null>
  /**
   * Exports a custom playlist through the native save dialog.
   *
   * The extension chooses M3U, M3U8 or the JSON snapshot. Resolves to the file
   * that was written, or null when the dialog was cancelled.
   */
  exportPlaylist(playlistId: number): Promise<string | null>
  /**
   * Imports an M3U, M3U8 or Player JSON playlist as a new custom playlist.
   *
   * Resolves to the import summary, or null when the dialog was cancelled.
   * Rejects with a readable message when the file cannot be parsed or none of
   * its entries are in the library.
   */
  importPlaylist(): Promise<PlaylistImportOutcome | null>
  /**
   * Writes every library row as CSV through the native save dialog.
   *
   * Resolves to the file that was written, or null when the dialog was cancelled.
   */
  exportLibraryCsv(): Promise<string | null>
  /**
   * Hashes unread local rows and reports byte-identical copies.
   *
   * The first scan reads every file; later scans only hash rows whose file has
   * changed. The files themselves are never touched by a merge.
   */
  findDuplicates(): Promise<DuplicateReport>
  /** Merges every current duplicate group, keeping the oldest row. */
  mergeDuplicates(): Promise<DuplicateMergeOutcome>
  /**
   * Opens a folder picker and points missing rows at matching files inside it.
   * Resolves null when the picker was cancelled.
   */
  relocateMissing(): Promise<RelocateReport | null>
  /**
   * Forgets library rows without deleting their files. A later scan indexes the
   * files again; removing a folder in Settings is the way to stop that.
   */
  removeTracks(trackIds: number[]): Promise<number>
  /** The last session's queue, or null when there is nothing worth resuming. */
  loadPlayback(): Promise<SavedPlayback | null>
  /**
   * Notes down what is playing. Fire-and-forget on purpose: it is called while
   * the window is closing, where awaiting a reply is not an option.
   */
  savePlayback(snapshot: PlaybackSnapshot): void
  /** Forgets the saved queue, so the next start is empty. */
  clearPlayback(): void
  resolveSource(track: ResolvableTrack): Promise<ResolvedSource>
  /**
   * Warms the resolver for a track that will probably play next.
   *
   * Fire-and-forget: it is a guess about the queue, so the caller does not care
   * whether it succeeds, and resolving early is the difference between a next
   * track that starts at once and one that waits for a sidecar run.
   */
  prefetchSource(track: ResolvableTrack): Promise<void>
  /** Every remembered link, newest activity first. */
  listOnline(): Promise<OnlineTrack[]>
  /**
   * Resolves a pasted link, remembers it and returns the history row.
   *
   * Resolving takes several seconds, which is why the Online view adds a
   * placeholder row first and fills it in when this answers.
   */
  addOnlineLink(url: string): Promise<OnlineTrack>
  /** Forgets one remembered link. Nothing on disk is touched. */
  removeOnline(id: number): Promise<void>
  /** Forgets every remembered link. Resolves to how many were removed. */
  clearOnline(): Promise<number>
  /**
   * Imports a playlist, album or mix and remembers it as an Online playlist.
   *
   * Does not touch the queue: the caller decides whether that import plays now
   * or is only added. Importing the same list again replaces its entries.
   *
   * `limit` is the number of tracks to keep (1-1000). Omitted means the Settings
   * count for that kind of list.
   */
  importOnlineList(url: string, limit?: number): Promise<OnlinePlaylistDetail>
  /**
   * Searches YouTube for videos. Metadata only; nothing is stored.
   *
   * `offset` is the number of results to skip, so the search view can page ten
   * at a time without asking for a twenty-result list on the first page.
   */
  searchYouTube(query: string, limit?: number, offset?: number): Promise<YouTubeSearchResult[]>
  /**
   * Lists a channel's recent videos by channel id, handle or URL. `offset` is
   * the number of videos to skip, so the channel page can page ten at a time.
   */
  getYouTubeChannel(target: string, limit?: number, offset?: number): Promise<YouTubeChannel>
  /** Every imported playlist, most recently imported first. */
  listOnlinePlaylists(): Promise<OnlinePlaylist[]>
  getOnlinePlaylist(playlistId: number): Promise<OnlinePlaylistDetail | null>
  /** Renames an imported playlist; the name survives a re-import. */
  renameOnlinePlaylist(playlistId: number, title: string): Promise<OnlinePlaylist | null>
  deleteOnlinePlaylist(playlistId: number): Promise<void>
  /** Removes one entry. Resolves to the playlist that changed, or null. */
  removeOnlinePlaylistItem(itemId: number): Promise<number | null>
  /**
   * Downloads a stream and indexes it into the library.
   *
   * Resolves with the library row id once the file is on disk and scanned. If
   * the video is already saved, resolves with that row without downloading.
   * Progress is pushed on `downloadChanged` while it works.
   */
  saveToLibrary(request: SaveToLibraryRequest): Promise<number>
  /**
   * Stops a save, whether it is queued or already downloading.
   *
   * The promise `saveToLibrary` returned rejects; a cancel is reported as a
   * `cancelled` progress event rather than a failure, so the UI can offer Retry
   * without treating the user's own decision as an error.
   */
  cancelSave(videoId: string): Promise<void>
  /** Which video ids already have a library row, for "already saved" badges. */
  savedVideoIds(videoIds: string[]): Promise<string[]>
  /** The system clipboard text, so the paste button needs no select-all. */
  readClipboardText(): Promise<string>
  writeClipboardText(text: string): Promise<void>
  reportPlayback(trackId: number, playedMs: number, completed: boolean): Promise<void>
  getEngineStatus(): Promise<EngineStatus>
  on<E extends PlayerEventName>(event: E, callback: (payload: PlayerEvents[E]) => void): number
  off(token: number): void
}
