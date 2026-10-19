import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, unlinkSync } from 'node:fs'
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
    resolve: (trackId: number) => void
    reject: (error: Error) => void
  }> = []
  /** In-flight or queued saves, so two clicks on one row download it once. */
  private readonly jobs = new Map<string, Promise<number>>()
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

    const promise = new Promise<number>((resolve, reject) => {
      this.queue.push({ request, resolve, reject })
      this.emit(request.videoId, 'queued', null)
      this.pump()
    }).finally(() => {
      this.jobs.delete(request.videoId)
    })

    this.jobs.set(request.videoId, promise)
    return promise
  }

  dispose(): void {
    this.abort.abort()
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
      void this.run(job.request)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.running -= 1
          this.pump()
        })
    }
  }

  private async run(request: SaveToLibraryRequest): Promise<number> {
    const { repo, library, paths, settings, log } = this.deps

    const already = repo.findByOrigin('youtube', request.videoId)
    if (already) {
      this.emit(request.videoId, 'saved', 100, null, already.id)
      return already.id
    }

    const root = this.downloadRoot()
    const tempDir = join(paths.downloads, randomUUID())

    try {
      mkdirSync(tempDir, { recursive: true })
      const format = settings.get().retention.downloadFormat
      this.emit(request.videoId, 'downloading', 0)

      const downloaded = await this.deps.ytDlp.download(request.videoId, {
        quality: settings.get().retention.qualityTier,
        format,
        outputTemplate: join(tempDir, `${request.videoId}.%(ext)s`),
        signal: this.abort.signal,
        onProgress: (percent) => this.emit(request.videoId, 'downloading', percent)
      })

      if (this.abort.signal.aborted) throw new Error('Saving was cancelled because the app is closing.')
      this.emit(request.videoId, 'finishing', 100)

      const extension = extname(downloaded).replace(/^\./, '') || format
      const parts = savePathParts(request)
      const stem = parts[parts.length - 1] ?? request.videoId
      const folderParts = parts.slice(0, -1)
      const targetFolder = join(root, ...folderParts)
      mkdirSync(targetFolder, { recursive: true })

      const target = uniquePath(join(targetFolder, `${stem}.${extension}`))
      moveFile(downloaded, target)

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
      log.warn('save failed', { videoId: request.videoId, error: message })
      this.emit(request.videoId, 'failed', null, message, null)
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
