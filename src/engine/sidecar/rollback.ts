import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from '@core/logging/logger'
import type { YtDlpRollbackStatus } from '@shared/types'

/**
 * Keeps the yt-dlp that was working before a self-update.
 *
 * yt-dlp fixes extractor breakage by shipping often, but a fresh release can
 * also be the thing that breaks playback. The binary that worked all week is
 * worth keeping: it is copied before `-U`, verified after, and put back when
 * the new one will not start or when the extractor fails repeatedly.
 *
 * The copy lives beside the managed binary rather than in userData so
 * uninstalling or clearing the engine folder takes it too. It is deliberately
 * a plain file, not a compressed archive: restoring has to work even when the
 * new binary cannot start.
 */

export const LKG_BINARY_NAME =
  process.platform === 'win32' ? 'yt-dlp.previous.exe' : 'yt-dlp.previous'
export const LKG_META_NAME = 'yt-dlp.previous.json'

interface RollbackRecord {
  version: number
  /** Version reported by the binary when it was saved, when the probe knew it. */
  versionLabel: string | null
  savedAt: number
  lastRestoredAt: number | null
}

const RECORD_VERSION = 1

function emptyRecord(): RollbackRecord {
  return { version: RECORD_VERSION, versionLabel: null, savedAt: 0, lastRestoredAt: null }
}

async function readRecord(dir: string): Promise<RollbackRecord> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, LKG_META_NAME), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return emptyRecord()
    const candidate = parsed as Partial<RollbackRecord>
    if (candidate.version !== RECORD_VERSION) return emptyRecord()
    return {
      version: RECORD_VERSION,
      versionLabel: typeof candidate.versionLabel === 'string' ? candidate.versionLabel : null,
      savedAt:
        typeof candidate.savedAt === 'number' && Number.isFinite(candidate.savedAt)
          ? candidate.savedAt
          : 0,
      lastRestoredAt:
        typeof candidate.lastRestoredAt === 'number' && Number.isFinite(candidate.lastRestoredAt)
          ? candidate.lastRestoredAt
          : null
    }
  } catch {
    return emptyRecord()
  }
}

async function writeRecord(dir: string, record: RollbackRecord): Promise<void> {
  const target = join(dir, LKG_META_NAME)
  const temporary = `${target}.tmp`
  await writeFile(temporary, JSON.stringify(record, null, 2), 'utf8')
  try {
    await rename(temporary, target)
  } catch {
    await rm(target, { force: true })
    await rename(temporary, target)
  }
}

/** True when the managed binary itself is the one being updated. */
export function isManagedBinary(
  managedDir: string | null | undefined,
  binary: string | null | undefined
): boolean {
  if (!managedDir || !binary) return false
  const base = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
  return binary.toLowerCase() === join(managedDir, base).toLowerCase()
}

/**
 * Copies the current binary aside before an update.
 *
 * The caller only passes a binary that has just answered `--version`, so a
 * broken file can never replace a good fallback.
 */
export async function saveLastKnownGood(
  dir: string,
  binary: string,
  version: string | null,
  now: () => number = Date.now
): Promise<YtDlpRollbackStatus> {
  await mkdir(dir, { recursive: true })
  const target = join(dir, LKG_BINARY_NAME)
  const temporary = `${target}.tmp`
  await copyFile(binary, temporary)
  try {
    await rename(temporary, target)
  } catch {
    await rm(target, { force: true })
    await rename(temporary, target)
  }
  const previous = await readRecord(dir)
  const at = now()
  await writeRecord(dir, {
    version: RECORD_VERSION,
    versionLabel: version,
    savedAt: at,
    lastRestoredAt: previous.lastRestoredAt
  })
  return { available: true, version, savedAt: at, lastRestoredAt: previous.lastRestoredAt }
}

/** What Settings shows. One stat and one small read; no process is spawned. */
export async function ytDlpRollbackStatus(
  dir: string | null | undefined
): Promise<YtDlpRollbackStatus> {
  if (!dir) return { available: false, version: null, savedAt: null, lastRestoredAt: null }
  const record = await readRecord(dir)
  try {
    const info = await stat(join(dir, LKG_BINARY_NAME))
    if (!info.isFile() || info.size === 0) {
      return { available: false, version: null, savedAt: null, lastRestoredAt: record.lastRestoredAt }
    }
    return {
      available: true,
      version: record.versionLabel,
      savedAt: record.savedAt > 0 ? record.savedAt : Math.round(info.mtimeMs),
      lastRestoredAt: record.lastRestoredAt
    }
  } catch {
    return { available: false, version: null, savedAt: null, lastRestoredAt: record.lastRestoredAt }
  }
}

/**
 * Swaps the saved binary back in and records that it happened.
 *
 * The copy becomes the current binary, so it is consumed: the next update
 * starts a new backup from whatever is working then. The record keeps its
 * version label and `lastRestoredAt` so About can say what happened.
 */
export async function restoreLastKnownGood(
  dir: string,
  targetBinary: string,
  now: () => number = Date.now
): Promise<{ restored: boolean; version: string | null }> {
  const source = join(dir, LKG_BINARY_NAME)
  try {
    const info = await stat(source)
    if (!info.isFile() || info.size === 0) return { restored: false, version: null }
  } catch {
    return { restored: false, version: null }
  }

  const temporary = `${targetBinary}.restore`
  await copyFile(source, temporary)
  try {
    await rename(temporary, targetBinary)
  } catch {
    await rm(targetBinary, { force: true })
    await rename(temporary, targetBinary)
  }
  await rm(source, { force: true })

  const record = await readRecord(dir)
  record.lastRestoredAt = now()
  await writeRecord(dir, record)
  return { restored: true, version: record.versionLabel }
}

/** For a fresh engine download: an old fallback must not outlive its install. */
export async function clearLastKnownGood(dir: string): Promise<void> {
  await Promise.all([
    rm(join(dir, LKG_BINARY_NAME), { force: true }).catch(() => undefined),
    rm(join(dir, LKG_META_NAME), { force: true }).catch(() => undefined)
  ])
}

/** A log line that names what was saved, without assuming a version exists. */
export function describeSavedRollback(
  log: Logger,
  status: YtDlpRollbackStatus
): void {
  log.info('saved the previous yt-dlp binary', {
    version: status.version,
    savedAt: status.savedAt
  })
}
