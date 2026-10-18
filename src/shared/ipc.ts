/**
 * The single source of truth for the main <-> renderer contract.
 *
 * Both sides import from here, so adding a channel without wiring both ends is a
 * compile error instead of a runtime "no handler registered for ..." crash.
 */
import type {
  AppPaths,
  AppSettings,
  DeepPartial,
  EngineStatus,
  LibraryStats,
  ListTracksQuery,
  ResolvedSource,
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
  mediaResolve: 'media:resolve',
  mediaReportPlay: 'media:report-play',
  engineStatus: 'engine:status'
} as const

/** Main -> renderer push channels. */
export const IPC_EVENTS = {
  scanProgress: 'event:scan-progress',
  libraryChanged: 'event:library-changed',
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
  playerCommand: PlayerCommand
}

export type PlayerEventName = keyof PlayerEvents

/** Maps an event name to its IPC channel. */
export const EVENT_CHANNELS: Record<PlayerEventName, IpcEventChannel> = {
  scanProgress: IPC_EVENTS.scanProgress,
  libraryChanged: IPC_EVENTS.libraryChanged,
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
  resolveSource(trackId: number): Promise<ResolvedSource>
  reportPlayback(trackId: number, playedMs: number, completed: boolean): Promise<void>
  getEngineStatus(): Promise<EngineStatus>
  on<E extends PlayerEventName>(event: E, callback: (payload: PlayerEvents[E]) => void): number
  off(token: number): void
}
