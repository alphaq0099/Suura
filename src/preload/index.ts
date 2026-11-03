import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import {
  EVENT_CHANNELS,
  IPC,
  type ArtworkRequest,
  type PlayerApi,
  type PlayerEventName,
  type PlayerEvents
} from '@shared/ipc'
import type {
  AllTracksQuery,
  AppSettings,
  ArtworkChoice,
  DeepPartial,
  ListAlbumsQuery,
  ListTracksQuery,
  LyricsBatchApplyResult,
  LyricsBatchSnapshot,
  LyricsBatchUndoResult,
  LyricsCandidate,
  LyricsLookupResult,
  LyricsTarget,
  LyricsWriteResult,
  PlaybackSnapshot,
  ResolvedSource,
  TagBatchApplyResult,
  TagBatchMode,
  TagBatchSnapshot,
  TagBatchUndoResult,
  TagLookupResult,
  TagWriteResult,
  TrackLyrics,
  TrackTagFields,
  UpdateStatus,
  YtDlpRollbackStatus
} from '@shared/types'

/**
 * The only bridge between the renderer and the main process.
 *
 * `ipcRenderer` itself is never exposed: the renderer can call these methods and
 * nothing else, and only the channels listed in shared/ipc.ts are reachable.
 */

const subscriptions = new Map<number, { channel: string; listener: (event: IpcRendererEvent, payload: unknown) => void }>()
let nextToken = 1

const api: PlayerApi = {
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<AppSettings>,

  updateSettings: (patch: DeepPartial<AppSettings>) =>
    ipcRenderer.invoke(IPC.settingsUpdate, patch) as Promise<AppSettings>,

  getPaths: () => ipcRenderer.invoke(IPC.pathsGet),

  getRuntimeInfo: () => ipcRenderer.invoke(IPC.runtimeInfo),

  saveDiagnostics: (summary: string) =>
    ipcRenderer.invoke(IPC.diagnosticsSave, summary) as Promise<string | null>,

  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder) as Promise<string | null>,

  openPath: (target: string) => ipcRenderer.invoke(IPC.openPath, target) as Promise<void>,

  backupData: () => ipcRenderer.invoke(IPC.dataBackup) as Promise<string | null>,

  restoreData: () => ipcRenderer.invoke(IPC.dataRestore) as Promise<boolean>,

  scanLibrary: (folder?: string) => ipcRenderer.invoke(IPC.libraryScan, folder),

  cancelScan: () => ipcRenderer.invoke(IPC.libraryScanCancel) as Promise<void>,

  addDroppedPaths: (paths: string[]) => ipcRenderer.invoke(IPC.libraryAddPaths, paths),

  // Not IPC: the File object only exists in the renderer world, and `webUtils`
  // is one of the few Electron helpers that must be reached from preload.
  getPathForFile: (file: File) => webUtils.getPathForFile(file),

  listTracks: (query?: ListTracksQuery) => ipcRenderer.invoke(IPC.libraryListTracks, query),

  searchLibrary: (query: string, limit?: number) =>
    ipcRenderer.invoke(IPC.librarySearch, query, limit),

  getTracks: (trackIds: number[]) => ipcRenderer.invoke(IPC.libraryTracksByIds, trackIds),

  listAlbums: (query?: ListAlbumsQuery) => ipcRenderer.invoke(IPC.libraryListAlbums, query),

  listAllTracks: (query?: AllTracksQuery) => ipcRenderer.invoke(IPC.libraryAllTracks, query),

  listArtists: (limit?: number) => ipcRenderer.invoke(IPC.libraryListArtists, limit),

  getStats: () => ipcRenderer.invoke(IPC.libraryStats),

  updateTrackTags: (trackId: number, fields: TrackTagFields, artworkKey?: string | null) =>
    ipcRenderer.invoke(IPC.libraryUpdateTags, trackId, fields, artworkKey) as Promise<TagWriteResult>,

  getArtworkChoices: (trackId: number) =>
    ipcRenderer.invoke(IPC.libraryArtworkChoices, trackId) as Promise<ArtworkChoice[]>,

  findArtworkCovers: (trackId: number) =>
    ipcRenderer.invoke(IPC.libraryArtworkCovers, trackId) as Promise<ArtworkChoice[]>,

  findTrackTags: (trackId: number) =>
    ipcRenderer.invoke(IPC.libraryAutoTag, trackId) as Promise<TagLookupResult>,

  findTrackTagsByFingerprint: (trackId: number) =>
    ipcRenderer.invoke(IPC.libraryAutoTagFingerprint, trackId) as Promise<TagLookupResult>,

  getTrackLyrics: (target: LyricsTarget) =>
    ipcRenderer.invoke(IPC.libraryLyrics, target) as Promise<TrackLyrics | null>,

  getFileLyrics: (target: LyricsTarget) =>
    ipcRenderer.invoke(IPC.libraryFileLyrics, target) as Promise<TrackLyrics | null>,

  setTrackLyricsOffset: (target: LyricsTarget, offsetMs: number) =>
    ipcRenderer.invoke(IPC.libraryLyricsOffset, target, offsetMs) as Promise<TrackLyrics | null>,

  findTrackLyrics: (target: LyricsTarget) =>
    ipcRenderer.invoke(IPC.libraryLyricsFind, target) as Promise<LyricsLookupResult>,

  useTrackLyrics: (target: LyricsTarget, candidate: LyricsCandidate) =>
    ipcRenderer.invoke(IPC.libraryLyricsUse, target, candidate) as Promise<TrackLyrics | null>,

  useFileLyrics: (target: LyricsTarget) =>
    ipcRenderer.invoke(IPC.libraryLyricsUseFile, target) as Promise<TrackLyrics | null>,

  writeTrackLyricsToFile: (target: LyricsTarget) =>
    ipcRenderer.invoke(IPC.libraryLyricsWrite, target) as Promise<LyricsWriteResult>,

  startLyricsBatch: (trackIds: number[]) =>
    ipcRenderer.invoke(IPC.libraryLyricsBatchStart, trackIds) as Promise<{ jobId: string }>,

  getLyricsBatch: (jobId: string) =>
    ipcRenderer.invoke(IPC.libraryLyricsBatchGet, jobId) as Promise<LyricsBatchSnapshot | null>,

  cancelLyricsBatch: (jobId: string) =>
    ipcRenderer.invoke(IPC.libraryLyricsBatchCancel, jobId) as Promise<void>,

  applyLyricsBatch: (jobId: string, itemIds: string[], writeToFile: boolean) =>
    ipcRenderer.invoke(IPC.libraryLyricsBatchApply, jobId, itemIds, writeToFile) as Promise<LyricsBatchApplyResult>,

  undoLyricsBatch: (jobId: string) =>
    ipcRenderer.invoke(IPC.libraryLyricsBatchUndo, jobId) as Promise<LyricsBatchUndoResult>,

  startTagBatch: (trackIds: number[]) =>
    ipcRenderer.invoke(IPC.libraryTagBatchStart, trackIds) as Promise<{ jobId: string }>,

  getTagBatch: (jobId: string) =>
    ipcRenderer.invoke(IPC.libraryTagBatchGet, jobId) as Promise<TagBatchSnapshot | null>,

  cancelTagBatch: (jobId: string) =>
    ipcRenderer.invoke(IPC.libraryTagBatchCancel, jobId) as Promise<void>,

  applyTagBatch: (jobId: string, itemIds: string[], mode: TagBatchMode) =>
    ipcRenderer.invoke(IPC.libraryTagBatchApply, jobId, itemIds, mode) as Promise<TagBatchApplyResult>,

  undoTagBatch: (jobId: string) =>
    ipcRenderer.invoke(IPC.libraryTagBatchUndo, jobId) as Promise<TagBatchUndoResult>,

  removeLibraryFolder: (folder: string) =>
    ipcRenderer.invoke(IPC.libraryRemoveFolder, folder) as Promise<AppSettings>,

  revealTrack: (trackId: number) => ipcRenderer.invoke(IPC.libraryRevealTrack, trackId) as Promise<void>,

  getArtwork: (request: ArtworkRequest) =>
    ipcRenderer.invoke(IPC.libraryArtwork, request) as Promise<string | null>,

  listPlaylists: () => ipcRenderer.invoke(IPC.playlistsList),

  createPlaylist: (name: string) => ipcRenderer.invoke(IPC.playlistsCreate, name),

  renamePlaylist: (playlistId: number, name: string) =>
    ipcRenderer.invoke(IPC.playlistsRename, playlistId, name),

  deletePlaylist: (playlistId: number) => ipcRenderer.invoke(IPC.playlistsDelete, playlistId) as Promise<void>,

  getPlaylist: (playlistId: number) => ipcRenderer.invoke(IPC.playlistsDetail, playlistId),

  addTracksToPlaylist: (playlistId: number, trackIds: number[]) =>
    ipcRenderer.invoke(IPC.playlistsAddTracks, playlistId, trackIds),

  removePlaylistItems: (playlistId: number, itemIds: number[]) =>
    ipcRenderer.invoke(IPC.playlistsRemoveItems, playlistId, itemIds),

  movePlaylistItem: (playlistId: number, itemId: number, toIndex: number) =>
    ipcRenderer.invoke(IPC.playlistsMoveItem, playlistId, itemId, toIndex),

  clearPlaylist: (playlistId: number) => ipcRenderer.invoke(IPC.playlistsClear, playlistId),

  exportPlaylist: (playlistId: number) =>
    ipcRenderer.invoke(IPC.playlistsExport, playlistId) as Promise<string | null>,

  importPlaylist: () => ipcRenderer.invoke(IPC.playlistsImport),

  exportLibraryCsv: () => ipcRenderer.invoke(IPC.libraryExportCsv) as Promise<string | null>,

  findDuplicates: () => ipcRenderer.invoke(IPC.libraryFindDuplicates),

  mergeDuplicates: () => ipcRenderer.invoke(IPC.libraryMergeDuplicates),

  relocateMissing: () => ipcRenderer.invoke(IPC.libraryRelocate),

  removeTracks: (trackIds: number[]) => ipcRenderer.invoke(IPC.libraryRemoveTracks, trackIds),

  loadPlayback: () => ipcRenderer.invoke(IPC.playbackLoad),

  savePlayback: (snapshot: PlaybackSnapshot) => ipcRenderer.send(IPC.playbackSave, snapshot),

  clearPlayback: () => ipcRenderer.send(IPC.playbackClear),

  resolveSource: (track) => ipcRenderer.invoke(IPC.mediaResolve, track),

  prefetchSource: (track) =>
    ipcRenderer.invoke(IPC.mediaPrefetch, track) as Promise<ResolvedSource>,

  scanReplayGain: () => ipcRenderer.invoke(IPC.replayGainScan),

  cancelReplayGain: () => ipcRenderer.invoke(IPC.replayGainCancel) as Promise<void>,

  getReplayGainStatus: () => ipcRenderer.invoke(IPC.replayGainStatus),

  listOnline: () => ipcRenderer.invoke(IPC.onlineList),

  addOnlineLink: (url: string) => ipcRenderer.invoke(IPC.onlineAddLink, url),

  removeOnline: (id: number) => ipcRenderer.invoke(IPC.onlineRemove, id) as Promise<void>,

  clearOnline: () => ipcRenderer.invoke(IPC.onlineClear) as Promise<number>,

  listStreamPlays: (limit?: number) => ipcRenderer.invoke(IPC.onlineStreamPlays, limit),

  importOnlineList: (url: string, limit?: number) => ipcRenderer.invoke(IPC.onlineImport, url, limit),

  searchYouTube: (query: string, limit?: number, offset?: number) =>
    ipcRenderer.invoke(IPC.onlineSearch, query, limit, offset),

  getYouTubeChannel: (target: string, limit?: number, offset?: number) =>
    ipcRenderer.invoke(IPC.onlineChannel, target, limit, offset),

  listOnlinePlaylists: () => ipcRenderer.invoke(IPC.onlinePlaylists),

  getOnlinePlaylist: (playlistId: number) => ipcRenderer.invoke(IPC.onlinePlaylist, playlistId),

  renameOnlinePlaylist: (playlistId: number, title: string) =>
    ipcRenderer.invoke(IPC.onlinePlaylistRename, playlistId, title),

  deleteOnlinePlaylist: (playlistId: number) =>
    ipcRenderer.invoke(IPC.onlinePlaylistDelete, playlistId) as Promise<void>,

  removeOnlinePlaylistItem: (itemId: number) =>
    ipcRenderer.invoke(IPC.onlinePlaylistRemoveItem, itemId) as Promise<number | null>,

  saveToLibrary: (request) => ipcRenderer.invoke(IPC.downloadSave, request) as Promise<number>,

  cancelSave: (videoId: string) =>
    ipcRenderer.invoke(IPC.downloadCancel, videoId) as Promise<void>,

  pauseSave: (videoId: string) =>
    ipcRenderer.invoke(IPC.downloadPause, videoId) as Promise<boolean>,

  resumeSave: (videoId: string) =>
    ipcRenderer.invoke(IPC.downloadResume, videoId) as Promise<boolean>,

  removeDownload: (videoId: string) =>
    ipcRenderer.invoke(IPC.downloadRemove, videoId) as Promise<boolean>,

  savedVideoIds: (videoIds: string[]) =>
    ipcRenderer.invoke(IPC.downloadSavedIds, videoIds) as Promise<string[]>,

  listDownloadHistory: () => ipcRenderer.invoke(IPC.downloadHistory),

  dismissDownload: (videoId: string) =>
    ipcRenderer.invoke(IPC.downloadDismiss, videoId) as Promise<void>,

  getCacheStats: () => ipcRenderer.invoke(IPC.cacheStats),

  listCacheEntries: (limit?: number) => ipcRenderer.invoke(IPC.cacheList, limit),

  clearCache: () => ipcRenderer.invoke(IPC.cacheClear),

  cleanCacheNow: () => ipcRenderer.invoke(IPC.cacheClean),

  promoteCacheEntry: (videoId: string) =>
    ipcRenderer.invoke(IPC.cachePromote, videoId) as Promise<number>,

  setCachePinned: (videoId: string, pinned: boolean) =>
    ipcRenderer.invoke(IPC.cachePin, videoId, pinned),

  revealCacheEntry: (videoId: string) =>
    ipcRenderer.invoke(IPC.cacheReveal, videoId) as Promise<void>,

  removeCacheEntry: (videoId: string) =>
    ipcRenderer.invoke(IPC.cacheRemove, videoId) as Promise<boolean>,

  readClipboardText: () => ipcRenderer.invoke(IPC.clipboardRead) as Promise<string>,

  writeClipboardText: (text: string) => ipcRenderer.invoke(IPC.clipboardWrite, text) as Promise<void>,

  reportPlayback: (trackId: number, playedMs: number, completed: boolean) =>
    ipcRenderer.invoke(IPC.mediaReportPlay, trackId, playedMs, completed) as Promise<void>,

  getEngineStatus: (force?: boolean) => ipcRenderer.invoke(IPC.engineStatus, force === true),

  installSidecars: () => ipcRenderer.invoke(IPC.sidecarInstall),

  cancelSidecarInstall: () => ipcRenderer.invoke(IPC.sidecarCancel) as Promise<void>,

  getPoTokenStatus: () => ipcRenderer.invoke(IPC.poTokenStatus),

  startPoTokenProvider: () => ipcRenderer.invoke(IPC.poTokenStart),

  stopPoTokenProvider: () => ipcRenderer.invoke(IPC.poTokenStop),

  restoreYtDlp: () => ipcRenderer.invoke(IPC.ytDlpRestore) as Promise<YtDlpRollbackStatus>,

  getUpdateStatus: () => ipcRenderer.invoke(IPC.updateStatus) as Promise<UpdateStatus>,

  checkForUpdates: () => ipcRenderer.invoke(IPC.updateCheck) as Promise<UpdateStatus>,

  downloadUpdate: () => ipcRenderer.invoke(IPC.updateDownload) as Promise<UpdateStatus>,

  installUpdate: () => ipcRenderer.invoke(IPC.updateInstall) as Promise<boolean>,

  isMiniPlayer: () => ipcRenderer.invoke(IPC.windowGetMini) as Promise<boolean>,

  setMiniPlayer: (enabled: boolean) =>
    ipcRenderer.invoke(IPC.windowSetMini, enabled) as Promise<boolean>,

  setTaskbarState: (state) =>
    ipcRenderer.invoke(IPC.windowSetTaskbarState, state) as Promise<boolean>,

  on<E extends PlayerEventName>(event: E, callback: (payload: PlayerEvents[E]) => void): number {
    const token = nextToken++
    const channel = EVENT_CHANNELS[event]
    const listener = (_event: IpcRendererEvent, payload: unknown): void => {
      callback(payload as PlayerEvents[E])
    }
    subscriptions.set(token, { channel, listener })
    ipcRenderer.on(channel, listener)
    return token
  },

  off(token: number): void {
    const entry = subscriptions.get(token)
    if (!entry) return
    ipcRenderer.removeListener(entry.channel, entry.listener)
    subscriptions.delete(token)
  }
}

contextBridge.exposeInMainWorld('player', api)
