import { copyFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { dialog } from 'electron'
import { findDatabaseRecoveryCandidate } from '@core/db/backups'
import {
  DatabaseSchemaTooNewError,
  latestVersion,
  openLibraryDatabase,
  type DatabaseHandle
} from '@core/db/database'
import type { Logger } from '@core/logging/logger'
import type { AppPaths } from '@shared/types'

/**
 * Opening the library, with a way back from a damaged file.
 *
 * SQLite corruption is rare but it is not recoverable in place, and the old
 * behaviour — an error box and an immediate exit — left the user with no way to
 * start the app short of finding and deleting `library.db` themselves. The
 * rotating automatic backups already exist, so the cheapest repair is to offer
 * one by name and keep the damaged file beside it.
 */

/** The user chose to quit rather than repair or replace the library. */
export class LibraryOpenCancelledError extends Error {
  constructor() {
    super('Suura closed because the library could not be opened.')
    this.name = 'LibraryOpenCancelledError'
  }
}

export interface OpenLibraryRecoveryOptions {
  backupsDir: string
  backupKeep: number
  /** False for --selftest/--scale/--perf, which must never wait on a dialog. */
  interactive: boolean
}

function recoveryStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/**
 * Moves a database that will not open aside instead of deleting it.
 *
 * The `-wal` and `-shm` sidecars belong to the damaged file and would confuse
 * SQLite if they were left beside the restored copy.
 */
function setAside(file: string): string {
  const destination = `${file}.unreadable-${recoveryStamp()}`
  renameSync(file, destination)
  rmSync(`${file}-wal`, { force: true })
  rmSync(`${file}-shm`, { force: true })
  return destination
}

export function openLibraryWithRecovery(
  paths: AppPaths,
  log: Logger,
  options: OpenLibraryRecoveryOptions
): DatabaseHandle {
  const open = (): DatabaseHandle =>
    openLibraryDatabase(paths.database, log, {
      backupsDir: options.backupsDir,
      backupKeep: options.backupKeep
    })

  try {
    return open()
  } catch (error) {
    // A newer schema is not damage: restoring an older copy would silently
    // throw away whatever that build wrote. Refuse, as before.
    if (error instanceof DatabaseSchemaTooNewError) throw error
    if (!options.interactive) throw error

    const candidate = findDatabaseRecoveryCandidate(options.backupsDir, latestVersion())
    if (!candidate) throw error

    log.warn('library did not open', { error })
    const answer = dialog.showMessageBoxSync({
      type: 'error',
      title: 'Suura could not open its library',
      message: 'The library database is damaged.',
      detail:
        `The newest usable automatic backup is from ${new Date(
          statSync(candidate.file).mtimeMs
        ).toLocaleString()} (schema ${candidate.schemaVersion}).\n\n` +
        'Restore it to bring the library back as it was then. Starting a new library keeps your music files but ' +
        'forgets playlists, play counts and tags until the folders are scanned again.\n\n' +
        'Either way, the damaged file is kept beside the database.',
      buttons: ['Restore latest backup', 'Start a new library', 'Quit'],
      defaultId: 0,
      cancelId: 2,
      noLink: true
    })

    if (answer === 2) throw new LibraryOpenCancelledError()

    const moved = setAside(paths.database)
    const restored = answer === 0
    if (restored) copyFileSync(candidate.file, paths.database)
    log.warn(restored ? 'restored the newest automatic backup' : 'started a new library', {
      damaged: moved,
      backup: restored ? candidate.file : null
    })
    return open()
  }
}
