import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc'
import { isImportedPlaylistTrackId } from '@shared/online'
import { clampPlaylistIndexWidth } from '@shared/playlists'
import type {
  AppSettings,
  ArtworkFit,
  ArtworkShape,
  ArtworkSize,
  DeepPartial,
  DownloadFormat,
  EngineSettings,
  InteractionSettings,
  LibraryClickAction,
  ListTracksQuery,
  PlaybackSnapshot,
  QualityTier,
  RepeatMode,
  ResolvableTrack,
  RetentionMode,
  RetentionSettings,
  SaveToLibraryRequest,
  ThemeMode,
  TrackSortField,
  VisualSettings
} from '@shared/types'
import { normalizePath } from '@core/library/content-key'
import { getEngineStatus } from '@engine/sidecar/engine-status'
import { isYouTubeVideoId } from '@shared/youtube'
import type { AppContainer } from './services/container'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function toId(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${what} id.`)
  }
  return value
}

function toTrackId(value: unknown): number {
  return toId(value, 'track')
}

/**
 * A resolve request comes from the renderer, so it names an id and a source
 * claim — never a file path. Local requests are looked up in the database by the
 * caller; YouTube requests carry the video id the resolver actually needs.
 * Negative ids are valid here because stream tracks are session-only.
 */
function toResolvableTrack(value: unknown): ResolvableTrack {
  if (!isPlainObject(value)) throw new Error('Malformed resolve request.')
  const id = value.id
  if (typeof id !== 'number' || !Number.isInteger(id)) throw new Error('Malformed resolve request.')
  if (value.sourceKind !== 'local' && value.sourceKind !== 'youtube') {
    throw new Error('Malformed resolve request.')
  }
  const sourceId = typeof value.sourceId === 'string' && value.sourceId.length <= 64 ? value.sourceId : null
  return { id, sourceKind: value.sourceKind, sourceId, filePath: null }
}

/** A list of ids from the renderer, or the request is refused outright. */
function toIdList(value: unknown, what: string): number[] {
  const valid =
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'number' && Number.isInteger(entry) && entry > 0)
  if (!valid) throw new Error(`Expected a list of ${what} ids.`)
  return [...new Set(value as number[])]
}

/**
 * A save request, narrowed to what the downloader actually uses.
 *
 * The title becomes a folder name and a file name, so it is length-capped here
 * and sanitised again by `savePathParts`; the video id is the part that must be
 * real, because it is the identity used to avoid a second download.
 */
function toSaveRequest(value: unknown): SaveToLibraryRequest {
  if (!isPlainObject(value)) throw new Error('Malformed save request.')
  const videoId = typeof value.videoId === 'string' ? value.videoId.trim() : ''
  if (!isYouTubeVideoId(videoId)) throw new Error('That link has no usable video id.')
  const title = typeof value.title === 'string' ? value.title.trim() : ''
  if (title.length === 0 || title.length > 500) throw new Error('That track has no title to save it under.')
  const artist = typeof value.artist === 'string' ? value.artist.trim().slice(0, 500) : ''
  const album = typeof value.album === 'string' ? value.album.trim().slice(0, 500) : ''
  return { videoId, title, artist: artist || null, album: album || null }
}

/** Video ids from the renderer, capped so a bad call cannot become a big query. */
function toVideoIdList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000) throw new Error('Expected a list of video ids.')
  const ids = value.filter((entry): entry is string => typeof entry === 'string' && isYouTubeVideoId(entry))
  return [...new Set(ids)]
}

/**
 * A play-state save, or null when the message cannot be trusted.
 *
 * This runs on a one-way channel, so there is no caller to throw at: a message
 * that does not look like a queue is dropped rather than written to the
 * database, where it would be read back at the next start-up.
 */
function sanitizeSnapshot(value: unknown): PlaybackSnapshot | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<PlaybackSnapshot>
  if (!Array.isArray(candidate.trackIds)) return null
  if (candidate.trackIds.length > 50_000) return null

  const valid = candidate.trackIds.every(
    (id) => typeof id === 'number' && Number.isInteger(id) && id > 0
  )
  if (!valid) return null

  const index = candidate.index
  if (typeof index !== 'number' || !Number.isInteger(index) || index < -1) return null
  if (index >= candidate.trackIds.length) return null

  const positionMs = candidate.positionMs
  if (typeof positionMs !== 'number' || !Number.isFinite(positionMs) || positionMs < 0) return null

  return { trackIds: candidate.trackIds, index, positionMs }
}

// Offline caching is deferred to its own phase. Only `stream` is accepted from
// the renderer, so a stale config or a hand-crafted patch cannot switch on a
// mode that has no implementation behind it.
const RETENTION_MODES: RetentionMode[] = ['stream']
const QUALITY_TIERS: QualityTier[] = ['best', 'high', 'balanced', 'data-saver']
const DOWNLOAD_FORMATS: DownloadFormat[] = ['opus', 'mp3', 'm4a']
const REPEAT_MODES: RepeatMode[] = ['off', 'all', 'one']
const THEMES: ThemeMode[] = ['system', 'light', 'dark']
const ARTWORK_SHAPES: ArtworkShape[] = ['square', 'circle']
const ARTWORK_FITS: ArtworkFit[] = ['cover', 'contain']
const ARTWORK_SIZES: ArtworkSize[] = ['small', 'medium', 'large', 'xlarge']
const LIBRARY_CLICK_ACTIONS: LibraryClickAction[] = ['nothing', 'select', 'play', 'select-play']
/** Must stay in step with SORT_COLUMNS in the track repository. */
const SORT_FIELDS: TrackSortField[] = ['title', 'artist', 'album', 'duration', 'year', 'added', 'played']

/**
 * Validates a settings patch coming from the renderer.
 *
 * This is not ceremony: `libraryFolders` *is* the allowlist that decides which
 * files `player-media://` will serve (see media-protocol.ts). Anything that can
 * widen that list is worth checking at the boundary.
 */
export function sanitizeSettingsPatch(input: unknown): DeepPartial<AppSettings> {
  if (!isPlainObject(input)) {
    throw new Error('Settings update must be an object.')
  }

  const patch: DeepPartial<AppSettings> = {}

  if (Array.isArray(input.libraryFolders)) {
    const folders = input.libraryFolders
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => normalizePath(entry))
    patch.libraryFolders = [...new Set(folders)]
  }

  if (typeof input.volume === 'number' && Number.isFinite(input.volume)) {
    patch.volume = clamp(input.volume, 0, 1)
  }
  if (typeof input.shuffle === 'boolean') {
    patch.shuffle = input.shuffle
  }
  if (typeof input.repeat === 'string' && REPEAT_MODES.includes(input.repeat as RepeatMode)) {
    patch.repeat = input.repeat as RepeatMode
  }
  if (typeof input.theme === 'string' && THEMES.includes(input.theme as ThemeMode)) {
    patch.theme = input.theme as ThemeMode
  }

  if (isPlainObject(input.visuals)) {
    const visuals: DeepPartial<VisualSettings> = {}
    const source = input.visuals
    if (typeof source.artworkShape === 'string' && ARTWORK_SHAPES.includes(source.artworkShape as ArtworkShape)) {
      visuals.artworkShape = source.artworkShape as ArtworkShape
    }
    if (typeof source.artworkFit === 'string' && ARTWORK_FITS.includes(source.artworkFit as ArtworkFit)) {
      visuals.artworkFit = source.artworkFit as ArtworkFit
    }
    if (typeof source.artworkSize === 'string' && ARTWORK_SIZES.includes(source.artworkSize as ArtworkSize)) {
      visuals.artworkSize = source.artworkSize as ArtworkSize
    }
    patch.visuals = visuals
  }

  if (isPlainObject(input.interaction)) {
    const interaction: DeepPartial<InteractionSettings> = {}
    const source = input.interaction
    if (
      typeof source.librarySingleClick === 'string' &&
      LIBRARY_CLICK_ACTIONS.includes(source.librarySingleClick as LibraryClickAction)
    ) {
      interaction.librarySingleClick = source.librarySingleClick as LibraryClickAction
    }
    if (
      typeof source.libraryDoubleClick === 'string' &&
      LIBRARY_CLICK_ACTIONS.includes(source.libraryDoubleClick as LibraryClickAction)
    ) {
      interaction.libraryDoubleClick = source.libraryDoubleClick as LibraryClickAction
    }
    patch.interaction = interaction
  }

  if (isPlainObject(input.retention)) {
    const retention: DeepPartial<RetentionSettings> = {}
    const source = input.retention
    if (typeof source.mode === 'string' && RETENTION_MODES.includes(source.mode as RetentionMode)) {
      retention.mode = source.mode as RetentionMode
    }
    if (typeof source.cacheBudgetMb === 'number' && Number.isFinite(source.cacheBudgetMb)) {
      retention.cacheBudgetMb = Math.round(clamp(source.cacheBudgetMb, 128, 1_000_000))
    }
    if (typeof source.cacheMaxAgeDays === 'number' && Number.isFinite(source.cacheMaxAgeDays)) {
      retention.cacheMaxAgeDays = Math.round(clamp(source.cacheMaxAgeDays, 1, 3650))
    }
    if (typeof source.downloadFolder === 'string' || source.downloadFolder === null) {
      retention.downloadFolder = source.downloadFolder === null ? null : normalizePath(source.downloadFolder)
    }
    if (typeof source.qualityTier === 'string' && QUALITY_TIERS.includes(source.qualityTier as QualityTier)) {
      retention.qualityTier = source.qualityTier as QualityTier
    }
    if (typeof source.downloadFormat === 'string' && DOWNLOAD_FORMATS.includes(source.downloadFormat as DownloadFormat)) {
      retention.downloadFormat = source.downloadFormat as DownloadFormat
    }
    patch.retention = retention
  }

  if (isPlainObject(input.engine)) {
    const engine: DeepPartial<EngineSettings> = {}
    const source = input.engine
    if (typeof source.binDir === 'string' || source.binDir === null) {
      engine.binDir = source.binDir === null ? null : normalizePath(source.binDir)
    }
    if (typeof source.autoUpdate === 'boolean') engine.autoUpdate = source.autoUpdate
    if (typeof source.downloadConcurrency === 'number' && Number.isFinite(source.downloadConcurrency)) {
      engine.downloadConcurrency = Math.round(clamp(source.downloadConcurrency, 1, 8))
    }
    if (typeof source.cookiesFromBrowser === 'string' || source.cookiesFromBrowser === null) {
      engine.cookiesFromBrowser = source.cookiesFromBrowser
    }
    if (typeof source.importLimit === 'number' && Number.isFinite(source.importLimit)) {
      engine.importLimit = Math.round(clamp(source.importLimit, 1, 1000))
    }
    if (typeof source.mixLimit === 'number' && Number.isFinite(source.mixLimit)) {
      engine.mixLimit = Math.round(clamp(source.mixLimit, 1, 500))
    }
    patch.engine = engine
  }

  if (isPlainObject(input.playlists)) {
    const source = input.playlists
    if (typeof source.indexWidth === 'number' && Number.isFinite(source.indexWidth)) {
      patch.playlists = { indexWidth: clampPlaylistIndexWidth(source.indexWidth) }
    }
  }

  return patch
}

function sanitizeListQuery(input: unknown): ListTracksQuery {
  if (!isPlainObject(input)) return {}
  const query: ListTracksQuery = {}
  if (typeof input.search === 'string' && input.search.trim().length > 0) {
    query.search = input.search.trim()
  }
  // Sorting reaches SQL as an ORDER BY fragment, so only these exact keys pass.
  if (typeof input.sort === 'string' && SORT_FIELDS.includes(input.sort as TrackSortField)) {
    query.sort = input.sort as TrackSortField
  }
  if (input.direction === 'asc' || input.direction === 'desc') {
    query.direction = input.direction
  }
  if (typeof input.limit === 'number' && Number.isFinite(input.limit)) {
    query.limit = Math.round(clamp(input.limit, 1, 50000))
  }
  if (typeof input.offset === 'number' && Number.isFinite(input.offset)) {
    query.offset = Math.max(0, Math.round(input.offset))
  }
  return query
}

export function registerIpcHandlers(container: AppContainer): void {
  const { settings, library, log } = container

  ipcMain.handle(IPC.settingsGet, () => settings.get())

  ipcMain.handle(IPC.settingsUpdate, (_event, patch: unknown) => settings.update(sanitizeSettingsPatch(patch)))

  ipcMain.handle(IPC.pathsGet, () => container.paths)

  ipcMain.handle(IPC.pickFolder, async () => {
    const parent = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a music folder',
      properties: ['openDirectory']
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    if (result.canceled) return null
    return result.filePaths[0] ?? null
  })

  ipcMain.handle(IPC.openPath, async (_event, target: unknown) => {
    if (typeof target !== 'string' || target.trim().length === 0) {
      throw new Error('Invalid path.')
    }
    const failure = await shell.openPath(target)
    if (failure) throw new Error(failure)
  })

  ipcMain.handle(IPC.libraryScan, async (_event, folder: unknown) => {
    const target = typeof folder === 'string' && folder.trim().length > 0 ? folder : undefined
    return library.scan(target)
  })

  ipcMain.handle(IPC.libraryScanCancel, () => {
    library.cancelScan()
  })

  ipcMain.handle(IPC.libraryListTracks, (_event, query: unknown) => library.list(sanitizeListQuery(query)))

  ipcMain.handle(IPC.libraryStats, () => library.stats())

  ipcMain.handle(IPC.libraryRemoveFolder, (_event, folder: unknown) => {
    if (typeof folder !== 'string' || folder.trim().length === 0) {
      throw new Error('Invalid folder.')
    }
    library.removeFolder(folder)
    return settings.get()
  })

  ipcMain.handle(IPC.libraryRevealTrack, async (_event, trackId: unknown) => {
    const track = library.trackById(toTrackId(trackId))
    if (!track?.filePath) {
      throw new Error('This track has no file on disk.')
    }
    shell.showItemInFolder(track.filePath)
  })

  ipcMain.handle(IPC.libraryArtwork, async (_event, input: unknown) => {
    // A stream row is not a `tracks` row. A history row carries the negation of
    // its id; an imported playlist entry has no history row at all, so it sends
    // the video id instead and the cover is fetched by that.
    if (typeof input === 'number') {
      if (Number.isInteger(input) && input < 0) return container.online.artworkFor(-input)
      return container.artwork.resolve(toTrackId(input))
    }

    if (!isPlainObject(input)) throw new Error('Malformed artwork request.')
    if (input.sourceKind === 'youtube') {
      const sourceId = typeof input.sourceId === 'string' ? input.sourceId : null
      if (!sourceId || !isYouTubeVideoId(sourceId)) return null
      return container.online.artworkForVideo(sourceId)
    }
    return container.artwork.resolve(toTrackId(input.id))
  })

  ipcMain.handle(IPC.mediaResolve, async (_event, input: unknown) => {
    const request = toResolvableTrack(input)
    if (request.sourceKind === 'youtube') {
      // Resolving is what "playing" means for a link, so it is when the history
      // row is lifted. An imported entry is not a link the user added: it lives
      // in its list, and playing it must not also push a copy into history.
      if (request.sourceId && !isImportedPlaylistTrackId(request.id)) {
        container.online.rememberPlay(request.sourceId)
      }
      return container.resolvers.resolve(request)
    }
    const track = library.trackById(request.id)
    if (!track) throw new Error('Unknown track.')
    return container.resolvers.resolve(track)
  })

  // The next track's resolve, run while the current one plays. Deliberately not
  // `mediaResolve`: a guess about the queue is not a play, so it must not lift a
  // history row or fail the caller when it does not work out.
  ipcMain.handle(IPC.mediaPrefetch, async (_event, input: unknown) => {
    const request = toResolvableTrack(input)
    await container.resolvers.prefetch(request)
  })

  // ---- online history --------------------------------------------------
  // A pasted link becomes a row before it is ever played or saved. Resolving it
  // here is deliberate: the answer warms the cache playback will read, so the
  // play button right after a paste is instant.
  ipcMain.handle(IPC.onlineList, () => container.online.list())

  ipcMain.handle(IPC.onlineAddLink, async (_event, input: unknown) => {
    if (typeof input !== 'string') throw new Error('Paste a YouTube video link.')
    const link = input.trim()
    if (link.length === 0 || link.length > 2048) throw new Error('Paste a YouTube video link.')
    return container.online.addLink(link)
  })

  ipcMain.handle(IPC.onlineRemove, (_event, id: unknown) => {
    container.online.remove(toId(id, 'history'))
  })

  ipcMain.handle(IPC.onlineClear, () => container.online.clear())

  // ----- imported playlists ---------------------------------------------
  // Importing is a long request (a flat listing is several seconds). It writes a
  // snapshot and returns it; queueing and playback are the renderer's call, so
  // "play now" and "add all" share one import path.
  ipcMain.handle(IPC.onlineImport, (_event, input: unknown, limit: unknown) => {
    if (typeof input !== 'string') throw new Error('Paste a YouTube playlist, album or mix link.')
    const link = input.trim()
    if (link.length === 0 || link.length > 2048) {
      throw new Error('Paste a YouTube playlist, album or mix link.')
    }
    const count =
      typeof limit === 'number' && Number.isFinite(limit) ? Math.round(limit) : undefined
    return container.online.importList(link, count)
  })

  ipcMain.handle(IPC.onlineSearch, (_event, query: unknown, limit: unknown, offset: unknown) => {
    if (typeof query !== 'string') throw new Error('Type something to search for.')
    const count = typeof limit === 'number' && Number.isFinite(limit) ? limit : undefined
    const skip = typeof offset === 'number' && Number.isFinite(offset) ? offset : undefined
    return container.online.search(query, count, skip)
  })

  ipcMain.handle(IPC.onlineChannel, (_event, target: unknown, limit: unknown, offset: unknown) => {
    if (typeof target !== 'string') throw new Error('That does not look like a channel link or id.')
    const count = typeof limit === 'number' && Number.isFinite(limit) ? limit : undefined
    const skip = typeof offset === 'number' && Number.isFinite(offset) ? offset : undefined
    return container.online.channel(target, count, skip)
  })

  ipcMain.handle(IPC.onlinePlaylists, () => container.online.playlists())

  ipcMain.handle(IPC.onlinePlaylist, (_event, id: unknown) =>
    container.online.playlist(toId(id, 'playlist'))
  )

  ipcMain.handle(IPC.onlinePlaylistRename, (_event, id: unknown, title: unknown) => {
    if (typeof title !== 'string') throw new Error('A playlist name needs 1–120 characters.')
    return container.online.renamePlaylist(toId(id, 'playlist'), title)
  })

  ipcMain.handle(IPC.onlinePlaylistDelete, (_event, id: unknown) => {
    container.online.deletePlaylist(toId(id, 'playlist'))
  })

  ipcMain.handle(IPC.onlinePlaylistRemoveItem, (_event, id: unknown) =>
    container.online.removePlaylistItem(toId(id, 'playlist entry'))
  )

  // ----- saving to the library ------------------------------------------
  // The promise resolves when the file is on disk *and* indexed: the Online
  // views can then play the local copy. Progress is pushed on downloadChanged.
  ipcMain.handle(IPC.downloadSave, (_event, input: unknown) =>
    container.downloads.save(toSaveRequest(input))
  )

  ipcMain.handle(IPC.downloadCancel, (_event, videoId: unknown) => {
    if (typeof videoId !== 'string' || !isYouTubeVideoId(videoId)) return
    container.downloads.cancel(videoId)
  })

  ipcMain.handle(IPC.downloadSavedIds, (_event, input: unknown) =>
    [...container.repo.savedOrigins('youtube', toVideoIdList(input))]
  )

  ipcMain.handle(IPC.clipboardRead, () => clipboard.readText())

  ipcMain.handle(IPC.clipboardWrite, (_event, text: unknown) => {
    // Through the main process rather than `navigator.clipboard`: the renderer's
    // async clipboard API needs a permission the app does not ask for, and the
    // Paste and Copy buttons are the whole point of not doing select-all.
    if (typeof text !== 'string' || text.length > 4096) return
    clipboard.writeText(text)
  })

  ipcMain.handle(IPC.mediaReportPlay, (_event, trackId: unknown, playedMs: unknown, completed: unknown) => {
    // A stream track is session-only and carries a negative id: there is no row
    // to count a play against until remote tracks are stored in M5.
    if (typeof trackId === 'number' && Number.isInteger(trackId) && trackId < 0) return
    library.reportPlayback(
      toTrackId(trackId),
      typeof playedMs === 'number' && Number.isFinite(playedMs) ? playedMs : 0,
      completed === true
    )
  })

  ipcMain.handle(IPC.engineStatus, async () => {
    const status = await getEngineStatus(settings.get().engine)
    log.debug('engine status probed', { ready: status.ready })
    return status
  })

  // ---- playlists --------------------------------------------------------
  // Every mutation answers with the playlist as it now stands. A hand-ordered
  // list has no client-side rule that could predict where a drop landed, so the
  // rule lives in one place (PlaylistService) and the view is told the result.
  ipcMain.handle(IPC.playlistsList, () => container.playlists.list())

  ipcMain.handle(IPC.playlistsCreate, (_event, name: unknown) => {
    if (typeof name !== 'string') throw new Error('Invalid playlist name.')
    return container.playlists.create(name)
  })

  ipcMain.handle(IPC.playlistsRename, (_event, playlistId: unknown, name: unknown) => {
    if (typeof name !== 'string') throw new Error('Invalid playlist name.')
    return container.playlists.rename(toId(playlistId, 'playlist'), name)
  })

  ipcMain.handle(IPC.playlistsDelete, (_event, playlistId: unknown) => {
    container.playlists.delete(toId(playlistId, 'playlist'))
  })

  ipcMain.handle(IPC.playlistsDetail, (_event, playlistId: unknown) =>
    container.playlists.detail(toId(playlistId, 'playlist'))
  )

  ipcMain.handle(IPC.playlistsAddTracks, (_event, playlistId: unknown, trackIds: unknown) => {
    const id = toId(playlistId, 'playlist')
    const result = container.playlists.addTracks(id, toIdList(trackIds, 'track'))
    // The counts matter to the caller — "3 added, 2 already there" is a better
    // answer than a silent nothing when the button is clicked twice.
    return { detail: container.playlists.detail(id), added: result.added, skipped: result.skipped }
  })

  ipcMain.handle(IPC.playlistsRemoveItems, (_event, playlistId: unknown, itemIds: unknown) => {
    const id = toId(playlistId, 'playlist')
    container.playlists.removeItems(id, toIdList(itemIds, 'entry'))
    return container.playlists.detail(id)
  })

  ipcMain.handle(IPC.playlistsMoveItem, (_event, playlistId: unknown, itemId: unknown, toIndex: unknown) => {
    const id = toId(playlistId, 'playlist')
    if (typeof toIndex !== 'number' || !Number.isFinite(toIndex)) throw new Error('Invalid position.')
    container.playlists.moveItem(id, toId(itemId, 'entry'), toIndex)
    return container.playlists.detail(id)
  })

  ipcMain.handle(IPC.playlistsClear, (_event, playlistId: unknown) => {
    const id = toId(playlistId, 'playlist')
    container.playlists.clear(id)
    return container.playlists.detail(id)
  })

  // ---- play state -------------------------------------------------------
  // One request/response channel to read it back, and two fire-and-forget ones
  // to write. Saving happens while the window is closing, where waiting for a
  // reply would mean the reply arrives after the process is gone — and a
  // malformed save is not worth a round trip, so it is logged and dropped.
  ipcMain.handle(IPC.playbackLoad, () => container.playback.load())

  ipcMain.on(IPC.playbackSave, (_event, snapshot: unknown) => {
    const state = sanitizeSnapshot(snapshot)
    if (!state) {
      log.warn('ignored a malformed play-state save')
      return
    }
    try {
      container.playback.save(state, Date.now())
    } catch (error) {
      log.warn('could not save play state', error)
    }
  })

  ipcMain.on(IPC.playbackClear, () => {
    try {
      container.playback.clear()
    } catch (error) {
      log.warn('could not clear play state', error)
    }
  })
}
