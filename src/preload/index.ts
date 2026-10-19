import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  EVENT_CHANNELS,
  IPC,
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

  pickFolder: () => ipcRenderer.invoke(IPC.pickFolder) as Promise<string | null>,

  openPath: (target: string) => ipcRenderer.invoke(IPC.openPath, target) as Promise<void>,

  scanLibrary: (folder?: string) => ipcRenderer.invoke(IPC.libraryScan, folder),

  cancelScan: () => ipcRenderer.invoke(IPC.libraryScanCancel) as Promise<void>,

  listTracks: (query?: ListTracksQuery) => ipcRenderer.invoke(IPC.libraryListTracks, query),

  getStats: () => ipcRenderer.invoke(IPC.libraryStats),

  removeLibraryFolder: (folder: string) =>
    ipcRenderer.invoke(IPC.libraryRemoveFolder, folder) as Promise<AppSettings>,

  revealTrack: (trackId: number) => ipcRenderer.invoke(IPC.libraryRevealTrack, trackId) as Promise<void>,

  getArtwork: (trackId: number) => ipcRenderer.invoke(IPC.libraryArtwork, trackId) as Promise<string | null>,

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

  loadPlayback: () => ipcRenderer.invoke(IPC.playbackLoad),

  savePlayback: (snapshot: PlaybackSnapshot) => ipcRenderer.send(IPC.playbackSave, snapshot),

  clearPlayback: () => ipcRenderer.send(IPC.playbackClear),

  resolveSource: (trackId: number) => ipcRenderer.invoke(IPC.mediaResolve, trackId),

  reportPlayback: (trackId: number, playedMs: number, completed: boolean) =>
    ipcRenderer.invoke(IPC.mediaReportPlay, trackId, playedMs, completed) as Promise<void>,

  getEngineStatus: () => ipcRenderer.invoke(IPC.engineStatus),

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
