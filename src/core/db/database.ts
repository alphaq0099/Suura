import { openDatabase, type SqlDatabase } from './driver'
import { MIGRATIONS } from './schema'
import type { Logger } from '../logging/logger'

export interface DatabaseHandle {
  db: SqlDatabase
  schemaVersion: number
  close(): void
}

/**
 * Opens the library database and brings it up to the latest schema version.
 *
 * Version tracking uses SQLite's own `user_version` pragma rather than a table,
 * because it is readable before the schema exists.
 */
export function openLibraryDatabase(file: string, log: Logger): DatabaseHandle {
  const db = openDatabase(file)
  const from = getUserVersion(db)
  const target = latestVersion()
  const pending = MIGRATIONS.filter((migration) => migration.version > from).sort(
    (a, b) => a.version - b.version
  )

  if (pending.length === 0) {
    log.info('database ready', { file, schemaVersion: from })
    return { db, schemaVersion: from, close: () => db.close() }
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
      throw error
    }
  }

  return { db, schemaVersion: target, close: () => db.close() }
}

function getUserVersion(db: SqlDatabase): number {
  const row = db.prepare('PRAGMA user_version').get<{ user_version: number }>()
  return row?.user_version ?? 0
}

export function latestVersion(): number {
  return MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0)
}
