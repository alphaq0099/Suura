import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Logger } from '@core/logging/logger'
import type { EngineSettings, QualityTier, YouTubeSearchResult } from '@shared/types'
import {
  describeYouTubeFailure,
  isRetryableYouTubeFailure,
  isSupportedCookieBrowser,
  isYouTubeBotCheck,
  isYouTubeVideoId,
  normalizeArtistName,
  withBrowserCookies,
  withPoTokenProvider,
  youtubeChannelUrl,
  youtubeFormatSelector,
  youtubeWatchUrl
} from '@shared/youtube'
import { locateExecutable, wellKnownDirectories } from './locate'
import { killTree } from './process-tree'
import { RequestScheduler } from './request-scheduler'
import {
  describeSavedRollback,
  isManagedBinary,
  restoreLastKnownGood as restoreSavedBinary,
  saveLastKnownGood,
  ytDlpRollbackStatus
} from './rollback'
import { YouTubeGate } from './youtube-gate'

/**
 * Resolving takes 10-20 s once IPv4 is forced (yt-dlp's own startup is several
 * seconds of that). 40 s covers a slow night without letting a blackholed
 * connection hold the player for minutes.
 */
const DEFAULT_TIMEOUT_MS = 40_000

/** A flat list of 200 entries is several requests on YouTube's side; 60 s is fair. */
const PLAYLIST_TIMEOUT_MS = 60_000

/** A single video's -J JSON is a few hundred KB. Anything past this is not a video. */
const MAX_STDOUT_BYTES = 8 * 1024 * 1024

/** A saved file is minutes of transfer, not seconds of metadata. */
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000

/** Progress is for a row's spinner, not for a graph; 4 Hz is plenty. */
const PROGRESS_INTERVAL_MS = 250

/** Enough to identify the failure without holding a whole yt-dlp transcript. */
const MAX_STDERR_BYTES = 64 * 1024

/**
 * yt-dlp starts are paced.
 *
 * Two metadata requests may run together, but starts are separated by a few
 * hundred milliseconds with jitter. A download can hold its slot for minutes,
 * so it has its own lane; a save must never sit in front of a play request.
 */
const METADATA_CONCURRENCY = 2
const METADATA_GAP_MS = 350
const METADATA_JITTER_MS = 250
const DOWNLOAD_CONCURRENCY = 8
const DOWNLOAD_GAP_MS = 750
const DOWNLOAD_JITTER_MS = 500

/** One retry for a transient network failure, never for a bot check. */
const TRANSIENT_RETRY_DELAY_MS = 2_000
const TRANSIENT_RETRY_JITTER_MS = 1_000
const UPDATE_TIMEOUT_MS = 90_000
const VERSION_TIMEOUT_MS = 15_000

/**
 * Repeated extractor failures that look like a broken release trigger one
 * automatic restore. Three inside ten minutes is not a flaky network, and the
 * previous binary is exactly the thing that was working before the update.
 */
const EXTRACTOR_FAILURE_WINDOW_MS = 10 * 60_000
const EXTRACTOR_FAILURE_LIMIT = 3
const ROLLBACK_COOLDOWN_MS = 30 * 60_000
const EXTRACTOR_BREAKAGE_PATTERN =
  /unable to extract|no video formats found|requested format is not available|nsig extraction failed|signature extraction failed|failed to parse json|unsupported url/i

/**
 * Keep yt-dlp on IPv4.
 *
 * On some Windows networks YouTube resolves to an IPv6 address that blackholes.
 * `--socket-timeout` does not bound the connection attempt, so yt-dlp sits at
 * "Downloading webpage" long past the app's deadline and playback never starts
 * (the process has to be killed). Forcing the family it can reach turns that
 * indefinite hang into a normal ten-to-twenty second resolve. A native IPv6
 * route is rare on the desktop networks this player targets; the option is
 * applied to every network command so a search, a save and a play all agree.
 */
const FORCE_IPV4_ARG = '--force-ipv4'

/** Transport flags every command that reaches YouTube or GitHub must carry. */
export function withNetworkTransport(args: readonly string[]): string[] {
  return [FORCE_IPV4_ARG, ...args]
}

export interface YtMediaInfo {
  videoId: string
  webpageUrl: string
  title: string
  /** The track artist when the extractor reports one, otherwise the channel. */
  artist: string | null
  /** The uploader/channel, kept apart from the artist for YouTube Links. */
  channel: string | null
  durationSec: number | null
  thumbnailUrl: string | null
  formatId: string
  ext: string
  codec: string | null
  bitrateKbps: number | null
  sampleRateHz: number | null
  channels: number | null
  fileSize: number | null
  /** The signed CDN URL. Never leaves the main process. */
  streamUrl: string
  /** The headers that URL needs. Also main-process only. */
  headers: Record<string, string>
  /** Epoch ms parsed from the URL's `expire` parameter, or a conservative guess. */
  expiresAt: number
  mimeType: string
}

/**
 * The part of the client the resolver needs, so tests can answer without a
 * sidecar. Kept narrow on purpose: the resolver has no business spawning things.
 */
export interface YtInfoProvider {
  fetchInfo(videoId: string, quality: QualityTier, signal?: AbortSignal): Promise<YtMediaInfo>
}

/** One entry of a flat playlist listing. Flat means no stream URLs, no formats. */
export interface YtPlaylistEntry {
  videoId: string
  title: string
  artist: string | null
  durationMs: number | null
}

export interface YtPlaylistInfo {
  listId: string
  title: string
  owner: string | null
  /** The count YouTube reports, or null when it reports none (a radio mix). */
  total: number | null
  /** True when entries were left behind: by the cap or by being unplayable. */
  truncated: boolean
  /** Cover candidates, largest first. The first one that decodes is used. */
  coverUrls: string[]
  entries: YtPlaylistEntry[]
}

/**
 * The part of the client an import needs.
 *
 * Separate from `YtInfoProvider` so the Online service can be tested with a fake
 * listing and the resolver never grows a method it does not use.
 */
export interface YtPlaylistProvider {
  fetchPlaylist(url: string, limit: number, signal?: AbortSignal): Promise<YtPlaylistInfo>
}

/** One channel as the discovery view needs it. */
export interface YtChannelInfo {
  channelId: string | null
  name: string
  url: string
  entries: YouTubeSearchResult[]
}

/**
 * Search and channel listings.
 *
 * Both are flat reads: ids and metadata, never a stream URL. That keeps discovery
 * cheap and means a result cannot start playing until it is deliberately opened,
 * which is the same rule pasted links follow.
 */
export interface YtSearchProvider {
  search(query: string, limit: number, offset?: number, signal?: AbortSignal): Promise<YouTubeSearchResult[]>
  channel(target: string, limit: number, offset?: number, signal?: AbortSignal): Promise<YtChannelInfo>
}

/** An expected failure with a message that is safe to show. */
export class YtDlpError extends Error {
  constructor(
    message: string,
    readonly detail: string
  ) {
    super(message)
    this.name = 'YtDlpError'
  }
}

/**
 * The arguments for one resolve, in one place.
 *
 * `--ignore-config` is not optional: a user's `~/.yt-dlp.conf` can add cookies,
 * output templates, archive files and subtitle requests, any of which changes
 * what `-J` returns or writes files this app promised not to write. The sidecar
 * must behave the same on every machine.
 */
export function buildInfoArgs(videoId: string, quality: QualityTier): string[] {
  return [
    '--ignore-config',
    '--no-playlist',
    '--no-progress',
    // The default check probes each candidate format to prove it downloads
    // before returning it. That is a second round trip per resolve, and the
    // stream proxy already turns a dead format into a re-resolve. For a plain
    // audio selector the probe buys little and costs a couple of seconds.
    '--no-check-formats',
    '--socket-timeout',
    '15',
    '-f',
    youtubeFormatSelector(quality),
    '-J',
    youtubeWatchUrl(videoId)
  ]
}

/**
 * The arguments for one playlist listing.
 *
 * `--no-playlist` is deliberately absent: this call *is* the playlist. `--flat`
 * keeps it to one request per page of ids instead of resolving every video, which
 * is the difference between seconds and minutes for a 200-track album. The cap is
 * applied on YouTube's side so a 5,000-track playlist never transfers.
 */
export function buildPlaylistArgs(url: string, limit: number): string[] {
  return [
    '--ignore-config',
    '--no-progress',
    '--socket-timeout',
    '15',
    '--flat-playlist',
    '--playlist-end',
    String(Math.max(1, Math.floor(limit))),
    '-J',
    url
  ]
}

/**
 * The arguments for one text search.
 *
 * `ytsearchN:` is a search *list* with N entries, and `--flat-playlist` keeps it
 * to ids and metadata. The cap is applied by the extractor, so asking for 20
 * results does not fetch a page of recommendations. The query goes in as one
 * argv element, so quotes and spaces are not shell syntax here.
 *
 * `offset` pages through that list. `ytsearch` has no continuation token, so
 * the extractor is asked for enough entries to reach the page (`offset +
 * limit`) and `--playlist-start` drops everything before it. Page one is still
 * a single ten-entry request; later pages grow the listing rather than asking
 * YouTube for a second page.
 */
export function buildSearchArgs(query: string, limit: number, offset = 0): string[] {
  const count = Math.max(1, Math.min(50, Math.floor(limit)))
  const start = Math.max(1, Math.floor(offset) + 1)
  const end = start + count - 1
  const fetchCount = Math.min(500, end)
  return [
    '--ignore-config',
    '--no-progress',
    '--socket-timeout',
    '15',
    '--flat-playlist',
    '--playlist-start',
    String(start),
    '--playlist-end',
    String(end),
    '-J',
    `ytsearch${fetchCount}:${query.trim()}`
  ]
}

/**
 * The arguments for one channel page.
 *
 * A channel's `/videos` tab is a flat list, which is why it uses the same shape
 * as a playlist import. The URL must already be normalised by
 * `youtubeChannelUrl`, so an arbitrary page cannot be handed to yt-dlp here.
 */
export function buildChannelArgs(url: string, limit: number, offset = 0): string[] {
  const count = Math.max(1, Math.min(50, Math.floor(limit)))
  const start = Math.max(1, Math.floor(offset) + 1)
  const end = start + count - 1
  return [
    '--ignore-config',
    '--no-progress',
    '--socket-timeout',
    '15',
    '--flat-playlist',
    '--playlist-start',
    String(start),
    '--playlist-end',
    String(end),
    '-J',
    url
  ]
}

export interface YtDownloadProgress {
  percent: number
  /** Transfer rate, when yt-dlp printed one. */
  speedBytesPerSecond: number | null
  /** Estimated seconds left, when yt-dlp printed one. */
  etaSeconds: number | null
}

export interface YtDownloadOptions {
  quality: QualityTier
  /** `opus`, `mp3` or `m4a`: the ext yt-dlp extracts to. */
  format: string
  /** Must contain `%(ext)s`; the downloader replaces it with the real extension. */
  outputTemplate: string
  onProgress?: (progress: YtDownloadProgress) => void
  signal?: AbortSignal
  timeoutMs?: number
}

const SPEED_UNITS: Readonly<Record<string, number>> = {
  b: 1,
  kb: 1_000,
  kib: 1_024,
  mb: 1_000_000,
  mib: 1_048_576,
  gb: 1_000_000_000,
  gib: 1_073_741_824
}

/**
 * One `[download]` line from yt-dlp.
 *
 * The percentage is the only field a save must have; speed and ETA are nice to
 * have and are absent for the final line and for some extractors. Parsing them
 * here keeps the process runner free of formatting details and makes the maths
 * testable without spawning anything.
 */
export function parseDownloadProgressLine(line: string): YtDownloadProgress | null {
  if (!line.includes('[download]')) return null
  const percentMatch = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line)
  if (!percentMatch?.[1]) return null
  const percent = Math.max(0, Math.min(100, Number(percentMatch[1])))

  let speedBytesPerSecond: number | null = null
  const speedMatch = /at\s+([\d.]+)\s*(B|kB|KB|KiB|MB|MiB|GB|GiB)\/s/i.exec(line)
  if (speedMatch?.[1] && speedMatch[2]) {
    const value = Number(speedMatch[1])
    const multiplier = SPEED_UNITS[speedMatch[2].toLowerCase()] ?? null
    if (Number.isFinite(value) && value >= 0 && multiplier !== null) {
      speedBytesPerSecond = Math.round(value * multiplier)
    }
  }

  let etaSeconds: number | null = null
  const etaMatch = /ETA\s+(\d+):(\d+)(?::(\d+))?/i.exec(line)
  if (etaMatch) {
    const first = Number(etaMatch[1])
    const second = Number(etaMatch[2])
    const third = etaMatch[3] === undefined ? null : Number(etaMatch[3])
    etaSeconds = third === null ? first * 60 + second : first * 3600 + second * 60 + third
  } else if (percent >= 100) {
    etaSeconds = 0
  }

  return { percent, speedBytesPerSecond, etaSeconds }
}

/**
 * Finds what yt-dlp actually wrote.
 *
 * The expected name is `<videoId>.<format>`, but the extractor decides the
 * extension in the last step and a thumbnail may sit beside it. Looking for the
 * id rather than trusting the template is what makes an unusual container (or a
 * future default) a working download instead of a "no file" error.
 */
function findDownloadedFile(outputTemplate: string, videoId: string, format: string): string | null {
  const directory = dirname(outputTemplate)
  const expected = join(directory, `${videoId}.${format}`)
  if (existsSync(expected)) return expected

  const candidates = [format, 'opus', 'ogg', 'mp3', 'm4a', 'webm', 'flac']
  for (const extension of candidates) {
    const candidate = join(directory, `${videoId}.${extension}`)
    if (existsSync(candidate)) return candidate
  }

  try {
    const prefix = `${videoId}.`
    const match = readdirSync(directory).find(
      (name) => name.startsWith(prefix) && !/\.(part|jpg|jpeg|png|webp|ytdl)$/i.test(name)
    )
    return match ? join(directory, match) : null
  } catch {
    return null
  }
}

/**
 * The arguments for one saved (kept) track.
 *
 * `-x` extracts the audio, `--embed-metadata` writes the tags the library will
 * read back, and `--embed-thumbnail` attaches the cover. The output template is
 * the downloader's temporary path; the service renames the file once its tags
 * say what the track is called.
 */
export function buildDownloadArgs(
  videoId: string,
  quality: QualityTier,
  format: string,
  outputTemplate: string,
  /** Folder yt-dlp should use for ffmpeg, when the app manages one. */
  ffmpegDir: string | null = null
): string[] {
  return [
    '--ignore-config',
    '--no-playlist',
    ...(ffmpegDir ? ['--ffmpeg-location', ffmpegDir] : []),
    '--socket-timeout',
    '15',
    '--newline',
    // Pausing aborts the process but keeps its UUID temp folder. A resumed save
    // reuses that folder, and yt-dlp must continue its `.part` file rather than
    // starting the transfer again.
    '--continue',
    '-f',
    youtubeFormatSelector(quality),
    '-x',
    '--audio-format',
    format,
    '--audio-quality',
    '0',
    '--embed-metadata',
    '--embed-thumbnail',
    '--convert-thumbnails',
    'jpg',
    '-o',
    outputTemplate,
    youtubeWatchUrl(videoId)
  ]
}

/**
 * Runs yt-dlp once per resolve.
 *
 * A long-lived process would save the ~1.5-2 s start-up cost, but yt-dlp is not
 * a server: its stdout is the JSON result, and a failed request would have to be
 * separated from the next one by parsing a stream. One process per resolve keeps
 * cancellation, timeouts and error handling honest; the session cache in
 * `YouTubeResolver` is what keeps the *second* play fast.
 */
export class YtDlpClient implements YtInfoProvider, YtPlaylistProvider, YtSearchProvider {
  private binary: string | null = null
  private updateInFlight: Promise<string> | null = null
  private rollbackAttemptedAt = 0
  private extractorFailures: number[] = []
  readonly gate: YouTubeGate

  private readonly metadataScheduler: RequestScheduler
  private readonly downloadScheduler: RequestScheduler

  constructor(
    private readonly deps: {
      engine: () => EngineSettings
      log: Logger
      timeoutMs?: number
      gate?: YouTubeGate
      metadataScheduler?: RequestScheduler
      downloadScheduler?: RequestScheduler
      /** Injectable for tests; the real default is two seconds plus jitter. */
      transientRetryDelayMs?: number
      /** The app-managed engine folder, used for the binary and ffmpeg. */
      managedDir?: string | null
    }
  ) {
    this.gate = deps.gate ?? new YouTubeGate()
    this.metadataScheduler =
      deps.metadataScheduler ??
      new RequestScheduler({
        maxConcurrent: METADATA_CONCURRENCY,
        minGapMs: METADATA_GAP_MS,
        jitterMs: METADATA_JITTER_MS
      })
    this.downloadScheduler =
      deps.downloadScheduler ??
      new RequestScheduler({
        maxConcurrent: DOWNLOAD_CONCURRENCY,
        minGapMs: DOWNLOAD_GAP_MS,
        jitterMs: DOWNLOAD_JITTER_MS
      })
  }

  async fetchInfo(videoId: string, quality: QualityTier, signal?: AbortSignal): Promise<YtMediaInfo> {
    const args = buildInfoArgs(videoId, quality)
    const { stdout } = await this.runWithRetry(args, signal)
    try {
      return parseInfo(stdout, videoId)
    } catch (error) {
      this.deps.log.warn('could not parse yt-dlp output', {
        videoId,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  async fetchPlaylist(url: string, limit: number, signal?: AbortSignal): Promise<YtPlaylistInfo> {
    const args = buildPlaylistArgs(url, limit)
    const { stdout } = await this.runWithRetry(args, signal, PLAYLIST_TIMEOUT_MS)
    try {
      return parsePlaylist(stdout, limit)
    } catch (error) {
      this.deps.log.warn('could not parse yt-dlp playlist output', {
        url,
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    }
  }

  async search(
    query: string,
    limit: number,
    offset = 0,
    signal?: AbortSignal
  ): Promise<YouTubeSearchResult[]> {
    const text = query.trim()
    if (text.length === 0) throw new YtDlpError('Type something to search for.', 'empty-query')
    const args = buildSearchArgs(text, limit, offset)
    const { stdout } = await this.runWithRetry(args, signal, PLAYLIST_TIMEOUT_MS)
    try {
      return parseSearchResults(stdout, limit)
    } catch (error) {
      this.deps.log.warn('could not parse yt-dlp search output', { error })
      throw error
    }
  }

  async channel(
    target: string,
    limit: number,
    offset = 0,
    signal?: AbortSignal
  ): Promise<YtChannelInfo> {
    const url = youtubeChannelUrl(target)
    if (!url) {
      throw new YtDlpError('That does not look like a channel link or id.', 'bad-channel')
    }
    const { stdout } = await this.runWithRetry(buildChannelArgs(url, limit, offset), signal, PLAYLIST_TIMEOUT_MS)
    try {
      return parseChannel(stdout, limit, url)
    } catch (error) {
      this.deps.log.warn('could not parse yt-dlp channel output', { error })
      throw error
    }
  }

  /**
   * Downloads one track to `outputTemplate`'s folder and returns the file.
   *
   * Unlike a resolve, this is expected to take minutes and to print progress, so
   * it gets its own runner instead of the buffered `run`: the row showing the
   * download needs a percentage, and buffering stdout would withhold it until the
   * process exited. The output template must contain `%(ext)s`.
   */
  download(videoId: string, options: YtDownloadOptions): Promise<string> {
    try {
      this.gate.assertReady()
      const engine = this.deps.engine()
      const browser = this.cookieBrowser()
      const fallback = engine.cookieFallback
      const useCookiesFirst = fallback === 'always' && browser !== null
      const baseArgs = withPoTokenProvider(
        withNetworkTransport(
          buildDownloadArgs(videoId, options.quality, options.format, options.outputTemplate, this.ffmpegLocation())
        ),
        engine
      )
      const binary = this.resolveBinary()
      const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS

      const attempt = (useCookies: boolean): Promise<string> =>
        this.downloadScheduler.schedule(
          () => {
            this.gate.assertReady()
            return this.spawnDownload(binary, this.withCookies(baseArgs, useCookies), videoId, options, timeoutMs)
          },
          { signal: options.signal, onAbort: () => new Error('Saving the track was cancelled.') }
        )

      return (async () => {
        try {
          try {
            return await attempt(useCookiesFirst)
          } catch (error) {
            if (options.signal?.aborted) throw error
            if (browser && fallback === 'on-bot-check' && isBotCheckError(error)) {
              this.deps.log.info('retrying download with browser cookies after a bot check', { browser })
              return await attempt(true)
            }
            throw error
          }
        } catch (error) {
          this.gate.recordFailure(error)
          throw error
        }
      })()
    } catch (error) {
      return Promise.reject(error)
    }
  }

  private spawnDownload(
    binary: string,
    args: string[],
    videoId: string,
    options: YtDownloadOptions,
    timeoutMs: number
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const signal = options.signal
      if (signal?.aborted) {
        reject(new Error('Saving the track was cancelled.'))
        return
      }

      let child: ChildProcess
      try {
        child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        reject(new YtDlpError('Could not start yt-dlp.', error instanceof Error ? error.message : String(error)))
        return
      }

      let stderr = ''
      let settled = false
      let lastEmit = 0

      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }

      const stop = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        killTree(child)
        reject(error)
      }

      const timer = setTimeout(() => {
        this.deps.log.warn('yt-dlp download timed out', {
          videoId,
          timeoutMs,
          stderr: stderr.slice(-2000)
        })
        stop(new YtDlpError('The download took too long. Try again.', 'download-timeout'))
      }, timeoutMs)

      const onAbort = (): void => stop(new Error('Saving the track was cancelled.'))
      signal?.addEventListener('abort', onAbort, { once: true })

      // Progress arrives on stdout as `[download]  42.3% of 4.10MiB at ...`.
      // Both streams are watched because yt-dlp has moved it between them.
      // Chunks do not respect line boundaries, so bytes are accumulated and only
      // complete lines are parsed.
      let progressBuffer = ''
      const emitProgress = (line: string): void => {
        const progress = parseDownloadProgressLine(line)
        if (!progress || !options.onProgress) return
        const now = Date.now()
        if (progress.percent >= 100 || now - lastEmit >= PROGRESS_INTERVAL_MS) {
          lastEmit = now
          options.onProgress(progress)
        }
      }
      const watch = (chunk: Buffer): void => {
        if (settled) return
        progressBuffer += chunk.toString('utf8')
        const lines = progressBuffer.split(/\r?\n/)
        progressBuffer = lines.pop() ?? ''
        for (const line of lines) emitProgress(line)
        // A pathological line must not grow this buffer for the whole download.
        if (progressBuffer.length > 8_192) progressBuffer = progressBuffer.slice(-8_192)
      }

      child.stdout?.on('data', watch)
      child.stderr?.on('data', (chunk: Buffer) => {
        watch(chunk)
        if (settled) return
        stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES)
      })

      child.on('error', (error) => {
        stop(new YtDlpError('Could not start yt-dlp.', error.message))
      })

      child.on('close', (code) => {
        if (settled) return
        if (progressBuffer.length > 0) emitProgress(progressBuffer)
        settled = true
        cleanup()

        if (code !== 0) {
          this.deps.log.warn('yt-dlp download failed', {
            videoId,
            code,
            stderr: stderr.slice(-2000)
          })
          reject(new YtDlpError(describeYouTubeFailure(stderr), stderr.slice(-4000)))
          return
        }

        const filePath = findDownloadedFile(options.outputTemplate, videoId, options.format)
        if (!filePath) {
          reject(new YtDlpError('The download finished but no file was found.', 'download-missing-file'))
          return
        }
        resolve(filePath)
      })
    })
  }

  /** The binary, or a message that says how to fix it. Located per call: settings can change. */
  private resolveBinary(): string {
    if (this.binary) return this.binary

    const located = locateExecutable('yt-dlp', {
      configuredDir: this.deps.engine().binDir,
      managedDir: this.deps.managedDir ?? null,
      extraDirs: wellKnownDirectories()
    })
    if (!located) {
      throw new YtDlpError(
        'yt-dlp is not installed. Open Settings → Streaming and choose Download engine, or set its folder.',
        'missing-binary'
      )
    }
    this.binary = located.path
    return located.path
  }

  /**
   * The folder holding the ffmpeg yt-dlp should use, when it is not on PATH.
   *
   * yt-dlp finds ffmpeg on PATH by itself. The copy the app downloads lives in
   * its own folder, so it has to be named explicitly or a save fails at the
   * conversion step after the download succeeded.
   */
  private ffmpegLocation(): string | null {
    const configured = this.deps.engine().binDir
    for (const dir of [configured, this.deps.managedDir]) {
      if (!dir) continue
      for (const file of process.platform === 'win32' ? ['ffmpeg.exe', 'ffmpeg'] : ['ffmpeg']) {
        if (existsSync(join(dir, file))) return dir
      }
    }
    return null
  }

  /** Updates the yt-dlp binary in place (`yt-dlp -U`), keeping the last good copy. */
  update(signal?: AbortSignal): Promise<string> {
    if (this.updateInFlight) return this.updateInFlight

    let binary: string
    try {
      binary = this.resolveBinary()
    } catch (error) {
      return Promise.reject(error)
    }

    const work = this.runUpdate(binary, signal).finally(() => {
      this.updateInFlight = null
    })

    this.updateInFlight = work
    return work
  }

  /**
   * Whether a previous managed binary is saved, and when it was last used.
   * Cheap: one stat and one small read, no process spawn.
   */
  rollbackStatus(): Promise<Awaited<ReturnType<typeof ytDlpRollbackStatus>>> {
    return ytDlpRollbackStatus(this.deps.managedDir)
  }

  /**
   * Puts the saved binary back. Used by the Settings button and by the
   * automatic path after a bad update or repeated extractor failures.
   */
  async restorePrevious(versionReason: 'manual' | 'automatic' = 'manual'): Promise<
    Awaited<ReturnType<typeof ytDlpRollbackStatus>>
  > {
    const dir = this.deps.managedDir
    const target = this.managedBinaryPath()
    if (!dir || !target) {
      throw new YtDlpError('The app does not manage a yt-dlp binary to restore.', 'no-managed-engine')
    }
    if (!existsSync(target)) {
      throw new YtDlpError('The managed yt-dlp binary is missing; download the engine again.', 'missing-binary')
    }
    const result = await restoreSavedBinary(dir, target)
    if (!result.restored) {
      throw new YtDlpError('There is no previous yt-dlp binary to restore.', 'no-rollback')
    }
    this.binary = null
    this.deps.log.info('restored the previous yt-dlp binary', {
      reason: versionReason,
      version: result.version
    })
    return this.rollbackStatus()
  }

  private async runUpdate(binary: string, signal?: AbortSignal): Promise<string> {
    const managedDir = this.deps.managedDir
    const managed = isManagedBinary(managedDir, binary)
    let saved = false

    if (managed && managedDir) {
      // Only back up a binary that answers `--version`. A broken file must never
      // overwrite the fallback that was working.
      const version = await this.binaryVersion(binary).catch(() => null)
      if (version) {
        try {
          describeSavedRollback(this.deps.log, await saveLastKnownGood(managedDir, binary, version))
          saved = true
        } catch (error) {
          this.deps.log.warn('could not save the previous yt-dlp binary', error)
        }
      }
    }

    try {
      const { stdout, stderr } = await this.spawnBuffered(
        binary,
        withNetworkTransport(['--ignore-config', '-U']),
        signal,
        UPDATE_TIMEOUT_MS,
        'Updating yt-dlp was cancelled.',
        // `-U` talks to GitHub, not YouTube. The generic resolve message sent
        // users looking at the wrong service when this timed out.
        'Updating yt-dlp took too long. Check the connection and try again.'
      )

      const output = [stdout, stderr]
        .map((part) => part.trim())
        .filter(Boolean)
        .join('\n')
        .trim()

      if (managed) {
        const version = await this.binaryVersion(binary).catch(() => null)
        if (!version) {
          if (saved && managedDir) await this.tryRestore(managedDir, binary, 'broken-update')
          throw new YtDlpError(
            saved
              ? 'The updated yt-dlp did not start. The previous version was restored.'
              : 'The updated yt-dlp did not start. Download the engine again from Settings.',
            'update-broken'
          )
        }
      }

      this.deps.log.info('yt-dlp update finished', { output: output.slice(-1000) })
      return output || 'yt-dlp is up to date.'
    } catch (error) {
      // `-U` can fail after replacing part of the file. If what remains no
      // longer starts, the backup is the difference between a working engine
      // and a user who has to find yt-dlp themselves.
      if (managed && managedDir) {
        const version = await this.binaryVersion(binary).catch(() => null)
        if (!version && saved) await this.tryRestore(managedDir, binary, 'failed-update')
      }
      this.deps.log.warn('yt-dlp update failed', error)
      throw error
    }
  }

  private managedBinaryPath(): string | null {
    const dir = this.deps.managedDir
    if (!dir) return null
    return join(dir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
  }

  /** Reads the version of a binary without touching the network. */
  private async binaryVersion(binary: string): Promise<string | null> {
    const { stdout } = await this.spawnBuffered(
      binary,
      ['--ignore-config', '--version'],
      undefined,
      VERSION_TIMEOUT_MS,
      'Checking the yt-dlp binary was cancelled.',
      'Timed out checking the yt-dlp binary.'
    )
    const line = stdout.trim().split(/\r?\n/)[0]?.trim() ?? ''
    return line.length > 0 ? line : null
  }

  private async tryRestore(dir: string, binary: string, reason: string): Promise<boolean> {
    try {
      const result = await restoreSavedBinary(dir, binary)
      if (!result.restored) return false
      this.binary = null
      this.deps.log.warn('restored the previous yt-dlp binary', { reason, version: result.version })
      return true
    } catch (error) {
      this.deps.log.warn('could not restore the previous yt-dlp binary', error)
      return false
    }
  }

  /**
   * One retry for a transient network failure, plus the conditional cookie
   * fallback for a bot check.
   *
   * The order matters: a cookie retry happens before the breaker records the
   * final failure, so a fallback that works does not pause playback. A bot
   * check is still never retried without cookies.
   */
  private async runWithRetry(
    args: string[],
    signal?: AbortSignal,
    timeoutOverrideMs?: number
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      return await this.runWithRetryInner(args, signal, timeoutOverrideMs)
    } catch (error) {
      // A failed request is the only place extractor breakage is visible. One
      // or two can be a flaky video; three in ten minutes means the release
      // itself is the problem.
      if (!signal?.aborted) void this.noteExtractorFailure(error)
      throw error
    }
  }

  private async noteExtractorFailure(error: unknown): Promise<void> {
    if (!isExtractorBreakage(error)) return
    const now = Date.now()
    this.extractorFailures = this.extractorFailures.filter(
      (at) => now - at < EXTRACTOR_FAILURE_WINDOW_MS
    )
    this.extractorFailures.push(now)
    if (this.extractorFailures.length < EXTRACTOR_FAILURE_LIMIT) return

    const dir = this.deps.managedDir
    const managed = this.managedBinaryPath()
    if (!dir || !managed || !existsSync(managed)) return
    if (now - this.rollbackAttemptedAt < ROLLBACK_COOLDOWN_MS) return

    this.rollbackAttemptedAt = now
    this.extractorFailures = []
    const restored = await this.tryRestore(dir, managed, 'repeated-extractor-failure')
    if (restored) this.deps.log.warn('yt-dlp extractor failures triggered a rollback')
  }

  private async runWithRetryInner(
    args: string[],
    signal?: AbortSignal,
    timeoutOverrideMs?: number
  ): Promise<{ stdout: string; stderr: string }> {
    const browser = this.cookieBrowser()
    const fallback = this.deps.engine().cookieFallback
    const useCookiesFirst = fallback === 'always' && browser !== null
    let cookiesTried = useCookiesFirst

    const attempt = (useCookies: boolean): Promise<{ stdout: string; stderr: string }> =>
      this.run(args, signal, timeoutOverrideMs, useCookies)

    const retryWithCookies = async (): Promise<{ stdout: string; stderr: string } | null> => {
      if (!browser || fallback !== 'on-bot-check' || cookiesTried) return null
      cookiesTried = true
      this.deps.log.info('retrying yt-dlp with browser cookies after a bot check', { browser })
      return attempt(true)
    }

    try {
      return await attempt(useCookiesFirst)
    } catch (error) {
      if (signal?.aborted) {
        this.gate.recordFailure(error)
        throw error
      }

      if (isBotCheckError(error)) {
        try {
          const retried = await retryWithCookies()
          if (retried) return retried
        } catch (cookieError) {
          this.gate.recordFailure(cookieError)
          throw cookieError
        }
        this.gate.recordFailure(error)
        throw error
      }

      if (!isRetryableError(error)) {
        this.gate.recordFailure(error)
        throw error
      }

      const base = this.deps.transientRetryDelayMs ?? TRANSIENT_RETRY_DELAY_MS
      const delay = base + Math.floor(Math.random() * TRANSIENT_RETRY_JITTER_MS)
      this.deps.log.info('retrying yt-dlp after a transient network failure', { delay })
      await delayWithSignal(delay, signal, 'Resolving the link was cancelled.')

      try {
        return await attempt(useCookiesFirst)
      } catch (retryError) {
        if (isBotCheckError(retryError)) {
          try {
            const retried = await retryWithCookies()
            if (retried) return retried
          } catch (cookieError) {
            this.gate.recordFailure(cookieError)
            throw cookieError
          }
        }
        this.gate.recordFailure(retryError)
        throw retryError
      }
    }
  }

  private run(
    args: string[],
    signal: AbortSignal | undefined,
    timeoutOverrideMs: number | undefined,
    useCookies: boolean
  ): Promise<{ stdout: string; stderr: string }> {
    let binary: string
    try {
      binary = this.resolveBinary()
      this.gate.assertReady()
    } catch (error) {
      return Promise.reject(error)
    }

    const timeoutMs = timeoutOverrideMs ?? this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
    // Read the settings at call time; changing them in Settings must affect the
    // next request, not only the next launch.
    const commandArgs = this.withCookies(
      withPoTokenProvider(withNetworkTransport(args), this.deps.engine()),
      useCookies
    )

    return this.metadataScheduler.schedule(
      () => {
        // The breaker may have tripped while this job waited for a slot.
        this.gate.assertReady()
        return this.spawnBuffered(binary, commandArgs, signal, timeoutMs)
      },
      { signal, onAbort: () => new Error('Resolving the link was cancelled.') }
    )
  }

  /** A usable browser only when the user has actually enabled a fallback. */
  private cookieBrowser(): string | null {
    const engine = this.deps.engine()
    if (engine.cookieFallback === 'off') return null
    return isSupportedCookieBrowser(engine.cookiesFromBrowser) ? engine.cookiesFromBrowser : null
  }

  private withCookies(args: string[], useCookies: boolean): string[] {
    if (!useCookies) return args
    const engine = this.deps.engine()
    return withBrowserCookies(args, engine.cookiesFromBrowser, engine.cookieBrowserProfile)
  }

  private spawnBuffered(
    binary: string,
    args: string[],
    signal: AbortSignal | undefined,
    timeoutMs: number,
    abortMessage = 'Resolving the link was cancelled.',
    timeoutMessage = 'YouTube took too long to answer. Check the connection and try again.'
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error(abortMessage))
        return
      }

      let child: ChildProcess
      try {
        child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        reject(new YtDlpError('Could not start yt-dlp.', error instanceof Error ? error.message : String(error)))
        return
      }

      const out: Buffer[] = []
      let outBytes = 0
      let stdoutTail = ''
      let stderr = ''
      let settled = false
      const startedAt = Date.now()

      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }

      const stop = (error: Error): void => {
        if (settled) return
        settled = true
        cleanup()
        killTree(child)
        reject(error)
      }

      const timer = setTimeout(() => {
        // The reason a resolve timed out used to disappear with the process.
        // Keeping the tail of stderr is what tells "waiting on YouTube" apart
        // from "the binary never started" or a stalled web request.
        this.deps.log.warn('yt-dlp timed out', {
          timeoutMs,
          elapsedMs: Date.now() - startedAt,
          stdoutBytes: outBytes,
          stdout: stdoutTail,
          stderr: stderr.slice(-4000)
        })
        stop(new YtDlpError(timeoutMessage, 'timeout'))
      }, timeoutMs)

      const onAbort = (): void => stop(new Error(abortMessage))
      signal?.addEventListener('abort', onAbort, { once: true })

      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return
        outBytes += chunk.length
        if (outBytes > MAX_STDOUT_BYTES) {
          stop(new YtDlpError('YouTube returned an unexpectedly large response.', 'stdout-overflow'))
          return
        }
        out.push(chunk)
        stdoutTail = (stdoutTail + chunk.toString('utf8')).slice(-1000)
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        if (settled) return
        stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES)
      })

      child.on('error', (error) => {
        stop(new YtDlpError('Could not start yt-dlp.', error.message))
      })

      child.on('close', (code) => {
        if (settled) return
        settled = true
        cleanup()

        const stdout = Buffer.concat(out).toString('utf8')
        if (code === 0) {
          resolve({ stdout, stderr })
          return
        }

        this.deps.log.warn('yt-dlp failed', { code, stderr: stderr.slice(-2000) })
        reject(new YtDlpError(describeYouTubeFailure(stderr), stderr.slice(-4000)))
      })
    })
  }
}

function isRetryableError(error: unknown): boolean {
  if (!(error instanceof YtDlpError)) return false
  // Our own deadline is not a transient socket error. Retrying it doubles the
  // time the listener waits without making a blocked request any likelier to
  // finish; the next attempt should be the listener's decision, not a timer's.
  if (error.detail === 'timeout') return false
  return isRetryableYouTubeFailure(`${error.message}\n${error.detail}`)
}

function isBotCheckError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const detail = (error as Error & { detail?: unknown }).detail
  return isYouTubeBotCheck(`${error.message}\n${typeof detail === 'string' ? detail : ''}`)
}

/**
 * A failure that points at yt-dlp's extractor rather than the network or the
 * user's setup. Timeouts and missing binaries are excluded on purpose: those
 * are exactly the cases where swapping the binary would not help.
 */
function isExtractorBreakage(error: unknown): boolean {
  if (!(error instanceof YtDlpError)) return false
  if (error.detail === 'timeout' || error.detail === 'missing-binary' || error.detail === 'update-broken') {
    return false
  }
  return EXTRACTOR_BREAKAGE_PATTERN.test(`${error.message}\n${error.detail}`)
}

function delayWithSignal(ms: number, signal: AbortSignal | undefined, message: string): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error(message))
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error(message))
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  webm: 'audio/webm',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  opus: 'audio/ogg',
  ogg: 'audio/ogg',
  mp3: 'audio/mpeg',
  aac: 'audio/aac'
}

/** Conservative fallback when the URL carries no expiry parameter. */
const DEFAULT_TTL_MS = 60 * 60_000

function parseInfo(stdout: string, requestedId: string): YtMediaInfo {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    throw new YtDlpError('YouTube returned something unreadable. Try again.', 'invalid-json')
  }
  if (!raw || typeof raw !== 'object') {
    throw new YtDlpError('YouTube returned something unreadable. Try again.', 'empty-json')
  }

  const info = raw as Record<string, unknown>
  if (info.is_live === true || info.live_status === 'is_live' || info.live_status === 'is_upcoming') {
    throw new YtDlpError('Live streams and premieres are not supported yet.', 'live')
  }

  // `-f` normally selects one format, which yt-dlp puts at the top level. A
  // single requested format is accepted too, so a merge is never attempted.
  const requested = Array.isArray(info.requested_formats) ? info.requested_formats : []
  const single = requested.length === 1 && requested[0] && typeof requested[0] === 'object'
    ? (requested[0] as Record<string, unknown>)
    : null
  const format = single ?? info
  const streamUrl = asString(format.url) ?? asString(info.url)
  if (!streamUrl || !/^https?:\/\//i.test(streamUrl)) {
    throw new YtDlpError('This video has no streamable audio.', 'no-stream')
  }

  const videoId = asString(info.id) ?? requestedId
  const ext = (asString(format.ext) ?? '').toLowerCase()
  const acodec = asString(format.acodec)
  const duration = asNumber(info.duration) ?? asNumber(format.duration)

  return {
    videoId,
    webpageUrl: asString(info.webpage_url) ?? youtubeWatchUrl(videoId),
    title: asString(info.title) ?? 'Untitled',
    artist: normalizeArtistName(
      asString(info.artist) ?? asString(info.creator) ?? asString(info.uploader) ?? asString(info.channel)
    ),
    channel: normalizeArtistName(asString(info.channel) ?? asString(info.uploader)),
    durationSec: duration,
    thumbnailUrl: thumbnailOf(info),
    formatId: asString(format.format_id) ?? '',
    ext,
    codec: normalizeCodec(acodec),
    bitrateKbps: roundOrNull(asNumber(format.abr)),
    sampleRateHz: roundOrNull(asNumber(format.asr)),
    channels: roundOrNull(asNumber(format.audio_channels)),
    fileSize: roundOrNull(asNumber(format.filesize_approx) ?? asNumber(format.filesize)),
    streamUrl,
    headers: headersOf(info.http_headers),
    expiresAt: expiryOf(streamUrl),
    mimeType: MIME_BY_EXTENSION[ext] ?? 'application/octet-stream'
  }
}

/** Entries YouTube marks as unplayable without the account that owns them. */
const UNAVAILABLE = new Set(['private', 'premium_only', 'subscriber_only', 'needs_auth'])

/**
 * Turns one `-J --flat-playlist` document into the list an import needs.
 *
 * Exported for the smoke tests: this is where the rules live, and none of them
 * need a sidecar. Flat entries carry no album or track number, so a playlist
 * entry's album stays null; an album's name comes from the list itself.
 */
export function parsePlaylist(stdout: string, limit: number): YtPlaylistInfo {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    throw new YtDlpError('YouTube returned something unreadable. Try again.', 'invalid-json')
  }
  if (!raw || typeof raw !== 'object') {
    throw new YtDlpError('YouTube returned something unreadable. Try again.', 'empty-json')
  }

  const info = raw as Record<string, unknown>
  const listId = asString(info.id) ?? ''
  if (!listId) {
    throw new YtDlpError('YouTube did not return a playlist for this link.', 'no-playlist')
  }

  const cap = Math.max(1, Math.floor(limit))
  const seen = new Set<string>()
  const entries: YtPlaylistEntry[] = []
  const rawEntries = Array.isArray(info.entries) ? info.entries : []

  for (const candidate of rawEntries) {
    if (entries.length >= cap) break
    if (!candidate || typeof candidate !== 'object') continue

    const entry = candidate as Record<string, unknown>
    const videoId = asString(entry.id) ?? ''
    if (!isYouTubeVideoId(videoId) || seen.has(videoId)) continue

    const availability = asString(entry.availability)
    if (availability && UNAVAILABLE.has(availability)) continue
    const liveStatus = asString(entry.live_status)
    if (liveStatus === 'is_live' || liveStatus === 'is_upcoming') continue

    const title = asString(entry.title)
    if (!title) continue

    const duration = asNumber(entry.duration)
    seen.add(videoId)
    entries.push({
      videoId,
      title,
      // A flat listing has no `artist`; the channel is the best available name.
      artist: normalizeArtistName(asString(entry.artist) ?? asString(entry.uploader) ?? asString(entry.channel)),
      durationMs: duration !== null && duration > 0 ? Math.round(duration * 1000) : null
    })
  }

  const total = asNumber(info.playlist_count)
  return {
    listId,
    title: asString(info.title) ?? listId,
    owner: asString(info.uploader) ?? asString(info.channel),
    total,
    // A mix never reports a total, so reaching the cap is the only truncation
    // signal it has. A finite list is truncated whenever entries were dropped,
    // whether by the cap or by being private.
    truncated: total !== null ? total > entries.length : entries.length >= cap,
    coverUrls: coverUrlsOf(info),
    entries
  }
}

/**
 * Turns a flat search or channel document into the rows a discovery list shows.
 *
 * The same rules as a playlist import apply: only real video ids, no private or
 * live entries, no duplicates. A result is metadata, so an unplayable one would
 * be a row that fails the moment it is clicked.
 */
export function parseSearchResults(stdout: string, limit: number): YouTubeSearchResult[] {
  return parseFlatEntries(parseJson(stdout), limit)
}

export function parseChannel(stdout: string, limit: number, fallbackUrl: string): YtChannelInfo {
  const info = parseJson(stdout)
  const channelId = asString(info.channel_id) ?? asString(info.id)
  const name = asString(info.channel) ?? asString(info.uploader) ?? asString(info.title) ?? 'Channel'
  // A channel listing's entries omit the channel fields (they are implied by the
  // page), unlike search entries. Filling them in here means a row opened from a
  // channel still knows the artist and can open the same channel again.
  const entries = parseFlatEntries(info, limit).map((entry) => ({
    ...entry,
    artist: entry.artist ?? name,
    channelId: entry.channelId ?? channelId,
    channelName: entry.channelName ?? name
  }))
  return {
    channelId,
    name,
    url: asString(info.webpage_url) ?? fallbackUrl,
    entries
  }
}

function parseJson(stdout: string): Record<string, unknown> {
  let raw: unknown
  try {
    raw = JSON.parse(stdout)
  } catch {
    throw new YtDlpError('YouTube returned something unreadable. Try again.', 'invalid-json')
  }
  if (!raw || typeof raw !== 'object') {
    throw new YtDlpError('YouTube returned something unreadable. Try again.', 'empty-json')
  }
  return raw as Record<string, unknown>
}

function parseFlatEntries(info: Record<string, unknown>, limit: number): YouTubeSearchResult[] {
  const cap = Math.max(1, Math.floor(limit))
  const seen = new Set<string>()
  const entries: YouTubeSearchResult[] = []
  const rawEntries = Array.isArray(info.entries) ? info.entries : []

  for (const candidate of rawEntries) {
    if (entries.length >= cap) break
    if (!candidate || typeof candidate !== 'object') continue

    const entry = candidate as Record<string, unknown>
    const videoId = asString(entry.id) ?? ''
    if (!isYouTubeVideoId(videoId) || seen.has(videoId)) continue

    const availability = asString(entry.availability)
    if (availability && UNAVAILABLE.has(availability)) continue
    const liveStatus = asString(entry.live_status)
    if (liveStatus === 'is_live' || liveStatus === 'is_upcoming') continue

    const title = asString(entry.title)
    if (!title) continue

    const duration = asNumber(entry.duration)
    const channelId = asString(entry.channel_id) ?? asString(entry.uploader_id)
    const channelName = normalizeArtistName(
      asString(entry.channel) ?? asString(entry.uploader) ?? asString(entry.channel_name)
    )
    seen.add(videoId)
    entries.push({
      videoId,
      title,
      artist: normalizeArtistName(asString(entry.artist) ?? asString(entry.uploader) ?? asString(entry.channel)),
      durationMs: duration !== null && duration > 0 ? Math.round(duration * 1000) : null,
      channelId,
      channelName
    })
  }
  return entries
}

/**
 * Every thumbnail URL the list offers, largest first.
 *
 * Returned as a list rather than one URL because YouTube's largest still is not
 * always a real image: an album cover's `maxresdefault.jpg` can answer 404 with a
 * decodable 120×90 placeholder, and the signed `sddefault.jpg` is the one that
 * holds the sleeve. The caller walks the list and checks the status.
 */
function coverUrlsOf(info: Record<string, unknown>): string[] {
  const ranked: Array<{ url: string; width: number }> = []
  const thumbnails = Array.isArray(info.thumbnails) ? info.thumbnails : []

  for (const candidate of thumbnails) {
    if (!candidate || typeof candidate !== 'object') continue
    const entry = candidate as Record<string, unknown>
    const url = asString(entry.url)
    if (!url) continue
    ranked.push({ url, width: asNumber(entry.width) ?? 0 })
  }

  const direct = asString(info.thumbnail)
  if (direct) ranked.push({ url: direct, width: 0 })

  ranked.sort((left, right) => right.width - left.width)
  const seen = new Set<string>()
  const urls: string[] = []
  for (const candidate of ranked) {
    if (seen.has(candidate.url)) continue
    seen.add(candidate.url)
    urls.push(candidate.url)
  }
  return urls
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value)
}

function normalizeCodec(acodec: string | null): string | null {
  if (!acodec) return null
  if (acodec.startsWith('mp4a')) return 'AAC'
  if (acodec === 'opus') return 'Opus'
  return acodec
}

function headersOf(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {}
  if (!value || typeof value !== 'object') return headers
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue === 'string' && headerValue.length > 0) headers[name] = headerValue
  }
  return headers
}

function thumbnailOf(info: Record<string, unknown>): string | null {
  const direct = asString(info.thumbnail)
  if (direct) return direct
  const thumbnails = Array.isArray(info.thumbnails) ? info.thumbnails : []
  for (let index = thumbnails.length - 1; index >= 0; index -= 1) {
    const entry = thumbnails[index]
    if (entry && typeof entry === 'object') {
      const url = asString((entry as Record<string, unknown>).url)
      if (url) return url
    }
  }
  return null
}

function expiryOf(streamUrl: string): number {
  try {
    const url = new URL(streamUrl)
    const expire = Number(url.searchParams.get('expire') ?? url.searchParams.get('expire_at'))
    // googlevideo uses seconds; ignore anything that is already in the past.
    if (Number.isFinite(expire) && expire > 0) {
      const ms = expire > 10_000_000_000 ? expire : expire * 1000
      if (ms > Date.now()) return ms
    }
  } catch {
    // Fall through to the conservative default.
  }
  return Date.now() + DEFAULT_TTL_MS
}
