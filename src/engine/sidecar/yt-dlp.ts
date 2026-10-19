import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Logger } from '@core/logging/logger'
import type { EngineSettings, QualityTier } from '@shared/types'
import {
  describeYouTubeFailure,
  isYouTubeVideoId,
  normalizeArtistName,
  youtubeFormatSelector,
  youtubeWatchUrl
} from '@shared/youtube'
import { locateExecutable, wellKnownDirectories } from './locate'

/** Resolving is 7-10 s on a normal connection; 25 s leaves room for a slow night. */
const DEFAULT_TIMEOUT_MS = 25_000

/** A flat list of 200 entries is several requests on YouTube's side; 60 s is fair. */
const PLAYLIST_TIMEOUT_MS = 60_000

/** A single video's -J JSON is a few hundred KB. Anything past this is not a video. */
const MAX_STDOUT_BYTES = 8 * 1024 * 1024

/** Enough to identify the failure without holding a whole yt-dlp transcript. */
const MAX_STDERR_BYTES = 64 * 1024

export interface YtMediaInfo {
  videoId: string
  webpageUrl: string
  title: string
  artist: string | null
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
 * Runs yt-dlp once per resolve.
 *
 * A long-lived process would save the ~1.5-2 s start-up cost, but yt-dlp is not
 * a server: its stdout is the JSON result, and a failed request would have to be
 * separated from the next one by parsing a stream. One process per resolve keeps
 * cancellation, timeouts and error handling honest; the session cache in
 * `YouTubeResolver` is what keeps the *second* play fast.
 */
export class YtDlpClient implements YtInfoProvider, YtPlaylistProvider {
  private binary: string | null = null

  constructor(
    private readonly deps: {
      engine: () => EngineSettings
      log: Logger
      timeoutMs?: number
    }
  ) {}

  async fetchInfo(videoId: string, quality: QualityTier, signal?: AbortSignal): Promise<YtMediaInfo> {
    const args = buildInfoArgs(videoId, quality)
    const { stdout } = await this.run(args, signal)
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
    const { stdout } = await this.run(args, signal, PLAYLIST_TIMEOUT_MS)
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

  /** The binary, or a message that says how to fix it. Located per call: settings can change. */
  private resolveBinary(): string {
    if (this.binary) return this.binary

    const configured = this.deps.engine().binDir
    const extensions = process.platform === 'win32' ? ['.exe', ''] : ['']
    if (configured) {
      for (const extension of extensions) {
        const candidate = join(configured, `yt-dlp${extension}`)
        if (existsSync(candidate)) {
          this.binary = candidate
          return candidate
        }
      }
    }

    const located = locateExecutable('yt-dlp', wellKnownDirectories())
    if (!located) {
      throw new YtDlpError(
        'yt-dlp was not found. Install it and add it to PATH, or set its folder in Settings.',
        'missing-binary'
      )
    }
    this.binary = located.path
    return located.path
  }

  private run(
    args: string[],
    signal?: AbortSignal,
    timeoutOverrideMs?: number
  ): Promise<{ stdout: string; stderr: string }> {
    const binary = this.resolveBinary()
    const timeoutMs = timeoutOverrideMs ?? this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('Resolving the link was cancelled.'))
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
      let stderr = ''
      let settled = false

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
        stop(new YtDlpError('YouTube took too long to answer. Try again.', 'timeout'))
      }, timeoutMs)

      const onAbort = (): void => stop(new Error('Resolving the link was cancelled.'))
      signal?.addEventListener('abort', onAbort, { once: true })

      child.stdout?.on('data', (chunk: Buffer) => {
        if (settled) return
        outBytes += chunk.length
        if (outBytes > MAX_STDOUT_BYTES) {
          stop(new YtDlpError('YouTube returned an unexpectedly large response.', 'stdout-overflow'))
          return
        }
        out.push(chunk)
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

/** yt-dlp can leave a deno/ffmpeg child behind; killing the tree is the only clean stop. */
function killTree(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => undefined)
    killer.unref()
    return
  }
  try {
    child.kill('SIGKILL')
  } catch {
    // It exited between the check and the kill.
  }
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
    artist: normalizeArtistName(asString(info.artist) ?? asString(info.uploader) ?? asString(info.channel)),
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
