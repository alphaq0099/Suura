/**
 * The single source of truth for the main <-> renderer contract.
 *
 * Both sides import from here, so adding a channel without wiring both ends is a
 * compile error instead of a runtime "no handler registered for ..." crash.
 */
import type {
  AddTracksOutcome,
  AlbumPage,
  AllTracksPage,
  AllTracksQuery,
  AppPaths,
  AppSettings,
  ArtworkChoice,
  ArtistSummary,
  CacheEntryDetails,
  CacheStats,
  DeepPartial,
  DownloadHistoryItem,
  DownloadProgress,
  DroppedPathsResult,
  DuplicateMergeOutcome,
  DuplicateReport,
  EngineStatus,
  LibraryStats,
  LibrarySearchResult,
  ListAlbumsQuery,
  ListTracksQuery,
  OnlinePlaylist,
  RelocateReport,
  OnlinePlaylistDetail,
  OnlineTrack,
  PlaybackSnapshot,
  Playlist,
  PlaylistDetail,
  PlaylistImportOutcome,
  PoTokenStatus,
  ReplayGainStatus,
  ResolvedSource,
  ResolvableTrack,
  RuntimeInfo,
  SavedPlayback,
  SaveToLibraryRequest,
  ScanProgress,
  StreamPlay,
  TagLookupResult,
  Track,
  TrackLyrics,
  TrackPage,
  TrackTagFields,
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
  runtimeInfo: 'app:runtime-info',
  diagnosticsSave: 'app:save-diagnostics',
  pickFolder: 'dialogs:pick-folder',
  openPath: 'shell:open-path',
  dataBackup: 'data:backup',
  dataRestore: 'data:restore',
  libraryScan: 'library:scan',
  libraryScanCancel: 'library:scan-cancel',
  libraryAddPaths: 'library:add-paths',
  libraryListTracks: 'library:list-tracks',
  librarySearch: 'library:search',
  libraryTracksByIds: 'library:tracks-by-ids',
  libraryListAlbums: 'library:list-albums',
  libraryAllTracks: 'library:all-tracks',
  libraryListArtists: 'library:list-artists',
  libraryStats: 'library:stats',
  libraryUpdateTags: 'library:update-tags',
  libraryAutoTag: 'library:auto-tag',
  libraryLyrics: 'library:lyrics',
  libraryLyricsOffset: 'library:lyrics-offset',
  libraryRemoveFolder: 'library:remove-folder',
  libraryRevealTrack: 'library:reveal-track',
  libraryArtwork: 'library:artwork',
  libraryArtworkChoices: 'library:artwork-choices',
  libraryArtworkCovers: 'library:artwork-covers',
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
  replayGainScan: 'audio:replay-gain-scan',
  replayGainCancel: 'audio:replay-gain-cancel',
  replayGainStatus: 'audio:replay-gain-status',
  onlineList: 'online:list',
  onlineAddLink: 'online:add-link',
  onlineRemove: 'online:remove',
  onlineClear: 'online:clear',
  onlineStreamPlays: 'online:stream-plays',
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
  downloadPause: 'download:pause',
  downloadResume: 'download:resume',
  downloadRemove: 'download:remove',
  downloadSavedIds: 'download:saved-ids',
  downloadHistory: 'download:history',
  downloadDismiss: 'download:dismiss',
  cacheStats: 'cache:stats',
  cacheList: 'cache:list',
  cacheClear: 'cache:clear',
  cacheClean: 'cache:clean',
  cachePromote: 'cache:promote',
  cachePin: 'cache:pin',
  cacheReveal: 'cache:reveal',
  cacheRemove: 'cache:remove',
  clipboardRead: 'clipboard:read-text',
  clipboardWrite: 'clipboard:write-text',
  mediaReportPlay: 'media:report-play',
  engineStatus: 'engine:status',
  poTokenStatus: 'engine:po-token-status',
  poTokenStart: 'engine:po-token-start',
  poTokenStop: 'engine:po-token-stop',
  windowGetMini: 'window:get-mini',
  windowSetMini: 'window:set-mini',
  windowSetTaskbarState: 'window:set-taskbar-state'
} as const

/** Main -> renderer push channels. */
export const IPC_EVENTS = {
  scanProgress: 'event:scan-progress',
  libraryChanged: 'event:library-changed',
  onlineChanged: 'event:online-changed',
  downloadChanged: 'event:download-changed',
  playHistoryChanged: 'event:play-history-changed',
  playerCommand: 'event:player-command',
  replayGainProgress: 'event:replay-gain-progress'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
export type IpcEventChannel = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS]

/**
 * Transport commands the main process can push at the player (media keys, the
 * tray menu and the taskbar thumbnail buttons); the renderer already handles
 * them.
 */
export type PlayerCommand =
  | { type: 'play-pause' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'stop' }
  /** Toggle the compact layout; the renderer asks main to resize the window. */
  | { type: 'mini-player' }

/** What the taskbar thumbnail toolbar should show right now. */
export interface TaskbarState {
  hasTrack: boolean
  isPlaying: boolean
  /**
   * The local row being played, so the main process can refuse to rewrite a
   * file it is currently streaming. Null for a remote track or nothing playing.
   */
  trackId: number | null
}

/** Payload type for each push event, so `on()` can be strongly typed. */
export interface PlayerEvents {
  scanProgress: ScanProgress
  libraryChanged: null
  /** A link was remembered, removed or played, so the Online history moved. */
  onlineChanged: null
  /** A save started, advanced, finished or failed. */
  downloadChanged: DownloadProgress
  /** A listen was counted, so recent-play shelves and history are stale. */
  playHistoryChanged: null
  playerCommand: PlayerCommand
  /** A loudness scan started, advanced or finished. */
  replayGainProgress: ReplayGainStatus
}

export type PlayerEventName = keyof PlayerEvents

/** Maps an event name to its IPC channel. */
export const EVENT_CHANNELS: Record<PlayerEventName, IpcEventChannel> = {
  scanProgress: IPC_EVENTS.scanProgress,
  libraryChanged: IPC_EVENTS.libraryChanged,
  onlineChanged: IPC_EVENTS.onlineChanged,
  downloadChanged: IPC_EVENTS.downloadChanged,
  playHistoryChanged: IPC_EVENTS.playHistoryChanged,
  playerCommand: IPC_EVENTS.playerCommand,
  replayGainProgress: IPC_EVENTS.replayGainProgress
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
  /** App and runtime versions for About; no machine or account details. */
  getRuntimeInfo(): Promise<RuntimeInfo>
  /**
   * Asks where to write a diagnostics bundle, then writes the renderer summary
   * plus the recent log. Resolves to the file path, or null when cancelled.
   */
  saveDiagnostics(summary: string): Promise<string | null>
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
  /**
   * Adds folders, or the folders containing dropped audio files, to the library
   * and scans them. Rejects when nothing droppable was supplied or a scan is
   * already running.
   */
  addDroppedPaths(paths: string[]): Promise<DroppedPathsResult>
  /**
   * The absolute path behind a `File` from an OS drag-and-drop.
   *
   * Modern Electron no longer exposes `File.path`; this is the supported lookup
   * and it has to live in preload, where `webUtils` is available.
   */
  getPathForFile(file: File): string
  listTracks(query?: ListTracksQuery): Promise<TrackPage>
  /**
   * The merged, deduped feed Home shows below its shelves.
   *
   * One call instead of four, because the list is ordered across all of them:
   * local files, counted stream listens, imported playlist entries and remembered
   * YouTube links, newest activity first.
   */
  listAllTracks(query?: AllTracksQuery): Promise<AllTracksPage>
  /**
   * Searches local files and database-only imported YouTube tracks together.
   *
   * One round trip so live typing can update both shelves in the same frame.
   * YouTube is deliberately absent: that is a separate, explicit request.
   */
  searchLibrary(query: string, limit?: number): Promise<LibrarySearchResult>
  /**
   * Looks up specific rows in one request.
   *
   * Downloads keeps only video ids and track ids, and restoring a selection of
   * twenty rows should not become twenty separate IPC round trips.
   */
  getTracks(trackIds: number[]): Promise<Track[]>
  /** Album summaries grouped by album title and album artist. */
  listAlbums(query?: ListAlbumsQuery): Promise<AlbumPage>
  /** Artists for the Home shelf, most recently played first. */
  listArtists(limit?: number): Promise<ArtistSummary[]>
  getStats(): Promise<LibraryStats>
  /**
   * Writes tags into a local file and refreshes its row.
   *
   * The file is rewritten atomically and a copy is kept under `backups/tags`,
   * so this is not a "maybe it worked" operation: it either resolves with the
   * updated row or rejects with a message that says why nothing changed.
   *
   * `artworkKey` is one of the cache keys `getArtworkChoices` handed out: the
   * bytes behind it are read here and embedded, so what was previewed is what
   * lands in the file. `null` removes the cover, and leaving it out keeps the
   * picture the file already has.
   */
  updateTrackTags(
    trackId: number,
    fields: TrackTagFields,
    artworkKey?: string | null
  ): Promise<Track>
  /**
   * Covers this file could use, from its own tags, its folder, its video and
   * any provider. Each is already cached, so the picker can show it at once.
   */
  getArtworkChoices(trackId: number): Promise<ArtworkChoice[]>
  /**
   * Asks the providers for a cover, the way **Find tags** asks for tags. The
   * results are cached too, so choosing one and saving sends a key rather than
   * a second download.
   */
  findArtworkCovers(trackId: number): Promise<ArtworkChoice[]>
  /**
   * Asks iTunes and MusicBrainz what this file is, scored against its own tags.
   *
   * The answer is a proposal, never a write: the review dialog decides which
   * fields to take, and those go through `updateTrackTags` like a manual edit.
   * Both providers are best effort, so a partial or empty answer is normal.
   */
  findTrackTags(trackId: number): Promise<TagLookupResult>
  /**
   * The lyrics already on disk for a local track, or null when it has none.
   *
   * A tag inside the file is read first; a `.lrc` with the same base name wins
   * over it, because that is the copy a user can edit without rewriting the
   * audio. Nothing here touches the network.
   */
  getTrackLyrics(trackId: number): Promise<TrackLyrics | null>
  /**
   * Remembers how far the lyrics should be shifted for this track.
   *
   * Positive values show the lines later. The offset is the user's, so it is
   * stored in the database rather than written into the file.
   */
  setTrackLyricsOffset(trackId: number, offsetMs: number): Promise<TrackLyrics | null>
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
   * Imports an M3U, M3U8 or Suura JSON playlist as a new custom playlist.
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
   * Resolves a track that will probably play next, without treating it as a
   * play.
   *
   * It returns the source so the player can attach it to its idle element and
   * hand over at the exact end of the current track. Unlike `resolveSource` it
   * does not lift a history row for a YouTube link: a guess about the queue is
   * not a play, and should not become one until the track actually starts.
   */
  prefetchSource(track: ResolvableTrack): Promise<ResolvedSource>
  /**
   * Measures ReplayGain for every local file that has no value yet.
   *
   * Long-running and CPU-heavy: progress is pushed on `replayGainProgress`.
   * Resolves when the run finishes or is cancelled.
   */
  scanReplayGain(): Promise<ReplayGainStatus>
  /** Stops a running loudness scan; ffmpeg is killed, not left to finish. */
  cancelReplayGain(): Promise<void>
  /** The current or last run, including how much of the library is analysed. */
  getReplayGainStatus(): Promise<ReplayGainStatus>
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
   * Counted listens of YouTube tracks, newest first.
   *
   * Separate from `listOnline`: a play from an imported list is not a link the
   * user added, but it is still something they listened to. Home's Recently
   * played shelf merges these with the local albums and singles.
   */
  listStreamPlays(limit?: number): Promise<StreamPlay[]>
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
  /**
   * Pauses one actively downloading save, keeping its partial file for a later
   * resume. Queued saves are cancelled instead; resolves false when there was
   * nothing to pause.
   */
  pauseSave(videoId: string): Promise<boolean>
  /** Resumes a paused save from the same temporary folder. */
  resumeSave(videoId: string): Promise<boolean>
  /**
   * Deletes a saved download's file and turns its history row into `removed`.
   * The library row and any playlist/queue reference stay, falling back to the
   * YouTube stream.
   */
  removeDownload(videoId: string): Promise<boolean>
  /** Which video ids already have a library row, for "already saved" badges. */
  savedVideoIds(videoIds: string[]): Promise<string[]>
  /**
   * Saves that outlived their window: unfinished, failed or cancelled.
   *
   * Successful rows are included too (newest first) so the future downloads
   * screen can show recent history. The saves dock filters to rows that need
   * attention.
   */
  listDownloadHistory(): Promise<DownloadHistoryItem[]>
  /** Removes one history row, so a dismissed failure does not return. */
  dismissDownload(videoId: string): Promise<void>
  /** Cache usage against the current budget. */
  getCacheStats(): Promise<CacheStats>
  /** Completed cache entries, most recently used first. */
  listCacheEntries(limit?: number): Promise<CacheEntryDetails[]>
  /** Deletes every cache file that is not currently open by the player. */
  clearCache(): Promise<CacheStats>
  /**
   * Applies the age and size policy now and reports the resulting usage.
   *
   * This is the same bounded prune the janitor runs, not a clear. It exists so
   * the user can reclaim space and see exactly what the policy removed.
   */
  cleanCacheNow(): Promise<CacheStats>
  /**
   * Copies one cached track into the library without downloading it again.
   *
   * Resolves to the new track id. The renderer never supplies a file path;
   * main validates the entry, copies its bytes and indexes the result.
   */
  promoteCacheEntry(videoId: string): Promise<number>
  /** Pins or unpins an entry; pinned entries are never evicted automatically. */
  setCachePinned(videoId: string, pinned: boolean): Promise<CacheStats>
  /** Shows a cached file in Explorer. The renderer never learns its path. */
  revealCacheEntry(videoId: string): Promise<void>
  /** Deletes one cache file. Resolves false when a lock kept it in place. */
  removeCacheEntry(videoId: string): Promise<boolean>
  /** The system clipboard text, so the paste button needs no select-all. */
  readClipboardText(): Promise<string>
  writeClipboardText(text: string): Promise<void>
  reportPlayback(trackId: number, playedMs: number, completed: boolean): Promise<void>
  getEngineStatus(): Promise<EngineStatus>
  /** The provider switch, URL and whether its `/ping` endpoint answers. */
  getPoTokenStatus(): Promise<PoTokenStatus>
  /** Starts the configured provider command and waits until it answers. */
  startPoTokenProvider(): Promise<PoTokenStatus>
  /** Stops only a provider this app started; external servers are untouched. */
  stopPoTokenProvider(): Promise<PoTokenStatus>
  /** True when the window is currently in its compact layout. */
  isMiniPlayer(): Promise<boolean>
  /**
   * Resizes the one window between the full UI and mini. The renderer changes
   * its own layout; this call only owns the native bounds and minimum size.
   */
  setMiniPlayer(enabled: boolean): Promise<boolean>
  /**
   * Rebuilds the Windows taskbar thumbnail toolbar.
   *
   * Resolves false on platforms without the feature, or when the window is
   * already gone. Its clicks come back as `playerCommand` events, so it is one
   * more way into the same transport as the media keys and tray.
   */
  setTaskbarState(state: TaskbarState): Promise<boolean>
  on<E extends PlayerEventName>(event: E, callback: (payload: PlayerEvents[E]) => void): number
  off(token: number): void
}
