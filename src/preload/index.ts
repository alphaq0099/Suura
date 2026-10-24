import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  EVENT_CHANNELS,
  IPC,
  type ArtworkRequest,
  type PlayerApi,
  type PlayerEventName,
  type PlayerEvents
} from '@shared/ipc'
import type { AppSettings, DeepPartial, ListTracksQuery, PlaybackSnapshot } from '@shared/types'

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

  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder) as Promise<string | null>,

  openPath: (target: string) => ipcRenderer.invoke(IPC.openPath, target) as Promise<void>,

  backupData: () => ipcRenderer.invoke(IPC.dataBackup) as Promise<string | null>,

  restoreData: () => ipcRenderer.invoke(IPC.dataRestore) as Promise<boolean>,

  scanLibrary: (folder?: string) => ipcRenderer.invoke(IPC.libraryScan, folder),

  cancelScan: () => ipcRenderer.invoke(IPC.libraryScanCancel) as Promise<void>,

  listTracks: (query?: ListTracksQuery) => ipcRenderer.invoke(IPC.libraryListTracks, query),

  getStats: () => ipcRenderer.invoke(IPC.libraryStats),

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

  prefetchSource: (track) => ipcRenderer.invoke(IPC.mediaPrefetch, track) as Promise<void>,

  scanReplayGain: () => ipcRenderer.invoke(IPC.replayGainScan),

  cancelReplayGain: () => ipcRenderer.invoke(IPC.replayGainCancel) as Promise<void>,

  getReplayGainStatus: () => ipcRenderer.invoke(IPC.replayGainStatus),

  listOnline: () => ipcRenderer.invoke(IPC.onlineList),

  addOnlineLink: (url: string) => ipcRenderer.invoke(IPC.onlineAddLink, url),

  removeOnline: (id: number) => ipcRenderer.invoke(IPC.onlineRemove, id) as Promise<void>,

  clearOnline: () => ipcRenderer.invoke(IPC.onlineClear) as Promise<number>,

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

  savedVideoIds: (videoIds: string[]) =>
    ipcRenderer.invoke(IPC.downloadSavedIds, videoIds) as Promise<string[]>,

  readClipboardText: () => ipcRenderer.invoke(IPC.clipboardRead) as Promise<string>,

  writeClipboardText: (text: string) => ipcRenderer.invoke(IPC.clipboardWrite, text) as Promise<void>,

  reportPlayback: (trackId: number, playedMs: number, completed: boolean) =>
    ipcRenderer.invoke(IPC.mediaReportPlay, trackId, playedMs, completed) as Promise<void>,

  getEngineStatus: () => ipcRenderer.invoke(IPC.engineStatus),

  getPoTokenStatus: () => ipcRenderer.invoke(IPC.poTokenStatus),

  startPoTokenProvider: () => ipcRenderer.invoke(IPC.poTokenStart),

  stopPoTokenProvider: () => ipcRenderer.invoke(IPC.poTokenStop),

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
