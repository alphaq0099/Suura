import { createDatabaseBackup, pruneDatabaseBackups } from './backups'
import { openDatabase, type SqlDatabase } from './driver'
import { MIGRATIONS, latestVersion } from './schema'
import type { Logger } from '../logging/logger'

export { latestVersion } from './schema'

export interface DatabaseHandle {
  db: SqlDatabase
  schemaVersion: number
  close(): void
}

export interface OpenLibraryDatabaseOptions {
  /** When set, a copy is made before an existing database is migrated. */
  backupsDir?: string
  /** How many automatic/pre-migration copies to keep. */
  backupKeep?: number
  /** Injectable clock for tests. */
  now?: number
}

/**
 * Thrown when a library was written by a newer build.
 *
 * Refusing to open is the data-safe choice: the older build does not know what
 * the newer migrations changed, and SQLite would happily let it write anyway.
 */
export class DatabaseSchemaTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number
  ) {
    super(
      `This library was written by a newer version of Player (schema ${found}; this build supports ${supported}). Update Player before opening it.`
    )
    this.name = 'DatabaseSchemaTooNewError'
  }
}

/**
 * Opens the library database and brings it up to the latest schema version.
 *
 * Version tracking uses SQLite's own `user_version` pragma rather than a table,
 * because it is readable before the schema exists.
 */
export function openLibraryDatabase(
  file: string,
  log: Logger,
  options: OpenLibraryDatabaseOptions = {}
): DatabaseHandle {
  const db = openDatabase(file)
  const from = getUserVersion(db)
  const target = latestVersion()

  if (from > target) {
    db.close()
    throw new DatabaseSchemaTooNewError(from, target)
  }

  const pending = MIGRATIONS.filter((migration) => migration.version > from).sort(
    (a, b) => a.version - b.version
  )

  if (pending.length === 0) {
    log.info('database ready', { file, schemaVersion: from })
    return { db, schemaVersion: from, close: () => db.close() }
  }

  let preMigrationBackup: string | null = null
  if (from > 0 && options.backupsDir) {
    // A migration is the one moment the app rewrites every row's surrounding
    // schema. Keep a consistent copy first, but do not make startup impossible
    // when the disk is full; the migrations themselves are transactional.
    try {
      preMigrationBackup = createDatabaseBackup(
        db,
        options.backupsDir,
        `pre-migration-v${from}`,
        new Date(options.now ?? Date.now())
      )
      pruneDatabaseBackups(options.backupsDir, options.backupKeep)
      log.info('database backed up before migration', { backup: preMigrationBackup, from, to: target })
    } catch (error) {
      log.warn('could not back up before migration', { from, to: target, error })
    }
  }

  log.info('applying migrations', { file, from, to: target, count: pending.length })
  for (const migration of pending) {
    // One transaction per migration so a failure leaves an older, usable schema.
    try {
      db.transaction(() => {
        migration.up(db)
        db.exec(`PRAGMA user_version = ${migration.version}`)
      })
      log.debug('migration applied', { version: migration.version, name: migration.name })
    } catch (error) {
      log.error('migration failed', { version: migration.version, name: migration.name, error })
      db.close()
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(
        preMigrationBackup
          ? `${reason} A copy from before the upgrade is at ${preMigrationBackup}.`
          : reason
      )
    }
  }

  return { db, schemaVersion: target, close: () => db.close() }
}

function getUserVersion(db: SqlDatabase): number {
  const row = db.prepare('PRAGMA user_version').get<{ user_version: number }>()
  return row?.user_version ?? 0
}
