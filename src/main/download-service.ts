import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, unlinkSync } from 'node:fs'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Logger } from '@core/logging/logger'
import type { SettingsService } from '@core/settings/settings-service'
import type { LibraryService } from '@core/library/library-service'
import type { TrackRepository } from '@core/library/track-repository'
import { localContentKey, normalizePath } from '@core/library/content-key'
import type { YtDlpClient } from '@engine/sidecar/yt-dlp'
import { isYouTubeVideoId } from '@shared/youtube'
import { savePathParts } from '@shared/files'
import type { AppPaths, DownloadProgress, SaveToLibraryRequest } from '@shared/types'

export interface DownloadServiceDeps {
  settings: SettingsService
  paths: AppPaths
  repo: TrackRepository
  library: LibraryService
  ytDlp: Pick<YtDlpClient, 'download'>
  /** `app.getPath('music')`, so core never has to know about Electron. */
  musicDir: string
  log: Logger
  onChange: (progress: DownloadProgress) => void
}

/** How long to wait for a scan that was already running when the file landed. */
const INDEX_WAIT_MS = 45_000
const INDEX_POLL_MS = 500

/**
 * Saves a stream to the library.
 *
 * The work is deliberately serialised per track and capped by
 * `engine.downloadConcurrency`: YouTube throttles bursts, each download is a
 * yt-dlp process, and a "Save all" on a 50-track mix must not start 50 of them.
 *
 * The file is downloaded to a temporary folder inside the app's data, tagged and
 * given a cover by yt-dlp, then moved into the user's music folder and indexed by
 * the ordinary scanner. Keeping the final file a normal local file is the point:
 * it plays offline, works with every existing view, and survives a cache wipe.
 */
export class DownloadService {
  private readonly queue: Array<{
    request: SaveToLibraryRequest
    controller: AbortController
    resolve: (trackId: number) => void
    reject: (error: Error) => void
  }> = []
  /** In-flight or queued saves, so two clicks on one row download it once. */
  private readonly jobs = new Map<string, Promise<number>>()
  /** One controller per video, so Cancel stops that save and not the app. */
  private readonly controllers = new Map<string, AbortController>()
  private running = 0
  private readonly abort = new AbortController()

  constructor(private readonly deps: DownloadServiceDeps) {}

  /** Saves one track, or returns the row of a video that is already saved. */
  save(request: SaveToLibraryRequest): Promise<number> {
    if (!isYouTubeVideoId(request.videoId)) {
      return Promise.reject(new Error('That link has no usable video id.'))
    }
    if (request.title.trim().length === 0) {
      return Promise.reject(new Error('That track has no title to save it under.'))
    }

    const pending = this.jobs.get(request.videoId)
    if (pending) return pending

    const controller = new AbortController()
    const promise = new Promise<number>((resolve, reject) => {
      this.queue.push({ request, controller, resolve, reject })
      this.emit(request.videoId, 'queued', null)
      this.pump()
    }).finally(() => {
      this.jobs.delete(request.videoId)
      this.controllers.delete(request.videoId)
    })

    this.jobs.set(request.videoId, promise)
    this.controllers.set(request.videoId, controller)
    return promise
  }

  /**
   * Stops one save, queued or running.
   *
   * A queued job has no process to kill, so it is taken out of the queue and
   * rejected at once. A running one is aborted through the controller the
   * download path already accepts; its `run` reports the cancellation and lets
   * the next queued save start.
   */
  cancel(videoId: string): void {
    const controller = this.controllers.get(videoId)
    if (!controller) return

    const queuedIndex = this.queue.findIndex((job) => job.request.videoId === videoId)
    if (queuedIndex >= 0) {
      const [job] = this.queue.splice(queuedIndex, 1)
      if (!job) return
      job.controller.abort()
      this.emit(videoId, 'cancelled', null)
      job.reject(new Error('Saving was cancelled.'))
      return
    }

    // In flight: the rejection is produced by the download's abort listener.
    controller.abort()
  }

  dispose(): void {
    this.abort.abort()
    for (const controller of this.controllers.values()) controller.abort()
    for (const job of this.queue.splice(0)) {
      job.reject(new Error('Saving was cancelled because the app is closing.'))
    }
  }

  private pump(): void {
    const limit = Math.max(1, Math.min(4, this.deps.settings.get().engine.downloadConcurrency))
    while (this.running < limit && this.queue.length > 0) {
      const job = this.queue.shift()
      if (!job) return
      this.running += 1
      void this.run(job.request, job.controller)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.running -= 1
          this.pump()
        })
    }
  }

  private async run(request: SaveToLibraryRequest, controller: AbortController): Promise<number> {
    const { repo, library, paths, settings, log } = this.deps

    const already = repo.findByOrigin('youtube', request.videoId)
    if (already) {
      this.emit(request.videoId, 'saved', 100, null, already.id)
      return already.id
    }

    const root = this.downloadRoot()
    const tempDir = join(paths.downloads, randomUUID())
    // Closing the app and pressing Cancel are different reasons but the same
    // mechanism, so one signal covers both for the sidecar process.
    const signal = AbortSignal.any([this.abort.signal, controller.signal])
    // Once the file is inside the library it is no longer cancellable: deleting
    // a finished download because indexing was slow would lose the user's work.
    let moved = false

    try {
      mkdirSync(tempDir, { recursive: true })
      const format = settings.get().retention.downloadFormat
      this.emit(request.videoId, 'downloading', 0)

      const downloaded = await this.deps.ytDlp.download(request.videoId, {
        quality: settings.get().retention.qualityTier,
        format,
        outputTemplate: join(tempDir, `${request.videoId}.%(ext)s`),
        signal,
        onProgress: (percent) => this.emit(request.videoId, 'downloading', percent)
      })

      if (signal.aborted) throw new Error('Saving was cancelled.')
      this.emit(request.videoId, 'finishing', 100)

      const extension = extname(downloaded).replace(/^\./, '') || format
      const parts = savePathParts(request)
      const stem = parts[parts.length - 1] ?? request.videoId
      const folderParts = parts.slice(0, -1)
      const targetFolder = join(root, ...folderParts)
      mkdirSync(targetFolder, { recursive: true })

      const target = uniquePath(join(targetFolder, `${stem}.${extension}`))
      moveFile(downloaded, target)
      moved = true

      // The folder becomes a library folder the first time anything is saved into
      // it. Adding it is idempotent and does not scan; the scan below indexes the
      // new file along with anything else that changed.
      library.addFolder(root)
      this.emit(request.videoId, 'indexing', 100, null, null)
      await library.scanWhenIdle()

      const key = localContentKey(target)
      let trackId = repo.existingFileState([key]).get(key)?.id ?? null
      if (trackId === null) trackId = await this.waitForRow(key)

      if (trackId === null) {
        throw new Error(
          'The file was saved, but the library has not indexed it yet. It will appear after the next scan.'
        )
      }

      // The tag normally carries the URL, but the downloader knows it first-hand
      // and must not depend on a tag surviving a conversion.
      repo.setOrigin(trackId, 'youtube', request.videoId)
      const track = repo.getById(trackId)
      if (!track) throw new Error('The saved file could not be read back from the library.')

      log.info('track saved', { videoId: request.videoId, trackId, bytes: track.fileSize, codec: track.codec })
      this.emit(request.videoId, 'saved', 100, null, trackId)
      return trackId
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save this track.'
      if (signal.aborted && !moved) {
        log.info('save cancelled', { videoId: request.videoId, closing: this.abort.signal.aborted })
        this.emit(request.videoId, 'cancelled', null, null, null)
      } else {
        log.warn('save failed', { videoId: request.videoId, error: message })
        this.emit(request.videoId, 'failed', null, message, null)
      }
      // Once the file is in the library folder it is left there even if indexing
      // failed: the next scan will pick it up, and deleting a complete download
      // because a scan was slow would lose work the user asked for.
      throw error instanceof Error ? error : new Error(message)
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true })
      } catch {
        // The next start-up's janitor can clean the temp folder.
      }
    }
  }

  private downloadRoot(): string {
    const configured = this.deps.settings.get().retention.downloadFolder
    const folder = configured && configured.trim().length > 0 ? configured : join(this.deps.musicDir, 'Player')
    return normalizePath(folder)
  }

  /**
   * Waits for a scan that was already in flight to index the new file.
   *
   * `scanWhenIdle` queues a rescan when one is running, so the row is coming —
   * this only has to outlast a large first scan, not re-scan anything itself.
   */
  private async waitForRow(key: string): Promise<number | null> {
    const deadline = Date.now() + INDEX_WAIT_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, INDEX_POLL_MS))
      const state = this.deps.repo.existingFileState([key]).get(key)
      if (state) return state.id
    }
    return null
  }

  private emit(
    videoId: string,
    status: DownloadProgress['status'],
    percent: number | null,
    error: string | null = null,
    trackId: number | null = null
  ): void {
    this.deps.onChange({ videoId, status, percent, error, trackId })
  }
}

/** A temp folder this service itself created: a bare UUID under `downloads/`. */
const TEMP_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Deletes what a crashed or force-quit download left behind.
 *
 * Each save works in a UUID folder under `downloads/` and removes it in a
 * `finally`. A process that is killed never reaches that branch, so the next
 * start sweeps the folder. Only UUID-named folders and `*.part` files are
 * touched: anything else in that directory was put there by someone else and is
 * not this service's to delete.
 */
export function cleanupAbandonedDownloads(root: string, log: Logger): number {
  let removed = 0
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const candidate = join(root, entry.name)
      const isTempFolder = entry.isDirectory() && TEMP_FOLDER.test(entry.name)
      const isPartial = entry.isFile() && entry.name.endsWith('.part')
      if (!isTempFolder && !isPartial) continue
      try {
        rmSync(candidate, { recursive: true, force: true })
        removed += 1
      } catch (error) {
        log.warn('could not remove abandoned download', { path: candidate, error })
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('could not sweep the downloads folder', error)
    }
  }
  if (removed > 0) log.info('swept abandoned download files', { removed, root })
  return removed
}

/**
 * A path whose name is not taken.
 *
 * Two different videos by the same artist can legitimately share a title, and a
 * second copy of the same video should not overwrite the first. Anything saved
 * twice on purpose gets ` (2)`, ` (3)`, and so on.
 */
function uniquePath(path: string): string {
  if (!existsSync(path)) return path
  const extension = extname(path)
  const stem = path.slice(0, path.length - extension.length)
  for (let copy = 2; copy < 100; copy += 1) {
    const candidate = `${stem} (${copy})${extension}`
    if (!existsSync(candidate)) return candidate
  }
  return `${stem} (${Date.now()})${extension}`
}

/** Moves a file, falling back to copy+rename across volumes. */
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to)
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
  }

  // A copy is not atomic on its own, so it lands as `.part` and is renamed into
  // place. A crash then leaves a partial temp file, never a half-written track.
  const partial = `${to}.part`
  copyFileSync(from, partial)
  renameSync(partial, to)
  unlinkSync(from)
}
