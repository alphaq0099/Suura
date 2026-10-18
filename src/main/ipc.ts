import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AppSettings,
  ArtworkFit,
  ArtworkShape,
  ArtworkSize,
  DeepPartial,
  EngineSettings,
  InteractionSettings,
  LibraryClickAction,
  ListTracksQuery,
  QualityTier,
  RepeatMode,
  RetentionMode,
  RetentionSettings,
  ThemeMode,
  TrackSortField,
  VisualSettings
} from '@shared/types'
import { normalizePath } from '@core/library/content-key'
import { getEngineStatus } from '@engine/sidecar/engine-status'
import type { AppContainer } from './services/container'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function toTrackId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error('Invalid track id.')
  }
  return value
}

const RETENTION_MODES: RetentionMode[] = ['stream', 'cache', 'keep']
const QUALITY_TIERS: QualityTier[] = ['best', 'high', 'balanced', 'data-saver']
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
    patch.engine = engine
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

  ipcMain.handle(IPC.libraryArtwork, (_event, trackId: unknown) => container.artwork.resolve(toTrackId(trackId)))

  ipcMain.handle(IPC.mediaResolve, async (_event, trackId: unknown) => {
    const track = library.trackById(toTrackId(trackId))
    if (!track) throw new Error('Unknown track.')
    return container.resolvers.resolve(track)
  })

  ipcMain.handle(IPC.mediaReportPlay, (_event, trackId: unknown, playedMs: unknown, completed: unknown) => {
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
}
