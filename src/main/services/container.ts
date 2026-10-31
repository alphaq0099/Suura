import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, nativeTheme } from 'electron'
import { ensureAppDirectories, resolveAppPaths } from '@core/paths'
import { createLogger, type Logger } from '@core/logging/logger'
import { SettingsService } from '@core/settings/settings-service'
import { applyPendingRestore, ensureDailyBackup, pruneDatabaseBackups } from '@core/db/backups'
import { openLibraryDatabase, type DatabaseHandle } from '@core/db/database'
import { TrackRepository } from '@core/library/track-repository'
import { DownloadHistoryRepository } from '@core/library/download-history-repository'
import { LibraryService } from '@core/library/library-service'
import { TagWriter } from '@core/library/tag-writer'
import { LyricsRepository } from '@core/library/lyrics-repository'
import { LyricsService } from '@core/library/lyrics-service'
import { FolderWatcher } from '@core/library/folder-watcher'
import { PlaylistRepository } from '@core/library/playlist-repository'
import { PlaylistService } from '@core/library/playlist-service'
import { DataCareService } from '@core/library/data-care-service'
import { OnlineRepository } from '@core/library/online-repository'
import { OnlinePlaylistRepository } from '@core/library/online-playlist-repository'
import { StreamPlayRepository } from '@core/library/stream-play-repository'
import { PlayStateRepository } from '@core/library/play-state-repository'
import { PlaybackService } from '@core/library/playback-service'
import { InnerTubeMetadataClient } from '@engine/innertube'
import { LocalFileResolver } from '@engine/local-file-resolver'
import { ResolverRegistry } from '@engine/resolver'
import { PoTokenProvider } from '@engine/sidecar/po-token'
import { EngineStatusCache } from '@engine/sidecar/engine-status'
import { probeExecutable } from '@engine/sidecar/locate'
import { YtDlpClient } from '@engine/sidecar/yt-dlp'
import { YouTubeResolver } from '@engine/youtube-resolver'
import { IPC_EVENTS } from '@shared/ipc'
import type { AppPaths, AppSettings } from '@shared/types'
import { createArtworkService, type ArtworkService } from '../artwork-service'
import { broadcast } from '../broadcast'
import { cleanupAbandonedDownloads, DownloadService } from '../download-service'
import { StreamCache } from '../stream-cache'
import { createOnlineService, type OnlineService } from '../online-service'
import { ReplayGainService } from '../replay-gain-service'
import { createTagLookup, type TagLookup } from '@core/library/tag-lookup'
import { createLyricsFinder, createLyricsLookup } from '@core/library/lyrics-lookup'
import { createGeniusProvider } from '@core/library/lyrics-genius'
import { createArtworkChoices, type ArtworkChoicesService } from '../artwork-choices'
import { createYoutubeService, type YoutubeService } from '../youtube-service'

/**
 * Owns every long-lived service and their wiring.
 *
 * The order here is the whole dependency graph in one place: paths -> logger ->
 * settings -> database -> repository -> services. Nothing reaches for a global.
 */
export interface AppContainer {
  paths: AppPaths
  log: Logger
  settings: SettingsService
  database: DatabaseHandle
  repo: TrackRepository
  library: LibraryService
  watcher: FolderWatcher
  /** Downloads a stream into the library (keep). */
  downloads: DownloadService
  /** Persisted save history, including failures that outlive the window. */
  downloadHistory: DownloadHistoryRepository
  /** Bounded copies of played streams, for offline playback. */
  streamCache: StreamCache
  playlists: PlaylistService
  /** Duplicate detection, safe merges and moved-file repair. */
  dataCare: DataCareService
  /** The last session's queue, saved as it plays and read once at start-up. */
  playback: PlaybackService
  resolvers: ResolverRegistry
  artwork: ArtworkService
  /** Paste-a-link streaming. Downloads (M4) will grow next to it. */
  youtube: YoutubeService
  /** The links the user has pasted, remembered between runs. */
  online: OnlineService
  /** Exposed alongside `repo` so the self-test can seed history directly. */
  onlineRepo: OnlineRepository
  /** Imported playlists, exposed so the self-test can seed one. */
  onlinePlaylists: OnlinePlaylistRepository
  /** The counted listens of streams; Home's Recently played reads it. */
  streamPlays: StreamPlayRepository
  /** Starts/stops an external PO Token provider when the user asks. */
  poToken: PoTokenProvider
  /** Saved yt-dlp/ffmpeg probe, so Settings opens without waiting. */
  engineStatus: EngineStatusCache
  /** Measures ReplayGain for local files in the background. */
  replayGain: ReplayGainService
  /** The only writer that modifies a user's files; exposed for later phases. */
  tagWriter: TagWriter
  /** Embedded and `.lrc` lyrics, plus the user's timing correction. */
  lyrics: LyricsService
  /** iTunes and MusicBrainz lookups for the tag finder. */
  tagLookup: TagLookup
  /** The covers the artwork picker offers, local and provider-supplied. */
  artworkChoices: ArtworkChoicesService
  dispose(): void
}

export function createContainer(): AppContainer {
  const paths = resolveAppPaths(app.getPath('userData'))
  ensureAppDirectories(paths)

  const log = createLogger('app', {
    file: paths.logs,
    level: app.isPackaged ? 'info' : 'debug'
  })
  log.info('starting', { version: app.getVersion(), userData: paths.userData, electron: process.versions.electron })

  // A restore is swapped in before anything opens the database. The marker was
  // staged by the previous run; if it is broken, applyPendingRestore leaves the
  // old library alone and records why.
  const hadDatabase = existsSync(paths.database)
  const restored = applyPendingRestore(paths, log.child('restore'))

  const settings = new SettingsService(paths.config, log.child('settings'))
  const poToken = new PoTokenProvider({
    engine: () => settings.get().engine,
    log: log.child('po-token')
  })
  const database = openLibraryDatabase(paths.database, log.child('db'), {
    backupsDir: paths.backups,
    backupKeep: settings.get().backups.retentionCount
  })
  if (hadDatabase || restored) {
    try {
      const backup = ensureDailyBackup(database.db, paths.backups, {
        keep: settings.get().backups.retentionCount
      })
      if (backup) log.info('daily database backup created', { backup })
    } catch (error) {
      // A full disk is not a reason to refuse to play music.
      log.warn('could not create the daily database backup', error)
    }
  }
  if (restored) log.info('started from a restored backup', { database: paths.database })
  const repo = new TrackRepository(database.db)
  const downloadHistory = new DownloadHistoryRepository(database.db)
  // Must run before this run can queue a save: any row still marked in-flight
  // belongs to a process that no longer exists.
  const interrupted = downloadHistory.markInterrupted()
  if (interrupted > 0) log.info('marked interrupted saves as failed', { count: interrupted })

  // Settings are the source of truth for the folder list, so make sure the
  // bookkeeping table matches them after a config file is edited by hand.
  for (const folder of settings.get().libraryFolders) {
    repo.addLibraryFolder(folder)
  }

  const resolvers = new ResolverRegistry((message, details) => log.debug(message, details))
  resolvers.register(new LocalFileResolver())

  const artwork = createArtworkService({ repo, paths, log: log.child('artwork') })

  const ytDlp = new YtDlpClient({
    engine: () => settings.get().engine,
    log: log.child('yt-dlp')
  })
  // The probe is saved between runs: opening Settings should not wait for two
  // child processes every time the app starts.
  const engineStatus = new EngineStatusCache({
    file: join(paths.userData, 'engine-status.json'),
    log: log.child('engine-status')
  })
  scheduleEngineAutoUpdate({ settings, ytDlp, log: log.child('yt-dlp-update') })
  const youtube = createYoutubeService(
    new YouTubeResolver({
      info: ytDlp,
      log: log.child('youtube'),
      quality: () => settings.get().retention.qualityTier,
      // The provider is expensive and most launches never stream, so it starts
      // on the first real YouTube request rather than at app start.
      onYouTubeRequest: () => poToken.noteYouTubeRequest()
    })
  )
  resolvers.register(youtube.resolver)

  const streamCache = new StreamCache({
    db: database.db,
    root: join(paths.cache, 'stream'),
    settings,
    log: log.child('cache')
  })
  streamCache.init()

  const onlineRepo = new OnlineRepository(database.db)
  const onlinePlaylists = new OnlinePlaylistRepository(database.db)
  const streamPlays = new StreamPlayRepository(database.db)
  // Search and channel metadata use YouTube's web API; playback keeps yt-dlp.
  // Separating them means a discovery request cannot spend the playback budget.
  const metadata = new InnerTubeMetadataClient({ log: log.child('innertube') })
  const online = createOnlineService({
    resolver: youtube.resolver,
    repo: onlineRepo,
    playlists: onlinePlaylists,
    plays: streamPlays,
    listProvider: ytDlp,
    discoverProvider: metadata,
    engine: () => settings.get().engine,
    artwork,
    log: log.child('online'),
    onChange: () => broadcast(IPC_EVENTS.onlineChanged, null),
    // A stream counted its listen, so Home's Recently played is stale even though
    // no library row changed. This is the same signal a local play sends.
    onPlayHistory: () => broadcast(IPC_EVENTS.playHistoryChanged, null)
  })

  const tagWriter = new TagWriter({
    backupDir: join(paths.backups, 'tags'),
    // Resolved per write rather than at startup: ffmpeg is optional until the
    // first edit, and Settings can change the folder between edits.
    resolveFfmpeg: async () => {
      const ffmpeg = await probeExecutable('ffmpeg', {
        configuredDir: settings.get().engine.binDir,
        versionArgs: ['-version']
      })
      if (!ffmpeg.found || !ffmpeg.path) {
        throw new Error(
          ffmpeg.error ?? 'ffmpeg was not found. Install it, or point Settings at the folder that holds it.'
        )
      }
      return ffmpeg.path
    }
  })

  const library = new LibraryService(
    repo,
    settings,
    log.child('library'),
    {
      onScanProgress: (progress) => broadcast(IPC_EVENTS.scanProgress, progress),
      onLibraryChanged: () => broadcast(IPC_EVENTS.libraryChanged, null),
      onPlayHistoryChanged: () => broadcast(IPC_EVENTS.playHistoryChanged, null)
    },
    tagWriter
  )

  const lyrics = new LyricsService(
    repo,
    new LyricsRepository(database.db),
    log.child('lyrics'),
    tagWriter,
    // LRCLIB first for timed LRC, Genius beside it for the words it lacks.
    createLyricsFinder({
      log: log.child('lyrics-lookup'),
      providers: [
        createLyricsLookup({ log: log.child('lyrics-lookup') }),
        createGeniusProvider({ log: log.child('lyrics-lookup') })
      ]
    })
  )

  // Keyless public services, asked in parallel when a file's tags are wrong.
  // The client owns its own timeouts and never throws: a provider being down is
  // a sentence in the review dialog, not a failed request.
  const tagLookup = createTagLookup({ log: log.child('tag-lookup') })
  const artworkChoices = createArtworkChoices({
    repo,
    artwork,
    tagLookup,
    log: log.child('artwork-choices')
  })

  // A crash or a force-quit never runs the download's `finally`, so sweep the
  // temp folders before anything can start writing a new one.
  cleanupAbandonedDownloads(paths.downloads, log.child('downloads'))

  const downloads = new DownloadService({
    settings,
    paths,
    repo,
    library,
    history: downloadHistory,
    ytDlp,
    musicDir: app.getPath('music'),
    log: log.child('downloads'),
    onChange: (progress) => {
      broadcast(IPC_EVENTS.downloadChanged, progress)
      // A finished save is a new library row, and Home's recent shelf is built
      // from it. The scan normally announces this first; sending it again when
      // the row is fully indexed makes the shelf correct even if the scan event
      // and the save event raced.
      if (progress.status === 'saved') broadcast(IPC_EVENTS.libraryChanged, null)
    },
    fileSizeHint: (videoId) => youtube.resolver.cachedFileSize(videoId)
  })

  // Playlists read tracks, so they take the same repository the library writes
  // through: pruning a track drops its playlist entries by foreign key, and the
  // two can never disagree about what a track id means.
  const playlists = new PlaylistService(new PlaylistRepository(database.db), repo, log.child('playlists'))
  const dataCare = new DataCareService(repo, log.child('data-care'))

  const playback = new PlaybackService(new PlayStateRepository(database.db), repo)

  // Both the folder list and the switch live in settings, so one listener keeps
  // the watchers in step with them — including the case where a folder is added
  // or removed while the app is running.
  const watcher = new FolderWatcher({
    log: log.child('watch'),
    onChange: (event) => {
      log.debug('folder change detected', event)
      void library.scanWhenIdle().catch((error) => {
        log.warn('could not scan after a folder change', error)
      })
    }
  })
  const applyWatchSettings = (next: AppSettings): void => {
    watcher.setFolders(next.library.watchForChanges ? next.libraryFolders : [])
  }
  applyWatchSettings(settings.get())
  const unwatchSettings = settings.onChange(applyWatchSettings)

  // Keep Electron's own chrome (title bar, scrollbars, context menus and native
  // dialogs) in step with the in-app theme. The renderer draws the palette
  // itself; this is the other half that CSS cannot reach. `system` is passed
  // through rather than resolved so Windows can keep following live changes.
  const applyTheme = (next: AppSettings): void => {
    nativeTheme.themeSource = next.theme === 'system' ? 'system' : next.theme
  }
  applyTheme(settings.get())
  const unwatchTheme = settings.onChange(applyTheme)

  // Lowering the retention count should take effect now, not only after the
  // next daily backup happens to rotate the folder.
  let backupKeep = settings.get().backups.retentionCount
  const unwatchBackupRetention = settings.onChange((next) => {
    if (next.backups.retentionCount === backupKeep) return
    backupKeep = next.backups.retentionCount
    try {
      const removed = pruneDatabaseBackups(paths.backups, backupKeep)
      if (removed > 0) log.info('pruned automatic backups', { removed, keep: backupKeep })
    } catch (error) {
      log.warn('could not prune automatic backups', error)
    }
  })

  // Turning the feature off must not leave a process the app started running.
  // Any change to the provider's own settings re-arms the one-shot auto-start:
  // nothing launches just because Settings was touched, but the next YouTube
  // request can start the new configuration without a restart.
  let poTokenConfig = settings.get().engine
  const unwatchPoToken = settings.onChange((next) => {
    const previous = poTokenConfig
    poTokenConfig = next.engine
    const relevantChange =
      previous.poTokenEnabled !== next.engine.poTokenEnabled ||
      previous.poTokenAutoStart !== next.engine.poTokenAutoStart ||
      previous.poTokenProviderCommand !== next.engine.poTokenProviderCommand ||
      previous.poTokenProviderUrl !== next.engine.poTokenProviderUrl
    if (!relevantChange) return
    if (!next.engine.poTokenEnabled) poToken.stopIfManaged()
    poToken.armAutoStart()
  })

  const replayGain = new ReplayGainService({
    settings,
    repo,
    log: log.child('replay-gain'),
    onProgress: (status) => broadcast(IPC_EVENTS.replayGainProgress, status)
  })

  return {
    paths,
    log,
    settings,
    database,
    repo,
    library,
    watcher,
    downloads,
    downloadHistory,
    streamCache,
    playlists,
    dataCare,
    playback,
    resolvers,
    artwork,
    youtube,
    online,
    onlineRepo,
    onlinePlaylists,
    streamPlays,
    poToken,
    engineStatus,
    replayGain,
    tagWriter,
    lyrics,
    tagLookup,
    artworkChoices,
    dispose: () => {
      unwatchSettings()
      unwatchTheme()
      unwatchBackupRetention()
      unwatchPoToken()
      poToken.dispose()
      replayGain.dispose()
      downloads.dispose()
      streamCache.dispose()
      watcher.stop()
      database.close()
      log.info('shutdown complete')
    }
  }
}

const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60_000
const AUTO_UPDATE_DELAY_MS = 20_000

/**
 * Keeps yt-dlp current without making every launch pay for it.
 *
 * `yt-dlp -U` is a network request, not a YouTube request. It runs in the
 * background once a day, after the window has settled, and a failed update is
 * logged rather than shown: an install managed by winget or pip may not allow
 * self-updates, and that must not look like a broken player.
 */
function scheduleEngineAutoUpdate(deps: {
  settings: SettingsService
  ytDlp: YtDlpClient
  log: Logger
}): void {
  if (process.env.PLAYER_SKIP_ENGINE_UPDATE === '1') return
  const engine = deps.settings.get().engine
  if (!engine.autoUpdate) return

  const last = typeof engine.lastUpdateCheckAt === 'number' ? engine.lastUpdateCheckAt : 0
  if (Date.now() - last < AUTO_UPDATE_INTERVAL_MS) return

  const timer = setTimeout(() => {
    // The switch or the timestamp may have changed while the timer waited.
    const current = deps.settings.get().engine
    const checkedAt = typeof current.lastUpdateCheckAt === 'number' ? current.lastUpdateCheckAt : 0
    if (!current.autoUpdate || Date.now() - checkedAt < AUTO_UPDATE_INTERVAL_MS) return

    void deps.ytDlp
      .update()
      .then((message) => deps.log.info('yt-dlp is current', { message: message.slice(-1000) }))
      .catch((error) => deps.log.warn('yt-dlp could not update itself', error))
      .finally(() => {
        // Record the attempt even on failure. Otherwise a binary that cannot
        // self-update would be retried on every single launch.
        deps.settings.update({ engine: { lastUpdateCheckAt: Date.now() } })
      })
  }, AUTO_UPDATE_DELAY_MS)
  timer.unref?.()
}
