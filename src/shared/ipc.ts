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
  EngineStatus,
  LibraryStats,
  ListTracksQuery,
  OnlineTrack,
  PlaybackSnapshot,
  Playlist,
  PlaylistDetail,
  ResolvedSource,
  ResolvableTrack,
  SavedPlayback,
  ScanProgress,
  TrackPage
} from './types'

/** Request/response channels, all backed by `ipcMain.handle`. */
export const IPC = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  pathsGet: 'app:paths',
  pickFolder: 'dialogs:pick-folder',
  openPath: 'shell:open-path',
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
  playbackLoad: 'playback:load',
  playbackSave: 'playback:save',
  playbackClear: 'playback:clear',
  mediaResolve: 'media:resolve',
  onlineList: 'online:list',
  onlineAddLink: 'online:add-link',
  onlineRemove: 'online:remove',
  onlineClear: 'online:clear',
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
  playerCommand: PlayerCommand
}

export type PlayerEventName = keyof PlayerEvents

/** Maps an event name to its IPC channel. */
export const EVENT_CHANNELS: Record<PlayerEventName, IpcEventChannel> = {
  scanProgress: IPC_EVENTS.scanProgress,
  libraryChanged: IPC_EVENTS.libraryChanged,
  onlineChanged: IPC_EVENTS.onlineChanged,
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
   */
  getArtwork(trackId: number): Promise<string | null>
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
  /** The system clipboard text, so the paste button needs no select-all. */
  readClipboardText(): Promise<string>
  writeClipboardText(text: string): Promise<void>
  reportPlayback(trackId: number, playedMs: number, completed: boolean): Promise<void>
  getEngineStatus(): Promise<EngineStatus>
  on<E extends PlayerEventName>(event: E, callback: (payload: PlayerEvents[E]) => void): number
  off(token: number): void
}
