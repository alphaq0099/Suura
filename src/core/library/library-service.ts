import type { LibraryStats, ListTracksQuery, ScanProgress, Track, TrackPage } from '@shared/types'
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

  /** Removes a folder and forgets every track that lived inside it. */
  removeFolder(folder: string, options: { deleteTracks?: boolean } = {}): void {
    const normalized = normalizePath(folder)
    const folders = this.folders().filter((entry) => entry !== normalized)
    this.settings.update({ libraryFolders: folders })
    this.repo.removeLibraryFolder(normalized)
    if (options.deleteTracks ?? true) {
      const removed = this.repo.pruneMissing([normalized], new Set())
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
    }
  }

  cancelScan(): void {
    if (!this.activeScan) return
    this.log.info('scan cancelled by user')
    this.activeScan.abort()
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
