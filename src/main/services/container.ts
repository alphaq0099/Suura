import { app } from 'electron'
import { ensureAppDirectories, resolveAppPaths } from '@core/paths'
import { createLogger, type Logger } from '@core/logging/logger'
import { SettingsService } from '@core/settings/settings-service'
import { openLibraryDatabase, type DatabaseHandle } from '@core/db/database'
import { TrackRepository } from '@core/library/track-repository'
import { LibraryService } from '@core/library/library-service'
import { FolderWatcher } from '@core/library/folder-watcher'
import { PlaylistRepository } from '@core/library/playlist-repository'
import { PlaylistService } from '@core/library/playlist-service'
import { OnlineRepository } from '@core/library/online-repository'
import { PlayStateRepository } from '@core/library/play-state-repository'
import { PlaybackService } from '@core/library/playback-service'
import { LocalFileResolver } from '@engine/local-file-resolver'
import { ResolverRegistry } from '@engine/resolver'
import { YtDlpClient } from '@engine/sidecar/yt-dlp'
import { YouTubeResolver } from '@engine/youtube-resolver'
import { IPC_EVENTS } from '@shared/ipc'
import type { AppPaths, AppSettings } from '@shared/types'
import { createArtworkService, type ArtworkService } from '../artwork-service'
import { broadcast } from '../broadcast'
import { createOnlineService, type OnlineService } from '../online-service'
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
  playlists: PlaylistService
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

  const settings = new SettingsService(paths.config, log.child('settings'))
  const database = openLibraryDatabase(paths.database, log.child('db'))
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
  const youtube = createYoutubeService(
    new YouTubeResolver({
      info: ytDlp,
      log: log.child('youtube'),
      quality: () => settings.get().retention.qualityTier
    })
  )
  resolvers.register(youtube.resolver)

  const onlineRepo = new OnlineRepository(database.db)
  const online = createOnlineService({
    resolver: youtube.resolver,
    repo: onlineRepo,
    artwork,
    log: log.child('online'),
    onChange: () => broadcast(IPC_EVENTS.onlineChanged, null)
  })

  const library = new LibraryService(repo, settings, log.child('library'), {
    onScanProgress: (progress) => broadcast(IPC_EVENTS.scanProgress, progress),
    onLibraryChanged: () => broadcast(IPC_EVENTS.libraryChanged, null)
  })

  // Playlists read tracks, so they take the same repository the library writes
  // through: pruning a track drops its playlist entries by foreign key, and the
  // two can never disagree about what a track id means.
  const playlists = new PlaylistService(new PlaylistRepository(database.db), repo, log.child('playlists'))

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

  return {
    paths,
    log,
    settings,
    database,
    repo,
    library,
    watcher,
    playlists,
    playback,
    resolvers,
    artwork,
    youtube,
    online,
    onlineRepo,
    dispose: () => {
      unwatchSettings()
      watcher.stop()
      database.close()
      log.info('shutdown complete')
    }
  }
}
