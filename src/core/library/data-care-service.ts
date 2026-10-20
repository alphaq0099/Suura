import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { opendir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { isAudioFile } from '@shared/mime'
import type { DuplicateMergeOutcome, DuplicateReport, RelocateReport } from '@shared/types'
import type { Logger } from '../logging/logger'
import type { TrackRepository } from './track-repository'

const HASH_CONCURRENCY = 4
const MAX_DEPTH = 32
const SKIP_DIRECTORIES = new Set([
  '$recycle.bin',
  'system volume information',
  'node_modules',
  '$windows.~ws'
])

/**
 * Library repair that is too expensive to run during an ordinary scan.
 *
 * Duplicate detection reads whole files, so it is explicitly triggered and the
 * hash is cached on the row. A changed file clears the hash when the scanner
 * writes it, which is the cheap invalidation step. Relocation uses the stored
 * hash first, then the size+mtime pair a move preserves.
 */
export class DataCareService {
  constructor(
    private readonly repo: TrackRepository,
    private readonly log: Logger
  ) {}

  async findDuplicates(): Promise<DuplicateReport> {
    const pending = this.repo.localTracksAwaitingHash()
    let hashed = 0
    for (let offset = 0; offset < pending.length; offset += HASH_CONCURRENCY) {
      const batch = pending.slice(offset, offset + HASH_CONCURRENCY)
      const results = await Promise.all(
        batch.map(async (track) => {
          if (!track.filePath) return false
          try {
            const hash = await hashFile(track.filePath)
            this.repo.setFileHash(track.id, hash)
            return true
          } catch (error) {
            this.log.warn('could not fingerprint track', { trackId: track.id, error })
            return false
          }
        })
      )
      hashed += results.filter(Boolean).length
    }

    const groups = this.repo.duplicateGroups()
    return {
      groups: groups.length,
      extraCopies: groups.reduce((sum, group) => sum + group.tracks.length - 1, 0),
      hashed
    }
  }

  /**
   * Merges every group, keeping its oldest row.
   *
   * "Oldest" is the row most likely to own the history: added first, highest
   * play count, already in the most playlists. The redundant files are deleted
   * only after the merge transaction commits; a failed unlink is reported and
   * leaves the row gone, so the next scan can index that file again.
   */
  async mergeDuplicates(): Promise<DuplicateMergeOutcome> {
    const groups = this.repo.duplicateGroups()
    let removed = 0
    let filesRemoved = 0
    let fileErrors = 0
    let mergedGroups = 0
    const now = Date.now()
    for (const group of groups) {
      const keeper = [...group.tracks].sort((a, b) => a.addedAt - b.addedAt || a.id - b.id)[0]
      if (!keeper) continue
      const duplicates = group.tracks.filter((track) => track.id !== keeper.id)
      removed += this.repo.mergeDuplicates(
        keeper.id,
        duplicates.map((track) => track.id),
        now
      )
      for (const duplicate of duplicates) {
        if (!duplicate.filePath) continue
        try {
          await unlink(duplicate.filePath)
          filesRemoved += 1
        } catch (error) {
          fileErrors += 1
          this.log.warn('could not delete merged duplicate file', {
            trackId: duplicate.id,
            filePath: duplicate.filePath,
            error
          })
        }
      }
      mergedGroups += 1
    }
    return { groups: mergedGroups, removed, filesRemoved, fileErrors }
  }

  /**
   * Finds missing rows in `folder` and points them at their files again.
   *
   * Only audio files whose size is one a missing row expects are considered, so
   * a folder full of unrelated music costs a walk, not a hash of every file.
   */
  async relocate(folder: string): Promise<RelocateReport> {
    const missing = this.repo.missingFileStates()
    if (missing.length === 0) return { scanned: 0, relocated: 0, unmatched: 0 }

    const byHash = new Map<string, typeof missing>()
    const bySizeMtime = new Map<string, typeof missing>()
    const sizes = new Set<number>()
    for (const row of missing) {
      if (row.fileHash) {
        const list = byHash.get(row.fileHash) ?? []
        list.push(row)
        byHash.set(row.fileHash, list)
      }
      // A hash is authoritative. Size+mtime is only a fallback for rows that
      // were never fingerprinted, never a way around a hash mismatch.
      if (!row.fileHash && row.fileSize !== null && row.fileMtimeMs !== null) {
        const key = statKey(row.fileSize, row.fileMtimeMs)
        const list = bySizeMtime.get(key) ?? []
        list.push(row)
        bySizeMtime.set(key, list)
      }
      if (row.fileSize !== null) sizes.add(row.fileSize)
    }

    const used = new Set<number>()
    let scanned = 0
    let relocated = 0
    const files: Array<{ filePath: string; size: number; mtimeMs: number }> = []
    await walk(folder, 0, files)

    for (const file of files) {
      scanned += 1
      if (!sizes.has(file.size)) continue

      let match: (typeof missing)[number] | undefined
      if (byHash.size > 0) {
        try {
          const hash = await hashFile(file.filePath)
          match = byHash.get(hash)?.find((row) => !used.has(row.id) && row.fileSize === file.size)
        } catch (error) {
          this.log.warn('could not fingerprint candidate during relocation', {
            filePath: file.filePath,
            error
          })
        }
      }
      match ??= bySizeMtime
        .get(statKey(file.size, file.mtimeMs))
        ?.find((row) => !used.has(row.id))

      if (!match) continue
      try {
        const existing = this.repo.findByFilePath(file.filePath)
        this.repo.relocateTrack(
          match.id,
          existing && existing.id !== match.id ? existing.id : null,
          { filePath: file.filePath, fileSize: file.size, fileMtimeMs: file.mtimeMs },
          Date.now()
        )
        used.add(match.id)
        relocated += 1
      } catch (error) {
        this.log.warn('could not relocate track', { trackId: match.id, filePath: file.filePath, error })
      }
    }

    return { scanned, relocated, unmatched: missing.length - relocated }
  }
}

function statKey(size: number, mtimeMs: number): string {
  return `${size}:${Math.trunc(mtimeMs)}`
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function walk(
  directory: string,
  depth: number,
  out: Array<{ filePath: string; size: number; mtimeMs: number }>
): Promise<void> {
  if (depth > MAX_DEPTH) return
  const handle = await opendir(directory)
  try {
    for await (const entry of handle) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue
        await walk(join(directory, entry.name), depth + 1, out)
      } else if (entry.isFile() && isAudioFile(entry.name)) {
        const filePath = join(directory, entry.name)
        try {
          const info = await stat(filePath)
          out.push({ filePath, size: info.size, mtimeMs: Math.trunc(info.mtimeMs) })
        } catch {
          // The file vanished while walking; it cannot be relocated.
        }
      }
    }
  } finally {
    try {
      await handle.close()
    } catch {
      // Already closed.
    }
  }
}
