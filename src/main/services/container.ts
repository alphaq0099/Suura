import { existsSync } from 'node:fs'
import { app, nativeTheme } from 'electron'
import { ensureAppDirectories, resolveAppPaths } from '@core/paths'
import { createLogger, type Logger } from '@core/logging/logger'
import { SettingsService } from '@core/settings/settings-service'
import { applyPendingRestore, ensureDailyBackup, pruneDatabaseBackups } from '@core/db/backups'
import { openLibraryDatabase, type DatabaseHandle } from '@core/db/database'
import { TrackRepository } from '@core/library/track-repository'
import { LibraryService } from '@core/library/library-service'
import { FolderWatcher } from '@core/library/folder-watcher'
import { PlaylistRepository } from '@core/library/playlist-repository'
import { PlaylistService } from '@core/library/playlist-service'
import { DataCareService } from '@core/library/data-care-service'
import { OnlineRepository } from '@core/library/online-repository'
import { OnlinePlaylistRepository } from '@core/library/online-playlist-repository'
import { PlayStateRepository } from '@core/library/play-state-repository'
import { PlaybackService } from '@core/library/playback-service'
import { InnerTubeMetadataClient } from '@engine/innertube'
import { LocalFileResolver } from '@engine/local-file-resolver'
import { ResolverRegistry } from '@engine/resolver'
import { PoTokenProvider } from '@engine/sidecar/po-token'
import { YtDlpClient } from '@engine/sidecar/yt-dlp'
import { YouTubeResolver } from '@engine/youtube-resolver'
import { IPC_EVENTS } from '@shared/ipc'
import type { AppPaths, AppSettings } from '@shared/types'
import { createArtworkService, type ArtworkService } from '../artwork-service'
import { broadcast } from '../broadcast'
import { cleanupAbandonedDownloads, DownloadService } from '../download-service'
import { createOnlineService, type OnlineService } from '../online-service'
import { ReplayGainService } from '../replay-gain-service'
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
  /** Starts/stops an external PO Token provider when the user asks. */
  poToken: PoTokenProvider
  /** Measures ReplayGain for local files in the background. */
  replayGain: ReplayGainService
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
  scheduleEngineAutoUpdate({ settings, ytDlp, log: log.child('yt-dlp-update') })
  const youtube = createYoutubeService(
    new YouTubeResolver({
      info: ytDlp,
      log: log.child('youtube'),
      quality: () => settings.get().retention.qualityTier
    })
  )
  resolvers.register(youtube.resolver)

  const onlineRepo = new OnlineRepository(database.db)
  const onlinePlaylists = new OnlinePlaylistRepository(database.db)
  // Search and channel metadata use YouTube's web API; playback keeps yt-dlp.
  // Separating them means a discovery request cannot spend the playback budget.
  const metadata = new InnerTubeMetadataClient({ log: log.child('innertube') })
  const online = createOnlineService({
    resolver: youtube.resolver,
    repo: onlineRepo,
    playlists: onlinePlaylists,
    listProvider: ytDlp,
    discoverProvider: metadata,
    engine: () => settings.get().engine,
    artwork,
    log: log.child('online'),
    onChange: () => broadcast(IPC_EVENTS.onlineChanged, null)
  })

  const library = new LibraryService(repo, settings, log.child('library'), {
    onScanProgress: (progress) => broadcast(IPC_EVENTS.scanProgress, progress),
    onLibraryChanged: () => broadcast(IPC_EVENTS.libraryChanged, null)
  })

  // A crash or a force-quit never runs the download's `finally`, so sweep the
  // temp folders before anything can start writing a new one.
  cleanupAbandonedDownloads(paths.downloads, log.child('downloads'))

  const downloads = new DownloadService({
    settings,
    paths,
    repo,
    library,
    ytDlp,
    musicDir: app.getPath('music'),
    log: log.child('downloads'),
    onChange: (progress) => broadcast(IPC_EVENTS.downloadChanged, progress)
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
  // Turning it on with auto-start set can start the provider without a restart.
  const unwatchPoToken = settings.onChange((next) => {
    if (!next.engine.poTokenEnabled) {
      poToken.stopIfManaged()
      return
    }
    if (next.engine.poTokenAutoStart) poToken.maybeAutoStart()
  })
  poToken.maybeAutoStart()

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
    playlists,
    dataCare,
    playback,
    resolvers,
    artwork,
    youtube,
    online,
    onlineRepo,
    onlinePlaylists,
    poToken,
    replayGain,
    dispose: () => {
      unwatchSettings()
      unwatchTheme()
      unwatchBackupRetention()
      unwatchPoToken()
      poToken.dispose()
      replayGain.dispose()
      downloads.dispose()
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
