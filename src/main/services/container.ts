import { app } from 'electron'
import { ensureAppDirectories, resolveAppPaths } from '@core/paths'
import { createLogger, type Logger } from '@core/logging/logger'
import { SettingsService } from '@core/settings/settings-service'
import { openLibraryDatabase, type DatabaseHandle } from '@core/db/database'
import { TrackRepository } from '@core/library/track-repository'
import { LibraryService } from '@core/library/library-service'
import { LocalFileResolver } from '@engine/local-file-resolver'
import { ResolverRegistry } from '@engine/resolver'
import { IPC_EVENTS } from '@shared/ipc'
import type { AppPaths } from '@shared/types'
import { createArtworkService, type ArtworkService } from '../artwork-service'
import { broadcast } from '../broadcast'

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
  resolvers: ResolverRegistry
  artwork: ArtworkService
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

  const library = new LibraryService(repo, settings, log.child('library'), {
    onScanProgress: (progress) => broadcast(IPC_EVENTS.scanProgress, progress),
    onLibraryChanged: () => broadcast(IPC_EVENTS.libraryChanged, null)
  })

  return {
    paths,
    log,
    settings,
    database,
    repo,
    library,
    resolvers,
    artwork,
    dispose: () => {
      database.close()
      log.info('shutdown complete')
    }
  }
}
