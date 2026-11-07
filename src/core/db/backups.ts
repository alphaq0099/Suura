import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { AppPaths } from '@shared/types'
import type { Logger } from '../logging/logger'
import { inspectDatabaseFile, type SqlDatabase } from './driver'
import { latestVersion } from './schema'

/**
 * Data-care files.
 *
 * There are two kinds of backup on purpose. Automatic ones are single SQLite
 * files in a known folder, cheap enough to make on every start and easy to
 * rotate. A manual backup is a folder with the database, the settings and a
 * manifest, because "restore my app" means both files and a folder is something
 * the user can copy to another drive without a custom archive format.
 */

export const BACKUP_FORMAT = 'player-backup'
export const BACKUP_FORMAT_VERSION = 1
export const BACKUP_KEEP = 10
export const RESTORE_MARKER = 'restore-pending.json'
export const RESTORE_FAILURE_MARKER = 'restore-failed.json'
export const RESTORE_STAGING_DIR = 'restore-staging'
const DAY_MS = 24 * 60 * 60 * 1000

export interface BackupManifest {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_FORMAT_VERSION
  appVersion: string
  createdAt: string
  schemaVersion: number
}

export interface BackupBundleSummary {
  directory: string
  database: string
  config: string
  manifest: BackupManifest
}

export interface InspectedBackup {
  directory: string
  database: string
  configPath: string
  config: unknown
  manifest: BackupManifest
  schemaVersion: number
}

interface BackupFile {
  file: string
  mtimeMs: number
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function pad(value: number): string {
  return value.toString().padStart(2, '0')
}

/** Local time, with characters that Windows does not allow in a folder name. */
export function backupTimestamp(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

function safeFilePart(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-')
}

function uniquePath(directory: string, base: string, extension: string): string {
  let candidate = join(directory, `${base}${extension}`)
  for (let suffix = 2; existsSync(candidate); suffix += 1) {
    candidate = join(directory, `${base} (${suffix})${extension}`)
  }
  return candidate
}

/** A folder name that is unique inside `parent`; the parent is created. */
export function nextBackupDirectory(parent: string, prefix = 'Suura backup', date = new Date()): string {
  mkdirSync(parent, { recursive: true })
  return uniquePath(parent, `${prefix} ${backupTimestamp(date)}`, '')
}

/** SQLite's own consistent copy, not a raw copy of a live WAL database. */
export function createDatabaseBackup(
  db: SqlDatabase,
  directory: string,
  label: string,
  date = new Date()
): string {
  mkdirSync(directory, { recursive: true })
  const destination = uniquePath(directory, `${safeFilePart(label)}-${backupTimestamp(date)}`, '.db')
  db.prepare('VACUUM INTO ?').run(destination)
  return destination
}

function listDatabaseBackups(directory: string): BackupFile[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.db'))
    .map((entry) => {
      const file = join(directory, entry.name)
      return { file, mtimeMs: statSync(file).mtimeMs }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/** Drops old automatic/pre-migration files. Manual backup folders are never touched. */
export function pruneDatabaseBackups(directory: string, keep = BACKUP_KEEP): number {
  const managed = listDatabaseBackups(directory).filter((entry) => {
    const name = entry.file.split(/[\\/]/).pop() ?? ''
    return name.startsWith('auto-') || name.startsWith('pre-migration-')
  })
  let removed = 0
  for (const entry of managed.slice(Math.max(0, keep))) {
    try {
      rmSync(entry.file, { force: true })
      removed += 1
    } catch {
      // A locked file will be retried on the next start; a failed rotation must
      // not stop the app from opening.
    }
  }
  return removed
}

/**
 * The newest automatic copy that SQLite reports as sound.
 *
 * Used only when the live library will not open. Manual backup folders are left
 * alone: those are the user's, and choosing one automatically would be a guess.
 * A copy from a newer schema is skipped too, because this build cannot read it.
 */
export function findDatabaseRecoveryCandidate(
  directory: string,
  maxSchemaVersion = latestVersion()
): { file: string; schemaVersion: number } | null {
  for (const entry of listDatabaseBackups(directory)) {
    const name = entry.file.split(/[\\/]/).pop() ?? ''
    if (!name.startsWith('auto-') && !name.startsWith('pre-migration-')) continue
    try {
      const inspection = inspectDatabaseFile(entry.file)
      if (inspection.integrity !== 'ok') continue
      if (inspection.schemaVersion > maxSchemaVersion) continue
      return { file: entry.file, schemaVersion: inspection.schemaVersion }
    } catch {
      // An unreadable file is not a candidate; try the next one.
    }
  }
  return null
}

/**
 * Makes at most one automatic copy per day.
 *
 * The file's mtime is the clock rather than a setting, so the policy survives a
 * config reset and does not add another preference to explain.
 */
export function ensureDailyBackup(
  db: SqlDatabase,
  directory: string,
  options: { now?: number; keep?: number } = {}
): string | null {
  const now = options.now ?? Date.now()
  const [latest] = listDatabaseBackups(directory)
  if (latest && now - latest.mtimeMs < DAY_MS) return null
  const file = createDatabaseBackup(db, directory, 'auto', new Date(now))
  pruneDatabaseBackups(directory, options.keep ?? BACKUP_KEEP)
  return file
}

function writeManifest(directory: string, manifest: BackupManifest): string {
  const file = join(directory, 'manifest.json')
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return file
}

/** Creates the folder bundle exposed by Settings -> Back up now. */
export function createBackupBundle(input: {
  db: SqlDatabase
  directory: string
  config: unknown
  appVersion: string
  schemaVersion: number
  now?: Date
}): BackupBundleSummary {
  mkdirSync(input.directory)
  const database = join(input.directory, 'library.db')
  input.db.prepare('VACUUM INTO ?').run(database)
  const config = join(input.directory, 'config.json')
  writeFileSync(config, `${JSON.stringify(input.config, null, 2)}\n`, 'utf8')
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    appVersion: input.appVersion,
    createdAt: (input.now ?? new Date()).toISOString(),
    schemaVersion: input.schemaVersion
  }
  writeManifest(input.directory, manifest)
  return { directory: input.directory, database, config, manifest }
}

/**
 * Validates a folder before anything is overwritten.
 *
 * The database is checked for integrity and for a schema this build can open.
 * Finding a newer schema here is the whole point of the guard: restoring it
 * would let this older build read tables it does not understand.
 */
export function inspectBackupBundle(directory: string): InspectedBackup {
  const manifestPath = join(directory, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error('This folder does not contain a Suura backup (manifest.json is missing).')
  }
  let rawManifest: unknown
  try {
    rawManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    throw new Error('The backup manifest is not valid JSON.')
  }
  if (!isPlainObject(rawManifest) || rawManifest.format !== BACKUP_FORMAT) {
    throw new Error('This folder does not contain a Suura backup.')
  }
  if (rawManifest.version !== BACKUP_FORMAT_VERSION) {
    throw new Error('This backup uses a newer format than this version of Suura understands.')
  }
  if (
    typeof rawManifest.appVersion !== 'string' ||
    typeof rawManifest.createdAt !== 'string' ||
    typeof rawManifest.schemaVersion !== 'number'
  ) {
    throw new Error('The backup manifest is incomplete.')
  }

  const database = join(directory, 'library.db')
  const configPath = join(directory, 'config.json')
  if (!existsSync(database)) throw new Error('The backup has no library.db.')
  if (!existsSync(configPath)) throw new Error('The backup has no config.json.')

  const inspection = inspectDatabaseFile(database)
  if (inspection.integrity !== 'ok') {
    throw new Error(`The backup database is damaged (${inspection.integrity}).`)
  }
  const target = latestVersion()
  if (inspection.schemaVersion > target) {
    throw new Error(
      `This backup was written by a newer version of Suura (schema ${inspection.schemaVersion}, this build supports ${target}). Update Suura before restoring it.`
    )
  }

  let config: unknown
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    throw new Error('The backup settings file is not valid JSON.')
  }
  if (!isPlainObject(config)) throw new Error('The backup settings file is not a settings object.')

  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    appVersion: rawManifest.appVersion,
    createdAt: rawManifest.createdAt,
    schemaVersion: rawManifest.schemaVersion
  }
  return {
    directory,
    database,
    configPath,
    config,
    manifest,
    schemaVersion: inspection.schemaVersion
  }
}

/**
 * Copies a vetted backup into a staging folder and leaves a marker.
 *
 * The actual replacement happens on the next start, before the database is
 * opened. That is the only time the app can swap the file without a live
 * connection or a WAL in the way.
 */
export function stageRestore(input: {
  backup: InspectedBackup
  userDataDir: string
  config: unknown
  now?: Date
}): { marker: string; stagingDirectory: string } {
  const stagingDirectory = join(input.userDataDir, RESTORE_STAGING_DIR)
  rmSync(stagingDirectory, { recursive: true, force: true })
  rmSync(join(input.userDataDir, RESTORE_FAILURE_MARKER), { force: true })
  mkdirSync(stagingDirectory, { recursive: true })
  const stagedDatabase = join(stagingDirectory, 'library.db')
  copyFileSync(input.backup.database, stagedDatabase)
  writeFileSync(join(stagingDirectory, 'config.json'), `${JSON.stringify(input.config, null, 2)}\n`, 'utf8')
  const marker = join(input.userDataDir, RESTORE_MARKER)
  writeFileSync(
    marker,
    `${JSON.stringify(
      {
        format: 'player-restore',
        version: 1,
        createdAt: (input.now ?? new Date()).toISOString(),
        backupDirectory: input.backup.directory,
        appVersion: input.backup.manifest.appVersion
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  return { marker, stagingDirectory }
}

function replaceFile(source: string, destination: string): void {
  try {
    renameSync(source, destination)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM') throw error
    rmSync(destination, { force: true })
    renameSync(source, destination)
  }
}

function writePreRestoreBundle(paths: AppPaths, sourceDatabase: string, sourceConfig: string, now: Date): void {
  try {
    const directory = nextBackupDirectory(paths.backups, 'Pre-restore', now)
    mkdirSync(directory)
    if (existsSync(sourceDatabase)) copyFileSync(sourceDatabase, join(directory, 'library.db'))
    if (existsSync(sourceConfig)) copyFileSync(sourceConfig, join(directory, 'config.json'))
    let schemaVersion = 0
    try {
      if (existsSync(sourceDatabase)) schemaVersion = inspectDatabaseFile(sourceDatabase).schemaVersion
    } catch {
      // A corrupt current library is exactly when this pre-restore copy matters;
      // the manifest can still say what was there.
    }
    writeManifest(directory, {
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION,
      appVersion: 'unknown',
      createdAt: now.toISOString(),
      schemaVersion
    })
  } catch {
    // Best effort. The user's chosen backup is still the recovery path.
  }
}

/**
 * Applies a staged restore at startup, before the database is opened.
 *
 * Returns true when a restore ran. On failure the old library is left in place
 * and the marker is renamed so the next start does not retry a broken restore
 * forever.
 */
export function applyPendingRestore(paths: AppPaths, log: Logger): boolean {
  const marker = join(paths.userData, RESTORE_MARKER)
  if (!existsSync(marker)) return false
  const stagingDirectory = join(paths.userData, RESTORE_STAGING_DIR)
  try {
    const markerData = JSON.parse(readFileSync(marker, 'utf8')) as unknown
    if (!isPlainObject(markerData) || markerData.format !== 'player-restore' || markerData.version !== 1) {
      throw new Error('The restore marker is not valid.')
    }
    const stagedDatabase = join(stagingDirectory, 'library.db')
    const stagedConfig = join(stagingDirectory, 'config.json')
    if (!existsSync(stagedDatabase) || !existsSync(stagedConfig)) {
      throw new Error('The staged restore is incomplete.')
    }
    const inspection = inspectDatabaseFile(stagedDatabase)
    if (inspection.integrity !== 'ok') throw new Error(`The staged database is damaged (${inspection.integrity}).`)
    const target = latestVersion()
    if (inspection.schemaVersion > target) {
      throw new Error(`The staged database uses schema ${inspection.schemaVersion}; this build supports ${target}.`)
    }
    const config = JSON.parse(readFileSync(stagedConfig, 'utf8')) as unknown
    if (!isPlainObject(config)) throw new Error('The staged settings are not a settings object.')

    if (existsSync(paths.database)) writePreRestoreBundle(paths, paths.database, paths.config, new Date())

    // The old WAL belongs to the old file. Removing the sidecars before the new
    // database lands is what keeps SQLite from replaying them onto it.
    rmSync(`${paths.database}-wal`, { force: true })
    rmSync(`${paths.database}-shm`, { force: true })
    replaceFile(stagedDatabase, paths.database)
    replaceFile(stagedConfig, paths.config)
    rmSync(`${paths.database}-wal`, { force: true })
    rmSync(`${paths.database}-shm`, { force: true })
    rmSync(stagingDirectory, { recursive: true, force: true })
    rmSync(marker, { force: true })
    log.info('library and settings restored', { schemaVersion: inspection.schemaVersion })
    return true
  } catch (error) {
    log.error('could not apply the staged restore', error)
    try {
      writeFileSync(
        join(paths.userData, RESTORE_FAILURE_MARKER),
        `${JSON.stringify(
          {
            format: 'player-restore-failure',
            createdAt: new Date().toISOString(),
            message: messageOf(error)
          },
          null,
          2
        )}\n`,
        'utf8'
      )
      rmSync(marker, { force: true })
    } catch {
      // If even this fails, the next start will try once more. That is better
      // than deleting a recovery marker we could not replace with a diagnosis.
    }
    return false
  }
}
