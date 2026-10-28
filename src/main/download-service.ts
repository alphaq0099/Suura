import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Logger } from '@core/logging/logger'
import type { SettingsService } from '@core/settings/settings-service'
import type { LibraryService } from '@core/library/library-service'
import type { TrackRepository } from '@core/library/track-repository'
import type { DownloadHistoryRepository } from '@core/library/download-history-repository'
import { isPathInside, localContentKey, normalizePath } from '@core/library/content-key'
import { freeBytesFor } from '@core/disk-space'
import type { YtDlpClient } from '@engine/sidecar/yt-dlp'
import { isYouTubeVideoId } from '@shared/youtube'
import { savePathParts } from '@shared/files'
import { formatBytes } from '@shared/format'
import { extensionForAudioMime } from './stream-cache'
import type { AppPaths, DownloadProgress, SaveToLibraryRequest } from '@shared/types'

export interface DownloadServiceDeps {
  settings: SettingsService
  paths: AppPaths
  repo: TrackRepository
  library: LibraryService
  history: DownloadHistoryRepository
  ytDlp: Pick<YtDlpClient, 'download'>
  /** `app.getPath('music')`, so core never has to know about Electron. */
  musicDir: string
  log: Logger
  onChange: (progress: DownloadProgress) => void
  /** The last resolved size for a video, or null. See `YouTubeResolver.cachedFileSize`. */
  fileSizeHint?: (videoId: string) => number | null
  /** Injected by the smoke tests so a full disk can be simulated. */
  freeBytes?: (path: string) => Promise<number | null>
}

/** How long to wait for a scan that was already running when the file landed. */
const INDEX_WAIT_MS = 45_000
const INDEX_POLL_MS = 500

/**
 * Space kept free on both the temporary and target volumes.
 *
 * A track's size is known only when the resolver happened to cache it. The
 * reserve covers conversion, tag writing and the cover image, and keeps a save
 * from filling the disk so completely that the library scan cannot run.
 */
const SPACE_RESERVE_BYTES = 256 * 1024 * 1024

/** Used when no sidecar size is cached; a long Opus track is well under this. */
const FALLBACK_TRACK_BYTES = 24 * 1024 * 1024

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
interface QueuedSave {
  request: SaveToLibraryRequest
  controller: AbortController
  /** Created once and reused by a pause/resume, so the `.part` file survives. */
  tempDir: string
  /**
   * Bytes already on disk, such as a completed stream cache entry.
   *
   * A promotion copies these instead of invoking yt-dlp. The copy still goes
   * through the ordinary temp -> library -> scan path, so the result is an
   * ordinary local track rather than a special kind of download.
   */
  cached?: { sourcePath: string; mimeType: string }
  resolve: (trackId: number) => void
  reject: (error: Error) => void
}

interface ActiveSave {
  request: SaveToLibraryRequest
  controller: AbortController
  tempDir: string
  status: DownloadProgress['status']
  percent: number | null
}

interface PausedSave {
  request: SaveToLibraryRequest
  tempDir: string
  percent: number | null
}

export class DownloadService {
  private readonly queue: QueuedSave[] = []
  /** In-flight or queued saves, so two clicks on one row download it once. */
  private readonly jobs = new Map<string, Promise<number>>()
  /** One controller per video, so Cancel stops that save and not the app. */
  private readonly controllers = new Map<string, AbortController>()
  /** Metadata for the history row, kept while a save is queued or running. */
  private readonly requests = new Map<string, SaveToLibraryRequest>()
  /** The save currently holding a download slot. */
  private readonly active = new Map<string, ActiveSave>()
  /** Paused saves whose UUID temp folder is deliberately kept. */
  private readonly paused = new Map<string, PausedSave>()
  /** Distinguishes a user pause from a cancel/close when the abort arrives. */
  private readonly pauseRequests = new Set<string>()
  /** Resume pressed before the paused job's abort finished unwinding. */
  private readonly pendingResume = new Set<string>()
  private running = 0
  private readonly abort = new AbortController()

  constructor(private readonly deps: DownloadServiceDeps) {}

  /** Saves one track, or returns the row of a video that is already saved. */
  save(request: SaveToLibraryRequest): Promise<number> {
    const invalid = this.invalidRequest(request)
    if (invalid) return Promise.reject(invalid)

    const pending = this.jobs.get(request.videoId)
    if (pending) return pending

    // Retrying a paused row goes through Save in some views. Reusing its folder
    // is what turns that into a resume rather than a second transfer.
    const paused = this.paused.get(request.videoId)
    if (paused) {
      this.paused.delete(request.videoId)
      this.pauseRequests.delete(request.videoId)
      return this.start(request, paused.tempDir)
    }

    return this.start(request, join(this.deps.paths.downloads, randomUUID()))
  }

  /**
   * Promotes a completed cache file into the library.
   *
   * The bytes are copied locally and then follow the same indexing and origin
   * path as a download, so there is no second network request and no separate
   * notion of a "downloaded" track. If a normal save for the same video is
   * already in flight, that promise is reused instead of racing it.
   */
  saveFromCache(
    request: SaveToLibraryRequest,
    sourcePath: string,
    mimeType: string
  ): Promise<number> {
    const invalid = this.invalidRequest(request)
    if (invalid) return Promise.reject(invalid)
    if (!existsSync(sourcePath)) {
      return Promise.reject(new Error('That cached file is no longer on disk.'))
    }

    const pending = this.jobs.get(request.videoId)
    if (pending) return pending
    // A paused download has a partial file that must be resumed, not replaced
    // by a cache copy; Save's ordinary path already knows how to do that.
    if (this.paused.has(request.videoId)) return this.save(request)

    return this.start(
      request,
      join(this.deps.paths.downloads, randomUUID()),
      { sourcePath, mimeType }
    )
  }

  private invalidRequest(request: SaveToLibraryRequest): Error | null {
    if (!isYouTubeVideoId(request.videoId)) {
      return new Error('That link has no usable video id.')
    }
    if (request.title.trim().length === 0) {
      return new Error('That track has no title to save it under.')
    }
    return null
  }

  private start(
    request: SaveToLibraryRequest,
    tempDir: string,
    cached?: { sourcePath: string; mimeType: string }
  ): Promise<number> {
    const videoId = request.videoId
    const controller = new AbortController()
    this.requests.set(videoId, request)
    const promise = new Promise<number>((resolve, reject) => {
      this.queue.push({ request, controller, tempDir, cached, resolve, reject })
      this.emit(videoId, 'queued', null)
      this.pump()
    }).finally(() => {
      if (this.jobs.get(videoId) === promise) this.jobs.delete(videoId)
      if (this.controllers.get(videoId) === controller) this.controllers.delete(videoId)
      this.requests.delete(videoId)
      // Resume can be pressed between Pause's event and the aborted job's
      // promise settling. Deferring it here is what keeps that click from being
      // silently dropped.
      if (this.pendingResume.delete(videoId)) {
        const paused = this.paused.get(videoId)
        if (paused && !this.jobs.has(videoId)) {
          this.paused.delete(videoId)
          this.pauseRequests.delete(videoId)
          void this.start(paused.request, paused.tempDir).catch(() => undefined)
        }
      }
    })

    this.jobs.set(videoId, promise)
    this.controllers.set(videoId, controller)
    return promise
  }

  /**
   * Stops one save, queued or running.
   *
   * A queued job has no process to kill, so it is taken out of the queue and
   * rejected at once. A running one is aborted through the controller the
   * download path already accepts; its `run` reports the cancellation and lets
   * the next queued save start. A paused save is discarded along with its
   * partial file, because there is no process left to stop.
   */
  cancel(videoId: string): void {
    const paused = this.paused.get(videoId)
    if (paused) {
      this.paused.delete(videoId)
      this.pauseRequests.delete(videoId)
      this.pendingResume.delete(videoId)
      this.removeTemp(paused.tempDir)
      this.requests.set(videoId, paused.request)
      this.emit(videoId, 'cancelled', null)
      this.requests.delete(videoId)
      return
    }

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
    this.pauseRequests.delete(videoId)
    controller.abort()
  }

  /**
   * Pauses a running transfer and keeps its UUID folder.
   *
   * Only an actively downloading save can pause: a queued one has nothing to
   * continue, and a file already being indexed must not be abandoned. The abort
   * is the same mechanism Cancel uses, so `run` decides from `pauseRequests`
   * whether to delete the partial file.
   */
  pause(videoId: string): boolean {
    const active = this.active.get(videoId)
    if (!active || active.status !== 'downloading') return false
    this.paused.set(videoId, {
      request: active.request,
      tempDir: active.tempDir,
      percent: active.percent
    })
    this.pauseRequests.add(videoId)
    this.emit(videoId, 'paused', active.percent)
    active.controller.abort()
    return true
  }

  /** Starts a paused save again from the folder its first attempt kept. */
  resume(videoId: string): boolean {
    const paused = this.paused.get(videoId)
    if (!paused) return false
    if (this.jobs.has(videoId)) {
      // The abort is still unwinding; `start`'s finally picks this up.
      this.pendingResume.add(videoId)
      return true
    }
    this.paused.delete(videoId)
    this.pauseRequests.delete(videoId)
    void this.start(paused.request, paused.tempDir).catch(() => undefined)
    return true
  }

  /**
   * Deletes a saved download and leaves a streaming library row behind.
   *
   * The row is marked missing rather than deleted: playlists and the restored
   * queue hold foreign keys to it, and its YouTube origin is what lets playback
   * fall back to the stream. The history row becomes `removed`, so the Downloads
   * screen can offer Save again after the file is gone. Deletion is restricted
   * to a configured library folder; a corrupt or hand-edited path must not turn
   * this into an arbitrary file delete.
   */
  removeDownload(videoId: string): boolean {
    if (this.active.has(videoId) || this.queue.some((job) => job.request.videoId === videoId)) {
      throw new Error('Pause or cancel this download before removing it.')
    }

    const paused = this.paused.get(videoId)
    if (paused) {
      this.paused.delete(videoId)
      this.pauseRequests.delete(videoId)
      this.pendingResume.delete(videoId)
      this.removeTemp(paused.tempDir)
    }

    const track = this.deps.repo.findByOriginIncludingMissing('youtube', videoId)
    const history = this.deps.history.get(videoId)
    if (!track && !history) return false

    if (track?.filePath) {
      const filePath = normalizePath(track.filePath)
      const folders = this.deps.settings.get().libraryFolders
      const allowed = folders.some((folder) => isPathInside(normalizePath(folder), filePath))
      if (!allowed) {
        throw new Error('That file is outside the library folders, so it was not deleted.')
      }
      if (existsSync(filePath)) {
        try {
          unlinkSync(filePath)
        } catch (error) {
          throw new Error(
            `Could not delete the saved file: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }
    }

    if (track) this.deps.repo.markMissingById(track.id, Date.now())
    this.emitRemoved(videoId, track?.id ?? history?.trackId ?? null)
    return true
  }

  dispose(): void {
    this.abort.abort()
    for (const controller of this.controllers.values()) controller.abort()
    for (const job of this.queue.splice(0)) {
      job.reject(new Error('Saving was cancelled because the app is closing.'))
    }
    for (const paused of this.paused.values()) this.removeTemp(paused.tempDir)
    this.paused.clear()
    this.pendingResume.clear()
  }

  private removeTemp(tempDir: string): void {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // The start-up janitor removes a UUID folder that could not be deleted.
    }
  }

  private pump(): void {
    const limit = Math.max(1, Math.min(4, this.deps.settings.get().engine.downloadConcurrency))
    while (this.running < limit && this.queue.length > 0) {
      const job = this.queue.shift()
      if (!job) return
      this.running += 1
      void this.run(job)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.running -= 1
          this.pump()
        })
    }
  }

  private async run(job: QueuedSave): Promise<number> {
    const { request, controller, tempDir } = job
    const { repo, library, settings, log } = this.deps
    const active: ActiveSave = {
      request,
      controller,
      tempDir,
      status: 'queued',
      percent: null
    }
    this.active.set(request.videoId, active)

    const already = repo.findByOrigin('youtube', request.videoId)
    if (already) {
      this.active.delete(request.videoId)
      this.emit(request.videoId, 'saved', 100, null, already.id)
      return already.id
    }

    const root = this.downloadRoot()
    // Closing the app and pressing Cancel are different reasons but the same
    // mechanism, so one signal covers both for the sidecar process.
    const signal = AbortSignal.any([this.abort.signal, controller.signal])
    // Once the file is inside the library it is no longer cancellable: deleting
    // a finished download because indexing was slow would lose the user's work.
    let moved = false
    let keepTemp = false

    try {
      const cachedBytes = job.cached
        ? statSync(job.cached.sourcePath, { throwIfNoEntry: false })?.size ?? null
        : undefined
      await this.assertDiskSpace(request.videoId, root, cachedBytes)
      mkdirSync(tempDir, { recursive: true })
      const format = settings.get().retention.downloadFormat
      let downloaded: string
      if (job.cached) {
        // No transfer is involved, so this is a finishing step from the first
        // event. It is deliberately not `downloading`: Pause has no meaning for
        // a local copy that is already complete.
        const extension =
          extname(job.cached.sourcePath).replace(/^\./, '') ||
          extensionForAudioMime(job.cached.mimeType)
        downloaded = join(tempDir, `${request.videoId}.${extension}`)
        copyFileSync(job.cached.sourcePath, downloaded)
        if (signal.aborted) throw new Error('Saving was cancelled.')
      } else {
        this.emit(request.videoId, 'downloading', 0)
        downloaded = await this.deps.ytDlp.download(request.videoId, {
          quality: settings.get().retention.qualityTier,
          format,
          outputTemplate: join(tempDir, `${request.videoId}.%(ext)s`),
          signal,
          onProgress: (progress) =>
            this.emit(
              request.videoId,
              'downloading',
              progress.percent,
              null,
              null,
              progress.speedBytesPerSecond,
              progress.etaSeconds
            )
        })
      }

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
      const paused =
        signal.aborted && !moved && !this.abort.signal.aborted && this.pauseRequests.has(request.videoId)
      if (paused) {
        // `pause` already emitted this status and kept the folder; this branch
        // must not turn the user's decision into a cancellation.
        keepTemp = true
        log.info('save paused', { videoId: request.videoId })
        throw new Error('Saving was paused.')
      }
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
      this.pauseRequests.delete(request.videoId)
      this.active.delete(request.videoId)
      if (!keepTemp) this.removeTemp(tempDir)
    }
  }

  private downloadRoot(): string {
    const configured = this.deps.settings.get().retention.downloadFolder
    const folder = configured && configured.trim().length > 0 ? configured : join(this.deps.musicDir, 'Suura')
    return normalizePath(folder)
  }

  /**
   * Refuses a save that cannot fit on both volumes it touches.
   *
   * The temporary file and the final file may be on different volumes, so both
   * are checked. `fileSizeHint` is the resolver's cached estimate; when there is
   * none the fallback is deliberately generous. A platform that cannot report
   * free space (null) is allowed through rather than blocked.
   */
  private async assertDiskSpace(
    videoId: string,
    targetRoot: string,
    knownBytes?: number | null
  ): Promise<void> {
    const hint =
      knownBytes !== undefined ? knownBytes : this.deps.fileSizeHint?.(videoId) ?? null
    const needed = (hint !== null && hint > 0 ? hint : FALLBACK_TRACK_BYTES) + SPACE_RESERVE_BYTES
    const free = this.deps.freeBytes ?? freeBytesFor
    const [tempFree, targetFree] = await Promise.all([
      free(this.deps.paths.downloads),
      free(targetRoot)
    ])

    const short = (label: string, bytes: number): Error =>
      new Error(
        `Not enough free space on the ${label} volume to save this track: ` +
          `${formatBytes(bytes)} available, about ${formatBytes(needed)} needed. ` +
          'Free up some space and try again.'
      )

    if (tempFree !== null && tempFree < needed) throw short('temporary', tempFree)
    if (targetFree !== null && targetFree < needed) throw short('library', targetFree)
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
    trackId: number | null = null,
    speedBytesPerSecond: number | null = null,
    etaSeconds: number | null = null
  ): void {
    const progress: DownloadProgress = {
      videoId,
      status,
      percent,
      error,
      trackId,
      speedBytesPerSecond,
      etaSeconds
    }
    const active = this.active.get(videoId)
    if (active) {
      active.status = status
      active.percent = percent
    }
    this.deps.onChange(progress)
    try {
      this.deps.history.record(progress, this.requests.get(videoId) ?? null)
    } catch (historyError) {
      // The screen is still correct if persistence fails; losing the save
      // because its history row could not be written is not an acceptable trade.
      this.deps.log.warn('could not record download history', { videoId, error: historyError })
    }
  }

  /** Records a file removal without inventing a save request or a percentage. */
  private emitRemoved(videoId: string, trackId: number | null): void {
    const progress: DownloadProgress = {
      videoId,
      status: 'removed',
      percent: null,
      error: null,
      trackId,
      speedBytesPerSecond: null,
      etaSeconds: null
    }
    this.deps.onChange(progress)
    try {
      this.deps.history.record(progress, null)
    } catch (historyError) {
      this.deps.log.warn('could not record removed download', { videoId, error: historyError })
    }
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
