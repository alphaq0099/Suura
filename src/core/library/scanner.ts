import { opendir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ScanProgress } from '@shared/types'
import { isAudioFile } from '@shared/mime'
import { localContentKey } from './content-key'
import { extractMetadata } from './metadata'
import type { TrackRepository, TrackWriteInput } from './track-repository'
import type { Logger } from '../logging/logger'

const SKIP_DIRECTORIES = new Set(['$recycle.bin', 'system volume information', 'node_modules', '$windows.~ws'])
const MAX_DEPTH = 32
/** Tag reads per parallel batch. Reads are I/O bound; writes are transactional. */
const BATCH_SIZE = 250

export interface ScanOptions {
  folders: string[]
  repo: TrackRepository
  log: Logger
  onProgress?: (progress: ScanProgress) => void
  signal?: AbortSignal
  /** Delete rows whose files disappeared during a complete scan. */
  prune?: boolean
}

export interface ScanResult {
  progress: ScanProgress
  aborted: boolean
}

interface CandidateFile {
  filePath: string
  size: number
  mtimeMs: number
}

interface ReadOutcome {
  entry: CandidateFile
  input: TrackWriteInput | null
  error: unknown
}

/**
 * Indexes every audio file under `folders`.
 *
 * Two things make this affordable on a real library:
 *  1. files whose size and mtime already match the database are never opened,
 *  2. tag reads run in parallel batches, and each batch is written in one
 *     transaction, so a 10k-file scan is a few hundred fsyncs instead of 10k.
 */
export async function scanLibraryFolders(options: ScanOptions): Promise<ScanResult> {
  const { folders, repo, log, onProgress, signal } = options

  const progress: ScanProgress = {
    phase: 'enumerating',
    filesSeen: 0,
    indexed: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    pruned: 0,
    currentFile: null,
    folder: null,
    startedAt: Date.now(),
    finishedAt: null
  }

  let lastEmit = 0
  const emit = (force = false): void => {
    if (!onProgress) return
    const now = Date.now()
    if (!force && now - lastEmit < 120) return
    lastEmit = now
    onProgress({ ...progress })
  }

  const candidates: CandidateFile[] = []
  const seenKeys = new Set<string>()
  /** Folders we could not fully enumerate; excluded from pruning. */
  const failedFolders = new Set<string>()

  for (const folder of folders) {
    if (signal?.aborted) break
    progress.folder = folder
    emit(true)
    try {
      await enumerate(folder, 0, candidates, seenKeys, progress, emit, signal)
    } catch (error) {
      log.warn('could not enumerate folder', { folder, error })
      failedFolders.add(folder)
    }
  }

  progress.phase = 'reading'
  progress.folder = null
  emit(true)

  const existing = repo.existingFileState([...seenKeys])

  // Drop unchanged files before reading any tags.
  const toRead: CandidateFile[] = []
  for (const candidate of candidates) {
    const state = existing.get(localContentKey(candidate.filePath))
    if (state && state.fileSize === candidate.size && state.fileMtimeMs === candidate.mtimeMs) {
      progress.skipped += 1
      continue
    }
    toRead.push(candidate)
  }
  emit(true)

  for (let offset = 0; offset < toRead.length; offset += BATCH_SIZE) {
    if (signal?.aborted) break
    const batch = toRead.slice(offset, offset + BATCH_SIZE)

    const outcomes = await Promise.all(
      batch.map(async (entry): Promise<ReadOutcome> => {
        try {
          const metadata = await extractMetadata(entry.filePath)
          const input: TrackWriteInput = {
            contentKey: localContentKey(entry.filePath),
            sourceKind: 'local',
            sourceId: null,
            ...metadata,
            fileSize: entry.size,
            fileMtimeMs: entry.mtimeMs,
            filePath: entry.filePath
          }
          return { entry, input, error: null }
        } catch (error) {
          return { entry, input: null, error }
        }
      })
    )

    const writes: Array<{ existingId: number | null; input: TrackWriteInput }> = []
    for (const outcome of outcomes) {
      if (!outcome.input) {
        progress.failed += 1
        log.warn('skipping unreadable file', { filePath: outcome.entry.filePath, error: outcome.error })
        continue
      }
      const state = existing.get(outcome.input.contentKey)
      writes.push({ existingId: state?.id ?? null, input: outcome.input })
    }

    if (writes.length > 0) {
      const result = repo.writeBatch(writes, Date.now())
      progress.indexed += result.inserted
      progress.updated += result.updated
    }
    progress.currentFile = batch[batch.length - 1]?.filePath ?? null
    emit()
  }

  // Only prune when the walk completed and every folder was readable. A partial
  // scan must never delete rows for files it simply did not get to.
  const aborted = Boolean(signal?.aborted)
  if (options.prune && !aborted && failedFolders.size === 0) {
    const prunableFolders = folders.filter((folder) => !failedFolders.has(folder))
    progress.pruned = repo.pruneMissing(prunableFolders, seenKeys)
  }

  progress.phase = 'done'
  progress.currentFile = null
  progress.finishedAt = Date.now()
  emit(true)

  return { progress, aborted }
}

async function enumerate(
  directory: string,
  depth: number,
  candidates: CandidateFile[],
  seenKeys: Set<string>,
  progress: ScanProgress,
  emit: (force?: boolean) => void,
  signal: AbortSignal | undefined
): Promise<void> {
  if (depth > MAX_DEPTH || signal?.aborted) return

  const handle = await opendir(directory)
  try {
    for await (const entry of handle) {
      if (signal?.aborted) return
      const name = entry.name

      if (entry.isDirectory()) {
        // Hidden and well-known junk directories are skipped; a leading dot is the
        // cross-platform convention for "not user content".
        if (name.startsWith('.') || SKIP_DIRECTORIES.has(name.toLowerCase())) continue
        await enumerate(join(directory, name), depth + 1, candidates, seenKeys, progress, emit, signal)
        continue
      }

      // Symlinks are skipped rather than followed, which avoids cycles.
      if (!entry.isFile()) continue
      if (!isAudioFile(name)) continue

      const filePath = join(directory, name)
      let info
      try {
        info = await stat(filePath)
      } catch {
        // File vanished between readdir and stat; ignore it.
        continue
      }

      candidates.push({ filePath, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) })
      seenKeys.add(localContentKey(filePath))
      progress.filesSeen += 1
      if (progress.filesSeen % 250 === 0) {
        progress.currentFile = filePath
        emit()
      }
    }
  } finally {
    // opendir handles are closed automatically when iteration ends or throws,
    // but an early `return` inside the loop can leave it open on some platforms.
    try {
      await handle.close()
    } catch {
      // Already closed.
    }
  }
}
