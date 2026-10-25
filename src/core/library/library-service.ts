import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  AlbumPage,
  ArtistSummary,
  DroppedPathsResult,
  LibraryStats,
  ListAlbumsQuery,
  ListTracksQuery,
  ScanProgress,
  Track,
  TrackPage
} from '@shared/types'
import { isAudioFile } from '@shared/mime'
import { isPathInside, normalizePath } from './content-key'
import { scanLibraryFolders } from './scanner'
import type { TrackRepository } from './track-repository'
import type { SettingsService } from '../settings/settings-service'
import type { Logger } from '../logging/logger'

export interface LibraryServiceEvents {
  onScanProgress?: (progress: ScanProgress) => void
  onLibraryChanged?: () => void
}

/** A track counts as played once it is finished or has been listened to this long. */
const PLAY_THRESHOLD_MS = 30_000

/**
 * Owns everything about the local library: folders, scanning, querying.
 *
 * `settings.libraryFolders` is the source of truth for *which* folders exist, so
 * that a hand-edited config file still works. The `library_folders` table only
 * carries scan bookkeeping and is kept in sync here.
 */
export class LibraryService {
  private activeScan: AbortController | null = null
  /** Set when a change arrives mid-scan, so the scan is repeated once it ends. */
  private rescanQueued = false

  constructor(
    private readonly repo: TrackRepository,
    private readonly settings: SettingsService,
    private readonly log: Logger,
    private readonly events: LibraryServiceEvents = {}
  ) {}

  isScanning(): boolean {
    return this.activeScan !== null
  }

  folders(): string[] {
    return [...this.settings.get().libraryFolders]
  }

  list(query: ListTracksQuery = {}): TrackPage {
    return this.repo.list(query)
  }

  listAlbums(query: ListAlbumsQuery = {}): AlbumPage {
    return this.repo.listAlbums(query)
  }

  listArtists(limit = 24): ArtistSummary[] {
    return this.repo.listArtists(limit)
  }

  stats(): LibraryStats {
    return this.repo.stats()
  }

  trackById(id: number): Track | null {
    return this.repo.getById(id)
  }

  /** Adds a folder to the library without scanning it. Idempotent. */
  addFolder(folder: string): void {
    const normalized = normalizePath(folder)
    const folders = this.folders()
    if (!folders.includes(normalized)) {
      this.settings.update({ libraryFolders: [...folders, normalized] })
    }
    this.repo.addLibraryFolder(normalized)
    this.emitChanged()
  }

  /**
   * Removes rows from the library without touching the files.
   *
   * Used by the selection bar. A later scan will index the files again, which is
   * the honest behaviour for "remove from the library" rather than "delete the
   * music": the folder remains a source, and the user can hide it deliberately
   * from Settings.
   */
  removeTracks(ids: number[]): number {
    const removed = this.repo.deleteByIds(ids)
    if (removed > 0) {
      this.log.info('tracks removed from the library', { removed })
      this.emitChanged()
    }
    return removed
  }

  /** Removes a folder and forgets every track that lived inside it. */
  removeFolder(folder: string, options: { deleteTracks?: boolean } = {}): void {
    const normalized = normalizePath(folder)
    const folders = this.folders().filter((entry) => entry !== normalized)
    this.settings.update({ libraryFolders: folders })
    this.repo.removeLibraryFolder(normalized)
    if (options.deleteTracks ?? true) {
      const removed = this.repo.deleteInFolders([normalized])
      this.log.info('removed folder and its tracks', { folder: normalized, removed })
    }
    this.emitChanged()
  }

  /**
   * Scans one folder, or the whole library when `folder` is omitted.
   *
   * Pruning (forgetting rows whose files are gone) only happens for a full
   * library scan; a single-folder scan must not delete anything outside it.
   */
  async scan(folder?: string): Promise<LibraryStats> {
    if (this.activeScan) {
      throw new Error('A library scan is already running.')
    }

    const single = folder ? normalizePath(folder) : null
    if (single) this.addFolder(single)

    const folders = single ? [single] : this.folders()
    if (folders.length === 0) {
      throw new Error('No music folders configured yet.')
    }

    const controller = new AbortController()
    this.activeScan = controller
    const runId = this.repo.startScanRun(single)
    this.log.info('scan started', { folders, prune: !single })

    try {
      const { progress, aborted } = await scanLibraryFolders({
        folders,
        repo: this.repo,
        log: this.log,
        signal: controller.signal,
        prune: !single,
        onProgress: (update) => this.events.onScanProgress?.(update)
      })

      this.repo.finishScanRun(runId, {
        indexed: progress.indexed,
        updated: progress.updated,
        skipped: progress.skipped,
        failed: progress.failed,
        pruned: progress.pruned
      })
      const finishedAt = progress.finishedAt ?? Date.now()
      for (const entry of folders) {
        this.repo.markFolderScanned(entry, finishedAt)
      }

      this.log.info('scan finished', {
        aborted,
        indexed: progress.indexed,
        updated: progress.updated,
        skipped: progress.skipped,
        failed: progress.failed,
        pruned: progress.pruned,
        durationMs: finishedAt - progress.startedAt
      })
      return this.stats()
    } finally {
      this.activeScan = null
      this.emitChanged()
      this.drainQueuedRescan()
    }
  }

  cancelScan(): void {
    if (!this.activeScan) return
    this.log.info('scan cancelled by user')
    // A queued repeat is what the *watcher* asked for, not the user, so cancelling
    // has to drop it too: otherwise the scan the user just stopped starts again.
    this.rescanQueued = false
    this.activeScan.abort()
  }

  /**
   * Adds what the user dropped on the window.
   *
   * The library is folder-based, so a dropped audio file is added by scanning
   * its directory. That is a deliberate simplification: indexing one file from
   * an otherwise ignored album would produce a library that changes shape again
   * the moment the folder is scanned, and the drop overlay says so. A dropped
   * non-audio file is rejected instead of quietly adding its parent.
   *
   * Folders already covered by a library root reuse that root rather than
   * creating a nested library entry, and one scan of a parent is enough even if
   * a child folder was dropped alongside it.
   */
  async addDroppedPaths(paths: string[]): Promise<DroppedPathsResult> {
    if (this.activeScan) throw new Error('A library scan is already running.')

    const targets = new Set<string>()
    for (const input of paths) {
      if (typeof input !== 'string' || input.trim().length === 0) continue
      let info: Awaited<ReturnType<typeof stat>>
      try {
        info = await stat(input)
      } catch {
        // A path can vanish between the drop and this call. It is not worth an
        // error when the rest of the drop is still usable.
        continue
      }
      if (info.isDirectory()) targets.add(normalizePath(input))
      else if (info.isFile() && isAudioFile(input)) targets.add(normalizePath(dirname(input)))
    }

    if (targets.size === 0) {
      throw new Error('Drop audio files or folders to add them to the library.')
    }

    // Keep only the outermost dropped folders: scanning an album also covers a
    // disc folder dropped next to it.
    const outermost = [...targets].filter(
      (candidate) =>
        ![...targets].some((other) => other !== candidate && isPathInside(other, candidate))
    )

    const existing = this.folders()
    const folders = [
      ...new Set(
        outermost.map((folder) => existing.find((root) => isPathInside(root, folder)) ?? folder)
      )
    ].sort()

    let stats = this.stats()
    for (const folder of folders) stats = await this.scan(folder)
    return { folders, stats }
  }

  /**
   * Scans, unless one is already running — in which case the scan is queued and
   * runs when the one in flight finishes, so files that changed while it was
   * working are not missed.
   *
   * This is the entry point for automatic scans. A manual scan should call
   * `scan()` and hear about the clash, because a click that silently does nothing
   * is worse than an error; a folder watcher has nobody to tell.
   */
  async scanWhenIdle(): Promise<LibraryStats | null> {
    if (this.activeScan) {
      this.rescanQueued = true
      this.log.debug('a scan is already running; queued one more')
      return null
    }
    return await this.scan()
  }

  /**
   * Runs the queued scan, if any. Called as every scan ends rather than only from
   * `scanWhenIdle`, so a change that lands during a *manual* scan is still picked
   * up — the queue is drained by whichever scan finished last.
   */
  private drainQueuedRescan(): void {
    if (!this.rescanQueued) return
    this.rescanQueued = false
    this.log.debug('rescanning for changes that arrived mid-scan')
    void this.scanWhenIdle().catch((error: unknown) => {
      this.log.warn('queued rescan failed', error)
    })
  }

  /** Called by the player when a track has been played enough to count. */
  reportPlayback(trackId: number, playedMs: number, completed: boolean): void {
    if (!completed && playedMs < PLAY_THRESHOLD_MS) return
    this.repo.incrementPlayCount(trackId, Date.now())
  }

  /** True when `filePath` is inside a configured library folder. */
  isPathAllowed(filePath: string): boolean {
    return this.folders().some((folder) => isPathInside(folder, filePath))
  }

  private emitChanged(): void {
    this.events.onLibraryChanged?.()
  }
}
