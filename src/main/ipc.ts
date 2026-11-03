import { app, BrowserWindow, clipboard, dialog, ipcMain, net, shell } from 'electron'
import { writeFile, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import {
  ACCENTS,
  DENSITIES,
  HERO_SLIDE_SECONDS_MAX,
  HERO_SLIDE_SECONDS_MIN,
  ICON_SETS,
  LYRICS_ALIGNS,
  MOTION_PREFERENCES,
  SURFACES,
  TEXT_SIZES,
  THEME_MODES
} from '@shared/appearance'
import { sanitizeAudioPatch } from '@shared/audio'
import { sanitizeFilePart } from '@shared/files'
import { IPC, IPC_EVENTS } from '@shared/ipc'
import { isLocalLibraryFilter, streamFallbackFor } from '@shared/library'
import { isImportedPlaylistTrackId } from '@shared/online'
import { countsAsPlay } from '@shared/play-count'
import { clampPlaylistIndexWidth } from '@shared/playlists'
import { sanitizeArtworkKey, sanitizeTagFields } from '@shared/tags'
import { sanitizeLyricsCandidate, sanitizeLyricsOffset } from '@shared/lyrics'
import type {
  AccentName,
  AlbumSortField,
  AllTracksFilter,
  AllTracksQuery,
  AppSettings,
  ArtworkFit,
  ArtworkShape,
  ArtworkSize,
  BackupSettings,
  CacheEntry,
  CacheEntryDetails,
  DeepPartial,
  Density,
  DesktopSettings,
  DownloadFormat,
  EngineSettings,
  IconSet,
  LyricsAlign,
  LyricsTarget,
  InteractionSettings,
  StartupSettings,
  StartupView,
  LibraryClickAction,
  LibrarySettings,
  ListAlbumsQuery,
  ListTracksQuery,
  LyricsWriteResult,
  MotionPreference,
  PlaybackSnapshot,
  QualityTier,
  RepeatMode,
  ResolvableTrack,
  ResolvedSource,
  RetentionMode,
  RetentionSettings,
  SaveToLibraryRequest,
  StreamLyricsTarget,
  SurfaceStyle,
  TagWriteResult,
  TextSize,
  ThemeMode,
  Track,
  TrackSortField,
  VisualSettings
} from '@shared/types'
import { ALBUM_SORT_FIELDS, STARTUP_VIEWS } from '@shared/types'
import {
  createBackupBundle,
  inspectBackupBundle,
  nextBackupDirectory,
  stageRestore
} from '@core/db/backups'
import { normalizePath } from '@core/library/content-key'
import { mimeForExtension } from '@core/library/artwork'
import type { TagArtworkWrite } from '@core/library/library-service'
import { libraryCsv } from '@core/library/library-csv'
import { sanitizeTaskbarState } from '@shared/taskbar'
import { applyTaskbarControls } from './taskbar'
import { DEFAULT_SETTINGS, mergeSettings } from '@core/settings/settings-service'
import {
  DOWNLOAD_FORMATS,
  QUALITY_TIERS,
  RETENTION_MODES
} from '@shared/settings-defaults'
import {
  isCookieFallbackMode,
  isSupportedCookieBrowser,
  isYouTubeVideoId,
  normalizeCookieBrowserProfile
} from '@shared/youtube'
import type { AppContainer } from './services/container'
import { listAllTracks } from './all-tracks'
import { broadcast } from './broadcast'
import { mergeDeferredTagWrite, PendingWrites, type DeferredTagWrite } from './pending-writes'
import { readLogTail, sanitizeDiagnosticsSummary, writeDiagnosticsFile } from './diagnostics'
import { LIBRARY_SEARCH_LIMIT, searchLibrary } from './library-search'
import { isMiniPlayer, setMiniPlayer } from './window-mode'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function showMessage(parent: BrowserWindow | null, options: Electron.MessageBoxOptions) {
  return parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
 * A batch selection is files only.
 *
 * A stream's negative id is dropped rather than refused: the batch is offered
 * from a local-only button, and a mixed selection should fetch what it can
 * instead of failing the whole request on a row it could never write.
 */
function toBatchTrackIds(value: unknown): number[] {
  if (!Array.isArray(value)) throw new Error('Malformed track selection.')
  const ids: number[] = []
  for (const entry of value) {
    if (typeof entry === 'number' && Number.isInteger(entry) && entry > 0) ids.push(entry)
  }
  if (ids.length === 0) throw new Error('Choose at least one track to fetch lyrics for.')
  return ids
}

function toBatchItemIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Malformed lyrics selection.')
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

function toBatchJobId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) {
    throw new Error('Malformed lyrics batch.')
  }
  return value
}

/** Reads one nullable string field of a stream's metadata. */
function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

/**
 * What a lyrics request is about: a library track, or a streaming link.
 *
 * A stream cannot be named by its track id — that id is negative by design and
 * differs depending on whether the song arrived from the history, a counted
 * listen or an imported playlist — so it arrives as the video id plus the row
 * values the finder searches with, exactly as the artwork request already
 * does. Every other handler keeps using `toTrackId`, which still refuses a
 * negative id.
 */
function toLyricsTarget(value: unknown): LyricsTarget {
  if (typeof value === 'number') return toTrackId(value)

  if (!isPlainObject(value)) throw new Error('Invalid track id.')
  if (value.sourceKind !== 'youtube') throw new Error('Invalid track id.')

  const videoId = value.videoId
  if (typeof videoId !== 'string' || !isYouTubeVideoId(videoId)) {
    throw new Error('Invalid track id.')
  }

  const target: StreamLyricsTarget = {
    sourceKind: 'youtube',
    videoId,
    title: optionalText(value.title),
    artist: optionalText(value.artist),
    album: optionalText(value.album),
    durationMs:
      typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs > 0
        ? Math.round(value.durationMs)
        : null
  }
  return target
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
 * Joins a cache row with the identity shown in Downloads.
 *
 * The cache deliberately knows only bytes. The online history has the title the
 * user saw, and the save history may have the URL and metadata even after the
 * file is gone. Falling back in that order keeps a cached mix from appearing as
 * a bare video id, and lets the same entry be promoted without a second fetch.
 */
function cacheEntryDetails(container: AppContainer, entry: CacheEntry): CacheEntryDetails {
  const track = container.repo.findByOriginIncludingMissing('youtube', entry.videoId)
  const history = container.downloadHistory.get(entry.videoId)
  const online = container.onlineRepo.getByVideoId(entry.videoId)
  const saved = Boolean(track && track.missingAt === null && track.filePath)
  return {
    ...entry,
    title: online?.title ?? history?.title ?? track?.title ?? entry.videoId,
    artist: online?.artist ?? history?.artist ?? track?.artist ?? null,
    album: online?.album ?? history?.album ?? track?.album ?? null,
    trackId: saved && track ? track.id : null,
    saved
  }
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

// All three modes are implemented now. The allowlist still matters: a stale
// renderer or a hand-crafted patch must not store a mode the main process has no
// branch for.
const REPEAT_MODES: RepeatMode[] = ['off', 'all', 'one']
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
  if (typeof input.theme === 'string' && THEME_MODES.includes(input.theme as ThemeMode)) {
    patch.theme = input.theme as ThemeMode
  }

  if (isPlainObject(input.library)) {
    const library: DeepPartial<LibrarySettings> = {}
    if (typeof input.library.watchForChanges === 'boolean') {
      library.watchForChanges = input.library.watchForChanges
    }
    patch.library = library
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
    if (
      typeof source.playlistArtworkSize === 'string' &&
      ARTWORK_SIZES.includes(source.playlistArtworkSize as ArtworkSize)
    ) {
      visuals.playlistArtworkSize = source.playlistArtworkSize as ArtworkSize
    }
    if (typeof source.textSize === 'string' && TEXT_SIZES.includes(source.textSize as TextSize)) {
      visuals.textSize = source.textSize as TextSize
    }
    if (typeof source.lyricsAlign === 'string' && LYRICS_ALIGNS.includes(source.lyricsAlign as LyricsAlign)) {
      visuals.lyricsAlign = source.lyricsAlign as LyricsAlign
    }
    if (typeof source.iconSet === 'string' && ICON_SETS.includes(source.iconSet as IconSet)) {
      visuals.iconSet = source.iconSet as IconSet
    }
    if (typeof source.showAlbumColumn === 'boolean') {
      visuals.showAlbumColumn = source.showAlbumColumn
    }
    if (typeof source.showChannelColumn === 'boolean') {
      visuals.showChannelColumn = source.showChannelColumn
    }
    if (typeof source.heroSlideSeconds === 'number' && Number.isFinite(source.heroSlideSeconds)) {
      visuals.heroSlideSeconds = Math.min(
        HERO_SLIDE_SECONDS_MAX,
        Math.max(HERO_SLIDE_SECONDS_MIN, Math.round(source.heroSlideSeconds))
      )
    }
    if (typeof source.accent === 'string' && ACCENTS.includes(source.accent as AccentName)) {
      visuals.accent = source.accent as AccentName
    }
    if (typeof source.density === 'string' && DENSITIES.includes(source.density as Density)) {
      visuals.density = source.density as Density
    }
    if (typeof source.surface === 'string' && SURFACES.includes(source.surface as SurfaceStyle)) {
      visuals.surface = source.surface as SurfaceStyle
    }
    if (typeof source.motion === 'string' && MOTION_PREFERENCES.includes(source.motion as MotionPreference)) {
      visuals.motion = source.motion as MotionPreference
    }
    if (typeof source.playerArtwork === 'boolean') {
      visuals.playerArtwork = source.playerArtwork
    }
    if (typeof source.playerAmbience === 'boolean') {
      visuals.playerAmbience = source.playerAmbience
    }
    patch.visuals = visuals
  }

  if (isPlainObject(input.audio)) {
    patch.audio = sanitizeAudioPatch(input.audio)
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
    if (typeof source.volumeWheelStep === 'number' && Number.isFinite(source.volumeWheelStep)) {
      interaction.volumeWheelStep = Math.round(clamp(source.volumeWheelStep, 1, 25))
    }
    patch.interaction = interaction
  }

  if (isPlainObject(input.startup)) {
    const startup: DeepPartial<StartupSettings> = {}
    const source = input.startup
    if (typeof source.view === 'string' && STARTUP_VIEWS.includes(source.view as StartupView)) {
      startup.view = source.view as StartupView
    }
    if (typeof source.scanOnLaunch === 'boolean') {
      startup.scanOnLaunch = source.scanOnLaunch
    }
    if (typeof source.resumePlayback === 'boolean') {
      startup.resumePlayback = source.resumePlayback
    }
    patch.startup = startup
  }

  if (isPlainObject(input.desktop)) {
    const desktop: DeepPartial<DesktopSettings> = {}
    if (typeof input.desktop.closeToTray === 'boolean') {
      desktop.closeToTray = input.desktop.closeToTray
    }
    patch.desktop = desktop
  }

  if (isPlainObject(input.backups)) {
    const backups: DeepPartial<BackupSettings> = {}
    const source = input.backups
    if (typeof source.retentionCount === 'number' && Number.isFinite(source.retentionCount)) {
      backups.retentionCount = Math.round(clamp(source.retentionCount, 3, 50))
    }
    patch.backups = backups
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
    if (typeof source.prefetchNext === 'boolean') engine.prefetchNext = source.prefetchNext
    if (typeof source.downloadConcurrency === 'number' && Number.isFinite(source.downloadConcurrency)) {
      engine.downloadConcurrency = Math.round(clamp(source.downloadConcurrency, 1, 8))
    }
    if (source.cookiesFromBrowser === null) {
      engine.cookiesFromBrowser = null
    } else if (isSupportedCookieBrowser(source.cookiesFromBrowser)) {
      engine.cookiesFromBrowser = source.cookiesFromBrowser
    }
    if (source.cookieBrowserProfile === null) {
      engine.cookieBrowserProfile = null
    } else if (typeof source.cookieBrowserProfile === 'string') {
      engine.cookieBrowserProfile = normalizeCookieBrowserProfile(source.cookieBrowserProfile)
    }
    if (isCookieFallbackMode(source.cookieFallback)) {
      engine.cookieFallback = source.cookieFallback
    }
    if (typeof source.poTokenEnabled === 'boolean') {
      engine.poTokenEnabled = source.poTokenEnabled
    }
    if (typeof source.poTokenProviderUrl === 'string') {
      engine.poTokenProviderUrl = source.poTokenProviderUrl.trim().slice(0, 2048)
    }
    if (source.poTokenProviderCommand === null) {
      engine.poTokenProviderCommand = null
    } else if (typeof source.poTokenProviderCommand === 'string') {
      // Do not trim a non-empty command: a trailing space is how a user types
      // the separator before the next argument. Only an all-space value means
      // "no command".
      const text = source.poTokenProviderCommand.slice(0, 4096)
      engine.poTokenProviderCommand = text.trim().length === 0 ? null : text
    }
    if (typeof source.poTokenAutoStart === 'boolean') {
      engine.poTokenAutoStart = source.poTokenAutoStart
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
  // `streams` is answered by the history table, not this query, so it is not a
  // legal value here even though the renderer's Library filter uses it.
  if (isLocalLibraryFilter(input.filter)) {
    query.filter = input.filter
  }
  // Sorting reaches SQL as an ORDER BY fragment, so only these exact keys pass.
  if (typeof input.sort === 'string' && SORT_FIELDS.includes(input.sort as TrackSortField)) {
    query.sort = input.sort as TrackSortField
  }
  if (input.direction === 'asc' || input.direction === 'desc') {
    query.direction = input.direction
  }
  if (typeof input.album === 'string' && input.album.length > 0) {
    query.album = input.album.slice(0, 500)
  }
  if (typeof input.albumArtist === 'string') {
    query.albumArtist = input.albumArtist.slice(0, 500)
  }
  if (typeof input.artist === 'string' && input.artist.trim().length > 0) {
    query.artist = input.artist.slice(0, 500)
  }
  if (input.albumless === true) {
    query.albumless = true
  }
  if (typeof input.limit === 'number' && Number.isFinite(input.limit)) {
    query.limit = Math.round(clamp(input.limit, 1, 50000))
  }
  if (typeof input.offset === 'number' && Number.isFinite(input.offset)) {
    query.offset = Math.max(0, Math.round(input.offset))
  }
  return query
}

function sanitizeAlbumListQuery(input: unknown): ListAlbumsQuery {
  if (!isPlainObject(input)) return {}
  const query: ListAlbumsQuery = {}
  if (typeof input.search === 'string' && input.search.trim().length > 0) {
    query.search = input.search.trim().slice(0, 200)
  }
  if (typeof input.artist === 'string' && input.artist.trim().length > 0) {
    query.artist = input.artist.slice(0, 500)
  }
  if (typeof input.sort === 'string' && ALBUM_SORT_FIELDS.includes(input.sort as AlbumSortField)) {
    query.sort = input.sort as AlbumSortField
  }
  if (input.direction === 'asc' || input.direction === 'desc') {
    query.direction = input.direction
  }
  if (typeof input.limit === 'number' && Number.isFinite(input.limit)) {
    query.limit = Math.round(clamp(input.limit, 1, 1000))
  }
  if (typeof input.offset === 'number' && Number.isFinite(input.offset)) {
    query.offset = Math.max(0, Math.round(input.offset))
  }
  return query
}

function sanitizeAllTracksQuery(input: unknown): AllTracksQuery {
  if (!isPlainObject(input)) return {}
  const query: AllTracksQuery = {}
  if (typeof input.search === 'string' && input.search.trim().length > 0) {
    query.search = input.search.trim().slice(0, 200)
  }
  // The filter is a closed set, because it decides which sources are read.
  if (input.filter === 'all' || input.filter === 'played' || input.filter === 'library') {
    query.filter = input.filter as AllTracksFilter
  }
  if (typeof input.limit === 'number' && Number.isFinite(input.limit)) {
    query.limit = Math.round(clamp(input.limit, 1, 200))
  }
  if (typeof input.offset === 'number' && Number.isFinite(input.offset)) {
    query.offset = Math.max(0, Math.round(input.offset))
  }
  return query
}

function sanitizeArtistLimit(input: unknown): number {
  if (typeof input !== 'number' || !Number.isFinite(input)) return 24
  return Math.round(clamp(input, 1, 500))
}

export function registerIpcHandlers(container: AppContainer): void {
  const { settings, library, log } = container

  // The renderer owns playback, so it is the only place that knows which file
  // is open. Windows will not let us replace a file that is being streamed, and
  // a write that fails after the user typed a page of lyrics is a bad trade, so
  // the id is kept here and checked before any tag write starts.
  let playingTrackId: number | null = null
  let playbackIsPlaying = false

  // A write aimed at the track that is open for playback is queued here rather
  // than refused. Fetching lyrics only happens while listening, so refusing was
  // asking the user to stop the song they were looking at. The queue drains as
  // soon as the renderer says the track is no longer the one playing.
  const pendingWrites = new PendingWrites({
    log: log.child('pending-writes'),
    onResult: (notice) => broadcast(IPC_EVENTS.pendingWriteChanged, notice)
  })

  // The tag fields each queued write still has to apply. A second save while
  // the first is waiting is a patch against the same unchanged row, so it is
  // folded into the queued one rather than replacing it: otherwise a field the
  // second save did not touch would be lost with the first patch.
  const deferredTags = new Map<number, DeferredTagWrite>()

  /**
   * Resolves a queue entry without recording a play. The local branch attaches
   * ReplayGain here rather than in the resolver: gain belongs to the file, and a
   * cached source must never carry a value from a file that has since changed.
   *
   * `warm` separates an actual play from a prefetch. Only a play starts a cache
   * copy or an auto-save; a prefetch may still *read* an existing cache entry,
   * which is what makes the track handoff instant without writing anything.
   */
  async function resolveSource(
    request: ResolvableTrack,
    options: { warm: boolean } = { warm: false }
  ): Promise<ResolvedSource> {
    if (request.sourceKind === 'youtube') {
      const videoId = request.sourceId
      if (videoId && isYouTubeVideoId(videoId)) {
        const cached = container.streamCache.cachedSource(videoId)
        if (cached) return cached

        // `net.isOnline` is a network-interface check, not a reachability test.
        // It is deliberately conservative: saying "not available offline" when
        // the user has a connection would be a lie, so only a definite offline
        // state short-circuits here. A connected but broken network still goes
        // through the resolver and gets the engine's own error.
        if (!net.isOnline()) {
          throw new Error(
            'This track is not cached and the computer is offline. Reconnect, or save it to your library while online.'
          )
        }
      }

      const source = await container.resolvers.resolve(request)
      if (options.warm && videoId && isYouTubeVideoId(videoId)) {
        void applyRetention(videoId)
      }
      return source
    }

    const track = library.trackById(request.id)
    if (!track) throw new Error('Unknown track.')

    // A saved download can be removed while its row stays in a playlist or a
    // restored queue. The row keeps the YouTube origin, so playback re-resolves
    // the stream instead of reporting a missing file.
    const fallback = streamFallbackFor(track)
    if (fallback) return resolveSource(fallback, options)
    if (track.missingAt !== null || !track.filePath) {
      throw new Error('This track’s file is missing. Scan the library or restore the file.')
    }

    const source = await container.resolvers.resolve(track)
    return {
      ...source,
      replayGainDb: track.replayGainDb,
      replayGainPeak: track.replayGainPeak
    }
  }

  /**
   * The side effect of a play, according to the retention mode.
   *
   * Fire-and-forget: playback must never wait for a copy, and both paths are
   * resumable if they fail. `streamDetails` is normally a cache hit because the
   * resolver just ran for this video.
   */
  async function applyRetention(videoId: string): Promise<void> {
    const mode = settings.get().retention.mode
    if (mode === 'stream') return

    try {
      const details = await container.youtube.resolver.streamDetails(videoId)
      if (mode === 'cache') {
        await container.streamCache.warm(videoId, {
          url: details.upstream.url,
          headers: details.upstream.headers,
          mimeType: details.upstream.mimeType,
          sizeHint: details.fileSize
        })
        return
      }

      if (mode === 'keep') {
        if (container.repo.findByOrigin('youtube', videoId)) return
        await container.downloads.save({
          videoId,
          title: details.title,
          artist: details.artist,
          album: null
        })
      }
    } catch (error) {
      log.debug('retention step failed', { videoId, mode, error })
    }
  }

  ipcMain.handle(IPC.settingsGet, () => settings.get())

  ipcMain.handle(IPC.settingsUpdate, (_event, patch: unknown) => settings.update(sanitizeSettingsPatch(patch)))

  ipcMain.handle(IPC.pathsGet, () => container.paths)

  ipcMain.handle(IPC.runtimeInfo, () => ({
    appVersion: app.getVersion(),
    electron: process.versions.electron ?? 'unknown',
    chromium: process.versions.chrome ?? 'unknown',
    node: process.versions.node
  }))

  // Diagnostics stay local. The renderer's summary already leaves out cookies,
  // history and library file paths; the log tail is appended here because only
  // the main process knows where the log lives.
  ipcMain.handle(IPC.diagnosticsSave, async (_event, summary: unknown) => {
    const parent = BrowserWindow.getFocusedWindow()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const options: Electron.SaveDialogOptions = {
      title: 'Save Suura diagnostics',
      buttonLabel: 'Save',
      defaultPath: join(app.getPath('documents'), `Suura diagnostics ${stamp}.txt`),
      filters: [{ name: 'Text file', extensions: ['txt'] }]
    }
    const result = parent
      ? await dialog.showSaveDialog(parent, options)
      : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null

    const target =
      extname(result.filePath).toLowerCase() === '.txt'
        ? result.filePath
        : `${result.filePath}.txt`
    const logTail = readLogTail(container.paths.logs)
    const appSummary = [
      `Packaged: ${app.isPackaged ? 'yes' : 'no'}`,
      `Platform: ${process.platform} ${process.arch}`,
      `OS: ${process.getSystemVersion()}`,
      `Locale: ${app.getLocale()}`,
      '',
      sanitizeDiagnosticsSummary(summary)
    ].join('\n')
    const written = await writeDiagnosticsFile(target, {
      summary: appSummary,
      logPath: container.paths.logs,
      log: logTail
    })
    log.info('diagnostics saved', {
      file: target,
      bytes: written.bytes,
      logTruncated: logTail.truncated
    })
    return target
  })

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

  // ----- data care -------------------------------------------------------
  ipcMain.handle(IPC.dataBackup, async () => {
    const parent = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Choose where to put the backup',
      buttonLabel: 'Save backup here',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const parentDirectory = result.filePaths[0]
    if (result.canceled || !parentDirectory) return null

    // The picker chooses the parent; the app owns the timestamped folder so two
    // backups from the same minute cannot overwrite each other.
    const directory = nextBackupDirectory(parentDirectory, 'Suura backup', new Date())
    const summary = createBackupBundle({
      db: container.database.db,
      directory,
      config: settings.get(),
      appVersion: app.getVersion(),
      schemaVersion: container.database.schemaVersion
    })
    log.info('manual backup created', {
      directory: summary.directory,
      schemaVersion: summary.manifest.schemaVersion
    })
    return summary.directory
  })

  ipcMain.handle(IPC.dataRestore, async () => {
    const parent = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a Suura backup folder',
      buttonLabel: 'Choose backup',
      properties: ['openDirectory']
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const directory = result.filePaths[0]
    if (result.canceled || !directory) return false

    let backup: ReturnType<typeof inspectBackupBundle>
    try {
      backup = inspectBackupBundle(directory)
    } catch (error) {
      await showMessage(parent, {
        type: 'error',
        title: 'That backup cannot be restored',
        message: 'That backup cannot be restored',
        detail: messageOf(error)
      })
      throw error
    }

    let config: AppSettings
    try {
      // A backup is a file the user could have edited or brought from another
      // machine, so it goes through the same allowlist as the Settings form.
      config = mergeSettings(DEFAULT_SETTINGS, sanitizeSettingsPatch(backup.config))
    } catch (error) {
      await showMessage(parent, {
        type: 'error',
        title: 'That backup cannot be restored',
        message: 'The backup settings are not valid',
        detail: messageOf(error)
      })
      throw error
    }

    const confirmation = await showMessage(parent, {
      type: 'warning',
      title: 'Restore this backup?',
      message: 'Replace the current library and settings?',
      detail: `The current database and settings are copied to the backups folder first. Suura will restart to finish the restore.\n\nBackup: ${directory}`,
      buttons: ['Restore and restart', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true
    })
    if (confirmation.response !== 0) return false

    stageRestore({
      backup,
      userDataDir: container.paths.userData,
      config
    })
    log.info('restore staged for the next start', {
      backup: directory,
      schemaVersion: backup.schemaVersion
    })
    // Give the IPC reply a moment to reach the renderer so it can show its
    // "restarting" note before the window goes away. `quit`, not `exit`, so the
    // normal will-quit disposal checkpoints and closes the database first; the
    // next start then swaps the staged files in.
    setTimeout(() => {
      app.relaunch()
      app.quit()
    }, 250)
    return true
  })

  ipcMain.handle(IPC.libraryScan, async (_event, folder: unknown) => {
    const target = typeof folder === 'string' && folder.trim().length > 0 ? folder : undefined
    return library.scan(target)
  })

  ipcMain.handle(IPC.libraryScanCancel, () => {
    library.cancelScan()
  })

  ipcMain.handle(IPC.libraryAddPaths, async (_event, paths: unknown) => {
    if (!Array.isArray(paths)) throw new Error('Drop paths must be a list.')
    const safe = paths
      .filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
      // A file manager can drop thousands of selected files; a bound keeps a
      // single accidental drop from freezing the scan queue for minutes.
      .slice(0, 500)
    return library.addDroppedPaths(safe)
  })

  ipcMain.handle(IPC.libraryListTracks, (_event, query: unknown) => library.list(sanitizeListQuery(query)))

  ipcMain.handle(IPC.librarySearch, (_event, query: unknown, limit: unknown) => {
    if (typeof query !== 'string') throw new Error('Type something to search for.')
    const text = query.trim().slice(0, 200)
    if (text.length === 0) return { local: [], imported: [] }
    const count =
      typeof limit === 'number' && Number.isFinite(limit)
        ? clamp(Math.round(limit), 1, 50)
        : LIBRARY_SEARCH_LIMIT
    return searchLibrary(container, text, count)
  })

  ipcMain.handle(IPC.libraryTracksByIds, (_event, input: unknown) => {
    if (!Array.isArray(input) || input.length > 500) {
      throw new Error('Expected a list of track ids.')
    }
    return container.repo.byIds(input.map(toTrackId))
  })

  ipcMain.handle(IPC.libraryListAlbums, (_event, query: unknown) =>
    library.listAlbums(sanitizeAlbumListQuery(query))
  )

  ipcMain.handle(IPC.libraryAllTracks, (_event, query: unknown) =>
    listAllTracks(container, sanitizeAllTracksQuery(query))
  )

  ipcMain.handle(IPC.libraryListArtists, (_event, limit: unknown) =>
    library.listArtists(sanitizeArtistLimit(limit))
  )

  ipcMain.handle(IPC.libraryStats, () => library.stats())

  ipcMain.handle(
    IPC.libraryUpdateTags,
    async (_event, trackId: unknown, input: unknown, artworkKey: unknown) => {
      const id = toTrackId(trackId)
      // Absent means "leave the picture alone"; null means "remove it". The two
      // are different writes, so they cannot both collapse to `undefined`.
      const wantsArtwork = artworkKey !== undefined
      const key = wantsArtwork ? sanitizeArtworkKey(artworkKey) : undefined
      const fields = sanitizeTagFields(input, { allowEmpty: wantsArtwork })

      let artwork: TagArtworkWrite | undefined
      if (wantsArtwork) {
        if (key === null) {
          artwork = { image: null, key: '' }
        } else if (key) {
          // Read the cached bytes the picker showed, so the written cover is
          // exactly the previewed one rather than a second download. This happens
          // before the playback check so a queued write holds the same bytes.
          const cached = container.artwork.pathFor(key)
          if (!cached) throw new Error('That cover is no longer available. Choose it again.')
          const data = await readFile(cached)
          artwork = {
            image: { data, mime: mimeForExtension(extname(cached)) },
            key
          }
        }
      }

      const write = (): Promise<Track> => library.updateTags(id, fields, artwork)
      if (playingTrackId === id) {
        const track = library.trackById(id)
        if (!track) throw new Error('Unknown track.')
        const merged = mergeDeferredTagWrite(deferredTags.get(id), { fields, artwork })
        deferredTags.set(id, merged)
        pendingWrites.enqueue(id, 'tags', async () => {
          await library.updateTags(id, merged.fields, merged.artwork)
          // Forget the fields only if no newer save folded itself in while
          // this write was running.
          if (deferredTags.get(id) === merged) deferredTags.delete(id)
        })
        return {
          track,
          deferred: true,
          message: 'Tags will be written to this file after this track finishes playing.'
        } satisfies TagWriteResult
      }

      return { track: await write(), deferred: false, message: null } satisfies TagWriteResult
    }
  )

  // The cheap answer: what is already on this machine. The picker calls this
  // when it opens, and asks for provider covers only if the user asks.
  ipcMain.handle(IPC.libraryArtworkChoices, (_event, trackId: unknown) =>
    container.artworkChoices.local(toTrackId(trackId))
  )

  ipcMain.handle(IPC.libraryArtworkCovers, (_event, trackId: unknown) =>
    container.artworkChoices.online(toTrackId(trackId))
  )

  // The finder reads the row, not the file, and only proposes. It is allowed
  // while the track plays: nothing is written until the editor saves.
  ipcMain.handle(IPC.libraryAutoTag, async (_event, trackId: unknown) => {
    const id = toTrackId(trackId)
    const track = library.trackById(id)
    if (!track?.filePath) throw new Error('Only files in your library can be looked up.')
    return container.tagLookup.lookup({
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationMs: track.durationMs
    })
  })

  // Reading is safe while the track plays: it opens the file for a moment and
  // writes nothing. The timing correction is a database row, never a tag. A
  // stream reads its fetched copy from the row keyed by its video id.
  ipcMain.handle(IPC.libraryLyrics, (_event, target: unknown) =>
    container.lyrics.read(toLyricsTarget(target))
  )

  // A stream has no file, so this is null for one rather than an error: the
  // tag editor is the only caller and never opens on a stream.
  ipcMain.handle(IPC.libraryFileLyrics, (_event, target: unknown) =>
    container.lyrics.readFile(toLyricsTarget(target))
  )

  ipcMain.handle(IPC.libraryLyricsOffset, (_event, target: unknown, offset: unknown) =>
    container.lyrics.setOffset(toLyricsTarget(target), sanitizeLyricsOffset(offset))
  )

  // The finder reads the row and asks a provider; nothing is stored until the
  // user chooses a match, so it is allowed while the track plays. A stream
  // carries the values to search with, since it has no row to read them from.
  ipcMain.handle(IPC.libraryLyricsFind, (_event, target: unknown) =>
    container.lyrics.find(toLyricsTarget(target))
  )

  ipcMain.handle(IPC.libraryLyricsUse, (_event, target: unknown, candidate: unknown) =>
    container.lyrics.use(toLyricsTarget(target), sanitizeLyricsCandidate(candidate))
  )

  ipcMain.handle(IPC.libraryLyricsUseFile, (_event, target: unknown) =>
    container.lyrics.useFile(toLyricsTarget(target))
  )

  // Writing into the file has the same guard as any other tag write: Windows
  // will not replace a file that is open for playback. Fetching lyrics only
  // happens while listening, so the write is queued for after the track instead
  // of asking the user to stop it. A stream has no file to write into and is
  // refused by the service with that sentence.
  ipcMain.handle(IPC.libraryLyricsWrite, async (_event, target: unknown) => {
    const lyricsTarget = toLyricsTarget(target)
    if (typeof lyricsTarget === 'number' && playingTrackId === lyricsTarget) {
      pendingWrites.enqueue(lyricsTarget, 'lyrics', () =>
        container.lyrics.writeToFile(lyricsTarget)
      )
      return {
        // The fetched copy is still stored, so the panel keeps showing exactly
        // what the user chose until the file write can replace it.
        lyrics: await container.lyrics.read(lyricsTarget),
        deferred: true,
        message: 'These lyrics will be written to the file after this track finishes playing.'
      } satisfies LyricsWriteResult
    }
    return {
      lyrics: await container.lyrics.writeToFile(lyricsTarget),
      deferred: false,
      message: null
    } satisfies LyricsWriteResult
  })

  // The batch runs in two passes so the slow half can show progress and be
  // cancelled: `start` scans and returns a job id, `apply` stores what the user
  // accepted. The playing check is the same one the single write uses, passed
  // per call because the live id belongs to this scope.
  ipcMain.handle(IPC.libraryLyricsBatchStart, (_event, trackIds: unknown) =>
    container.lyricsBatch.start(toBatchTrackIds(trackIds))
  )

  ipcMain.handle(IPC.libraryLyricsBatchGet, (_event, jobId: unknown) =>
    container.lyricsBatch.get(toBatchJobId(jobId))
  )

  ipcMain.handle(IPC.libraryLyricsBatchCancel, (_event, jobId: unknown) => {
    container.lyricsBatch.cancel(toBatchJobId(jobId))
  })

  ipcMain.handle(
    IPC.libraryLyricsBatchApply,
    (_event, jobId: unknown, itemIds: unknown, writeToFile: unknown) =>
      container.lyricsBatch.apply(
        toBatchJobId(jobId),
        toBatchItemIds(itemIds),
        writeToFile === true,
        (trackId) => playingTrackId !== trackId
      )
  )

  ipcMain.handle(IPC.libraryLyricsBatchUndo, (_event, jobId: unknown) =>
    container.lyricsBatch.undo(toBatchJobId(jobId))
  )

  // Batch tags write real files, so the same playback guard the single editor
  // uses is passed per call: Windows will not replace a file that is open for
  // playback, and the row is reported instead of failing the whole batch.
  ipcMain.handle(IPC.libraryTagBatchStart, (_event, trackIds: unknown) =>
    container.tagBatch.start(toBatchTrackIds(trackIds))
  )

  ipcMain.handle(IPC.libraryTagBatchGet, (_event, jobId: unknown) =>
    container.tagBatch.get(toBatchJobId(jobId))
  )

  ipcMain.handle(IPC.libraryTagBatchCancel, (_event, jobId: unknown) => {
    container.tagBatch.cancel(toBatchJobId(jobId))
  })

  ipcMain.handle(
    IPC.libraryTagBatchApply,
    (_event, jobId: unknown, itemIds: unknown, mode: unknown) =>
      container.tagBatch.apply(
        toBatchJobId(jobId),
        toBatchItemIds(itemIds),
        // Only the one word that means "overwrite" gets it; anything else is the
        // safe default, because a malformed request must never replace tags.
        mode === 'replace' ? 'replace' : 'fill',
        (trackId) => playingTrackId !== trackId
      )
  )

  ipcMain.handle(IPC.libraryTagBatchUndo, (_event, jobId: unknown) =>
    container.tagBatch.undo(toBatchJobId(jobId))
  )

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
    }
    return resolveSource(request, { warm: true })
  })

  // The next track's resolve, run while the current one plays. Deliberately not
  // `mediaResolve`: a guess about the queue is not a play, so it must not lift a
  // history row. The renderer attaches the returned source to its idle element.
  ipcMain.handle(IPC.mediaPrefetch, async (_event, input: unknown) => {
    const request = toResolvableTrack(input)
    return resolveSource(request, { warm: false })
  })

  // Loudness analysis is a long job with its own progress event. The renderer
  // never sees a raw file path after the value is stored; it is only used here
  // to feed ffmpeg.
  ipcMain.handle(IPC.replayGainScan, () => container.replayGain.scan())

  ipcMain.handle(IPC.replayGainCancel, () => {
    container.replayGain.cancel()
  })

  ipcMain.handle(IPC.replayGainStatus, () => container.replayGain.getStatus())

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

  ipcMain.handle(IPC.onlineStreamPlays, (_event, limit: unknown) => {
    const count =
      typeof limit === 'number' && Number.isFinite(limit) ? Math.round(limit) : undefined
    return container.online.streamPlays(count)
  })

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

  ipcMain.handle(IPC.downloadPause, (_event, videoId: unknown) => {
    if (typeof videoId !== 'string' || !isYouTubeVideoId(videoId)) return false
    return container.downloads.pause(videoId)
  })

  ipcMain.handle(IPC.downloadResume, (_event, videoId: unknown) => {
    if (typeof videoId !== 'string' || !isYouTubeVideoId(videoId)) return false
    return container.downloads.resume(videoId)
  })

  ipcMain.handle(IPC.downloadRemove, (_event, videoId: unknown) => {
    if (typeof videoId !== 'string' || !isYouTubeVideoId(videoId)) return false
    const removed = container.downloads.removeDownload(videoId)
    if (removed) broadcast(IPC_EVENTS.libraryChanged, null)
    return removed
  })

  ipcMain.handle(IPC.downloadSavedIds, (_event, input: unknown) =>
    [...container.repo.savedOrigins('youtube', toVideoIdList(input))]
  )

  ipcMain.handle(IPC.downloadHistory, () => container.downloadHistory.list())
  ipcMain.handle(IPC.downloadDismiss, (_event, videoId: unknown) => {
    if (typeof videoId !== 'string' || !isYouTubeVideoId(videoId)) return
    container.downloadHistory.remove(videoId)
  })

  ipcMain.handle(IPC.cacheStats, () => container.streamCache.stats())
  ipcMain.handle(IPC.cacheList, (_event, limit: unknown) => {
    const rows = container.streamCache.list(
      typeof limit === 'number' && Number.isFinite(limit) ? Math.round(limit) : 200
    )
    return rows.map((entry) => cacheEntryDetails(container, entry))
  })
  ipcMain.handle(IPC.cacheClear, () => container.streamCache.clear())
  ipcMain.handle(IPC.cacheClean, () => container.streamCache.cleanNow())
  ipcMain.handle(IPC.cachePromote, async (_event, videoId: unknown) => {
    if (typeof videoId !== 'string' || !isYouTubeVideoId(videoId)) {
      throw new Error('Invalid video id.')
    }
    // Saving a track that is already in the library is a no-op rather than a
    // duplicate file: the cache and the saved file are the same recording.
    const existing = container.repo.findByOrigin('youtube', videoId)
    if (existing) return existing.id

    const entry = container.streamCache.get(videoId)
    const path = entry?.complete ? container.streamCache.filePath(videoId) : null
    if (!entry || !path) throw new Error('That cache entry is no longer on disk.')
    const details = cacheEntryDetails(container, entry)
    const trackId = await container.downloads.saveFromCache(
      {
        videoId,
        title: details.title,
        artist: details.artist,
        album: details.album
      },
      path,
      entry.mimeType
    )
    // The bytes now live in the library. Dropping the cache copy keeps the
    // promotion from quietly doubling the space the same recording occupies.
    container.streamCache.remove(videoId)
    return trackId
  })
  ipcMain.handle(IPC.cachePin, (_event, videoId: unknown, pinned: unknown) => {
    if (typeof videoId !== 'string' || !isYouTubeVideoId(videoId)) {
      throw new Error('Invalid video id.')
    }
    return container.streamCache.setPinned(videoId, pinned === true)
  })
  ipcMain.handle(IPC.cacheReveal, (_event, videoId: unknown) => {
    if (typeof videoId !== 'string' || !isYouTubeVideoId(videoId)) {
      throw new Error('Invalid video id.')
    }
    const path = container.streamCache.filePath(videoId)
    if (!path) throw new Error('That cache entry is no longer on disk.')
    shell.showItemInFolder(path)
  })
  ipcMain.handle(IPC.cacheRemove, (_event, videoId: unknown) => {
    if (typeof videoId !== 'string' || !isYouTubeVideoId(videoId)) {
      throw new Error('Invalid video id.')
    }
    return container.streamCache.remove(videoId)
  })

  ipcMain.handle(IPC.clipboardRead, () => clipboard.readText())

  ipcMain.handle(IPC.clipboardWrite, (_event, text: unknown) => {
    // Through the main process rather than `navigator.clipboard`: the renderer's
    // async clipboard API needs a permission the app does not ask for, and the
    // Paste and Copy buttons are the whole point of not doing select-all.
    if (typeof text !== 'string' || text.length > 4096) return
    clipboard.writeText(text)
  })

  ipcMain.handle(IPC.mediaReportPlay, (_event, trackId: unknown, playedMs: unknown, completed: unknown) => {
    const played = typeof playedMs === 'number' && Number.isFinite(playedMs) ? playedMs : 0
    const finished = completed === true
    // A stream track has a negative session id and no `tracks` row. Its counted
    // listen still belongs in Recently played, so it goes to the stream play log
    // instead of the library's play count.
    if (typeof trackId === 'number' && Number.isInteger(trackId) && trackId < 0) {
      if (countsAsPlay(played, finished)) container.online.recordStreamPlay(trackId)
      return
    }
    library.reportPlayback(toTrackId(trackId), played, finished)
  })

  ipcMain.handle(IPC.engineStatus, async (_event, force: unknown) => {
    const [status, poToken, sidecars, rollback] = await Promise.all([
      container.engineStatus.get(settings.get().engine, { force: force === true }),
      container.poToken.status(),
      container.sidecars.states(),
      container.ytDlp.rollbackStatus()
    ])
    log.debug('engine status probed', { ready: status.ready, poToken: poToken.serverReachable })
    return { ...status, poToken, sidecars, rollback }
  })

  ipcMain.handle(IPC.sidecarInstall, async () => {
    const result = await container.sidecars.install()
    log.info('sidecar install finished', {
      installed: result.installed,
      failed: result.failed.map((failure) => failure.id),
      cancelled: result.cancelled
    })
    // The saved probe was taken before these files existed.
    if (result.installed.length > 0) {
      await container.engineStatus.get(settings.get().engine, { force: true })
    }
    return result
  })

  ipcMain.handle(IPC.sidecarCancel, () => {
    container.sidecars.cancel()
  })

  ipcMain.handle(IPC.poTokenStatus, () => container.poToken.status())
  ipcMain.handle(IPC.poTokenStart, () => container.poToken.start())
  ipcMain.handle(IPC.poTokenStop, () => container.poToken.stop())

  ipcMain.handle(IPC.ytDlpRestore, async () => {
    const status = await container.ytDlp.restorePrevious('manual')
    // The saved probe now names the previous version.
    await container.engineStatus.get(settings.get().engine, { force: true })
    return status
  })

  // ---- app updates ------------------------------------------------------
  // The service owns every state transition; these handlers only ask it and
  // return the resulting snapshot. A check is package-only and dormant until a
  // feed URL is configured, so none of these reaches the network by accident.
  ipcMain.handle(IPC.updateStatus, () => container.updates.statusSnapshot())
  ipcMain.handle(IPC.updateCheck, () => container.updates.checkNow())
  ipcMain.handle(IPC.updateDownload, () => container.updates.downloadNow())
  ipcMain.handle(IPC.updateInstall, () => container.updates.installNow())

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

  // ----- transfer files --------------------------------------------------
  // Export and import are dialog-driven on purpose: the renderer never needs a
  // filesystem path from the user, and a cancelled dialog is a null rather than
  // an error the UI has to explain.
  ipcMain.handle(IPC.playlistsExport, async (_event, playlistId: unknown) => {
    const id = toId(playlistId, 'playlist')
    const detail = container.playlists.detail(id)
    if (!detail) throw new Error('That playlist no longer exists.')

    const parent = BrowserWindow.getFocusedWindow()
    const defaultPath = join(app.getPath('documents'), `${sanitizeFilePart(detail.playlist.name, 'playlist')}.m3u8`)
    const options: Electron.SaveDialogOptions = {
      title: 'Export playlist',
      buttonLabel: 'Export',
      defaultPath,
      filters: [
        { name: 'M3U8 playlist', extensions: ['m3u8'] },
        { name: 'M3U playlist', extensions: ['m3u'] },
        { name: 'Suura playlist (JSON)', extensions: ['json'] }
      ]
    }
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null

    const extension = extname(result.filePath).toLowerCase()
    const target = ['.m3u', '.m3u8', '.json'].includes(extension) ? result.filePath : `${result.filePath}.m3u8`
    const chosen = extname(target).toLowerCase()
    const format = chosen === '.json' ? 'json' : chosen === '.m3u' ? 'm3u' : 'm3u8'
    const exported = container.playlists.exportPlaylist(id, format)
    await writeFile(target, exported.text, 'utf8')
    log.info('playlist exported', { playlistId: id, file: target, format })
    return target
  })

  ipcMain.handle(IPC.playlistsImport, async () => {
    const parent = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Import playlist',
      buttonLabel: 'Import',
      properties: ['openFile'],
      filters: [
        { name: 'Playlists', extensions: ['m3u', 'm3u8', 'json'] }
      ]
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const file = result.filePaths[0]
    if (result.canceled || !file) return null
    return container.playlists.importPlaylistFromFile(file)
  })

  ipcMain.handle(IPC.libraryExportCsv, async () => {
    const parent = BrowserWindow.getFocusedWindow()
    const date = new Date().toISOString().slice(0, 10)
    const options: Electron.SaveDialogOptions = {
      title: 'Export library as CSV',
      buttonLabel: 'Export',
      defaultPath: join(app.getPath('documents'), `Suura Library ${date}.csv`),
      filters: [{ name: 'CSV spreadsheet', extensions: ['csv'] }]
    }
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    const target = extname(result.filePath).toLowerCase() === '.csv' ? result.filePath : `${result.filePath}.csv`

    const tracks = container.repo.allForExport()
    await writeFile(target, libraryCsv(tracks), 'utf8')
    log.info('library exported as CSV', { file: target, tracks: tracks.length })
    return target
  })

  ipcMain.handle(IPC.libraryFindDuplicates, () => container.dataCare.findDuplicates())

  ipcMain.handle(IPC.libraryMergeDuplicates, async () => {
    const outcome = await container.dataCare.mergeDuplicates()
    log.info('duplicate merge finished', outcome)
    return outcome
  })

  ipcMain.handle(IPC.libraryRemoveTracks, (_event, input: unknown) => {
    const ids = toIdList(input, 'track')
    return container.library.removeTracks(ids)
  })

  ipcMain.handle(IPC.libraryRelocate, async () => {
    const parent = BrowserWindow.getFocusedWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Find moved files',
      buttonLabel: 'Search this folder',
      properties: ['openDirectory']
    }
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const folder = result.filePaths[0]
    if (result.canceled || !folder) return null
    return container.dataCare.relocate(folder)
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

  // ---- window mode ------------------------------------------------------
  // The renderer owns whether the compact UI is shown; main owns the native
  // bounds. Keeping those separate is what lets a renderer reload recover: it
  // asks for the remembered state instead of assuming full size.
  ipcMain.handle(IPC.windowGetMini, (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    return window ? isMiniPlayer(window) : false
  })

  ipcMain.handle(IPC.windowSetMini, (event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Window mode must be a boolean.')
    const window = BrowserWindow.fromWebContents(event.sender)
    return window ? setMiniPlayer(window, enabled) : false
  })

  // ---- taskbar thumbnail toolbar ---------------------------------------
  // The renderer owns playback state, so it pushes the two facts the toolbar
  // needs. Clicks come back on the normal player-command broadcast.
  ipcMain.handle(IPC.windowSetTaskbarState, (event, input: unknown) => {
    const state = sanitizeTaskbarState(input)
    if (!state) throw new Error('Malformed taskbar state.')
    playingTrackId = state.hasTrack ? state.trackId : null
    playbackIsPlaying = state.isPlaying
    const window = BrowserWindow.fromWebContents(event.sender)
    const applied = window ? applyTaskbarControls(window, state, log.child('taskbar')) : false
    // A deferred write can run once its file is no longer open. The queue is
    // drained without blocking the toolbar: a write that still cannot open the
    // file stays queued, and the next state change tries again.
    void pendingWrites.flush(
      (trackId) => trackId === playingTrackId && playbackIsPlaying
    )
    return applied
  })
}
