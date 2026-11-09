/**
 * Smoke test for everything that does not need a window.
 *
 * Run with `npm run smoke`. It builds a throwaway library in the temp folder
 * using ffmpeg, indexes it twice, searches it, resolves a playable URL and then
 * deletes a file to prove that pruning works. This is the check that a UI-only
 * test could never give you: that the core is correct on real files.
 */
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, basename, join, relative } from 'node:path'
import { promisify } from 'node:util'
import { deflateRawSync } from 'node:zlib'

import {
  ACCENT_CHOICES,
  DENSITY_CHOICES,
  DENSITY_ROW_HEIGHT,
  DEFAULT_APPEARANCE,
  LYRICS_ALIGN_CHOICES,
  LYRICS_ALIGNS,
  MOTION_CHOICES,
  SURFACE_CHOICES,
  THEME_CHOICES
} from '@shared/appearance'
import {
  DEFAULT_AUDIO_SETTINGS,
  EQ_BAND_COUNT,
  EQ_BAND_FREQUENCIES,
  EQ_PRESETS,
  dbToGain,
  normalizationGain,
  normalizeAudioSettings,
  replayGainForLufs,
  sanitizeAudioPatch
} from '@shared/audio'
import { DEFAULT_PREFERENCE_PATCH } from '@shared/settings-defaults'
import { isLocalLibraryFilter, recentlyAddedCutoff, streamFallbackFor } from '@shared/library'
import { PLAY_COUNT_THRESHOLD_MS, PlaySession, countsAsPlay } from '@shared/play-count'
import { mergeAddedShelf, mergePlayedShelf } from '@shared/played-shelf'
import {
  candidateFromAcoustidRecording,
  candidatesFromItunes,
  candidatesFromMusicBrainz,
  durationScore,
  normalizeMatchText,
  rankCandidates,
  scoreCandidate,
  textSimilarity,
  titleVariants
} from '@shared/auto-tag'
import {
  AcoustidError,
  acoustidLookupUrl,
  describeAcoustidFailure,
  normalizeAcoustidKey,
  parseAcoustidLookup
} from '@shared/acoustid'
import { fpcalcArgs, parseFpcalcOutput } from '@engine/sidecar/fpcalc'
import {
  describeTagBatchChange,
  positionText,
  tagBatchChanges,
  tagBatchFields
} from '@shared/tag-batch'
import type { AlbumSummary, EngineStatus, LyricsBatchSnapshot, LyricsCandidate, PendingWriteNotice, PlaylistDetail, SidecarId, SidecarProgress, StreamLyricsTarget, TagBatchSnapshot, TagCandidate, TagLookupQuery, Track } from '@shared/types'
import { serializeDetails, silentLogger } from '@core/logging/logger'
import {
  DIAGNOSTICS_SUMMARY_LIMIT,
  buildDiagnosticsBundle,
  readLogTail,
  sanitizeDiagnosticsSummary,
  writeDiagnosticsFile
} from '../src/main/diagnostics'
import {
  CRASH_REPORT_KEEP,
  CrashReporter,
  buildCrashReportBundle,
  clearCrashReports,
  listCrashReports
} from '../src/main/crash-reports'
import {
  DATABASE_BUDGET_BYTES,
  PAGE_BUDGET_MS,
  RESCAN_BUDGET_MS,
  RSS_BUDGET_BYTES,
  SCAN_BUDGET_MS,
  SEARCH_BUDGET_MS,
  checkScaleBudgets,
  type ScaleSummary
} from '../src/main/scale-check'
import { resolveAppPaths, ensureAppDirectories } from '@core/paths'
import { DEFAULT_SETTINGS, mergeSettings, normalizeRetention, normalizeUpdate, normalizeUpdateFeedUrl, SettingsService } from '@core/settings/settings-service'
import { DatabaseSchemaTooNewError, latestVersion, openLibraryDatabase } from '@core/db/database'
import {
  applyPendingRestore,
  createBackupBundle,
  createDatabaseBackup,
  ensureDailyBackup,
  findDatabaseRecoveryCandidate,
  inspectBackupBundle,
  nextBackupDirectory,
  pruneDatabaseBackups,
  stageRestore
} from '@core/db/backups'
import { openDatabase } from '@core/db/driver'
import { TrackRepository, buildFtsQuery, type ScanRunSummary } from '@core/library/track-repository'
import { DownloadHistoryRepository } from '@core/library/download-history-repository'
import { LibraryService } from '@core/library/library-service'
import { DataCareService } from '@core/library/data-care-service'
import { FolderWatcher, isLibraryEvent, type FolderWatchEvent } from '@core/library/folder-watcher'
import { PlaylistRepository } from '@core/library/playlist-repository'
import { PlaylistService } from '@core/library/playlist-service'
import { copyPlaylistToFolder, planPlaylistCopy } from '@core/library/playlist-copy'
import {
  MAX_PLAYLIST_ENTRIES,
  exportPlaylistJson,
  exportPlaylistM3U,
  parsePlaylistFile,
  playlistFormatFromPath
} from '@core/library/playlist-file'
import { libraryCsv } from '@core/library/library-csv'
import { OnlineRepository } from '@core/library/online-repository'
import { OnlinePlaylistRepository } from '@core/library/online-playlist-repository'
import { StreamPlayRepository } from '@core/library/stream-play-repository'
import { PlayStateRepository } from '@core/library/play-state-repository'
import { PlaybackService } from '@core/library/playback-service'
import { createTagLookup, itunesUrl, musicBrainzQuery } from '@core/library/tag-lookup'
import type { TagLookup } from '@core/library/tag-lookup'
import {
  createLyricsFinder,
  createLyricsLookup,
  lrclibGetUrl,
  lrclibSearchUrl,
  type LyricsLookup,
  type LyricsProvider
} from '@core/library/lyrics-lookup'
import { createGeniusProvider } from '@core/library/lyrics-genius'
import { isPathInside, localContentKey, normalizePath } from '@core/library/content-key'
import { scanLibraryFolders } from '@core/library/scanner'
import { youtubeOriginOf, youtubeOriginOfNative, extractMetadata, loadMetadataParser } from '@core/library/metadata'
import {
  TAG_TEMP_PREFIX,
  TagWriteError,
  TagWriter,
  isTagTempFile,
  rawLyricsOf,
  sweepTagTempFile,
  type TagFields,
  type TagWriteResult
} from '@core/library/tag-writer'
import { artworkKeyFor, extractArtwork, extensionForMime, mimeForExtension } from '@core/library/artwork'
import { decodeLyricsFile } from '@core/library/lyrics'
import { LyricsRepository, StreamLyricsRepository } from '@core/library/lyrics-repository'
import { LyricsService } from '@core/library/lyrics-service'
import { LocalFileResolver } from '@engine/local-file-resolver'
import { parseEbur128Summary } from '@engine/replay-gain'
import { EngineStatusCache, getEngineStatus } from '@engine/sidecar/engine-status'
import { installAsset, sidecarStates } from '@engine/sidecar/install'
import {
  SIDECAR_ASSETS,
  assetsForPlatform,
  sidecarAsset,
  sidecarAssetsByPlatform,
  type SidecarAsset
} from '@engine/sidecar/manifest'
import {
  clearLastKnownGood,
  isManagedBinary,
  restoreLastKnownGood,
  saveLastKnownGood,
  ytDlpRollbackStatus
} from '@engine/sidecar/rollback'
import { resolveUpdateFeedUrl, sanitizeUpdateSettingsPatch } from '@shared/update'
import { isSafeEntryName, readZipEntry } from '@engine/sidecar/zip'
import { RequestScheduler } from '@engine/sidecar/request-scheduler'
import { retryAfterMs, retryWaitMs } from '@core/scheduling/provider-retry'
import {
  parseChannelInfo,
  parseChannelPage,
  parseDurationText,
  parseResolvedChannelId,
  parseSearchPage
} from '@engine/innertube'
import { YouTubeGate } from '@engine/sidecar/youtube-gate'
import { PoTokenProvider, splitCommandLine } from '@engine/sidecar/po-token'
import type { YtInfoProvider, YtMediaInfo } from '@engine/sidecar/yt-dlp'
import {
  buildChannelArgs,
  buildDownloadArgs,
  buildInfoArgs,
  buildPlaylistArgs,
  buildSearchArgs,
  parseChannel,
  parseDownloadProgressLine,
  parsePlaylist,
  parseSearchResults,
  withNetworkTransport
} from '@engine/sidecar/yt-dlp'
import { RemoteStreamProxy, type UpstreamMedia } from '@engine/stream-proxy'
import { ResolverRegistry } from '@engine/resolver'
import { YouTubeResolver } from '@engine/youtube-resolver'
import { StreamCache } from '../src/main/stream-cache'
import { PLAYLIST_INDEX_MAX, PLAYLIST_INDEX_MIN, clampPlaylistIndexWidth } from '@shared/playlists'
import { clampToWorkArea } from '@shared/window-bounds'
import { parseMediaUrl } from '@shared/media-url'
import { buildStreamUrl, parseStreamUrl } from '@shared/stream-url'
import {
  PLAYBACK_RECOVERY_DELAYS_MS,
  recoveryDelayMs,
  shouldRecoverPlayback
} from '@shared/playback-recovery'
import {
  DEFAULT_PO_TOKEN_PROVIDER_URL,
  cleanYouTubeMetadata,
  describeYouTubeFailure,
  extractYouTubeVideoId,
  isCookieFallbackMode,
  isRetryableYouTubeFailure,
  isYouTubeBotCheck,
  normalizeArtistName,
  normalizeCookieBrowserProfile,
  normalizeCookiesFile,
  normalizePoTokenProviderUrl,
  parseYouTubeLink,
  usesAppBoundEncryption,
  withBrowserCookies,
  withCookiesFile,
  withPoTokenProvider,
  youtubeChannelUrl,
  youtubeListTitle,
  youtubeListUrl,
  youtubeThumbnailCandidates,
  youtubeWatchUrl
} from '@shared/youtube'
import { buildArtworkUrl, parseArtworkUrl } from '@shared/artwork-url'
import { formatAudioSummary, formatCodec } from '@shared/format'
import { nextDecision, shuffleFrom, shuffled } from '@shared/queue'
import { sanitizeTaskbarState, taskbarControls } from '@shared/taskbar'
import { parseRangeHeader } from '@shared/range'
import { isImportedPlaylistTrackId, onlineEntryToTrack, onlinePlaylistItemToTrack } from '@shared/online'
import { canPrefetchSearchMatch, mergeLibrarySearch, type SearchPrefetchGate } from '@shared/search'
import { sanitizeFilePart, savePathParts } from '@shared/files'
import { sanitizeArtworkKey, sanitizeTagFields } from '@shared/tags'
import {
  LYRICS_CANDIDATE_LIMIT,
  LYRICS_OFFSET_MAX,
  activeLyricIndex,
  candidatesFromLrclib,
  formatLyricsOffset,
  parseLyrics,
  rankLyricsCandidates,
  sanitizeLyricsCandidate,
  sanitizeLyricsOffset
} from '@shared/lyrics'
import { geniusHits, geniusSearchUrl, isGeniusUrl, lyricsFromGeniusHtml } from '@shared/genius'
import { AsyncTtlCache } from '../src/main/async-cache'
import { cleanupAbandonedDownloads, DownloadService } from '../src/main/download-service'
import { ReplayGainService } from '../src/main/replay-gain-service'
import { LyricsBatchService } from '../src/main/lyrics-batch-service'
import { TagBatchService } from '../src/main/tag-batch-service'
import { mergeDeferredTagWrite, PendingWrites } from '../src/main/pending-writes'

const execFileAsync = promisify(execFile)

const results: Array<{ name: string; ok: boolean; detail: string | null }> = []
let failed = 0

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail: detail ?? null })
  if (!ok) failed += 1
  const suffix = !ok && detail ? `  <- ${detail}` : ''
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${suffix}`)
}

function checkEqual<T>(name: string, actual: T, expected: T): void {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Polls a predicate. Used where the answer arrives from the file system rather
 * than from a promise we can await: a watcher has to be given a moment to notice.
 */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(50)
  }
  return predicate()
}

interface Fixture {
  path: string
  title: string
}

async function generateFlac(
  ffmpeg: string,
  dir: string,
  fileName: string,
  tags: { title: string; artist: string; album: string; track: number; year: number; comment?: string },
  frequency: number
): Promise<string> {
  const target = join(dir, fileName)
  const metadata: string[] = []
  for (const [key, value] of [
    ['title', tags.title],
    ['artist', tags.artist],
    ['album', tags.album],
    ['track', String(tags.track)],
    ['date', String(tags.year)],
    ...(tags.comment ? [['comment', tags.comment] as [string, string]] : [])
  ] as Array<[string, string]>) {
    metadata.push('-metadata', `${key}=${value}`)
  }
  await execFileAsync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=${frequency}:duration=1.2`,
      '-c:a',
      'flac',
      ...metadata,
      target
    ],
    { timeout: 60_000 }
  )
  return target
}

interface ZipTestEntry {
  name: string
  data: Buffer
  /** 0 = stored, 8 = deflated (the default). */
  method?: 0 | 8
}

/**
 * Builds the smallest valid ZIP the installer could meet.
 *
 * CRCs are left at zero because the reader does not verify them; it only trusts
 * the sizes and the pinned archive digest. The point of this fixture is to
 * exercise the central-directory walk and the deflate path without shipping an
 * archive in the repository.
 */
function buildZip(entries: readonly ZipTestEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const method = entry.method ?? 8
    const compressed = method === 8 ? deflateRawSync(entry.data) : entry.data
    const name = Buffer.from(entry.name, 'utf8')

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x0314, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + compressed.length
  }

  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

async function main(): Promise<void> {
  console.log('Suura core smoke test\n')

  // Exercises the sidecar locator/version probe that the engine layer will use.
  const engine = await getEngineStatus({
    binDir: null,
    autoUpdate: false,
    lastUpdateCheckAt: null,
    downloadConcurrency: 1,
    cookiesFromBrowser: null,
    cookieBrowserProfile: null,
    cookiesFile: null,
    cookieFallback: 'off',
    poTokenEnabled: false,
    poTokenProviderUrl: 'http://127.0.0.1:4416',
    poTokenProviderCommand: null,
    poTokenAutoStart: false,
    prefetchNext: true,
    importLimit: 200,
    mixLimit: 50
  })
  check('engine probe located ffmpeg', engine.ffmpeg.found, engine.ffmpeg.error ?? 'not found')
  check('engine probe read the ffmpeg version string', Boolean(engine.ffmpeg.version))
  check('engine probe reports yt-dlp presence without crashing', typeof engine.ytDlp.found === 'boolean')
  console.log(
    `      ffmpeg : ${engine.ffmpeg.path ?? 'missing'}\n      yt-dlp : ${engine.ytDlp.path ?? 'missing'}${
      engine.ytDlp.version ? ` (${engine.ytDlp.version})` : ''
    }\n`
  )

  // The saved probe is what makes the first Settings open instant after a
  // restart. The probe is injected so this never spawns a binary.
  const cacheRoot = await mkdtemp(join(tmpdir(), 'player-engine-cache-'))
  const cacheFile = join(cacheRoot, 'engine-status.json')
  const fakeStatus = (version: string): EngineStatus => ({
    ytDlp: {
      name: 'yt-dlp',
      found: true,
      path: join(cacheRoot, 'yt-dlp.exe'),
      version,
      source: 'path',
      error: null
    },
    ffmpeg: {
      name: 'ffmpeg',
      found: true,
      path: join(cacheRoot, 'ffmpeg.exe'),
      version: 'fake-ffmpeg',
      source: 'path',
      error: null
    },
    ready: true
  })
  const cacheEngine = { ...DEFAULT_SETTINGS.engine }
  let cacheProbes = 0
  const statusCache = new EngineStatusCache({
    file: cacheFile,
    log: silentLogger,
    probe: async () => {
      cacheProbes += 1
      return fakeStatus(`probe-${cacheProbes}`)
    }
  })
  const firstProbe = await statusCache.get(cacheEngine)
  const secondProbe = await statusCache.get(cacheEngine)
  checkEqual('engine cache: the first read runs the probe', cacheProbes, 1)
  checkEqual('engine cache: the next read is served from memory', cacheProbes, 1)
  checkEqual('engine cache: the probe result is returned', firstProbe.ytDlp.version, 'probe-1')
  checkEqual('engine cache: the cached result is returned', secondProbe.ytDlp.version, 'probe-1')

  let restartProbes = 0
  const afterRestart = new EngineStatusCache({
    file: cacheFile,
    log: silentLogger,
    probe: async () => {
      restartProbes += 1
      return fakeStatus('after-restart')
    }
  })
  const restored = await afterRestart.get(cacheEngine)
  checkEqual('engine cache: a restart reads the saved probe', restartProbes, 0)
  checkEqual('engine cache: the saved version survives a restart', restored.ytDlp.version, 'probe-1')

  const forced = await statusCache.get(cacheEngine, { force: true })
  checkEqual('engine cache: Refresh runs a new probe', cacheProbes, 2)
  checkEqual('engine cache: Refresh returns the new result', forced.ytDlp.version, 'probe-2')

  await statusCache.get({ ...cacheEngine, binDir: cacheRoot })
  checkEqual('engine cache: a changed engine folder is probed again', cacheProbes, 3)
  await rm(cacheRoot, { recursive: true, force: true })

  const ffmpegPath = engine.ffmpeg.path
  if (!ffmpegPath) {
    console.log('SKIP  ffmpeg was not found, so no fixtures can be generated.')
    console.log('      Install ffmpeg on PATH (or set engine.binDir in the app) and re-run.')
    process.exitCode = 2
    return
  }
  console.log(`Using ffmpeg at ${ffmpegPath}\n`)

  const root = await mkdtemp(join(tmpdir(), 'player-smoke-'))
  const musicDir = join(root, 'music')
  const nestedDir = join(musicDir, 'Album A')
  await mkdir(nestedDir, { recursive: true })

  const fixtures: Fixture[] = []
  try {
    fixtures.push({
      path: await generateFlac(
        ffmpegPath,
        nestedDir,
        '01 - Test Tone A.flac',
        { title: 'Test Tone A', artist: 'Smoke Artist', album: 'Fixtures Vol 1', track: 1, year: 2021 },
        440
      ),
      title: 'Test Tone A'
    })
    fixtures.push({
      path: await generateFlac(
        ffmpegPath,
        nestedDir,
        '02 - Test Tone B.flac',
        { title: 'Test Tone B', artist: 'Smoke Artist', album: 'Fixtures Vol 1', track: 2, year: 2021 },
        523
      ),
      title: 'Test Tone B'
    })
    fixtures.push({
      path: await generateFlac(
        ffmpegPath,
        musicDir,
        'Loose Third.flac',
        { title: 'Loose Third', artist: 'Another Artist', album: 'Assorted', track: 9, year: 2019 },
        659
      ),
      title: 'Loose Third'
    })

    // A second album folder, to prove nested directories are walked.
    const albumB = join(musicDir, 'Album B')
    await mkdir(albumB, { recursive: true })
    fixtures.push({
      path: await generateFlac(
        ffmpegPath,
        albumB,
        'Nested Fourth.flac',
        { title: 'Nested Fourth', artist: 'Another Artist', album: 'Album B', track: 1, year: 2022 },
        784
      ),
      title: 'Nested Fourth'
    })
    // Hidden directories are skipped entirely, so this one must not be indexed.
    const hiddenDir = join(musicDir, '.hidden')
    await mkdir(hiddenDir, { recursive: true })
    await generateFlac(ffmpegPath, hiddenDir, 'Ignored.flac', { title: 'Ignored', artist: 'X', album: 'Y', track: 1, year: 2020 }, 200)
    // ...and so must a file with a non-audio extension.
    await writeFile(join(musicDir, 'notes.txt'), 'this is not audio\n', 'utf8')

    // --- database ---------------------------------------------------------
    const paths = resolveAppPaths(join(root, 'userData'))
    ensureAppDirectories(paths)

    const database = openLibraryDatabase(paths.database, silentLogger)
    checkEqual('schema is at the latest migration version', database.schemaVersion, latestVersion())

    const repo = new TrackRepository(database.db)
    const settings = new SettingsService(paths.config, silentLogger)
    const library = new LibraryService(repo, settings, silentLogger)

    // --- scan -------------------------------------------------------------
    const stats = await library.scan(musicDir)
    checkEqual('scan indexed exactly the 4 audio files', stats.tracks, 4)
    checkEqual('scan recorded one library folder', settings.get().libraryFolders.length, 1)
    check('scan recorded a finish timestamp', stats.lastScanAt !== null && stats.lastScanAt > 0)

    const page = library.list()
    const tracks = page.tracks
    const toneA = tracks.find((track) => track.title === 'Test Tone A')
    check('tags were read (title, artist, album)', Boolean(toneA?.artist === 'Smoke Artist' && toneA.album === 'Fixtures Vol 1'))
    check('track number was read from the tag', toneA?.trackNo === 1)
    check('duration was read from the header', Boolean(toneA?.durationMs && toneA.durationMs > 900))
    check('codec was detected', Boolean(toneA?.codec))
    check('file size and path were stored', Boolean(toneA?.fileSize && toneA.filePath))
    check('album artist fell back to the track artist', toneA?.albumArtist === 'Smoke Artist')
    check(
      'files inside a hidden directory were skipped',
      !tracks.some((track) => track.title === 'Ignored')
    )
    check(
      'the non-audio file was skipped',
      !tracks.some((track) => (track.filePath ?? '').endsWith('notes.txt'))
    )

    // --- incremental rescan ----------------------------------------------
    await library.scan(musicDir)
    const secondRun: ScanRunSummary | null = repo.lastScanRun()
    checkEqual('rescan read no tags at all (size+mtime fast path)', secondRun?.skipped ?? -1, 4)
    checkEqual('rescan inserted nothing', secondRun?.indexed ?? -1, 0)
    checkEqual('rescan produced no duplicate rows', library.list().tracks.length, 4)

    // Touch a file so its mtime changes without changing its path.
    const subject = fixtures[0]
    if (subject) {
      const future = new Date(Date.now() + 5000)
      await utimes(subject.path, future, future)
    }
    await library.scan(musicDir)
    const thirdRun: ScanRunSummary | null = repo.lastScanRun()
    checkEqual('a re-touched file was re-read', thirdRun?.updated ?? -1, 1)
    checkEqual('re-reading a file does not duplicate it', repo.stats().tracks, 4)

    // --- replay gain storage ----------------------------------------------
    checkEqual('replay gain: a newly indexed file starts unmeasured', toneA?.replayGainDb ?? null, null)
    checkEqual('replay gain: the library counts every local file', repo.replayGainStats().total, 4)
    checkEqual('replay gain: no file is measured yet', repo.replayGainStats().analyzed, 0)
    checkEqual('replay gain: the scan queue contains every local file', repo.replayGainCandidates().length, 4)
    if (toneA) {
      repo.setReplayGain(toneA.id, -4.5, -0.8)
      const measured = repo.getById(toneA.id)
      checkEqual('replay gain: a measured gain is stored on the track', measured?.replayGainDb ?? null, -4.5)
      checkEqual('replay gain: the true peak is stored alongside it', measured?.replayGainPeak ?? null, -0.8)
      checkEqual('replay gain: a measured file leaves the scan queue', repo.replayGainCandidates().length, 3)
      checkEqual('replay gain: the analysed count follows', repo.replayGainStats().analyzed, 1)

      // The measurement belongs to the bytes. A changed file must not keep
      // applying an old gain, so the scanner clears both columns.
      if (toneA.filePath) {
        const changed = new Date(Date.now() + 10_000)
        await utimes(toneA.filePath, changed, changed)
        await library.scan(musicDir)
        const rescanned = repo.getById(toneA.id)
        checkEqual('replay gain: a changed file loses its stale gain', rescanned?.replayGainDb ?? null, null)
        checkEqual('replay gain: a changed file rejoins the scan queue', repo.replayGainCandidates().length, 4)
      }
    }

    // The whole scan, not just its pieces: the service locates ffmpeg, runs two
    // workers over the real fixtures, writes measured values and reports a
    // finished phase. The generated tones are small, so this is quick.
    const gainProgress: string[] = []
    const gainService = new ReplayGainService({
      settings,
      repo,
      log: silentLogger,
      onProgress: (status) => gainProgress.push(status.phase)
    })
    const gainResult = await gainService.scan()
    checkEqual('replay gain: the scan measured every local file', gainResult.libraryAnalyzed, 4)
    checkEqual('replay gain: a finished scan leaves nothing queued', repo.replayGainCandidates().length, 0)
    checkEqual('replay gain: the service reports completion', gainResult.phase, 'done')
    check(
      'replay gain: progress includes a scan and a finish',
      gainProgress.includes('scanning') && gainProgress[gainProgress.length - 1] === 'done',
      gainProgress.join(',')
    )
    check(
      'replay gain: measured files carry a finite gain and peak',
      repo
        .list()
        .tracks.every(
          (track) =>
            typeof track.replayGainDb === 'number' &&
            Number.isFinite(track.replayGainDb) &&
            typeof track.replayGainPeak === 'number' &&
            Number.isFinite(track.replayGainPeak)
        )
    )
    gainService.dispose()

    // --- search -----------------------------------------------------------
    const searchHits = library.list({ search: 'Tone' }).tracks
    check('full-text search matched by title prefix', searchHits.length === 2, `got ${searchHits.length}`)
    const artistHits = library.list({ search: 'Another' }).tracks
    checkEqual('full-text search matched both tracks by artist', artistHits.length, 2)
    check(
      'search results carry the matched artist',
      artistHits.every((track) => track.artist === 'Another Artist')
    )
    const noHits = library.list({ search: 'zzzznotpresent' })
    checkEqual('full-text search returns nothing for a missing term', noHits.tracks.length, 0)
    checkEqual('the total counts the whole result set, not the page', noHits.total, 0)
    const punctuated = library.list({ search: 'AC/DC "Back in Black"' }).tracks
    check('punctuated search input does not throw', Array.isArray(punctuated))
    checkEqual('FTS query sanitisation drops punctuation', buildFtsQuery('AC/DC'), '"AC"* AND "DC"*')
    checkEqual('FTS query sanitisation returns null for empty input', buildFtsQuery('   ...   '), null)

    // --- sorting and paging ------------------------------------------------
    // The list is virtualized and pages through the result set, so the order has
    // to be a *total* order: if two rows compare equal, a different page can come
    // back in a different order and rows are skipped or repeated.
    const byTitleAsc = library.list({ sort: 'title', direction: 'asc', limit: 2 })
    checkEqual('a page reports the full result count', byTitleAsc.total, 4)
    checkEqual('a page is limited', byTitleAsc.tracks.length, 2)
    const byTitleDesc = library.list({ sort: 'title', direction: 'desc', limit: 2 })
    check(
      'descending order reverses the page',
      byTitleDesc.tracks[0]?.title !== byTitleAsc.tracks[0]?.title,
      `${byTitleAsc.tracks[0]?.title} / ${byTitleDesc.tracks[0]?.title}`
    )
    const firstPage = library.list({ sort: 'title', direction: 'asc', limit: 2, offset: 0 }).tracks
    const secondPage = library.list({ sort: 'title', direction: 'asc', limit: 2, offset: 2 }).tracks
    const pagedIds = [...firstPage, ...secondPage].map((track) => track.id)
    checkEqual('paging visits every row exactly once', new Set(pagedIds).size, 4)
    checkEqual(
      'paging is in the same order as one big page',
      pagedIds.join(','),
      library.list({ sort: 'title', direction: 'asc', limit: 10 }).tracks.map((track) => track.id).join(',')
    )
    const byDuration = library.list({ sort: 'duration', direction: 'desc' }).tracks
    const durations = byDuration.map((track) => track.durationMs ?? 0)
    check(
      'sorting by duration is monotonic',
      durations.every((value, index) => index === 0 || (durations[index - 1] as number) >= value),
      durations.join(' / ')
    )
    const unknownSort = library.list({ sort: 'title; DROP TABLE tracks' as never }).tracks
    check('an unknown sort field falls back to the default order', unknownSort.length === 4)
    check('the tracks table survived the sort attempt', repo.stats().tracks === 4)

    // --- resolution -------------------------------------------------------
    const resolver = new LocalFileResolver()
    if (toneA) {
      const source = await resolver.resolve(toneA)
      check('resolver produced a player-media URL', source.url.startsWith('player-media://media/'), source.url)
      const parsed = parseMediaUrl(source.url)
      checkEqual('media URL round-trips to the original path', parsed?.path ?? null, toneA.filePath)
      check('resolver reported a MIME type', source.mimeType === 'audio/flac', String(source.mimeType))
      checkEqual('file URLs never expire', source.expiresAt, null)
    }

    // --- play reporting ---------------------------------------------------
    check(
      'a listen below the threshold is not a play',
      !countsAsPlay(PLAY_COUNT_THRESHOLD_MS - 1, false)
    )
    check('a listen at the threshold is a play', countsAsPlay(PLAY_COUNT_THRESHOLD_MS, false))
    check('a completed listen is always a play', countsAsPlay(0, true))

    const session = new PlaySession()
    check('a fresh listen may be reported', session.shouldReport(1, 1_000, false))
    check('crossing the threshold is reported live', session.shouldReport(1, 31_000, false))
    check(
      'the end report does not count the same listen twice',
      !session.shouldReport(1, 31_500, true)
    )
    session.begin()
    check('replaying the track starts a new countable listen', session.shouldReport(1, 31_000, false))
    check('a different track gets its own listen', session.shouldReport(2, 0, true))

    if (toneA) {
      library.reportPlayback(toneA.id, 1000, false)
      checkEqual('a skipped listen is not counted as played', repo.getById(toneA.id)?.playCount ?? -1, 0)
      library.reportPlayback(toneA.id, 1000, true)
      checkEqual('a completed listen increments the play count', repo.getById(toneA.id)?.playCount ?? -1, 1)
      library.reportPlayback(toneA.id, 31_000, false)
      checkEqual('listening past the threshold counts as played', repo.getById(toneA.id)?.playCount ?? -1, 2)
      check('the last-played timestamp was recorded', Boolean(repo.getById(toneA.id)?.lastPlayedAt))

      let playHistoryEvents = 0
      const watchedLibrary = new LibraryService(repo, settings, silentLogger, {
        onPlayHistoryChanged: () => {
          playHistoryEvents += 1
        }
      })
      // Use an id that cannot exist so the event assertions do not perturb the
      // library-wide play counts checked below.
      watchedLibrary.reportPlayback(-1, 1000, false)
      checkEqual('a skipped listen sends no play-history change', playHistoryEvents, 0)
      watchedLibrary.reportPlayback(-1, 1000, true)
      checkEqual('a completed listen sends one play-history change', playHistoryEvents, 1)
      watchedLibrary.reportPlayback(-1, 31_000, false)
      checkEqual('a threshold listen sends one play-history change', playHistoryEvents, 2)
    }

    // --- the Recently played shelf ---------------------------------------
    // A played file with no album tag has no album card, so Home has to merge
    // those singles into the shelf itself. The merge is the part that decides
    // which card represents a listen; the SQL below proves the query can find
    // them without a scan-time copy of album data.
    const mergeAlbum = (name: string, at: number | null) =>
      ({ album: name, lastPlayedAt: at, trackCount: 2, trackId: -1 }) as AlbumSummary
    // The added shelf reads a different timestamp, so an album fixture built for
    // the played shelf would sort as `undefined`. Keep the two explicit.
    const mergeAddedAlbum = (name: string, at: number | null) =>
      ({ album: name, addedAt: at, trackCount: 2, trackId: -1 }) as AlbumSummary
    const mergeTrack = (id: number, album: string | null, at: number | null) =>
      ({ id, album, lastPlayedAt: at }) as Track
    const mergeStream = (videoId: string, album: string | null, at: number | null) =>
      ({
        id: 0,
        sourceKind: 'youtube',
        sourceId: videoId,
        originKind: null,
        originId: null,
        album,
        lastPlayedAt: at
      }) as Track
    const merged = mergePlayedShelf(
      [mergeAlbum('Older', 100), mergeAlbum('Unplayed', null)],
      [
        mergeTrack(7, null, 300),
        mergeTrack(8, 'Has Album', 400),
        mergeTrack(9, null, 200),
        // A downloaded stream: the same video must not be shown twice.
        ({ ...mergeTrack(10, null, 500), originKind: 'youtube', originId: 'samevideo1' } as Track)
      ],
      [mergeStream('samevideo1', null, 600), mergeStream('streamtwo', 'YouTube Album', 450)],
      4
    )
    checkEqual(
      'recently played merges albums, albumless singles and streams newest first',
      merged
        .map((entry) =>
          entry.kind === 'album'
            ? entry.album.album
            : entry.track.sourceKind === 'youtube'
              ? entry.track.sourceId
              : entry.track.id
        )
        .join(','),
      '10,streamtwo,7,9'
    )
    check(
      'recently played skips album tracks, unplayed rows and downloaded duplicates',
      !merged.some((entry) => entry.kind === 'track' && entry.track.id === 8) &&
        !merged.some((entry) => entry.kind === 'album' && entry.album.album === 'Unplayed') &&
        !merged.some((entry) => entry.kind === 'track' && entry.track.sourceId === 'samevideo1')
    )
    check(
      'a YouTube album tag does not hide a stream from recently played',
      merged.some((entry) => entry.kind === 'track' && entry.track.sourceId === 'streamtwo')
    )

    const addedMerge = mergeAddedShelf(
      [
        mergeAddedAlbum('Recent Album', 200),
        // A release with one file is a track; its album card must give way to
        // the track card, which is what carries the track actions.
        ({ ...mergeAddedAlbum('Single Release', 250), trackCount: 1, trackId: 13 } as AlbumSummary)
      ],
      [
        ({ ...mergeTrack(11, null, 300), addedAt: 300 } as Track),
        ({ ...mergeTrack(12, 'Has Album', 400), addedAt: 400 } as Track),
        ({ ...mergeTrack(13, 'Single Release', 250), addedAt: 250 } as Track)
      ],
      3
    )
    checkEqual(
      'recently added merges albumless files with albums newest first',
      addedMerge.map((entry) => (entry.kind === 'album' ? entry.album.album : entry.track.id)).join(','),
      '11,13,Recent Album'
    )
    check(
      'recently added keeps album tracks on their album card',
      !addedMerge.some((entry) => entry.kind === 'track' && entry.track.id === 12)
    )
    check(
      'recently added shows a one-file release as its track, not an album',
      addedMerge.some((entry) => entry.kind === 'track' && entry.track.id === 13) &&
        !addedMerge.some((entry) => entry.kind === 'album' && entry.album.album === 'Single Release')
    )

    const playedSingle = mergePlayedShelf(
      [({ ...mergeAlbum('Solo Release', 150), trackCount: 1, trackId: 13 } as AlbumSummary)],
      [mergeTrack(13, 'Solo Release', 150)],
      [],
      3
    )
    checkEqual(
      'recently played shows a one-file release as its track, not an album',
      playedSingle.map((entry) => (entry.kind === 'album' ? entry.album.album : entry.track.id)).join(','),
      '13'
    )

    // The stream play log is what makes a YouTube listen visible on Home.
    const streamPlays = new StreamPlayRepository(database.db)
    streamPlays.upsert(
      { videoId: 'streamone1', title: 'Stream One', artist: 'A', album: null, durationMs: 1000 },
      1_000
    )
    streamPlays.upsert(
      { videoId: 'streamtwo2', title: 'Stream Two', artist: 'B', album: 'Record', durationMs: 2000 },
      2_000
    )
    checkEqual('a stream play is written once', streamPlays.count(), 2)
    checkEqual(
      'stream plays list newest first',
      streamPlays.list().map((play) => play.videoId).join(','),
      'streamtwo2,streamone1'
    )
    const replayed = streamPlays.upsert(
      { videoId: 'streamone1', title: 'Stream One', artist: 'A', album: null, durationMs: 1000 },
      3_000
    )
    checkEqual('replaying a stream counts another listen', replayed.playCount, 2)
    checkEqual(
      'a replayed stream rises to the top',
      streamPlays.list()[0]?.videoId,
      'streamone1'
    )
    check(
      'touching an unknown stream row changes nothing',
      !streamPlays.touch(9_999, 4_000) && streamPlays.count() === 2
    )
    streamPlays.clear()
    checkEqual('the play log can be cleared', streamPlays.count(), 0)

    const singleId = repo.insert(
      {
        contentKey: 'smoke-albumless-single',
        sourceKind: 'local',
        sourceId: null,
        originKind: null,
        originId: null,
        title: 'Smoke Single',
        artist: 'Smoke',
        albumArtist: null,
        album: null,
        trackNo: null,
        discNo: null,
        trackTotal: null,
        discTotal: null,
        year: null,
        genre: null,
        durationMs: 1000,
        codec: 'flac',
        bitrateKbps: null,
        sampleRate: null,
        channels: null,
        fileSize: null,
        fileMtimeMs: null,
        filePath: null
      },
      Date.now()
    )
    library.reportPlayback(singleId, 31_000, false)
    const albumlessPlays = library.list({
      sort: 'played',
      direction: 'desc',
      filter: 'most-played',
      albumless: true
    })
    check(
      'an albumless query returns the played single',
      albumlessPlays.tracks.some((track) => track.id === singleId)
    )
    check(
      'an albumless query excludes album tracks',
      albumlessPlays.tracks.every((track) => track.album === null || track.album.trim() === '')
    )
    repo.deleteByIds([singleId])

    // --- smart library views ----------------------------------------------
    // The chips are answered by SQL, so the checks are about the sets and the
    // natural order rather than about a renderer predicate that could drift.
    check('the library filter allowlist accepts a local view', isLocalLibraryFilter('most-played'))
    check('the library filter allowlist refuses the history chip', !isLocalLibraryFilter('streams'))
    check(
      'the library filter allowlist refuses arbitrary SQL text',
      !isLocalLibraryFilter("recent' OR 1=1 --")
    )

    const recent = library.list({ filter: 'recent' })
    checkEqual('recently added includes a just-scanned library', recent.total, 4)
    check(
      'recently added opens newest first',
      recent.tracks.every(
        (track, index) => index === 0 || (recent.tracks[index - 1]?.addedAt ?? 0) >= track.addedAt
      )
    )

    const mostPlayed = library.list({ filter: 'most-played' })
    checkEqual('most played only includes tracks with a play', mostPlayed.total, 1)
    checkEqual('the played track is the one reported', mostPlayed.tracks[0]?.id, toneA?.id)

    const neverPlayed = library.list({ filter: 'never-played' })
    checkEqual('never played is the complement of most played', neverPlayed.total, 3)
    check(
      'never played excludes the track that was heard',
      !neverPlayed.tracks.some((track) => track.id === toneA?.id)
    )
    checkEqual(
      'a search and a smart filter combine',
      library.list({ filter: 'most-played', search: 'Another' }).total,
      0
    )

    const smartStats = library.stats()
    checkEqual('the stats count recent rows', smartStats.recentTracks, 4)
    checkEqual('the stats count played rows', smartStats.playedTracks, 1)
    checkEqual('the stats count unplayed rows', smartStats.unplayedTracks, 3)

    if (toneA) {
      // Push one row outside the window without touching its file. The view has
      // to be a date window, not "the four newest rows".
      database.db
        .prepare('UPDATE tracks SET added_at = ? WHERE id = ?')
        .run(recentlyAddedCutoff() - 1, toneA.id)
      checkEqual(
        'recently added honours the date window',
        library.list({ filter: 'recent' }).total,
        3
      )
      checkEqual('the recent count follows the same window', library.stats().recentTracks, 3)
    }

    // --- album and artist summaries ---------------------------------------
    // Home groups by album title plus the album artist fallback, so these checks
    // cover the same rule the artwork cache already uses.
    const albumPage = library.listAlbums({ sort: 'title' })
    checkEqual('album summaries count distinct albums', albumPage.total, 3)
    checkEqual('album summaries return every album on one page', albumPage.albums.length, 3)
    checkEqual('the library album count uses the grid’s grouping', library.stats().albums, albumPage.total)
    const fixturesAlbum = albumPage.albums.find((album) => album.album === 'Fixtures Vol 1')
    checkEqual('album summaries fall back to the track artist', fixturesAlbum?.albumArtist, 'Smoke Artist')
    checkEqual('album summaries count their tracks', fixturesAlbum?.trackCount, 2)
    check(
      'album summaries carry a representative track',
      Number.isInteger(fixturesAlbum?.trackId) && repo.getById(fixturesAlbum?.trackId ?? -1)?.album === 'Fixtures Vol 1'
    )
    check(
      'album summaries sum the album duration',
      (fixturesAlbum?.durationMs ?? 0) > 0
    )
    checkEqual('album search matches a title', library.listAlbums({ search: 'Assorted' }).total, 1)
    checkEqual(
      'album search matches the album artist',
      library.listAlbums({ search: 'Smoke' }).total,
      1
    )
    checkEqual(
      'the artist filter keeps that artist’s albums',
      library.listAlbums({ artist: 'Another Artist' }).total,
      2
    )
    checkEqual('album pages honour the offset', library.listAlbums({ limit: 2, offset: 2 }).albums.length, 1)

    const artistRows = library.listArtists(10)
    checkEqual('artist summaries group by artist', artistRows.length, 2)
    const smokeArtist = artistRows.find((artist) => artist.artist === 'Smoke Artist')
    checkEqual('artist summaries count tracks', smokeArtist?.trackCount, 2)
    checkEqual('artist summaries count distinct albums', smokeArtist?.albumCount, 1)
    check(
      'artist summaries carry a representative track',
      Number.isInteger(smokeArtist?.trackId) && repo.getById(smokeArtist?.trackId ?? -1)?.artist === 'Smoke Artist'
    )

    const albumTracks = library.list({
      album: 'Fixtures Vol 1',
      albumArtist: 'Smoke Artist',
      sort: 'album',
      direction: 'asc'
    })
    checkEqual('album detail returns only that album', albumTracks.total, 2)
    check(
      'album detail is ordered by track number',
      albumTracks.tracks[0]?.trackNo === 1 && albumTracks.tracks[1]?.trackNo === 2
    )
    checkEqual(
      'an exact artist query returns that artist’s tracks',
      library.list({ artist: 'Another Artist' }).total,
      2
    )

    // --- allowlist --------------------------------------------------------
    check('a file inside a library folder is allowed', library.isPathAllowed(join(musicDir, 'x.flac')))
    check('a file outside every library folder is denied', !library.isPathAllowed(join(root, 'elsewhere.flac')))
    check('normalisation is case-insensitive on Windows', normalizePath(musicDir) === normalizePath(musicDir.toUpperCase()))
    check(
      'sibling folders with a shared prefix are not treated as nested',
      !isPathInside(join(root, 'music'), join(root, 'music-other', 'song.flac'))
    )
    checkEqual('content keys are stable', localContentKey(join(musicDir, 'x.flac')), localContentKey(join(musicDir, 'x.flac')))

    // --- display formatting ------------------------------------------------
    // The library table has one narrow column for codec and bitrate, so the raw
    // container names ("MPEG-4/AAC", "MPEG-1 Layer 3") have to be shortened.
    checkEqual('an mp4/aac codec is shortened', formatCodec('MPEG-4/AAC'), 'AAC')
    checkEqual('a layer-3 codec becomes mp3', formatCodec('MPEG-1 Layer 3'), 'MP3')
    checkEqual('flac keeps its name', formatCodec('FLAC'), 'FLAC')
    checkEqual('an unknown codec is passed through', formatCodec('AC-3'), 'AC-3')
    checkEqual('a missing codec becomes a dash', formatCodec(null), '--')
    checkEqual('codec and bitrate are joined', formatAudioSummary('MPEG-4/AAC', 421.4), 'AAC · 421 kbps')
    checkEqual('bitrate alone is enough', formatAudioSummary(null, 320), '320 kbps')
    checkEqual('nothing known shows a dash', formatAudioSummary(null, null), '—')

    // --- queue rules --------------------------------------------------------
    // Repeat and shuffle decide what plays next, which is the one behaviour a
    // user notices immediately when it is wrong (a queue that stops one track
    // early, or a shuffle that loses the track you are listening to).
    const decision = (position: number, length: number, repeat: 'off' | 'all' | 'one', completed: boolean): string => {
      const result = nextDecision(position, length, repeat, completed)
      return result.kind === 'play' ? `play:${result.position}` : result.kind
    }
    checkEqual('the next track plays', decision(0, 3, 'off', true), 'play:1')
    checkEqual('the end of the queue stops when repeat is off', decision(2, 3, 'off', true), 'stop')
    checkEqual('repeat all wraps to the start', decision(2, 3, 'all', true), 'play:0')
    checkEqual('repeat one replays a finished track', decision(1, 3, 'one', true), 'replay')
    checkEqual('repeat one still skips on a manual next', decision(1, 3, 'one', false), 'play:2')
    checkEqual('a manual next at the end stops without repeat', decision(2, 3, 'off', false), 'stop')
    checkEqual('an empty queue never plays', decision(-1, 0, 'all', true), 'stop')
    checkEqual('a single track with repeat all loops', decision(0, 1, 'all', true), 'play:0')

    // --- taskbar controls ---------------------------------------------------
    // Windows only shows these in the thumbnail preview, and their play/pause
    // label has to follow the player. Kept pure so the decision is checked even
    // when the smoke run is not on Windows.
    const noTaskbar = taskbarControls(false, false)
    checkEqual('an empty player offers no taskbar buttons', noTaskbar.length, 0)
    const pausedTaskbar = taskbarControls(true, false)
    checkEqual('a loaded track offers three taskbar buttons', pausedTaskbar.length, 3)
    checkEqual(
      'the middle taskbar button plays while paused',
      pausedTaskbar[1]?.command.type === 'play-pause' && pausedTaskbar[1].tooltip === 'Play',
      true
    )
    checkEqual(
      'the middle taskbar button pauses while playing',
      taskbarControls(true, true)[1]?.tooltip,
      'Pause'
    )
    check(
      'taskbar state rejects malformed input',
      sanitizeTaskbarState({ hasTrack: true }) === null &&
        sanitizeTaskbarState({ hasTrack: true, isPlaying: true })?.isPlaying === true
    )
    checkEqual(
      'taskbar state carries the playing row id',
      sanitizeTaskbarState({ hasTrack: true, isPlaying: true, trackId: 42 })?.trackId,
      42
    )
    check(
      'taskbar state drops a nonsense track id rather than trusting it',
      sanitizeTaskbarState({ hasTrack: true, isPlaying: true, trackId: -3 })?.trackId === null &&
        sanitizeTaskbarState({ hasTrack: true, isPlaying: true, trackId: 'x' })?.trackId === null
    )

    const sequence = ['a', 'b', 'c', 'd', 'e']
    const shuffling = shuffled(sequence, () => 0.5)
    checkEqual('shuffling keeps every entry', [...shuffling].sort().join(''), [...sequence].sort().join(''))
    checkEqual('shuffling does not mutate the input', sequence.join(''), 'abcde')
    checkEqual('a deterministic shuffle is repeatable', shuffled(sequence, () => 0.5).join(''), shuffling.join(''))
    const kept = shuffleFrom(sequence, 2, () => 0.5)
    checkEqual('shuffle keeps the playing track first', kept[0], 'c')
    checkEqual('shuffle keeps the playing track only once', kept.filter((item) => item === 'c').length, 1)
    checkEqual('shuffle keeps every entry', [...kept].sort().join(''), [...sequence].sort().join(''))
    checkEqual('shuffle with nothing playing just shuffles', shuffleFrom(sequence, -1, () => 0.5).length, 5)

    // --- range requests ---------------------------------------------------
    checkEqual('open-ended range', JSON.stringify(parseRangeHeader('bytes=100-', 1000)), JSON.stringify({ start: 100, end: 999 }))
    checkEqual('closed range', JSON.stringify(parseRangeHeader('bytes=0-99', 1000)), JSON.stringify({ start: 0, end: 99 }))
    checkEqual('suffix range', JSON.stringify(parseRangeHeader('bytes=-50', 1000)), JSON.stringify({ start: 950, end: 999 }))
    checkEqual('end beyond file size is clamped', JSON.stringify(parseRangeHeader('bytes=990-5000', 1000)), JSON.stringify({ start: 990, end: 999 }))
    checkEqual('start beyond file size is rejected', parseRangeHeader('bytes=1000-', 1000), null)
    checkEqual('reversed range is rejected', parseRangeHeader('bytes=500-100', 1000), null)
    checkEqual('multi-range is rejected', parseRangeHeader('bytes=0-10,20-30', 1000), null)
    checkEqual('garbage is rejected', parseRangeHeader('pages=1-2', 1000), null)

    // --- artwork ----------------------------------------------------------
    // Cover art is read lazily (it is a second parse of the file), resized and
    // cached under a content hash. These checks cover what does not need
    // Electron: pulling a picture out of a real file, and the three-state
    // bookkeeping the UI depends on (not looked at / none / cached).
    const coverPath = join(root, 'cover.png')
    await execFileAsync(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=#3355ff:s=80x80', '-frames:v', '1', coverPath],
      { timeout: 60_000 }
    )
    const artTrackPath = join(root, 'With Cover.mp3')
    await execFileAsync(
      ffmpegPath,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'sine=frequency=330:duration=1',
        '-i', coverPath,
        '-map', '0:a', '-map', '1:v',
        '-c:a', 'libmp3lame', '-c:v', 'copy',
        '-id3v2_version', '3',
        '-metadata', 'title=With Cover',
        '-metadata', 'artist=Cover Artist',
        '-metadata', 'album=Cover Album',
        '-metadata:s:v', 'title=Album cover',
        '-metadata:s:v', 'comment=Cover (front)',
        artTrackPath
      ],
      { timeout: 60_000 }
    )

    const embedded = await extractArtwork(artTrackPath)
    check('artwork is extracted from a file with an embedded cover', Boolean(embedded && embedded.data.length > 0))
    checkEqual('the embedded cover kept its format', embedded?.mime, 'image/png')
    const coverless = toneA ? await extractArtwork(toneA.filePath as string) : null
    checkEqual('a file with no cover reports none', coverless, null)

    checkEqual('PNG covers map to a .png extension', extensionForMime('image/png'), '.png')
    checkEqual('JPEG covers map to a .jpg extension', extensionForMime('image/jpeg'), '.jpg')
    checkEqual('image format matching ignores case', extensionForMime('IMAGE/JPEG'), '.jpg')
    checkEqual('an image format we cannot serve is refused', extensionForMime('image/tiff'), null)

    const artworkKey = artworkKeyFor(new Uint8Array([1, 2, 3]), '.jpg')
    check('an artwork key is a content hash plus its extension', /^[0-9a-f]{40}\.jpg$/.test(artworkKey), artworkKey)
    checkEqual('identical covers produce identical keys', artworkKeyFor(new Uint8Array([1, 2, 3]), '.jpg'), artworkKey)
    check('different covers produce different keys', artworkKeyFor(new Uint8Array([1, 2, 4]), '.jpg') !== artworkKey)

    const artworkUrl = buildArtworkUrl(artworkKey)
    check('an artwork URL uses the player-art scheme', artworkUrl.startsWith('player-art://art/'), artworkUrl)
    checkEqual('an artwork URL round-trips to its key', parseArtworkUrl(artworkUrl)?.key ?? null, artworkKey)
    checkEqual('a media URL is not accepted as artwork', parseArtworkUrl('player-media://media/?path=x'), null)
    checkEqual('a malformed artwork URL is rejected', parseArtworkUrl('not a url'), null)
    checkEqual('an empty artwork key is rejected', parseArtworkUrl('player-art://art/'), null)

    // null and '' must stay different: null sends the UI to the main process to
    // look, '' tells it there is nothing to find.
    if (toneA) {
      checkEqual('a freshly indexed track has no artwork verdict yet', repo.artworkState(toneA.id)?.artworkKey, null)
      checkEqual('an unlooked-at track shows no artwork in the UI', repo.getById(toneA.id)?.artworkKey, null)
      repo.setArtworkKey(toneA.id, artworkKey)
      checkEqual('a cached key is stored', repo.artworkState(toneA.id)?.artworkKey, artworkKey)
      checkEqual('a cached key reaches the UI', repo.getById(toneA.id)?.artworkKey, artworkKey)
      checkEqual('a sibling on the same album reuses the key', repo.artworkKeyForAlbum('Fixtures Vol 1', 'Smoke Artist'), artworkKey)
      repo.setArtworkKey(toneA.id, '')
      checkEqual('"no artwork" is remembered as a verdict', repo.artworkState(toneA.id)?.artworkKey, '')
      checkEqual('"no artwork" is hidden from the UI', repo.getById(toneA.id)?.artworkKey, null)
      checkEqual('an album with no cached key reports none', repo.artworkKeyForAlbum('Fixtures Vol 1', 'Smoke Artist'), null)
    }

    // --- playlists ----------------------------------------------------------
    // A playlist is a hand-ordered list, so almost everything worth testing is
    // about order: what an append does, what a drop between two rows does, and
    // what happens when drops into the same gap run out of room between them.
    const playlists = new PlaylistService(new PlaylistRepository(database.db), repo, silentLogger)
    const titlesOf = (playlistId: number): string[] =>
      (playlists.detail(playlistId)?.items ?? []).map((item) => item.track.title)
    const entryIdsOf = (playlistId: number): number[] =>
      (playlists.detail(playlistId)?.items ?? []).map((item) => item.id)

    const allIds = library.list().tracks.map((track) => track.id)
    const allTitles = library.list().tracks.map((track) => track.title)

    const road = playlists.create('  Road   Trip  ')
    checkEqual('a playlist name is trimmed and collapsed', road.name, 'Road Trip')
    checkEqual('a new playlist is empty', road.trackCount, 0)

    const appended = playlists.addTracks(road.id, allIds)
    checkEqual('every track was added', appended.added, allIds.length)
    checkEqual('the playlist keeps the order the tracks were added in', titlesOf(road.id).join(' | '), allTitles.join(' | '))
    checkEqual('the entry count follows the contents', playlists.detail(road.id)?.playlist.trackCount, allIds.length)

    const repeated = playlists.addTracks(road.id, [allIds[0] as number, 999_999])
    checkEqual('adding a track that is already there adds nothing', repeated.added, 0)
    checkEqual('the duplicate and the track that does not exist are both skipped', repeated.skipped, 2)
    checkEqual('skipping changed nothing', titlesOf(road.id).length, allIds.length)

    // Moving: `toIndex` is the index in the order *after* the move, which is what
    // a drop position means on screen.
    const entries = entryIdsOf(road.id)
    playlists.moveItem(road.id, entries[3] as number, 0)
    checkEqual(
      'the last entry can be moved to the front',
      titlesOf(road.id).join(' | '),
      [allTitles[3], allTitles[0], allTitles[1], allTitles[2]].join(' | ')
    )
    playlists.moveItem(road.id, entries[3] as number, 3)
    checkEqual('and back to the end', titlesOf(road.id).join(' | '), allTitles.join(' | '))
    playlists.moveItem(road.id, entries[0] as number, 2)
    checkEqual(
      'an entry can be dropped into the middle',
      titlesOf(road.id).join(' | '),
      [allTitles[1], allTitles[2], allTitles[0], allTitles[3]].join(' | ')
    )
    checkEqual('moving an entry where it already is reports nothing to do', playlists.moveItem(road.id, entries[0] as number, 2), false)
    playlists.moveItem(road.id, entries[0] as number, 0)
    checkEqual('the playlist is back to its original order', titlesOf(road.id).join(' | '), allTitles.join(' | '))

    // Positions start 1024 apart and each drop into the same place halves the gap,
    // so dropping between the same two neighbours repeatedly is the path that has
    // to renumber the playlist. The order must come out the same either way.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const current = entryIdsOf(road.id)
      playlists.moveItem(road.id, current[0] as number, 1)
    }
    checkEqual('repeated drops into the same gap keep the order exact', titlesOf(road.id).join(' | '), allTitles.join(' | '))
    checkEqual('and lose nothing', titlesOf(road.id).length, allIds.length)

    // Entries are addressed by entry id, never by track id: the same track can sit
    // in two playlists, and a removal has to mean one of them.
    const other = playlists.create('Other')
    playlists.addTracks(other.id, [allIds[0] as number])
    checkEqual('the same track can live in two playlists', playlists.detail(other.id)?.items.length, 1)
    const foreignEntry = entryIdsOf(other.id)[0] as number
    checkEqual('removing an entry through the wrong playlist removes nothing', playlists.removeItems(road.id, [foreignEntry]), 0)
    checkEqual('the other playlist is untouched', playlists.detail(other.id)?.items.length, 1)
    checkEqual('and so is the first', playlists.detail(road.id)?.items.length, allIds.length)

    const renamed = playlists.rename(other.id, 'Driving')
    checkEqual('a playlist can be renamed', renamed.name, 'Driving')
    check('the list shows the new name', playlists.list().some((entry) => entry.name === 'Driving'))
    checkEqual('playlists are listed with their counts', playlists.list().map((entry) => entry.trackCount).join(','), `${allIds.length},1`)

    let duplicateName: string | null = null
    try {
      playlists.create('driving')
    } catch (error) {
      duplicateName = (error as Error).message
    }
    check(
      'a duplicate name is refused with a readable message, not a SQLite error',
      Boolean(duplicateName?.includes('already a playlist')),
      duplicateName ?? 'no error was thrown'
    )
    let emptyName: string | null = null
    try {
      playlists.create('   ')
    } catch (error) {
      emptyName = (error as Error).message
    }
    check('an empty name is refused', Boolean(emptyName?.includes('needs a name')), emptyName ?? 'no error was thrown')

    let missingPlaylist: string | null = null
    try {
      playlists.addTracks(987_654, [allIds[0] as number])
    } catch (error) {
      missingPlaylist = (error as Error).message
    }
    check(
      'adding to a playlist that does not exist is refused',
      Boolean(missingPlaylist?.includes('no longer exists')),
      missingPlaylist ?? 'no error was thrown'
    )

    playlists.delete(other.id)
    checkEqual('deleting a playlist removes it', playlists.detail(other.id), null)
    checkEqual('and takes its entries with it', playlists.list().length, 1)

    // --- playlist transfer and CSV export ----------------------------------
    // These are files from outside the app: the parser has to be tolerant of
    // encodings and relative paths, but the importer must never invent library
    // rows for files that are not there.
    const transferTracks = library.list().tracks
    const firstTrack = transferTracks[0]
    const secondTrack = transferTracks[1]
    if (!firstTrack?.filePath || !secondTrack?.filePath) throw new Error('transfer fixtures are missing paths')

    checkEqual('a .m3u extension selects M3U', playlistFormatFromPath('C:\\Music\\mix.M3U'), 'm3u')
    checkEqual('a .m3u8 extension selects M3U8', playlistFormatFromPath('C:\\Music\\mix.m3u8'), 'm3u8')
    checkEqual('a .json extension selects JSON', playlistFormatFromPath('C:\\Music\\mix.JSON'), 'json')
    let playlistExtensionError = ''
    try {
      playlistFormatFromPath('C:\\Music\\mix.txt')
    } catch (error) {
      playlistExtensionError = (error as Error).message
    }
    check('an unknown playlist extension is refused', playlistExtensionError.includes('.m3u'), playlistExtensionError)

    checkEqual(
      'a playlist path finds the same row as the scanner',
      repo.findByFilePath(firstTrack.filePath)?.id,
      firstTrack.id
    )

    const roadDetail = playlists.detail(road.id)
    if (!roadDetail) throw new Error('the original playlist disappeared')
    const roadM3U = exportPlaylistM3U(roadDetail)
    check('an exported M3U declares itself and names the list', roadM3U.startsWith('#EXTM3U\r\n#PLAYLIST:Road Trip\r\n'))
    checkEqual(
      'an exported M3U writes one EXTINF per track',
      (roadM3U.match(/#EXTINF:/g) ?? []).length,
      roadDetail.items.length
    )
    check('an exported M3U contains absolute file paths', roadM3U.includes(firstTrack.filePath))

    // --- send to phone -----------------------------------------------------
    // A phone cannot use an absolute Windows path, so the copy is a folder: the
    // files under their own names and one .m3u8 beside them pointing at those
    // names. Streamed rows have no file and are counted, never invented.
    const phonePlan = planPlaylistCopy(roadDetail)
    checkEqual('a phone copy plans one file per local track', phonePlan.entries.length, roadDetail.items.length)
    checkEqual('a local playlist has nothing streamed', phonePlan.streamed, 0)
    check(
      'a phone copy keeps playlist order',
      phonePlan.entries.every((entry, position) => entry.index === position)
    )

    const phoneSource = join(root, 'phone-source')
    await mkdir(phoneSource, { recursive: true })
    const phoneDetail = (name: string, paths: (string | null)[]): PlaylistDetail => ({
      playlist: {
        id: 1,
        name,
        createdAt: 0,
        updatedAt: 0,
        trackCount: paths.length,
        artworkKey: null,
        artworkTrackId: null
      },
      items: paths.map((filePath, index) => ({
        id: index + 1,
        track: { ...firstTrack, id: 9000 + index, filePath }
      }))
    })

    const collision = planPlaylistCopy(
      phoneDetail('Phone Mix', [join(phoneSource, 'Song One.mp3'), join(phoneSource, 'song one.mp3')])
    )
    checkEqual(
      'two files with the same name get distinct names, case-insensitively',
      collision.entries.map((entry) => entry.fileName).join(' | '),
      'Song One.mp3 | song one (2).mp3'
    )

    const streamedPlan = planPlaylistCopy(phoneDetail('Streams', [null]))
    checkEqual('a streamed row is counted, not planned as a copy', streamedPlan.streamed, 1)
    checkEqual('and it produces no file entry', streamedPlan.entries.length, 0)

    const phoneFolder = join(root, 'phone-export')
    const phoneProgress: number[] = []
    const phoneCopy = await copyPlaylistToFolder(roadDetail, phoneFolder, (done) => {
      phoneProgress.push(done)
    })
    checkEqual('every local file is copied for the phone', phoneCopy.copied, roadDetail.items.length)
    checkEqual('the playlist lands beside the files', phoneCopy.playlistFile, join(phoneFolder, 'Road Trip.m3u8'))
    check('the copied file keeps its name', existsSync(join(phoneFolder, basename(firstTrack.filePath))))
    const phoneText = await readFile(phoneCopy.playlistFile, 'utf8')
    check(
      'the phone playlist points at names, not at the PC paths',
      !phoneText.includes(firstTrack.filePath) && phoneText.includes(basename(firstTrack.filePath))
    )
    check(
      'the phone playlist is an extended M3U with CRLF',
      phoneText.startsWith('#EXTM3U\r\n#PLAYLIST:Road Trip\r\n') && phoneText.includes('\r\n')
    )
    checkEqual('copying reports progress for every planned file', phoneProgress.length, phonePlan.entries.length)
    checkEqual('and finishes at the total', phoneProgress[phoneProgress.length - 1], phonePlan.entries.length)

    const partialCopy = await copyPlaylistToFolder(
      phoneDetail('Partial', [firstTrack.filePath, join(phoneSource, 'gone.mp3')]),
      join(root, 'phone-partial')
    )
    checkEqual('a vanished file is reported as missing', partialCopy.missing, 1)
    checkEqual('the rest of the playlist still copies', partialCopy.copied, 1)
    const partialText = await readFile(partialCopy.playlistFile, 'utf8')
    check('a missing file is left out of the phone playlist', !partialText.includes('gone.mp3'))

    let streamedCopyError = ''
    try {
      await copyPlaylistToFolder(phoneDetail('Only streams', [null]), join(root, 'phone-streams'))
    } catch (error) {
      streamedCopyError = (error as Error).message
    }
    check(
      'a playlist of streams only says there is nothing to copy',
      streamedCopyError.includes('streamed tracks'),
      streamedCopyError
    )

    const portablePath = join(musicDir, 'portable-test.m3u8')
    const portableText = [
      '\uFEFF#EXTM3U',
      '#PLAYLIST:Portable Mix',
      `#EXTINF:12,${firstTrack.artist ?? 'Unknown'} - ${firstTrack.title}`,
      relative(musicDir, firstTrack.filePath),
      secondTrack.filePath,
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      '#EXTINF:-1,Missing file',
      'C:\\not-in-library.flac'
    ].join('\r\n')
    const portable = parsePlaylistFile(portableText, portablePath)
    checkEqual('the #PLAYLIST name wins over the filename', portable.name, 'Portable Mix')
    checkEqual(
      'a relative M3U entry resolves beside the playlist',
      normalizePath(portable.entries[0]?.path ?? ''),
      normalizePath(firstTrack.filePath)
    )
    checkEqual('EXTINF seconds become milliseconds', portable.entries[0]?.durationMs, 12_000)
    checkEqual('EXTINF "Artist - Title" is split', portable.entries[0]?.artist, firstTrack.artist)
    checkEqual(
      'an absolute M3U entry is kept',
      normalizePath(portable.entries[1]?.path ?? ''),
      normalizePath(secondTrack.filePath)
    )
    checkEqual('an HTTP entry stays a URL', portable.entries[2]?.url, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')

    const importedM3U = playlists.importPlaylistText(portableText, portablePath)
    checkEqual('an M3U import creates a playlist', importedM3U.detail.playlist.name, 'Portable Mix')
    checkEqual('two entries matched library rows', importedM3U.added, 2)
    checkEqual('entries outside the library are counted as missing', importedM3U.missing, 2)
    checkEqual('every M3U entry had a location', importedM3U.invalid, 0)
    checkEqual(
      'an import keeps the file order',
      importedM3U.detail.items.map((item) => item.track.title).join('|'),
      [firstTrack.title, secondTrack.title].join('|')
    )

    const secondImport = playlists.importPlaylistText(portableText, portablePath)
    checkEqual('a repeated import gets a predictable suffix', secondImport.detail.playlist.name, 'Portable Mix (2)')

    const duplicateText = ['#EXTM3U', firstTrack.filePath, firstTrack.filePath, secondTrack.filePath].join('\n')
    const duplicateImport = playlists.importPlaylistText(duplicateText, join(musicDir, 'duplicates.m3u'))
    checkEqual('a file name is the fallback playlist name', duplicateImport.detail.playlist.name, 'duplicates')
    checkEqual('repeated entries within one file are dropped', duplicateImport.duplicates, 1)
    checkEqual('only unique tracks are written', duplicateImport.added, 2)

    let nothingMatched = ''
    try {
      playlists.importPlaylistText('#EXTM3U\nC:\\also-not-in-library.flac\n', join(musicDir, 'nothing.m3u'))
    } catch (error) {
      nothingMatched = (error as Error).message
    }
    check('an import with no library tracks is refused', nothingMatched.includes('No tracks'), nothingMatched)
    check('a refused import leaves no empty playlist', !playlists.list().some((entry) => entry.name === 'nothing'))

    const roadJson = exportPlaylistJson(roadDetail)
    const parsedJson = parsePlaylistFile(roadJson, join(musicDir, 'road.json'))
    checkEqual('JSON export names its list', parsedJson.name, 'Road Trip')
    checkEqual('JSON export carries every entry', parsedJson.entries.length, roadDetail.items.length)
    const jsonImport = playlists.importPlaylistText(roadJson, join(musicDir, 'road-copy.json'))
    checkEqual('a JSON export round-trips into a new playlist', jsonImport.added, roadDetail.items.length)
    checkEqual('the copy gets a suffix because the name exists', jsonImport.detail.playlist.name, 'Road Trip (2)')

    let newerJson = ''
    try {
      parsePlaylistFile(
        JSON.stringify({ format: 'player-playlist', version: 99, name: 'Future', entries: [] }),
        join(musicDir, 'future.json')
      )
    } catch (error) {
      newerJson = (error as Error).message
    }
    check('a newer JSON playlist is refused', newerJson.includes('newer version'), newerJson)

    let foreignJson = ''
    try {
      parsePlaylistFile(JSON.stringify({ format: 'something-else', entries: [] }), join(musicDir, 'foreign.json'))
    } catch (error) {
      foreignJson = (error as Error).message
    }
    check('an unrelated JSON file is not mistaken for a playlist', foreignJson.includes('not a Suura playlist'), foreignJson)

    let oversizedJson = ''
    try {
      parsePlaylistFile(
        JSON.stringify({
          format: 'player-playlist',
          version: 1,
          name: 'Too many',
          entries: Array.from({ length: MAX_PLAYLIST_ENTRIES + 1 }, () => ({}))
        }),
        join(musicDir, 'oversized.json')
      )
    } catch (error) {
      oversizedJson = (error as Error).message
    }
    check('a playlist with too many entries is refused', oversizedJson.includes('more than'), oversizedJson)

    checkEqual('the export query is not capped at one page', repo.allForExport().length, transferTracks.length)
    const csv = libraryCsv(transferTracks)
    check('a CSV export starts with a UTF-8 BOM', csv.charCodeAt(0) === 0xfeff)
    check('the CSV header names the useful columns', csv.includes('Title,Artist,Album Artist,Album,Disc,Track'))
    checkEqual('the CSV has one row per track', csv.split('\r\n').filter((line) => line.length > 0).length, transferTracks.length + 1)
    check('the CSV includes a track path', csv.includes(firstTrack.filePath))
    const trickyCsv = libraryCsv([{ ...firstTrack, title: 'A, "B"', artist: 'Line\nBreak' }])
    check('the CSV quotes commas and doubles quotes', trickyCsv.includes('"A, ""B"""'))
    check('the CSV quotes embedded newlines', trickyCsv.includes('"Line\nBreak"'))

    for (const entry of playlists.list()) {
      if (entry.id !== road.id) playlists.delete(entry.id)
    }
    checkEqual('transfer tests leave the original playlist alone', playlists.list().length, 1)

    // --- folder watching ---------------------------------------------------
    // Watching is what lets the library keep up with the disk on its own, and it
    // does that by turning any change into a whole-library scan: the scan skips
    // every file whose size and mtime are unchanged, so there is no need to work
    // out *which* file changed. These checks use a real temp folder and real file
    // system events, so the debounce and the OS watcher are covered too.
    checkEqual('a written audio file is worth reacting to', isLibraryEvent('change', 'song.flac'), true)
    checkEqual('a written cover image is not', isLibraryEvent('change', 'cover.jpg'), false)
    checkEqual('a download part-file is not', isLibraryEvent('change', 'song.flac.part'), false)
    checkEqual('a created file counts whatever it is called', isLibraryEvent('rename', 'cover.jpg'), true)
    checkEqual('a folder leaving counts, even with a dot in its name', isLibraryEvent('rename', 'Album.2024'), true)
    checkEqual('an unnamed change counts', isLibraryEvent('change', null), true)

    const changes: FolderWatchEvent[] = []
    const watcher = new FolderWatcher({
      log: silentLogger,
      quietMs: 40,
      maxDelayMs: 1500,
      onChange: (event) => {
        changes.push(event)
        // The container wires exactly this pair together: a change asks the
        // library for a scan, and the scan's own result is what the UI sees.
        void library.scanWhenIdle().catch(() => undefined)
      }
    })
    const watched = normalizePath(musicDir)
    watcher.setFolders([watched])
    checkEqual('the watcher watches the folder it was given', watcher.folders().join('|'), watched)
    check('the watcher reports that it is watching', watcher.isWatching())

    // A file arriving is the case a user actually notices: an album is copied in
    // and it should appear without pressing anything.
    const arrived = join(musicDir, 'Watched Arrival.flac')
    await copyFile(fixtures[1]?.path ?? '', arrived)
    const arrivedIndexed = await waitFor(() => repo.stats().tracks === 5, 8000)
    check('a file copied in while running is indexed without being asked', arrivedIndexed, `tracks = ${repo.stats().tracks}`)
    check('the watcher reported the change', changes.length >= 1, `got ${changes.length} reports`)
    checkEqual('the report names the folder that changed', changes[0]?.folders[0] ?? null, watched)
    checkEqual('the report counts the events it coalesced', (changes[0]?.events ?? 0) > 0, true)
    check(
      'the new file is in the library',
      library.list().tracks.some((track) => track.filePath && normalizePath(track.filePath) === normalizePath(arrived))
    )

    // ...and a file leaving is the case that would otherwise leave a broken row
    // behind, because a watcher-triggered scan is a full scan and prunes.
    await unlink(arrived)
    const arrivalPruned = await waitFor(() => repo.stats().tracks === 4, 8000)
    check('a deleted file is forgotten without being asked', arrivalPruned, `tracks = ${repo.stats().tracks}`)

    watcher.stop()
    checkEqual('stopping the watcher closes every handle', watcher.isWatching(), false)
    const reportsBeforeStop = changes.length
    await writeFile(join(musicDir, 'After Stop.txt'), 'written after the watcher was stopped\n', 'utf8')
    await delay(500)
    checkEqual('nothing is reported after stopping', changes.length, reportsBeforeStop)

    // --- prune ------------------------------------------------------------
    // Pruning is deliberately limited to full library scans, so a scan of one
    // folder can never delete rows belonging to another.
    if (subject) {
      const beforePrune = playlists.detail(road.id)?.items.length ?? 0
      await unlink(subject.path)
      const singleScan = await library.scan(musicDir)
      checkEqual('a single-folder scan does not prune', singleScan.tracks, 4)
      const fullScan = await library.scan()
      checkEqual('a full library scan prunes the deleted file', fullScan.tracks, 3)
      checkEqual('the full scan reported one pruned row', repo.lastScanRun()?.pruned ?? -1, 1)
      check('the surviving tracks are still present', library.list().tracks.some((track) => track.title === 'Test Tone B'))
      // A playlist entry is a reference to a track row, so when the row goes the
      // entry goes with it rather than dangling.
      const afterPrune = playlists.detail(road.id)?.items.length ?? -1
      checkEqual('the pruned track left the playlist with it', afterPrune, beforePrune - 1)
      checkEqual('the playlist count agrees with its contents', playlists.detail(road.id)?.playlist.trackCount, afterPrune)
      checkEqual('the rest of the playlist survived', titlesOf(road.id).length, afterPrune)
    }

    // --- clearing a playlist ----------------------------------------------
    // The visible length omits a missing row, but clearing removes stored
    // entries, so compare against the table rather than the filtered view.
    const storedBeforeClear =
      database.db
        .prepare('SELECT COUNT(*) AS total FROM playlist_items WHERE playlist_id = ?')
        .get<{ total: number }>(road.id)?.total ?? 0
    const cleared = playlists.clear(road.id)
    checkEqual('clearing removes every entry', cleared, storedBeforeClear)
    checkEqual('a cleared playlist is empty', playlists.detail(road.id)?.items.length, 0)
    checkEqual('clearing keeps the playlist itself', playlists.list().length, 1)

    // --- play state --------------------------------------------------------
    // Resuming is a promise about the *next* start, so it is tested the way it
    // is used: write a snapshot and read it back through the service. The
    // interesting cases are the ones where the library moved between the two:
    // a queue names tracks by id, and ids can stop existing.
    const playback = new PlaybackService(new PlayStateRepository(database.db), repo)
    const first = library.list({ limit: 1 }).tracks[0]
    const second = library.list({ limit: 2 }).tracks[1]
    if (first && second) {
      playback.save({ trackIds: [first.id, second.id], index: 1, positionMs: 1234 }, Date.now())
      const restored = playback.load()
      checkEqual(
        'a saved queue comes back in its own order',
        restored?.tracks.map((track) => track.id).join(','),
        `${first.id},${second.id}`
      )
      checkEqual('the current track is remembered', restored?.index, 1)
      checkEqual('the position is remembered', restored?.positionMs, 1234)

      playback.save({ trackIds: [999_999, second.id], index: 1, positionMs: 5000 }, Date.now())
      const withHole = playback.load()
      checkEqual(
        'a track that is gone is dropped from the queue',
        withHole?.tracks.map((track) => track.id).join(','),
        String(second.id)
      )
      checkEqual('and the cursor follows the track that survived', withHole?.index, 0)
      checkEqual('the saved position survives the shift', withHole?.positionMs, 5000)

      playback.save({ trackIds: [999_999, second.id], index: 0, positionMs: 3000 }, Date.now())
      const lostCurrent = playback.load()
      checkEqual('a lost current track falls back to the first row', lostCurrent?.index, 0)
      checkEqual('and starts that row from the beginning', lostCurrent?.positionMs, 0)

      playback.save({ trackIds: [], index: -1, positionMs: 0 }, Date.now())
      checkEqual('an empty queue clears the save', playback.load(), null)

      database.db
        .prepare(
          `INSERT INTO play_state (id, queue, cursor, position_ms, updated_at)
           VALUES (1, ?, 0, 0, 0)
           ON CONFLICT(id) DO UPDATE SET queue = excluded.queue`
        )
        .run('not json')
      checkEqual('a corrupted save is ignored rather than thrown', playback.load(), null)
    }

    // --- dropped paths ----------------------------------------------------
    // The library is folder-based, so a dropped file has to become its parent
    // folder. The cases worth pinning down are the common slip (a text file in
    // the selection), the parent-directory rule, and dropping the same folder
    // twice, which happens whenever a user drags an album and then its files.
    const dropFolder = join(root, 'Dropped Album')
    await mkdir(dropFolder, { recursive: true })
    const dropFile = join(dropFolder, '01 - Dropped Tune.flac')
    await copyFile(fixtures[1]?.path ?? '', dropFile)
    await writeFile(join(dropFolder, 'notes.txt'), 'not audio\n', 'utf8')

    let rejectedNonAudio = false
    try {
      await library.addDroppedPaths([join(dropFolder, 'notes.txt')])
    } catch {
      rejectedNonAudio = true
    }
    check('a dropped non-audio file is rejected', rejectedNonAudio)

    const droppedFile = await library.addDroppedPaths([dropFile])
    checkEqual('dropping a file adds its parent folder', droppedFile.folders.join('|'), normalizePath(dropFolder))
    checkEqual('and indexes the track inside it', droppedFile.stats.tracks, 4)
    checkEqual('the parent becomes a library folder', library.folders().length, 2)

    const droppedAgain = await library.addDroppedPaths([dropFolder])
    checkEqual('dropping the same folder again is idempotent', droppedAgain.stats.tracks, 4)
    checkEqual('and does not duplicate the library folder', library.folders().length, 2)

    library.removeFolder(dropFolder)
    checkEqual('removing the dropped folder returns the original library', library.list().tracks.length, 3)
    checkEqual('and leaves only the original folder', library.folders().length, 1)

    // --- removal of a whole folder ---------------------------------------
    library.removeFolder(musicDir)
    checkEqual('removing a folder forgets its tracks', library.list().tracks.length, 0)
    checkEqual('removing a folder clears the setting', settings.get().libraryFolders.length, 0)

    // --- the playlist index width ----------------------------------------
    // The width lives in settings because the Playlists view unmounts on every
    // trip to another view; a fresh service reading the same file proves it
    // survives the part that matters.
    settings.update({ playlists: { indexWidth: 321 } })
    const reread = new SettingsService(paths.config, silentLogger)
    checkEqual('the playlist index width survives a reload', reread.get().playlists.indexWidth, 321)
    checkEqual('a width below the minimum is clamped', clampPlaylistIndexWidth(10), PLAYLIST_INDEX_MIN)
    checkEqual('a width above the maximum is clamped', clampPlaylistIndexWidth(9999), PLAYLIST_INDEX_MAX)

    // --- window bounds when a monitor is gone ------------------------------
    // The mini player remembers the normal window rectangle. If the monitor
    // that held it was unplugged, restoring the rectangle verbatim would put
    // the window off-screen, where it cannot be grabbed or moved back.
    const workArea = { x: 0, y: 0, width: 1920, height: 1040 }
    const inPlace = clampToWorkArea({ x: 100, y: 80, width: 1200, height: 780 }, workArea)
    check(
      'a window already inside a work area keeps its bounds',
      inPlace.x === 100 && inPlace.y === 80 && inPlace.width === 1200 && inPlace.height === 780,
      JSON.stringify(inPlace)
    )
    const pulled = clampToWorkArea({ x: 2500, y: 900, width: 1200, height: 780 }, workArea)
    check(
      'a window remembered off-screen is pulled back into the work area',
      pulled.x >= 0 &&
        pulled.y >= 0 &&
        pulled.x + pulled.width <= workArea.width &&
        pulled.y + pulled.height <= workArea.height,
      JSON.stringify(pulled)
    )
    const oversized = clampToWorkArea({ x: -50, y: -50, width: 2500, height: 1400 }, workArea)
    check(
      'a window larger than the work area shrinks to fit it',
      oversized.x === 0 && oversized.y === 0 && oversized.width === 1920 && oversized.height === 1040,
      JSON.stringify(oversized)
    )

    // Import limits are settings, not constants: an album may be worth 200 rows
    // and a radio mix is a snapshot whose length the user picks.
    checkEqual(
      'import limits default to 200 playlists / 50 mixes',
      `${settings.get().engine.importLimit}/${settings.get().engine.mixLimit}`,
      '200/50'
    )
    settings.update({ engine: { importLimit: 250, mixLimit: 30 } })
    const rereadLimits = new SettingsService(paths.config, silentLogger)
    checkEqual('an import limit survives a reload', rereadLimits.get().engine.importLimit, 250)
    checkEqual('a mix length survives a reload', rereadLimits.get().engine.mixLimit, 30)

    // A saved file is an ordinary local track that happens to remember where it
    // came from. The video id is read back from a tag, not kept in a parallel
    // table, so a rescan or a moved file cannot lose it.
    checkEqual('saved files default to Opus (no re-encode)', settings.get().retention.downloadFormat, 'opus')
    settings.update({ retention: { downloadFormat: 'mp3' } })
    const rereadFormat = new SettingsService(paths.config, silentLogger)
    checkEqual('a saved format survives a reload', rereadFormat.get().retention.downloadFormat, 'mp3')
    checkEqual(
      'the download folder defaults to the music folder',
      rereadFormat.get().retention.downloadFolder,
      null
    )

    // All three retention modes are implemented. A stored value must survive a
    // reload, while a hand-edited value outside the contract still falls back to
    // the default instead of reaching the cache or downloader.
    settings.update({ retention: { mode: 'cache' } })
    checkEqual(
      'an offline cache mode survives a reload',
      new SettingsService(paths.config, silentLogger).get().retention.mode,
      'cache'
    )
    settings.update({ retention: { mode: 'keep' } })
    checkEqual(
      'a keep mode survives a reload',
      new SettingsService(paths.config, silentLogger).get().retention.mode,
      'keep'
    )
    checkEqual('an unknown retention mode falls back to stream', normalizeRetention({ mode: 'someday' }).mode, 'stream')
    checkEqual('an unknown download format falls back', normalizeRetention({ downloadFormat: 'aiff' }).downloadFormat, 'opus')
    checkEqual('a tiny cache budget is clamped up', normalizeRetention({ cacheBudgetMb: 8 }).cacheBudgetMb, 128)
    checkEqual('a huge cache budget is clamped down', normalizeRetention({ cacheBudgetMb: 9_000_000 }).cacheBudgetMb, 1_000_000)
    checkEqual('a zero cache age is clamped up', normalizeRetention({ cacheMaxAgeDays: 0 }).cacheMaxAgeDays, 1)
    checkEqual('a huge cache age is clamped down', normalizeRetention({ cacheMaxAgeDays: 99_999 }).cacheMaxAgeDays, 3650)
    settings.update({ retention: { mode: 'stream', cacheBudgetMb: DEFAULT_SETTINGS.retention.cacheBudgetMb, cacheMaxAgeDays: DEFAULT_SETTINGS.retention.cacheMaxAgeDays } })

    // A killed process never runs the download's cleanup. The next start sweeps
    // only this service's own UUID folders and partial files, never a folder the
    // user happened to put in downloads/.
    const sweepRoot = join(root, 'sweep-downloads')
    await mkdir(join(sweepRoot, '11111111-1111-1111-1111-111111111111'), { recursive: true })
    await writeFile(join(sweepRoot, '11111111-1111-1111-1111-111111111111', 'leftover.part'), 'x')
    await mkdir(join(sweepRoot, 'keep-me'), { recursive: true })
    await writeFile(join(sweepRoot, 'keep-me', 'notes.txt'), 'x')
    await writeFile(join(sweepRoot, 'orphan.part'), 'x')
    const swept = cleanupAbandonedDownloads(sweepRoot, silentLogger)
    checkEqual('startup sweep removes one temp folder and one partial file', swept, 2)
    check('startup sweep removes the UUID folder', !existsSync(join(sweepRoot, '11111111-1111-1111-1111-111111111111')))
    check('startup sweep keeps an unrelated folder', existsSync(join(sweepRoot, 'keep-me', 'notes.txt')))
    check('startup sweep removes the orphaned partial file', !existsSync(join(sweepRoot, 'orphan.part')))

    // --- cancelling a save ------------------------------------------------
    // The fake sidecar never finishes on its own, so the only way out is the
    // controller. That is what Cancel does after a real download has started.
    const downloadHistory = new DownloadHistoryRepository(database.db)
    const seen: Array<{ status: string }> = []
    const cancellable = new DownloadService({
      settings,
      paths,
      repo,
      library,
      history: downloadHistory,
      musicDir,
      log: silentLogger,
      ytDlp: {
        download: (_videoId, options) =>
          new Promise<string>((_resolve, reject) => {
            options.signal?.addEventListener(
              'abort',
              () => reject(new Error('Saving the track was cancelled.')),
              { once: true }
            )
          })
      },
      onChange: (progress) => seen.push(progress),
      freeBytes: async () => 50 * 1024 ** 3
    })
    const pendingSave = cancellable.save({
      videoId: 'dQw4w9WgXcQ',
      title: 'Cancel this save',
      artist: null,
      album: null
    })
    await delay(30)
    cancellable.cancel('dQw4w9WgXcQ')
    let rejected = false
    try {
      await pendingSave
    } catch {
      rejected = true
    }
    check('download: cancelling rejects the save\'s promise', rejected)
    check(
      'download: cancel is reported as cancelled, not failed',
      seen.some((progress) => progress.status === 'cancelled') && !seen.some((progress) => progress.status === 'failed')
    )
    check(
      'download: a cancelled save leaves no temp folder',
      readdirSync(paths.downloads).filter((name) => name.length === 36).length === 0
    )
    const cancelledRow = downloadHistory.get('dQw4w9WgXcQ')
    checkEqual('download: the cancelled save is persisted', cancelledRow?.status, 'cancelled')
    checkEqual('download: the persisted row keeps the request title', cancelledRow?.title, 'Cancel this save')

    // --- pausing and resuming a save -------------------------------------
    // Pause aborts the sidecar but keeps the UUID folder. Resume must reuse that
    // exact folder; starting a second transfer in a fresh one would quietly lose
    // the partial file the pause was meant to preserve.
    const resumeSourceDir = join(root, 'resume-source')
    await mkdir(resumeSourceDir, { recursive: true })
    const resumeSource = await generateFlac(
      ffmpegPath,
      resumeSourceDir,
      'resume-source.flac',
      { title: 'Resume me', artist: 'Test Artist', album: 'Test Album', track: 1, year: 2026 },
      200
    )
    const pauseSeen: Array<{ status: string }> = []
    let pauseCalls = 0
    let firstTempDir = ''
    let secondTempDir = ''
    const resumable = new DownloadService({
      settings,
      paths,
      repo,
      library,
      history: downloadHistory,
      musicDir,
      log: silentLogger,
      ytDlp: {
        download: async (videoId, options) => {
          pauseCalls += 1
          const temp = dirname(options.outputTemplate)
          if (pauseCalls === 1) {
            firstTempDir = temp
            await mkdir(temp, { recursive: true })
            await writeFile(join(temp, 'partial.part'), 'x')
            return new Promise<string>((_resolve, reject) => {
              options.signal?.addEventListener(
                'abort',
                () => reject(new Error('Saving the track was cancelled.')),
                { once: true }
              )
            })
          }
          secondTempDir = temp
          const target = join(temp, `${videoId}.flac`)
          copyFileSync(resumeSource, target)
          return target
        }
      },
      onChange: (progress) => pauseSeen.push(progress),
      freeBytes: async () => 50 * 1024 ** 3
    })
    const pausedRequest = {
      videoId: 'M7lc1UVf-VE',
      title: 'Pause and resume',
      artist: 'Test Artist',
      album: 'Test Album'
    }
    const pendingPause = resumable.save(pausedRequest)
    await delay(80)
    const didPause = resumable.pause('M7lc1UVf-VE')
    // Press Resume immediately: the aborted job may still be unwinding, and the
    // service must defer the restart rather than drop the click.
    const didResume = resumable.resume('M7lc1UVf-VE')
    let pauseRejected = false
    try {
      await pendingPause
    } catch {
      pauseRejected = true
    }
    check('download: pause stops the save', didPause && pauseRejected)
    check('download: resume is accepted while pause unwinds', didResume)
    check(
      'download: pause is reported as paused, not failed',
      pauseSeen.some((progress) => progress.status === 'paused') &&
        !pauseSeen.some((progress) => progress.status === 'failed')
    )
    check(
      'download: pause keeps its UUID temp folder',
      firstTempDir.length > 0 && existsSync(firstTempDir)
    )

    let resumedRow = downloadHistory.get('M7lc1UVf-VE')
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (resumedRow?.status === 'saved' || resumedRow?.status === 'failed') break
      await delay(25)
      resumedRow = downloadHistory.get('M7lc1UVf-VE')
    }
    checkEqual('download: the resumed save finishes', resumedRow?.status, 'saved')
    check('download: resume reuses the paused temp folder', secondTempDir === firstTempDir)
    check('download: resume really started a second sidecar call', pauseCalls === 2)

    const resumedTrackId = resumedRow?.trackId ?? null
    const resumedTrack = resumedTrackId === null ? null : repo.getById(resumedTrackId)
    const resumedFile = resumedTrack?.filePath ?? null
    check('download: the resumed save made a local track', resumedTrack?.sourceKind === 'local')

    const removalPlaylists = new PlaylistService(
      new PlaylistRepository(database.db),
      repo,
      silentLogger
    )
    const removalPlaylist = removalPlaylists.create('Removed download')
    if (resumedTrackId !== null) removalPlaylists.addTracks(removalPlaylist.id, [resumedTrackId])
    checkEqual(
      'download: the tracked save is in a playlist before removal',
      removalPlaylists.detail(removalPlaylist.id)?.items.length,
      1
    )

    const didRemove = resumable.removeDownload('M7lc1UVf-VE')
    check('download: removing a saved file reports success', didRemove)
    check('download: removing a saved file deletes it', resumedFile !== null && !existsSync(resumedFile))
    checkEqual(
      'download: removal records the removed status',
      downloadHistory.get('M7lc1UVf-VE')?.status,
      'removed'
    )
    const removedTrack = resumedTrackId === null ? null : repo.getById(resumedTrackId)
    checkEqual('download: the removed row becomes a stream track', removedTrack?.sourceKind, 'youtube')
    check('download: the removed row hides its old path', removedTrack?.filePath === null)
    check('download: the removed row keeps its video id', removedTrack?.sourceId === 'M7lc1UVf-VE')
    check('download: the removed row is still marked missing', removedTrack?.missingAt !== null)
    check(
      'download: the "already saved" lookup no longer offers it',
      !repo.savedOrigins('youtube', ['M7lc1UVf-VE']).has('M7lc1UVf-VE')
    )
    const fallback = removedTrack ? streamFallbackFor(removedTrack) : null
    check(
      'download: playback resolves a removed download from YouTube',
      fallback?.sourceKind === 'youtube' && fallback.sourceId === 'M7lc1UVf-VE'
    )
    const removalDetail = removalPlaylists.detail(removalPlaylist.id)
    checkEqual('download: the playlist keeps the removed item', removalDetail?.items.length, 1)
    checkEqual(
      'download: the playlist maps the removed item to YouTube',
      removalDetail?.items[0]?.track.sourceKind,
      'youtube'
    )
    checkEqual(
      'download: the playlist item still names its row',
      removalDetail?.items[0]?.track.id,
      resumedTrackId
    )
    resumable.dispose()

    // --- promoting a cache file into the library --------------------------
    // The whole point of promotion is that the bytes already exist: saving it
    // must not call the sidecar again, yet the result has to be an ordinary
    // local track with its YouTube origin, so it plays and syncs like any save.
    let promotedDownloads = 0
    const promotable = new DownloadService({
      settings,
      paths,
      repo,
      library,
      history: downloadHistory,
      musicDir,
      log: silentLogger,
      ytDlp: {
        download: async () => {
          promotedDownloads += 1
          throw new Error('Promotion must not call the sidecar.')
        }
      },
      freeBytes: async () => 50 * 1024 ** 3,
      onChange: () => undefined
    })
    const promotedId = await promotable.saveFromCache(
      {
        videoId: 'fJ9rUzIMcZQ',
        title: 'Promoted from cache',
        artist: 'Test Artist',
        album: 'Test Album'
      },
      resumeSource,
      'audio/flac'
    )
    const promoted = repo.getById(promotedId)
    checkEqual('download: promotion makes no sidecar call', promotedDownloads, 0)
    checkEqual('download: a promoted copy is a local track', promoted?.sourceKind, 'local')
    checkEqual('download: a promoted copy remembers its video', promoted?.originId, 'fJ9rUzIMcZQ')
    checkEqual('download: a promoted copy names YouTube as its origin', promoted?.originKind, 'youtube')
    checkEqual('download: a promoted copy is recorded as saved', downloadHistory.get('fJ9rUzIMcZQ')?.status, 'saved')
    check('download: the promoted file is on disk', promoted?.filePath != null && existsSync(promoted.filePath))
    checkEqual(
      'download: the promoted copy keeps the cached bytes',
      promoted?.fileSize ?? null,
      statSync(resumeSource).size
    )
    promotedDownloads = 0
    let missingSourceRejected = false
    try {
      await promotable.saveFromCache(
        { videoId: 'kJQP7kiw5Fk', title: 'Gone', artist: null, album: null },
        join(root, 'gone.flac'),
        'audio/flac'
      )
    } catch {
      missingSourceRejected = true
    }
    check('download: promoting a vanished cache file is refused', missingSourceRejected)
    checkEqual('download: a refused promotion makes no sidecar call', promotedDownloads, 0)
    promotable.dispose()

    downloadHistory.record(
      { videoId: '9bZkp7q19f0', status: 'downloading', percent: 41, error: null, trackId: null },
      { videoId: '9bZkp7q19f0', title: 'Interrupted', artist: 'Night', album: null }
    )
    checkEqual('download: an in-flight row is turned into a failure at startup', downloadHistory.markInterrupted(), 1)
    const interruptedRow = downloadHistory.get('9bZkp7q19f0')
    checkEqual('download: the interrupted row is failed', interruptedRow?.status, 'failed')
    check(
      'download: the interrupted row explains itself',
      typeof interruptedRow?.error === 'string' && interruptedRow.error.length > 0 && interruptedRow.percent === null
    )
    downloadHistory.remove('9bZkp7q19f0')
    check('download: dismissing a history row removes it', downloadHistory.get('9bZkp7q19f0') === null)

    // A relaunch is a fresh database handle. The Downloads screen is allowed to
    // be empty only when this row is genuinely gone, not when the in-memory hook
    // forgot it.
    const relaunchPaths = resolveAppPaths(join(root, 'relaunch-userData'))
    ensureAppDirectories(relaunchPaths)
    const beforeRelaunch = openLibraryDatabase(relaunchPaths.database, silentLogger)
    new DownloadHistoryRepository(beforeRelaunch.db).record(
      {
        videoId: 'aqz-KE-bpKQ',
        status: 'saved',
        percent: 100,
        error: null,
        trackId: 42
      },
      { videoId: 'aqz-KE-bpKQ', title: 'Survives a relaunch', artist: 'Night', album: 'Offline' }
    )
    beforeRelaunch.close()
    const afterRelaunch = openLibraryDatabase(relaunchPaths.database, silentLogger)
    const persistedHistory = new DownloadHistoryRepository(afterRelaunch.db).list()
    check(
      'download: a saved history row survives reopening the database',
      persistedHistory.some(
        (row) =>
          row.videoId === 'aqz-KE-bpKQ' &&
          row.status === 'saved' &&
          row.title === 'Survives a relaunch' &&
          row.trackId === 42
      )
    )
    afterRelaunch.close()
    cancellable.dispose()

    const originDir = join(root, 'saved')
    await mkdir(originDir, { recursive: true })
    await generateFlac(
      ffmpegPath,
      originDir,
      'saved-from-youtube.flac',
      {
        title: 'a thousand years',
        artist: 'Christina Perri',
        album: 'head or heart',
        track: 1,
        year: 2011,
        comment: 'https://www.youtube.com/watch?v=XeUYMrGmLPw'
      },
      330
    )
    const originRepo = new TrackRepository(database.db)
    await scanLibraryFolders({ folders: [originDir], repo: originRepo, log: silentLogger })
    const savedTrack = originRepo.findByOrigin('youtube', 'XeUYMrGmLPw')
    checkEqual('a saved file is an ordinary local track', savedTrack?.sourceKind, 'local')
    checkEqual('a saved file remembers its video id', savedTrack?.originId, 'XeUYMrGmLPw')
    check('a saved file keeps its path', typeof savedTrack?.filePath === 'string')
    check(
      'the "already saved" lookup finds it',
      originRepo.savedOrigins('youtube', ['XeUYMrGmLPw', 'IDyQO0QuvKY']).has('XeUYMrGmLPw')
    )
    checkEqual(
      'a video that is not saved is not reported',
      originRepo.savedOrigins('youtube', ['IDyQO0QuvKY']).size,
      0
    )
    if (savedTrack) {
      originRepo.setOrigin(savedTrack.id, null, null)
      checkEqual('an origin can be cleared', originRepo.findByOrigin('youtube', 'XeUYMrGmLPw'), null)
      originRepo.setOrigin(savedTrack.id, 'youtube', 'XeUYMrGmLPw')
      checkEqual(
        'the downloader can set an origin without a tag',
        originRepo.findByOrigin('youtube', 'XeUYMrGmLPw')?.id,
        savedTrack.id
      )
    }

    // --- data care: backups, restore and the schema guard -----------------
    const trackCountBeforeRestore = repo.stats().tracks
    const backupDirectory = nextBackupDirectory(join(root, 'manual-backups'), 'Suura backup', new Date('2026-10-20T12:00:00Z'))
    const bundle = createBackupBundle({
      db: database.db,
      directory: backupDirectory,
      config: settings.get(),
      appVersion: '0.1.0-smoke',
      schemaVersion: database.schemaVersion,
      now: new Date('2026-10-20T12:00:00Z')
    })
    check(
      'a manual backup contains the database, settings and manifest',
      existsSync(bundle.database) && existsSync(bundle.config) && existsSync(join(bundle.directory, 'manifest.json'))
    )
    checkEqual('the backup manifest records the schema', bundle.manifest.schemaVersion, latestVersion())
    const inspected = inspectBackupBundle(backupDirectory)
    checkEqual('a backup database passes integrity and schema checks', inspected.schemaVersion, latestVersion())
    checkEqual(
      'a backup carries the current settings',
      (inspected.config as { volume: number }).volume,
      settings.get().volume
    )

    const automatic = ensureDailyBackup(database.db, paths.backups, { now: Date.now() })
    check('the first start of the day creates an automatic backup', Boolean(automatic && existsSync(automatic)))
    check(
      'a second start on the same day does not add another automatic backup',
      ensureDailyBackup(database.db, paths.backups, { now: Date.now() + 1000 }) === null
    )

    const rotationDirectory = join(root, 'rotation')
    for (let index = 0; index < 5; index += 1) {
      createDatabaseBackup(database.db, rotationDirectory, `auto-${index}`, new Date(Date.now() + index * 1000))
    }
    checkEqual('rotation starts with five automatic copies', readdirSync(rotationDirectory).length, 5)
    checkEqual('rotation removes the oldest copies', pruneDatabaseBackups(rotationDirectory, 2), 3)
    checkEqual('rotation keeps the requested number', readdirSync(rotationDirectory).length, 2)

    // A live library that will not open is repaired from the newest healthy
    // automatic copy, not by asking the user to delete the file by hand.
    const recoveryDirectory = join(root, 'recovery')
    createDatabaseBackup(database.db, recoveryDirectory, 'auto-old', new Date(Date.now() - 60_000))
    createDatabaseBackup(database.db, recoveryDirectory, 'auto-new', new Date())
    await writeFile(join(recoveryDirectory, 'auto-broken.db'), 'this is not a database')
    const candidate = findDatabaseRecoveryCandidate(recoveryDirectory, latestVersion())
    check('recovery finds an automatic copy', candidate !== null)
    check('recovery skips a file that is not a database', !candidate?.file.includes('broken'))
    checkEqual('recovery reports the copy schema', candidate?.schemaVersion, latestVersion())
    const manualDirectory = join(root, 'manual-only')
    createDatabaseBackup(database.db, manualDirectory, 'manual-copy', new Date())
    check(
      'recovery leaves manual backups out',
      findDatabaseRecoveryCandidate(manualDirectory, latestVersion()) === null
    )

    const futureDatabase = join(root, 'future.db')
    copyFileSync(
      createDatabaseBackup(database.db, join(root, 'guard'), 'auto-guard', new Date()),
      futureDatabase
    )
    const future = openDatabase(futureDatabase)
    future.exec('PRAGMA user_version = 99')
    future.close()
    let schemaGuard = ''
    try {
      openLibraryDatabase(futureDatabase, silentLogger)
    } catch (error) {
      schemaGuard = error instanceof DatabaseSchemaTooNewError ? error.message : String(error)
    }
    check('a library from a newer build is refused before migration', schemaGuard.includes('newer version'))

    const newerBackup = join(root, 'newer-backup')
    await mkdir(newerBackup, { recursive: true })
    copyFileSync(futureDatabase, join(newerBackup, 'library.db'))
    await writeFile(join(newerBackup, 'config.json'), JSON.stringify(settings.get()))
    await writeFile(
      join(newerBackup, 'manifest.json'),
      JSON.stringify({
        format: 'player-backup',
        version: 1,
        appVersion: '0.1.0-future',
        createdAt: new Date().toISOString(),
        schemaVersion: 99
      })
    )
    let backupGuard = ''
    try {
      inspectBackupBundle(newerBackup)
    } catch (error) {
      backupGuard = error instanceof Error ? error.message : String(error)
    }
    check('a backup from a newer build is refused before restore', backupGuard.includes('newer version'))

    // --- persistence and restore -----------------------------------------
    database.close()
    stageRestore({
      backup: inspected,
      userDataDir: paths.userData,
      config: settings.get(),
      now: new Date('2026-10-20T12:00:00Z')
    })
    check(
      'a staged restore leaves a marker for the next start',
      existsSync(join(paths.userData, 'restore-pending.json'))
    )
    check('a staged restore is applied on the next start', applyPendingRestore(paths, silentLogger))
    check('a successful restore removes its marker', !existsSync(join(paths.userData, 'restore-pending.json')))
    check(
      'a restore keeps the replaced data aside',
      readdirSync(paths.backups, { withFileTypes: true }).filter(
        (entry) => entry.isDirectory() && entry.name.startsWith('Pre-restore')
      ).length === 1
    )
    const reopened = openLibraryDatabase(paths.database, silentLogger)
    checkEqual('database reopens at the current schema version', reopened.schemaVersion, latestVersion())
    checkEqual(
      'the restored database still has the library',
      new TrackRepository(reopened.db).stats().tracks,
      trackCountBeforeRestore
    )
    reopened.close()
    check('the database file exists on disk', existsSync(paths.database))
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
  }

  // --- M12a: bounded stream cache ------------------------------------------
  // A local HTTP server stands in for the CDN. The cache is the one component
  // whose failure mode is invisible until the network is gone, so it is tested
  // with real files and a real fetch instead of a fake.
  {
    const root = await mkdtemp(join(tmpdir(), 'player-cache-'))
    const paths = resolveAppPaths(join(root, 'userData'))
    ensureAppDirectories(paths)
    const database = openLibraryDatabase(paths.database, silentLogger)
    const settings = new SettingsService(paths.config, silentLogger)
    const cacheRoot = join(paths.cache, 'stream')
    const payload = Buffer.alloc(64 * 1024, 7)
    let hits = 0
    const server = createServer((request, response) => {
      hits += 1
      if (request.url === '/fail') {
        response.writeHead(500, { 'content-type': 'text/plain' })
        response.end('nope')
        return
      }
      response.writeHead(200, {
        'content-type': 'audio/webm',
        'content-length': payload.length
      })
      response.end(payload)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const base = `http://127.0.0.1:${port}`
    const now = { value: 1_000_000 }
    let budgetMb = 64
    let free = 10 * 1024 ** 3
    const cacheSettings = {
      get: () => {
        const current = settings.get()
        return { ...current, retention: { ...current.retention, cacheBudgetMb: budgetMb } }
      }
    }
    const cache = new StreamCache({
      db: database.db,
      root: cacheRoot,
      settings: cacheSettings,
      log: silentLogger,
      freeBytes: async () => free,
      now: () => now.value
    })
    cache.init()

    const source = (path: string, sizeHint: number | null = payload.length) => ({
      url: `${base}${path}`,
      headers: {},
      mimeType: 'audio/webm',
      sizeHint
    })

    try {
      checkEqual('cache: starts empty', cache.stats().entries, 0)
      checkEqual('cache: an invalid video id is never fetched', await cache.warm('not a video', source('/ok')), null)
      checkEqual('cache: an invalid id makes no request', hits, 0)

      const first = await cache.warm('dQw4w9WgXcQ', source('/ok'))
      check('cache: a completed warm stores the entry', first !== null && first.sizeBytes === payload.length)
      checkEqual('cache: the completed entry is counted', cache.stats().entries, 1)
      const files = readdirSync(cacheRoot)
      check(
        'cache: the file is renamed to its MIME extension',
        files.length === 1 && files[0]?.endsWith('.webm') === true,
        files.join(',')
      )
      check('cache: no partial file survives', !files.some((name) => name.endsWith('.part')))
      const cachedSource = cache.cachedSource('dQw4w9WgXcQ')
      check('cache: a cached video resolves to player-media', cachedSource?.url.startsWith('player-media://') === true)
      checkEqual('cache: the cached source keeps the MIME type', cachedSource?.mimeType, 'audio/webm')
      check('cache: the cache root is allowlisted', cache.isPathAllowed(join(cacheRoot, files[0] ?? 'x.webm')))
      check('cache: a path outside the cache is refused', !cache.isPathAllowed(join(root, 'outside.webm')))

      let before = hits
      await cache.warm('dQw4w9WgXcQ', source('/ok'))
      checkEqual('cache: warming a stored video does not fetch again', hits, before)

      before = hits
      const [a, b] = await Promise.all([
        cache.warm('9bZkp7q19f0', source('/ok')),
        cache.warm('9bZkp7q19f0', source('/ok'))
      ])
      check('cache: concurrent warms share one download', hits - before === 1 && a !== null && b !== null)
      checkEqual('cache: the second entry is counted', cache.stats().entries, 2)

      const failed = await cache.warm('kJQP7kiw5Fk', source('/fail'))
      check('cache: a failed download stores nothing', failed === null)
      checkEqual('cache: a failed download leaves the entry count alone', cache.stats().entries, 2)
      check(
        'cache: a failed download leaves no partial file',
        !readdirSync(cacheRoot).some((name) => name.endsWith('.part'))
      )

      // A cache copy must never fill the disk. The play itself already works.
      free = 1024 * 1024
      before = hits
      checkEqual('cache: a low-disk warm is skipped', await cache.warm('3JZ_D3ELwOQ', source('/ok')), null)
      checkEqual('cache: a skipped warm makes no request', hits, before)
      free = 10 * 1024 ** 3

      cache.setPinned('dQw4w9WgXcQ', true)
      checkEqual('cache: pinning is reflected in the stats', cache.stats().pinnedEntries, 1)

      // A tiny budget evicts unpinned copies but never a pinned one.
      budgetMb = 0.01
      const overBudget = await cache.warm('3JZ_D3ELwOQ', source('/ok'))
      check('cache: a copy over budget is evicted immediately', overBudget === null)
      checkEqual('cache: the pinned copy survives budget eviction', cache.stats().pinnedEntries, 1)
      check('cache: the pinned copy is still listed', cache.get('dQw4w9WgXcQ') !== null)
      checkEqual('cache: only the pinned bytes remain', cache.stats().bytes, payload.length)
      budgetMb = 64

      cache.setPinned('dQw4w9WgXcQ', false)
      now.value += 31 * 24 * 60 * 60_000
      await cache.warm('3JZ_D3ELwOQ', source('/ok'))
      check('cache: an entry past the age limit is evicted', cache.get('dQw4w9WgXcQ') === null)
      check('cache: the newly played entry survives the age sweep', cache.get('3JZ_D3ELwOQ') !== null)

      const staleName = readdirSync(cacheRoot).find((name) => name.endsWith('.webm'))
      if (staleName) await rm(join(cacheRoot, staleName), { force: true })
      check('cache: a missing file is not offered as a cached source', cache.cachedSource('3JZ_D3ELwOQ') === null)
      check('cache: a stale row is dropped', cache.get('3JZ_D3ELwOQ') === null)

      // One entry can be revealed or removed without touching the rest. The
      // renderer never receives the path; `filePath` exists for main-only
      // actions such as Explorer's Show in folder.
      await cache.warm('dQw4w9WgXcQ', source('/ok'))
      const revealPath = cache.filePath('dQw4w9WgXcQ')
      check('cache: one entry exposes its path to main', revealPath !== null && existsSync(revealPath))
      check('cache: revealing an unknown entry reports nothing', cache.filePath('M7lc1UVf-VE') === null)
      check('cache: removing one entry reports success', cache.remove('dQw4w9WgXcQ'))
      check('cache: removing one entry deletes its file', revealPath !== null && !existsSync(revealPath))
      checkEqual('cache: removing one entry drops its row', cache.stats().entries, 0)
      check('cache: a removed entry cannot be revealed', cache.filePath('dQw4w9WgXcQ') === null)
      check('cache: removing an unknown entry is a no-op', !cache.remove('M7lc1UVf-VE'))

      // A normal restart must not look like a cache wipe: a complete entry
      // inside the age and size policy survives start-up reconciliation.
      await cache.warm('dQw4w9WgXcQ', source('/ok'))
      const bytesBeforeRestart = cache.stats().bytes
      const restarted = new StreamCache({
        db: database.db,
        root: cacheRoot,
        settings: cacheSettings,
        log: silentLogger,
        freeBytes: async () => free,
        now: () => now.value
      })
      restarted.init()
      checkEqual('cache: a restart keeps a valid entry', restarted.stats().entries, 1)
      checkEqual('cache: a restart keeps its bytes', restarted.stats().bytes, bytesBeforeRestart)
      restarted.dispose()

      // "Clean now" is the janitor's bounded policy, not a second clear: an
      // unpinned entry past the age limit goes, a pinned one stays, and a fresh
      // entry is untouched. This is what the Downloads button promises.
      await cache.warm('M7lc1UVf-VE', source('/ok'))
      cache.setPinned('M7lc1UVf-VE', true)
      now.value += 31 * 24 * 60 * 60_000
      await cache.warm('3JZ_D3ELwOQ', source('/ok'))
      const cleaned = cache.cleanNow()
      check('cache: clean now removes an unpinned entry past the age limit', cache.get('dQw4w9WgXcQ') === null)
      check('cache: clean now keeps a pinned entry past the age limit', cache.get('M7lc1UVf-VE') !== null)
      check('cache: clean now keeps an entry inside the limit', cache.get('3JZ_D3ELwOQ') !== null)
      checkEqual('cache: clean now reports the surviving bytes', cleaned.bytes, payload.length * 2)

      // `clear` removes everything, pinned included.
      cache.setPinned('M7lc1UVf-VE', true)
      cache.clear()
      checkEqual('cache: clearing removes every entry', cache.stats().entries, 0)
      checkEqual('cache: clearing removes the files', readdirSync(cacheRoot).length, 0)

      // An unclean shutdown leaves a partial and an orphan. The next start-up
      // deletes both without touching a row whose file is intact.
      await writeFile(join(cacheRoot, 'orphan.webm'), 'leftover')
      await writeFile(join(cacheRoot, '9bZkp7q19f0.webm.part'), 'half')
      const reopened = new StreamCache({
        db: database.db,
        root: cacheRoot,
        settings: cacheSettings,
        log: silentLogger,
        freeBytes: async () => free,
        now: () => now.value
      })
      reopened.init()
      checkEqual('cache: start-up removes leftovers', readdirSync(cacheRoot).length, 0)
      reopened.dispose()
    } finally {
      cache.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      database.close()
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  // --- M7: duplicate detection and moved files ----------------------------
  // This runs against its own small library so a merge can delete rows and a
  // move can hide one without disturbing the counts the main checks rely on.
  {
    const root = await mkdtemp(join(tmpdir(), 'player-data-care-'))
    const music = join(root, 'music')
    await mkdir(music, { recursive: true })
    const movedDir = join(root, 'moved')
    await mkdir(movedDir, { recursive: true })
    const firstPath = await generateFlac(
      ffmpegPath,
      music,
      'First Copy.flac',
      { title: 'First Copy', artist: 'Care Artist', album: 'Care', track: 1, year: 2024 },
      320
    )
    const secondPath = await generateFlac(
      ffmpegPath,
      music,
      'Second.flac',
      { title: 'Second', artist: 'Care Artist', album: 'Care', track: 2, year: 2024 },
      420
    )
    const duplicatePath = join(music, 'First Copy Again.flac')
    await copyFile(firstPath, duplicatePath)

    const paths = resolveAppPaths(join(root, 'userData'))
    ensureAppDirectories(paths)
    const handle = openLibraryDatabase(paths.database, silentLogger)
    try {
      const repo = new TrackRepository(handle.db)
      const settings = new SettingsService(paths.config, silentLogger)
      const library = new LibraryService(repo, settings, silentLogger)
      const playlists = new PlaylistService(new PlaylistRepository(handle.db), repo, silentLogger)
      const care = new DataCareService(repo, silentLogger)

      await library.scan(music)
      checkEqual('data care: the scan indexed both copies and the second file', repo.stats().tracks, 3)
      const indexed = library.list().tracks
      const first = indexed.find(
        (track) => track.filePath !== null && normalizePath(track.filePath) === normalizePath(firstPath)
      )
      const duplicate = indexed.find(
        (track) => track.filePath !== null && normalizePath(track.filePath) === normalizePath(duplicatePath)
      )
      const second = indexed.find(
        (track) => track.filePath !== null && normalizePath(track.filePath) === normalizePath(secondPath)
      )
      if (!first || !duplicate || !second) throw new Error('data care fixtures were not indexed')

      const firstList = playlists.create('Care First')
      const secondList = playlists.create('Care Second')
      playlists.addTracks(firstList.id, [first.id, second.id])
      playlists.addTracks(secondList.id, [duplicate.id])
      library.reportPlayback(duplicate.id, 31_000, true)

      const report = await care.findDuplicates()
      checkEqual('data care: identical files form one duplicate group', report.groups, 1)
      checkEqual('data care: the extra copy is counted', report.extraCopies, 1)
      checkEqual('data care: every present file was fingerprinted', report.hashed, 3)

      const keeperId = Math.min(first.id, duplicate.id)
      const keeperPath = keeperId === first.id ? firstPath : duplicatePath
      const redundantPath = keeperId === first.id ? duplicatePath : firstPath
      const merged = await care.mergeDuplicates()
      checkEqual('data care: the merge removed one row', merged.removed, 1)
      checkEqual('data care: the merge deleted the redundant file', merged.filesRemoved, 1)
      checkEqual('data care: the duplicate row is gone', repo.stats().tracks, 2)
      check('data care: the keeper file stayed on disk', existsSync(keeperPath))
      check('data care: the redundant file is gone', !existsSync(redundantPath))
      checkEqual(
        'data care: the duplicate playlist points at the keeper',
        playlists.detail(secondList.id)?.items[0]?.track.id,
        keeperId
      )
      checkEqual('data care: the keeper inherited the play', repo.getById(keeperId)?.playCount, 1)
      checkEqual('data care: the original playlist still has both tracks', playlists.detail(firstList.id)?.items.length, 2)

      const movedPath = join(movedDir, 'Second.flac')
      await rename(secondPath, movedPath)
      await library.scan()
      checkEqual('data care: a moved file disappears from the normal list', repo.stats().tracks, 1)
      checkEqual('data care: the row is kept as missing', repo.stats().missingTracks, 1)
      checkEqual('data care: the missing row is still in the playlist', playlists.detail(firstList.id)?.items.length, 1)

      const relocated = await care.relocate(movedDir)
      checkEqual('data care: the moved file was matched', relocated.relocated, 1)
      checkEqual('data care: the library is whole again', repo.stats().tracks, 2)
      checkEqual('data care: nothing is missing now', repo.stats().missingTracks, 0)
      checkEqual(
        'data care: the row id survived the move',
        normalizePath(repo.getById(second.id)?.filePath ?? ''),
        normalizePath(movedPath)
      )
      checkEqual('data care: the playlist entry came back', playlists.detail(firstList.id)?.items.length, 2)

      // A row that was never fingerprinted falls back to exact size+mtime.
      handle.db.prepare('UPDATE tracks SET file_hash = NULL WHERE id = ?').run(keeperId)
      const movedAgainDir = join(root, 'moved-again')
      await mkdir(movedAgainDir, { recursive: true })
      const movedAgain = join(movedAgainDir, 'Keeper Again.flac')
      await rename(keeperPath, movedAgain)
      await library.scan()
      checkEqual('data care: the moved keeper is missing', repo.stats().missingTracks, 1)
      const relocatedByStat = await care.relocate(movedAgainDir)
      checkEqual('data care: size and mtime relocate a hashless row', relocatedByStat.relocated, 1)
      checkEqual(
        'data care: the same row was matched without a hash',
        normalizePath(repo.getById(keeperId)?.filePath ?? ''),
        normalizePath(movedAgain)
      )
      checkEqual('data care: the library still has both rows', repo.stats().tracks, 2)

      checkEqual('bulk: removing a row reports one track', library.removeTracks([keeperId]), 1)
      checkEqual('bulk: the row left the library', repo.stats().tracks, 1)
      check('bulk: removing from the library keeps the file', existsSync(movedAgain))
    } finally {
      handle.close()
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  // --- M3: links, the stream proxy and the resolver cache -----------------
  {
    checkEqual(
      'youtube: a watch link with a playlist keeps the video',
      extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ'),
      'dQw4w9WgXcQ'
    )
    checkEqual('youtube: youtu.be links work', extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=30'), 'dQw4w9WgXcQ')
    checkEqual('youtube: shorts links work', extractYouTubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
    checkEqual('youtube: music.youtube.com works', extractYouTubeVideoId('https://music.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
    checkEqual('youtube: a bare id works', extractYouTubeVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
    check('youtube: a playlist without a video is rejected', extractYouTubeVideoId('https://www.youtube.com/playlist?list=PL123') === null)
    check('youtube: another host is rejected', extractYouTubeVideoId('https://example.com/watch?v=dQw4w9WgXcQ') === null)
    check('youtube: a short id is rejected', extractYouTubeVideoId('https://youtu.be/short') === null)

    // The stills have to be JPEG: `nativeImage` returns an empty image for the
    // WebP that `yt-dlp` reports, which is why covers went missing. Both entries
    // are 16:9, because the app crops covers to a square and YouTube's 4:3 stills
    // would bake their letterbox bars into it.
    const thumbs = youtubeThumbnailCandidates('dQw4w9WgXcQ')
    checkEqual(
      'youtube: the thumbnail is asked for as JPEG, largest first',
      thumbs.join(' '),
      'https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg'
    )
    check('youtube: no WebP stills are requested', thumbs.every((url) => url.endsWith('.jpg') && !url.includes('vi_webp')))
    check('youtube: anything that is not a video id has no thumbnail', youtubeThumbnailCandidates('nope').length === 0)

    // --- link classification ---------------------------------------------
    // A mix wins over its seed video; a playlist with a video is a video first.
    const kindOf = (input: string): string => JSON.stringify(parseYouTubeLink(input))
    checkEqual(
      'youtube: a watch link is a video',
      kindOf('https://www.youtube.com/watch?v=XeUYMrGmLPw'),
      '{"kind":"video","videoId":"XeUYMrGmLPw"}'
    )
    checkEqual(
      'youtube: a youtu.be link is a video',
      kindOf('https://youtu.be/XeUYMrGmLPw?t=30'),
      '{"kind":"video","videoId":"XeUYMrGmLPw"}'
    )
    checkEqual(
      'youtube: a radio link is a mix, not its seed video',
      kindOf('https://www.youtube.com/watch?v=jqRjvIbJ2ZM&list=RDjqRjvIbJ2ZM&start_radio=1'),
      '{"kind":"list","listId":"RDjqRjvIbJ2ZM","listKind":"mix"}'
    )
    checkEqual(
      'youtube: a video inside a playlist stays a video with an offer',
      kindOf('https://www.youtube.com/watch?v=qP-7GNoDJ5c&list=PLAw8F_6lIU7I'),
      '{"kind":"video-in-list","videoId":"qP-7GNoDJ5c","listId":"PLAw8F_6lIU7I","listKind":"playlist"}'
    )
    checkEqual(
      'youtube: a playlist page is a list',
      kindOf('https://www.youtube.com/playlist?list=PLAw8F_6lIU7I'),
      '{"kind":"list","listId":"PLAw8F_6lIU7I","listKind":"playlist"}'
    )
    checkEqual(
      'youtube: a music album is an album',
      kindOf('https://music.youtube.com/playlist?list=OLAK5uy_ndFTmevlaZfhex3Y34n96wzv6Lp8Dc50c'),
      '{"kind":"list","listId":"OLAK5uy_ndFTmevlaZfhex3Y34n96wzv6Lp8Dc50c","listKind":"album"}'
    )
    checkEqual(
      'youtube: a bare list id is a list',
      kindOf('PLAw8F_6lIU7I'),
      '{"kind":"list","listId":"PLAw8F_6lIU7I","listKind":"playlist"}'
    )
    checkEqual(
      'youtube: a bare video id is still a video',
      kindOf('dQw4w9WgXcQ'),
      '{"kind":"video","videoId":"dQw4w9WgXcQ"}'
    )
    checkEqual(
      'youtube: Liked videos is refused with a reason',
      kindOf('https://www.youtube.com/playlist?list=LL'),
      '{"kind":"refused","reason":"account-list"}'
    )
    checkEqual(
      'youtube: Watch Later is refused with a reason',
      kindOf('https://www.youtube.com/playlist?list=WL'),
      '{"kind":"refused","reason":"account-list"}'
    )
    checkEqual(
      'youtube: an @handle is a channel, not a playlist',
      kindOf('https://www.youtube.com/@RickAstley'),
      '{"kind":"refused","reason":"channel"}'
    )
    checkEqual(
      'youtube: a /channel/ page is a channel',
      kindOf('https://www.youtube.com/channel/UCuAXFkgsw1L7xaCfnd5JJOw'),
      '{"kind":"refused","reason":"channel"}'
    )
    checkEqual(
      'youtube: another host is not YouTube',
      kindOf('https://example.com/watch?v=dQw4w9WgXcQ'),
      '{"kind":"refused","reason":"not-youtube"}'
    )

    checkEqual('youtube: an album title loses its prefix', youtubeListTitle('Album - head or heart', 'album'), 'head or heart')
    checkEqual('youtube: a mix title loses its prefix', youtubeListTitle('Mix - Hope', 'mix'), 'Hope')
    checkEqual(
      'youtube: a hand-made playlist keeps its name',
      youtubeListTitle('Mix - Hope', 'playlist'),
      'Mix - Hope'
    )
    checkEqual('youtube: a Topic channel becomes the artist', normalizeArtistName('Christina Perri - Topic'), 'Christina Perri')
    checkEqual('youtube: an ordinary artist is untouched', normalizeArtistName('The Chainsmokers'), 'The Chainsmokers')

    // --- M5 metadata cleanup and discovery -------------------------------
    const cleaned = cleanYouTubeMetadata('Bella Poarch - Build a B*tch (Official Music Video)', 'Bella Poarch')
    checkEqual('youtube: an official-video suffix is removed', cleaned.title, 'Build a B*tch')
    checkEqual('youtube: the repeated artist prefix becomes the artist field', cleaned.artist, 'Bella Poarch')
    checkEqual(
      'youtube: a live take keeps the label that makes it a different recording',
      cleanYouTubeMetadata('Song (Live)', null).title,
      'Song (Live)'
    )
    checkEqual('youtube: a 4K tag is decoration, not a title', cleanYouTubeMetadata('Track [4K]', null).title, 'Track')
    checkEqual(
      'youtube: an artist prefix is not stripped when it belongs to the title',
      cleanYouTubeMetadata('Simon & Garfunkel - The Boxer', 'Simon & Garfunkel').title,
      'The Boxer'
    )

    checkEqual(
      'youtube: a channel id becomes its videos page',
      youtubeChannelUrl('UCCY_8y1FjtOegxKB4s2bWqw'),
      'https://www.youtube.com/channel/UCCY_8y1FjtOegxKB4s2bWqw/videos'
    )
    checkEqual(
      'youtube: an @handle becomes its videos page',
      youtubeChannelUrl('https://www.youtube.com/@bellapoarch'),
      'https://www.youtube.com/@bellapoarch/videos'
    )
    check('youtube: a non-YouTube channel URL is refused', youtubeChannelUrl('https://example.com/@nope') === null)

    checkEqual('youtube: search asks for a capped flat list', buildSearchArgs('lofi beats', 20).at(-1), 'ytsearch20:lofi beats')
    const searchPageTwo = buildSearchArgs('lofi beats', 10, 10)
    check(
      'youtube: search page two skips the first ten results',
      searchPageTwo[searchPageTwo.indexOf('--playlist-start') + 1] === '11' &&
        searchPageTwo[searchPageTwo.indexOf('--playlist-end') + 1] === '20' &&
        searchPageTwo.at(-1) === 'ytsearch20:lofi beats'
    )
    checkEqual(
      'youtube: a channel listing asks for the videos tab',
      buildChannelArgs('https://www.youtube.com/channel/UCCY_8y1FjtOegxKB4s2bWqw/videos', 5).at(-1),
      'https://www.youtube.com/channel/UCCY_8y1FjtOegxKB4s2bWqw/videos'
    )
    const channelPageTwo = buildChannelArgs('https://www.youtube.com/@SFVMusic/videos', 10, 10)
    check(
      'youtube: channel page two skips the first ten videos',
      channelPageTwo[channelPageTwo.indexOf('--playlist-start') + 1] === '11' &&
        channelPageTwo[channelPageTwo.indexOf('--playlist-end') + 1] === '20'
    )

    const searchFixture = JSON.stringify({
      entries: [
        {
          id: 'FLGCGc7sAUw',
          title: 'Bella Poarch - Build a B*tch (Official Music Video)',
          duration: 170,
          channel_id: 'UCCY_8y1FjtOegxKB4s2bWqw',
          channel: 'Bella Poarch'
        },
        // A search result can be a channel itself; it is not a playable row.
        { id: 'UCCY_8y1FjtOegxKB4s2bWqw', title: 'Bella Poarch', _type: 'url' },
        { id: 'too-short', title: 'Not a video' }
      ]
    })
    const searchResults = parseSearchResults(searchFixture, 10)
    checkEqual('youtube: search keeps only real videos', searchResults.length, 1)
    checkEqual('youtube: a search result carries its channel id', searchResults[0]?.channelId, 'UCCY_8y1FjtOegxKB4s2bWqw')
    checkEqual('youtube: a search result carries its duration', searchResults[0]?.durationMs, 170_000)

    const channelFixture = JSON.stringify({
      id: 'UCCY_8y1FjtOegxKB4s2bWqw',
      channel: 'Bella Poarch',
      channel_id: 'UCCY_8y1FjtOegxKB4s2bWqw',
      webpage_url: 'https://www.youtube.com/channel/UCCY_8y1FjtOegxKB4s2bWqw/videos',
      entries: [
        {
          id: 'Nm6vnRBVCds',
          title: 'Bella Poarch - Garden (Official Lyric Video)',
          duration: 171
        }
      ]
    })
    const channelInfo = parseChannel(
      channelFixture,
      10,
      'https://www.youtube.com/channel/UCCY_8y1FjtOegxKB4s2bWqw/videos'
    )
    checkEqual('youtube: a channel listing keeps its name', channelInfo.name, 'Bella Poarch')
    checkEqual(
      'youtube: a channel entry inherits the channel it was listed from',
      channelInfo.entries[0]?.channelName,
      'Bella Poarch'
    )
    checkEqual('youtube: a channel entry keeps its duration', channelInfo.entries[0]?.durationMs, 171_000)

    checkEqual('innertube: duration parses hours', parseDurationText('1:01:14'), 3_674_000)
    checkEqual('innertube: duration parses minutes', parseDurationText('4:05'), 245_000)
    checkEqual(
      'innertube: duration parses accessible words',
      parseDurationText('1 hour, 2 minutes, 3 seconds'),
      3_723_000
    )
    checkEqual('innertube: a live label is not a duration', parseDurationText('LIVE'), null)

    const innertubeSearch = {
      contents: {
        twoColumnSearchResultsRenderer: {
          primaryContents: {
            sectionListRenderer: {
              contents: [
                {
                  itemSectionRenderer: {
                    contents: [
                      {
                        videoRenderer: {
                          videoId: 'lTRiuFIWV54',
                          title: { runs: [{ text: 'A lofi mix' }] },
                          ownerText: {
                            runs: [
                              {
                                text: 'Lofi Girl',
                                navigationEndpoint: {
                                  browseEndpoint: { browseId: 'UCSJ4gkVC6NrvII8umztf0Ow' }
                                }
                              }
                            ]
                          },
                          lengthText: { simpleText: '1:01:14' }
                        }
                      },
                      {
                        // A live radio row has no duration and must not become a track.
                        videoRenderer: {
                          videoId: 'rFZHOHl-L8A',
                          title: { runs: [{ text: 'lofi hip hop radio' }] },
                          ownerText: { runs: [{ text: 'Lofi Girl' }] }
                        }
                      },
                      {
                        continuationItemRenderer: {
                          continuationEndpoint: { continuationCommand: { token: 'search-token' } }
                        }
                      }
                    ]
                  }
                }
              ]
            }
          }
        }
      }
    }
    const innertubeSearchPage = parseSearchPage(innertubeSearch)
    checkEqual('innertube: search keeps one real video', innertubeSearchPage.items.length, 1)
    checkEqual('innertube: search keeps the channel id', innertubeSearchPage.items[0]?.channelId, 'UCSJ4gkVC6NrvII8umztf0Ow')
    checkEqual('innertube: search keeps the duration', innertubeSearchPage.items[0]?.durationMs, 3_674_000)
    checkEqual('innertube: search exposes its continuation', innertubeSearchPage.continuation, 'search-token')

    const innertubeSearchContinuation = parseSearchPage({
      onResponseReceivedCommands: [
        {
          appendContinuationItemsAction: {
            continuationItems: [
              {
                itemSectionRenderer: {
                  contents: [
                    {
                      videoRenderer: {
                        videoId: 'goxmvGJkoi0',
                        title: { runs: [{ text: 'Kami' }] },
                        ownerText: {
                          runs: [
                            {
                              text: 'LO-FI SENPAI',
                              navigationEndpoint: {
                                browseEndpoint: { browseId: 'UCxONCRXEhzv0cRbWCKybOsw' }
                              }
                            }
                          ]
                        },
                        lengthText: { simpleText: '3:06:35' }
                      }
                    }
                  ]
                }
              }
            ]
          }
        }
      ]
    })
    checkEqual('innertube: a search continuation adds its video', innertubeSearchContinuation.items.length, 1)
    checkEqual(
      'innertube: a search continuation keeps the duration',
      innertubeSearchContinuation.items[0]?.durationMs,
      11_195_000
    )
    checkEqual('innertube: the last search page has no continuation', innertubeSearchContinuation.continuation, null)

    const innertubeChannel = {
      metadata: {
        channelMetadataRenderer: {
          externalId: 'UCSJ4gkVC6NrvII8umztf0Ow',
          title: 'Lofi Girl'
        }
      },
      contents: {
        twoColumnBrowseResultsRenderer: {
          tabs: [
            {
              tabRenderer: {
                selected: true,
                content: {
                  richGridRenderer: {
                    contents: [
                      {
                        richItemRenderer: {
                          content: {
                            lockupViewModel: {
                              contentId: 'PVSOJyG5WKU',
                              contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
                              metadata: {
                                lockupMetadataViewModel: {
                                  title: { content: 'LOFI PRO Headphones' }
                                }
                              },
                              contentImage: {
                                thumbnailViewModel: {
                                  overlays: [
                                    {
                                      thumbnailBottomOverlayViewModel: {
                                        badges: [{ thumbnailBadgeViewModel: { text: '0:39' } }]
                                      }
                                    }
                                  ]
                                }
                              }
                            }
                          }
                        }
                      },
                      {
                        richItemRenderer: {
                          content: {
                            lockupViewModel: {
                              contentId: 'rFZHOHl-L8A',
                              contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
                              metadata: {
                                lockupMetadataViewModel: {
                                  title: { content: 'Live radio' }
                                }
                              },
                              contentImage: {
                                thumbnailViewModel: {
                                  overlays: [
                                    {
                                      thumbnailBottomOverlayViewModel: {
                                        badges: [{ thumbnailBadgeViewModel: { text: 'LIVE' } }]
                                      }
                                    }
                                  ]
                                }
                              }
                            }
                          }
                        }
                      },
                      {
                        continuationItemRenderer: {
                          continuationEndpoint: { continuationCommand: { token: 'channel-token' } }
                        }
                      }
                    ]
                  }
                }
              }
            }
          ]
        }
      }
    }
    const innertubeChannelInfo = parseChannelInfo(
      innertubeChannel,
      'https://www.youtube.com/channel/UCSJ4gkVC6NrvII8umztf0Ow/videos'
    )
    checkEqual('innertube: a channel page names the channel', innertubeChannelInfo.name, 'Lofi Girl')
    checkEqual(
      'innertube: a channel page carries its id',
      innertubeChannelInfo.channelId,
      'UCSJ4gkVC6NrvII8umztf0Ow'
    )
    const innertubeChannelPage = parseChannelPage(innertubeChannel, innertubeChannelInfo)
    checkEqual('innertube: a channel skips a live lockup', innertubeChannelPage.items.length, 1)
    checkEqual('innertube: a channel entry keeps its duration', innertubeChannelPage.items[0]?.durationMs, 39_000)
    checkEqual(
      'innertube: a channel entry inherits its channel',
      innertubeChannelPage.items[0]?.channelName,
      'Lofi Girl'
    )
    checkEqual('innertube: a channel exposes its continuation', innertubeChannelPage.continuation, 'channel-token')

    const innertubeChannelContinuation = parseChannelPage(
      {
        onResponseReceivedActions: [
          {
            appendContinuationItemsAction: {
              continuationItems: [
                {
                  richItemRenderer: {
                    content: {
                      lockupViewModel: {
                        contentId: 'goxmvGJkoi0',
                        contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
                        metadata: {
                          lockupMetadataViewModel: {
                            title: { content: 'Kami' }
                          }
                        },
                        contentImage: {
                          thumbnailViewModel: {
                            overlays: [
                              {
                                thumbnailBottomOverlayViewModel: {
                                  badges: [{ thumbnailBadgeViewModel: { text: '3:06:35' } }]
                                }
                              }
                            ]
                          }
                        }
                      }
                    }
                  }
                }
              ]
            }
          }
        ]
      },
      innertubeChannelInfo
    )
    checkEqual('innertube: a channel continuation adds its video', innertubeChannelContinuation.items.length, 1)
    checkEqual(
      'innertube: a channel continuation keeps the duration',
      innertubeChannelContinuation.items[0]?.durationMs,
      11_195_000
    )
    checkEqual(
      'innertube: a channel handle resolves to its id',
      parseResolvedChannelId({ endpoint: { browseEndpoint: { browseId: 'UCSJ4gkVC6NrvII8umztf0Ow' } } }),
      'UCSJ4gkVC6NrvII8umztf0Ow'
    )

    checkEqual(
      'youtube: a mix is fetched in the shape that returns a queue',
      youtubeListUrl('RDjqRjvIbJ2ZM'),
      'https://www.youtube.com/watch?v=jqRjvIbJ2ZM&list=RDjqRjvIbJ2ZM&start_radio=1'
    )
    checkEqual(
      'youtube: any other list uses the playlist form',
      youtubeListUrl('PLAw8F_6lIU7I'),
      'https://www.youtube.com/playlist?list=PLAw8F_6lIU7I'
    )

    const playlistArgs = buildPlaylistArgs('https://www.youtube.com/playlist?list=PLAw8F_6lIU7I', 50)
    check('youtube: a listing is flat', playlistArgs.includes('--flat-playlist'))
    check('youtube: a listing is capped on YouTube side', playlistArgs.includes('--playlist-end') && playlistArgs.includes('50'))
    check('youtube: a listing never says "no playlist"', !playlistArgs.includes('--no-playlist'))
    checkEqual('youtube: the listing URL comes last', playlistArgs[playlistArgs.length - 1], 'https://www.youtube.com/playlist?list=PLAw8F_6lIU7I')

    // --- saving a stream ---------------------------------------------------
    const template = join(tmpdir(), 'save', 'XeUYMrGmLPw.%(ext)s')
    const downloadArgs = buildDownloadArgs('XeUYMrGmLPw', 'high', 'opus', template)
    check('download: the user config is ignored', downloadArgs.includes('--ignore-config'))
    check('download: one video, not a list', downloadArgs.includes('--no-playlist'))
    check('download: audio is extracted', downloadArgs.includes('-x') && downloadArgs.includes('--audio-format'))
    checkEqual('download: the chosen format reaches yt-dlp', downloadArgs[downloadArgs.indexOf('--audio-format') + 1], 'opus')
    check(
      'download: tags and the cover are embedded',
      downloadArgs.includes('--embed-metadata') && downloadArgs.includes('--embed-thumbnail')
    )
    check('download: the output template is kept', downloadArgs.includes(template))
    checkEqual(
      'download: the watch URL comes last',
      downloadArgs[downloadArgs.length - 1],
      'https://www.youtube.com/watch?v=XeUYMrGmLPw'
    )
    const mp3Args = buildDownloadArgs('XeUYMrGmLPw', 'balanced', 'mp3', template)
    checkEqual('download: a compatibility format is honoured', mp3Args[mp3Args.indexOf('--audio-format') + 1], 'mp3')
    check(
      'download: progress is not suppressed',
      !downloadArgs.includes('--no-progress') && !downloadArgs.includes('--quiet')
    )
    check(
      'download: --continue resumes a paused transfer',
      downloadArgs.includes('--continue')
    )

    const midProgress = parseDownloadProgressLine(
      '[download]  42.3% of 4.10MiB at 1.25MiB/s ETA 00:12'
    )
    checkEqual('download: progress parses its percentage', midProgress?.percent, 42.3)
    checkEqual(
      'download: progress parses its transfer rate',
      midProgress?.speedBytesPerSecond,
      1_310_720
    )
    checkEqual('download: progress parses its ETA', midProgress?.etaSeconds, 12)
    const finalProgress = parseDownloadProgressLine('[download] 100% of 4.10MiB in 00:03')
    check('download: the final progress line is complete', finalProgress?.percent === 100)
    check('download: the final line has no transfer rate', finalProgress?.speedBytesPerSecond === null)
    checkEqual('download: the final line has no time left', finalProgress?.etaSeconds, 0)
    const longEta = parseDownloadProgressLine('[download]  5.0% of 1.00GiB at 2.00MiB/s ETA 01:02:03')
    checkEqual('download: a long ETA includes hours', longEta?.etaSeconds, 3723)
    check(
      'download: a non-progress line is ignored',
      parseDownloadProgressLine('[info] Downloading video') === null
    )

    // --- file names for saved tracks --------------------------------------
    checkEqual('files: slashes cannot create folders', sanitizeFilePart('AC/DC: Live?', 'x'), 'AC DC Live')
    checkEqual('files: trailing dots and spaces are dropped', sanitizeFilePart('Song. . ', 'x'), 'Song')
    checkEqual('files: a reserved device name is escaped', sanitizeFilePart('CON', 'x'), '_CON')
    checkEqual('files: a reserved name with an extension is escaped', sanitizeFilePart('con.txt', 'x'), '_con.txt')
    checkEqual('files: an empty name falls back', sanitizeFilePart('   ', 'Untitled'), 'Untitled')
    checkEqual(
      'files: an album becomes a folder',
      savePathParts({ title: 'a thousand years', artist: 'Christina Perri', album: 'head or heart' }).join('/'),
      'Christina Perri/head or heart/a thousand years'
    )
    checkEqual(
      'files: a single goes straight under the artist',
      savePathParts({ title: 'Hope', artist: 'The Chainsmokers', album: null }).join('/'),
      'The Chainsmokers/Hope'
    )
    checkEqual(
      'files: a missing artist still has a folder',
      savePathParts({ title: 'Untitled', artist: null, album: null }).join('/'),
      'Unknown artist/Untitled'
    )

    // --- the origin a saved file carries ----------------------------------
    checkEqual(
      'origin: a canonical watch URL comment is recognised',
      youtubeOriginOf([{ text: 'Provided to YouTube by …' }, { text: 'https://www.youtube.com/watch?v=XeUYMrGmLPw' }]),
      'XeUYMrGmLPw'
    )
    checkEqual(
      'origin: a short link is recognised',
      youtubeOriginOf([{ text: 'https://youtu.be/IDyQO0QuvKY' }]),
      'IDyQO0QuvKY'
    )
    checkEqual(
      'origin: a URL inside prose is not an origin',
      youtubeOriginOf([{ text: 'Listen at https://www.youtube.com/watch?v=XeUYMrGmLPw' }]),
      null
    )
    checkEqual('origin: no comment means a normal local file', youtubeOriginOf(undefined), null)
    checkEqual(
      'origin: an MP3 TXXX comment is recognised too',
      youtubeOriginOfNative({
        'ID3v2.4': [
          { id: 'TIT2', value: 'Hope' },
          { id: 'TXXX:comment', value: 'https://www.youtube.com/watch?v=IDyQO0QuvKY' }
        ]
      }),
      'IDyQO0QuvKY'
    )
    checkEqual(
      'origin: native prose is not an origin',
      youtubeOriginOfNative({ vorbis: [{ id: 'comment', value: 'from https://youtu.be/IDyQO0QuvKY and more' }] }),
      null
    )

    // --- flat playlist parsing -------------------------------------------
    const playlistJson = JSON.stringify({
      _type: 'playlist',
      id: 'OLAK5uy_test',
      title: 'Album - head or heart',
      uploader: null,
      channel: 'Christina Perri',
      playlist_count: 4,
      thumbnails: [
        { url: 'https://i9.ytimg.com/s_p/x/maxresdefault.jpg', width: 1200 },
        { url: 'https://i9.ytimg.com/s_p/x/sddefault.jpg', width: 640 }
      ],
      entries: [
        { id: 'XeUYMrGmLPw', title: 'a thousand years', duration: 285, uploader: 'Christina Perri - Topic', availability: 'public' },
        { id: 'IDyQO0QuvKY', title: 'Hope', duration: 180, uploader: 'The Chainsmokers', availability: 'public' },
        { id: 'XeUYMrGmLPw', title: 'duplicate', duration: 285 },
        { id: 'cnRB2CgUpSw', title: 'live', availability: 'public', live_status: 'is_live' },
        { id: 'abcDEFGHIJK', title: 'private', availability: 'private' },
        { id: 'short', title: 'not a video id' },
        { id: 'abcDEF12345', title: 'last', duration: 201.4, uploader: 'ImagineDragons' }
      ]
    })
    const parsedList = parsePlaylist(playlistJson, 10)
    checkEqual('playlist: the id is read', parsedList.listId, 'OLAK5uy_test')
    checkEqual('playlist: the title is read', parsedList.title, 'Album - head or heart')
    checkEqual('playlist: the owner falls back to the channel', parsedList.owner, 'Christina Perri')
    checkEqual('playlist: the reported total is kept', parsedList.total, 4)
    checkEqual('playlist: unplayable, duplicate and short entries are dropped', parsedList.entries.length, 3)
    checkEqual('playlist: the order is kept', parsedList.entries.map((entry) => entry.videoId).join(','), 'XeUYMrGmLPw,IDyQO0QuvKY,abcDEF12345')
    checkEqual('playlist: a Topic uploader becomes the artist', parsedList.entries[0]?.artist, 'Christina Perri')
    checkEqual('playlist: seconds become milliseconds', parsedList.entries[2]?.durationMs, 201400)
    check(
      'playlist: covers are tried largest first',
      Boolean(parsedList.coverUrls[0]?.includes('maxresdefault') && parsedList.coverUrls[1]?.includes('sddefault'))
    )
    check('playlist: a finite list reports that it was cut', parsedList.truncated)

    const capped = parsePlaylist(playlistJson, 2)
    checkEqual('playlist: the cap is applied after the drops', capped.entries.length, 2)
    check(
      'playlist: a mix with no total is truncated when it hits the cap',
      parsePlaylist(
        JSON.stringify({ id: 'RDtest', title: 'Mix - x', entries: [{ id: 'XeUYMrGmLPw', title: 'a' }] }),
        1
      ).truncated
    )
    check(
      'playlist: unreadable JSON is a human error',
      (() => {
        try {
          parsePlaylist('{', 10)
          return false
        } catch (error) {
          return error instanceof Error && error.message.toLowerCase().includes('unreadable')
        }
      })()
    )

    const args = buildInfoArgs('dQw4w9WgXcQ', 'best')
    checkEqual('youtube: the user config is always ignored', args.slice(0, 2).join(' '), '--ignore-config --no-playlist')
    check('youtube: the extra format probe is skipped on a resolve', args.includes('--no-check-formats'))
    const networkArgs = withNetworkTransport(args)
    checkEqual('youtube: every network command forces IPv4', networkArgs[0], '--force-ipv4')
    checkEqual('youtube: forcing IPv4 keeps the resolve arguments', networkArgs.slice(1).join(' '), args.join(' '))
    check('youtube: the format is audio-only with a muxed fallback', args.includes('bestaudio/best'))
    const botCheckMessage = describeYouTubeFailure('ERROR: Sign in to confirm you are not a bot').toLowerCase()
    check(
      'youtube: a bot check becomes a human message that says retrying is the way',
      botCheckMessage.includes('automated traffic') && botCheckMessage.includes('does not sign in')
    )
    check(
      'youtube: an unavailable video becomes a human message',
      describeYouTubeFailure('ERROR: Video unavailable').toLowerCase().includes('unavailable')
    )
    const cookieFailure = describeYouTubeFailure(
      'ERROR: Failed to decrypt with DPAPI. See https://github.com/yt-dlp/yt-dlp/issues/10927 for more info\n'
    ).toLowerCase()
    check(
      'youtube: an unreadable Chrome cookie store names the cause and the way out',
      cookieFailure.includes('chrome and edge') &&
        cookieFailure.includes('firefox') &&
        cookieFailure.includes('po token') &&
        !cookieFailure.includes('region-locked')
    )
    const lockedCookieDb = describeYouTubeFailure(
      'ERROR: Could not copy Chrome cookie database. See https://github.com/yt-dlp/yt-dlp/issues/7271'
    ).toLowerCase()
    check(
      'youtube: a locked Chrome cookie database suggests closing Chrome',
      lockedCookieDb.includes('chrome is open') && lockedCookieDb.includes('close chrome')
    )
    const rateLimitMessage = describeYouTubeFailure(
      'ERROR: Unable to download webpage: HTTP Error 429: Too Many Requests'
    ).toLowerCase()
    check(
      'youtube: a 429 is described as a rate limit, not a bot challenge',
      rateLimitMessage.includes('rate-limiting') && rateLimitMessage.includes('pause')
    )
    check(
      'youtube: only Chrome and Edge are flagged for App-Bound Encryption',
      usesAppBoundEncryption('chrome') && usesAppBoundEncryption('edge') && !usesAppBoundEncryption('firefox')
    )
    check('youtube: the bot-check classifier is shared', isYouTubeBotCheck('ERROR: Sign in to confirm you are not a bot'))
    check(
      'youtube: a failed cookie read is not mistaken for a bot check',
      !isYouTubeBotCheck('ERROR: could not find chrome cookies database')
    )
    check(
      'youtube: an unreadable cookie store does not pause YouTube requests',
      !isYouTubeBotCheck('ERROR: Failed to decrypt with DPAPI. See https://github.com/yt-dlp/yt-dlp/issues/10927')
    )
    check(
      'youtube: a 429 still pauses requests like a challenge',
      isYouTubeBotCheck('Unable to download webpage: HTTP Error 429: Too Many Requests')
    )
    check('youtube: a transient network failure is retryable', isRetryableYouTubeFailure('ERROR: Connection reset by peer'))
    check(
      'youtube: a bot check is never retryable',
      !isRetryableYouTubeFailure('ERROR: Sign in to confirm you are not a bot')
    )
    check('youtube: a resolve deadline is not doubled by a retry', !isRetryableYouTubeFailure('timeout'))
    checkEqual(
      'youtube: cookies are passed only when a browser is chosen',
      withBrowserCookies(['--ignore-config'], 'chrome').slice(0, 3).join(' '),
      '--ignore-config --cookies-from-browser chrome'
    )
    checkEqual(
      'youtube: cookie arguments are absent by default',
      withBrowserCookies(['--ignore-config'], null).join(' '),
      '--ignore-config'
    )
    checkEqual(
      'youtube: a browser profile is appended to the cookie source',
      withBrowserCookies(['--ignore-config'], 'chrome', 'Profile 1')[2],
      'chrome:Profile 1'
    )
    check(
      'youtube: a newline in a browser profile is rejected',
      normalizeCookieBrowserProfile('Profile 1\n--exec bad') === null
    )
    checkEqual(
      'youtube: a cookies file is passed after --ignore-config',
      withCookiesFile(['--ignore-config', '--no-playlist'], 'C:\\cookies\\youtube.txt').slice(0, 3).join(' '),
      '--ignore-config --cookies C:\\cookies\\youtube.txt'
    )
    checkEqual(
      'youtube: no cookies file means no cookie argument',
      withCookiesFile(['--ignore-config'], null).join(' '),
      '--ignore-config'
    )
    check(
      'youtube: a relative cookies path is rejected',
      normalizeCookiesFile('cookies.txt') === null && normalizeCookiesFile('C:\\cookies.txt') !== null
    )
    check(
      'youtube: a newline in a cookies path is rejected',
      normalizeCookiesFile('C:\\cookies.txt\n--exec bad') === null
    )
    checkEqual(
      'youtube: a provider URL loses its trailing slash',
      normalizePoTokenProviderUrl('http://127.0.0.1:4416/'),
      'http://127.0.0.1:4416'
    )
    check(
      'youtube: a non-http provider URL is rejected',
      normalizePoTokenProviderUrl('ftp://127.0.0.1/provider') === null
    )
    checkEqual(
      'youtube: the provider argument is absent while the switch is off',
      withPoTokenProvider(['--ignore-config'], DEFAULT_SETTINGS.engine).join(' '),
      '--ignore-config'
    )
    const providerArgs = withPoTokenProvider(
      ['--ignore-config', '-J', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
      {
        ...DEFAULT_SETTINGS.engine,
        poTokenEnabled: true,
        poTokenProviderUrl: 'http://127.0.0.1:4416/'
      }
    )
    checkEqual(
      'youtube: the provider argument is explicit and follows ignore-config',
      providerArgs.slice(0, 3).join(' '),
      '--ignore-config --extractor-args youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416'
    )
    check(
      'youtube: the provider argument keeps the request at the end',
      providerArgs[providerArgs.length - 1] === 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
    )
    const providerCommand = splitCommandLine('node "C:\\Program Files\\provider\\main.js" --port 4416')
    checkEqual('provider: a quoted Windows path survives command splitting', providerCommand[1], 'C:\\Program Files\\provider\\main.js')
    checkEqual('provider: arguments after a quoted path are kept', providerCommand[3], '4416')
    check(
      'provider: an unclosed quote is a readable error',
      (() => {
        try {
          splitCommandLine('node "C:\\provider\\main.js')
          return false
        } catch (error) {
          return error instanceof Error && error.message.includes('unclosed')
        }
      })()
    )

    check('settings: prefetch is on by default', DEFAULT_SETTINGS.engine.prefetchNext)

    // --- app update channel ------------------------------------------------
    checkEqual('update: the stable channel is the default', DEFAULT_SETTINGS.update.channel, 'stable')
    checkEqual(
      'update: the published feed is the default',
      DEFAULT_SETTINGS.update.feedUrl,
      'https://pub-f78cb36c07324422ba352033e3d71909.r2.dev'
    )
    checkEqual(
      'update: the default feed resolves to latest.yml',
      resolveUpdateFeedUrl(DEFAULT_SETTINGS.update.feedUrl, 'stable'),
      'https://pub-f78cb36c07324422ba352033e3d71909.r2.dev/latest.yml'
    )
    check('update: background checks are on by default', DEFAULT_SETTINGS.update.autoCheck)
    checkEqual(
      'update: a stable feed resolves to latest.yml',
      resolveUpdateFeedUrl('https://updates.example.com/suura', 'stable'),
      'https://updates.example.com/suura/latest.yml'
    )
    checkEqual(
      'update: a beta feed resolves to beta.yml',
      resolveUpdateFeedUrl('https://updates.example.com/suura/', 'beta'),
      'https://updates.example.com/suura/beta.yml'
    )
    checkEqual(
      'update: normalisation trims trailing slashes',
      normalizeUpdateFeedUrl('https://updates.example.com/suura///'),
      'https://updates.example.com/suura'
    )
    checkEqual(
      'update: a pasted channel file becomes its folder',
      normalizeUpdateFeedUrl('https://updates.example.com/suura/latest.yml'),
      'https://updates.example.com/suura'
    )
    check(
      'update: plain HTTP is refused outside loopback',
      normalizeUpdateFeedUrl('http://updates.example.com/suura') === null
    )
    checkEqual(
      'update: loopback HTTP is allowed for a local feed',
      normalizeUpdateFeedUrl('http://localhost:8080/suura'),
      'http://localhost:8080/suura'
    )
    check('update: a URL with credentials is refused', normalizeUpdateFeedUrl('https://user:secret@example.com/suura') === null)
    checkEqual('update: an unknown channel falls back to stable', normalizeUpdate({ channel: 'nightly' }).channel, 'stable')
    check('update: an invalid feed URL is stored as null', normalizeUpdate({ feedUrl: 'not a url' }).feedUrl === null)
    checkEqual('update: a check timestamp is rounded', normalizeUpdate({ lastCheckAt: 1234.6 }).lastCheckAt, 1235)
    checkEqual('update: an unset check timestamp stays null', normalizeUpdate({ lastCheckAt: -5 }).lastCheckAt, null)

    check('settings: fingerprint matching is off until a key is supplied', DEFAULT_SETTINGS.metadata.acoustidKey === null)

    // The About panel sends a patch; it has to survive validation, and the one
    // field the renderer must not control is the check timestamp.
    const updatePatch = sanitizeUpdateSettingsPatch({
      channel: 'beta',
      feedUrl: 'https://updates.example.com/suura/latest.yml',
      autoCheck: false,
      lastCheckAt: 999
    })
    checkEqual('update: a renderer patch keeps its channel', updatePatch.channel, 'beta')
    checkEqual(
      'update: a renderer patch normalises the feed URL',
      updatePatch.feedUrl,
      'https://updates.example.com/suura'
    )
    checkEqual('update: a renderer patch keeps auto-check off', updatePatch.autoCheck, false)
    check('update: a renderer patch cannot set the check timestamp', updatePatch.lastCheckAt === undefined)
    checkEqual(
      'update: an unknown channel is dropped from a patch',
      sanitizeUpdateSettingsPatch({ channel: 'nightly' }).channel,
      undefined
    )
    checkEqual(
      'update: clearing the feed is an explicit null',
      sanitizeUpdateSettingsPatch({ feedUrl: null }).feedUrl,
      null
    )

    check('settings: closing the window quits by default', !DEFAULT_SETTINGS.desktop.closeToTray)
    check('settings: starting with Windows is off by default', !DEFAULT_SETTINGS.startup.startOnLogin)
    check('settings: browser cookies are off by default', DEFAULT_SETTINGS.engine.cookiesFromBrowser === null)
    checkEqual('settings: cookie fallback is off by default', DEFAULT_SETTINGS.engine.cookieFallback, 'off')
    checkEqual('settings: no cookies file until one is chosen', DEFAULT_SETTINGS.engine.cookiesFile, null)
    check('settings: the cookie fallback accepts its three modes', isCookieFallbackMode('off') && isCookieFallbackMode('on-bot-check') && isCookieFallbackMode('always'))
    check('settings: the PO Token provider is off by default', !DEFAULT_SETTINGS.engine.poTokenEnabled)
    checkEqual(
      'settings: the PO Token provider points at its standard local port',
      DEFAULT_SETTINGS.engine.poTokenProviderUrl,
      DEFAULT_PO_TOKEN_PROVIDER_URL
    )

    const settingsRoot = await mkdtemp(join(tmpdir(), 'player-settings-'))
    const legacySettingsFile = join(settingsRoot, 'legacy-cookie-settings.json')
    await writeFile(legacySettingsFile, JSON.stringify({ engine: { cookiesFromBrowser: 'chrome' } }), 'utf8')
    const migrated = new SettingsService(legacySettingsFile, silentLogger).get()
    checkEqual(
      'settings: a legacy browser selection keeps the old always-on cookie behaviour',
      migrated.engine.cookieFallback,
      'always'
    )
    const freshSettingsFile = join(settingsRoot, 'fresh-cookie-settings.json')
    await writeFile(freshSettingsFile, JSON.stringify({ engine: { cookiesFromBrowser: 'chrome', cookieFallback: 'off' } }), 'utf8')
    const explicitOff = new SettingsService(freshSettingsFile, silentLogger).get()
    checkEqual(
      'settings: an explicit off cookie fallback is not overwritten by migration',
      explicitOff.engine.cookieFallback,
      'off'
    )

    // A key is pasted, so it can carry spaces or the wrong thing entirely. The
    // read path keeps a real key and turns anything else into "not configured".
    const badKeyFile = join(settingsRoot, 'bad-acoustid.json')
    await writeFile(badKeyFile, JSON.stringify({ metadata: { acoustidKey: 'not a key!' } }), 'utf8')
    checkEqual(
      'settings: an invalid AcoustID key is stored as not configured',
      new SettingsService(badKeyFile, silentLogger).get().metadata.acoustidKey,
      null
    )
    const goodKeyFile = join(settingsRoot, 'good-acoustid.json')
    await writeFile(goodKeyFile, JSON.stringify({ metadata: { acoustidKey: ' cSpUJKpD ' } }), 'utf8')
    checkEqual(
      'settings: a valid AcoustID key survives a read',
      new SettingsService(goodKeyFile, silentLogger).get().metadata.acoustidKey,
      'cSpUJKpD'
    )

    // The switch registers a Windows sign-in item, so only the literal `true`
    // may arm it; a hand-edited string must not start anything at login.
    const startupFile = join(settingsRoot, 'startup-flag.json')
    await writeFile(startupFile, JSON.stringify({ startup: { startOnLogin: 'yes' } }), 'utf8')
    checkEqual(
      'settings: a non-boolean start-with-Windows flag stays off',
      new SettingsService(startupFile, silentLogger).get().startup.startOnLogin,
      false
    )
    const startupOnFile = join(settingsRoot, 'startup-on.json')
    await writeFile(startupOnFile, JSON.stringify({ startup: { startOnLogin: true } }), 'utf8')
    checkEqual(
      'settings: a chosen start-with-Windows flag survives a read',
      new SettingsService(startupOnFile, silentLogger).get().startup.startOnLogin,
      true
    )
    // The provider manager is worth exercising for real: a command is split
    // without a shell, the child is started, `/ping` is read, and stopping kills
    // only the process this app owns. The temporary server speaks the two
    // endpoints the manager cares about.
    const portProbe = createServer()
    await new Promise<void>((resolve, reject) => {
      portProbe.once('error', reject)
      portProbe.listen(0, '127.0.0.1', () => resolve())
    })
    const portAddress = portProbe.address()
    const providerPort = portAddress && typeof portAddress === 'object' ? portAddress.port : 0
    await new Promise<void>((resolve) => portProbe.close(() => resolve()))

    const providerScript = join(settingsRoot, 'provider.mjs')
    await writeFile(
      providerScript,
      [
        "import { createServer } from 'node:http'",
        'const port = Number(process.argv[2])',
        'const server = createServer((request, response) => {',
        "  if (request.url === '/ping') {",
        "    response.setHeader('content-type', 'application/json')",
        "    response.end(JSON.stringify({ version: 'test-1', server_uptime: 1 }))",
        '    return',
        '  }',
        '  response.statusCode = 404',
        '  response.end()',
        '})',
        "server.listen(port, '127.0.0.1')"
      ].join('\n'),
      'utf8'
    )
    const providerEngine = {
      ...DEFAULT_SETTINGS.engine,
      poTokenEnabled: true,
      poTokenProviderUrl: `http://127.0.0.1:${providerPort}`,
      poTokenProviderCommand: `"${process.execPath}" "${providerScript}" ${providerPort}`
    }
    const provider = new PoTokenProvider({ engine: () => providerEngine, log: silentLogger })
    try {
      const started = await provider.start()
      check(
        'provider: a configured command starts and answers /ping',
        started.serverReachable && started.managedRunning,
        JSON.stringify(started)
      )
      checkEqual('provider: the server version is reported', started.serverVersion, 'test-1')
      const stopped = await provider.stop()
      check(
        'provider: stopping ends the process this app started',
        !stopped.serverReachable && !stopped.managedRunning,
        JSON.stringify(stopped)
      )
    } catch (error) {
      check(
        'provider: the manager can start and stop a real local server',
        false,
        error instanceof Error ? error.message : String(error)
      )
    } finally {
      provider.dispose()
    }

    // Startup no longer spawns the provider: the first YouTube request does,
    // and only once. The command here writes a marker and exits, so the check
    // is about the spawn and nothing else.
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
    const latchRoot = await mkdtemp(join(tmpdir(), 'player-po-latch-'))
    const latchMarker = join(latchRoot, 'started.txt')
    const latchEngine = {
      ...DEFAULT_SETTINGS.engine,
      poTokenEnabled: true,
      poTokenAutoStart: false,
      poTokenProviderCommand: `"${process.execPath}" -e "require('node:fs').writeFileSync(process.argv[1], 'started')" "${latchMarker}"`
    }
    const latch = new PoTokenProvider({ engine: () => latchEngine, log: silentLogger })
    try {
      latch.noteYouTubeRequest()
      await wait(300)
      check(
        'provider: a YouTube request leaves auto-start off alone',
        !existsSync(latchMarker)
      )
      latchEngine.poTokenAutoStart = true
      latch.armAutoStart()
      latch.noteYouTubeRequest()
      let spawned = false
      for (let attempt = 0; attempt < 40 && !spawned; attempt += 1) {
        await wait(50)
        spawned = existsSync(latchMarker)
      }
      check('provider: the first YouTube request starts an auto-start provider', spawned)
    } finally {
      latch.dispose()
      await rm(latchRoot, { recursive: true, force: true })
    }

    // A cold start takes far longer than a warm one: the provider loads
    // thousands of small files before it binds, and the first launch after a
    // reboot can pass 45 seconds. The first deadline must only end the wait;
    // killing the child there left the provider down for the rest of the
    // session. These two children start slowly and never at all.
    const slowScript = join(settingsRoot, 'slow-provider.mjs')
    await writeFile(
      slowScript,
      [
        "import { createServer } from 'node:http'",
        'const port = Number(process.argv[2])',
        'const server = createServer((request, response) => {',
        "  if (request.url === '/ping') {",
        "    response.setHeader('content-type', 'application/json')",
        "    response.end(JSON.stringify({ version: 'slow-1', server_uptime: 1 }))",
        '    return',
        '  }',
        '  response.statusCode = 404',
        '  response.end()',
        '})',
        "setTimeout(() => server.listen(port, '127.0.0.1'), 1200)"
      ].join('\n'),
      'utf8'
    )
    const slowProvider = new PoTokenProvider({
      engine: () => ({
        ...DEFAULT_SETTINGS.engine,
        poTokenEnabled: true,
        poTokenProviderUrl: `http://127.0.0.1:${providerPort}`,
        poTokenProviderCommand: `"${process.execPath}" "${slowScript}" ${providerPort}`
      }),
      log: silentLogger,
      readyWaitMs: 300,
      giveUpMs: 15_000
    })
    try {
      const slowStarted = await slowProvider.start()
      check(
        'provider: a child that is still loading is reported as starting, not killed',
        slowStarted.managedRunning && !slowStarted.serverReachable && slowStarted.error === null,
        JSON.stringify(slowStarted)
      )
      await delay(2500)
      const slowReady = await slowProvider.status()
      check(
        'provider: a slow child is picked up once it answers',
        slowReady.serverReachable && slowReady.managedRunning,
        JSON.stringify(slowReady)
      )
    } finally {
      // Awaited so the port is free for the child below; `dispose` only signals
      // the kill and returns.
      await slowProvider.stop()
    }

    const stuckScript = join(settingsRoot, 'stuck-provider.mjs')
    await writeFile(stuckScript, 'setInterval(() => {}, 1000)\n', 'utf8')
    const stuckProvider = new PoTokenProvider({
      engine: () => ({
        ...DEFAULT_SETTINGS.engine,
        poTokenEnabled: true,
        poTokenProviderUrl: `http://127.0.0.1:${providerPort}`,
        poTokenProviderCommand: `"${process.execPath}" "${stuckScript}" ${providerPort}`
      }),
      log: silentLogger,
      readyWaitMs: 200,
      giveUpMs: 2000
    })
    try {
      const stuckStarted = await stuckProvider.start()
      check(
        'provider: a child past the first deadline keeps running while it is watched',
        stuckStarted.managedRunning && !stuckStarted.serverReachable,
        JSON.stringify(stuckStarted)
      )
      await delay(4000)
      const stuckEnded = await stuckProvider.status()
      check(
        'provider: a child that never answers is stopped at the give-up deadline',
        !stuckEnded.managedRunning &&
          typeof stuckEnded.error === 'string' &&
          stuckEnded.error.includes('did not answer'),
        JSON.stringify(stuckEnded)
      )
    } finally {
      stuckProvider.dispose()
    }

    // The other half of the ownership rule: a server the user already runs is
    // never killed just because the app is asked to stop "its" provider.
    const externalServer = createServer((request, response) => {
      if (request.url === '/ping') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ version: 'external', server_uptime: 1 }))
        return
      }
      response.statusCode = 404
      response.end()
    })
    await new Promise<void>((resolve, reject) => {
      externalServer.once('error', reject)
      externalServer.listen(0, '127.0.0.1', () => resolve())
    })
    const externalAddress = externalServer.address()
    const externalPort = externalAddress && typeof externalAddress === 'object' ? externalAddress.port : 0
    const externalProvider = new PoTokenProvider({
      engine: () => ({
        ...DEFAULT_SETTINGS.engine,
        poTokenEnabled: true,
        poTokenProviderUrl: `http://127.0.0.1:${externalPort}`
      }),
      log: silentLogger
    })
    try {
      externalProvider.stopIfManaged()
      const externalStatus = await externalProvider.status()
      check(
        'provider: stopping never touches a server the app did not start',
        externalStatus.serverReachable
      )
    } finally {
      externalProvider.dispose()
      externalServer.closeAllConnections()
      await new Promise<void>((resolve) => externalServer.close(() => resolve()))
    }
    await rm(settingsRoot, { recursive: true, force: true })

    // Appearance is deliberately bounded: the UI offers a fixed set, so these
    // checks guard against a choice being added to the renderer without a
    // matching default, label or validation value.
    checkEqual('appearance: Midnight is the default theme', DEFAULT_SETTINGS.theme, 'dark')
    checkEqual('appearance: the five accents are offered', ACCENT_CHOICES.length, 5)
    check('appearance: every theme has a label and a hint', THEME_CHOICES.every((choice) => choice.label.length > 0 && choice.hint.length > 0))
    checkEqual(
      'appearance: the blue-black theme is named Midnight',
      THEME_CHOICES.find((choice) => choice.value === 'dark')?.label,
      'Midnight'
    )
    checkEqual(
      'appearance: the accent-tinted surface is named Accented',
      SURFACE_CHOICES.find((choice) => choice.value === 'accented')?.label,
      'Accented'
    )
    check('appearance: every density has a label', DENSITY_CHOICES.every((choice) => choice.label.length > 0))
    check('appearance: every surface has a label', SURFACE_CHOICES.every((choice) => choice.label.length > 0))
    check('appearance: every motion choice has a label', MOTION_CHOICES.every((choice) => choice.label.length > 0))
    check(
      'appearance: row height grows with density',
      DENSITY_ROW_HEIGHT.compact < DENSITY_ROW_HEIGHT.comfortable &&
        DENSITY_ROW_HEIGHT.comfortable < DENSITY_ROW_HEIGHT.spacious
    )
    check(
      'appearance: the default includes artwork and player choices',
      DEFAULT_APPEARANCE.visuals?.playerArtwork === true && DEFAULT_APPEARANCE.visuals?.playerAmbience === true
    )
    checkEqual('appearance: lyrics are centred by default', DEFAULT_SETTINGS.visuals.lyricsAlign, 'center')
    check(
      'appearance: both lyric alignments are offered with a label',
      LYRICS_ALIGNS.length === 2 &&
        LYRICS_ALIGN_CHOICES.length === LYRICS_ALIGNS.length &&
        LYRICS_ALIGN_CHOICES.every(
          (choice) => LYRICS_ALIGNS.includes(choice.value) && choice.label.length > 0
        )
    )

    const appearanceSettings = mergeSettings(DEFAULT_SETTINGS, {
      theme: 'light',
      visuals: {
        accent: 'rose',
        density: 'compact',
        surface: 'accented',
        motion: 'reduced',
        artworkShape: 'circle',
        artworkFit: 'contain',
        artworkSize: 'xlarge',
        lyricsAlign: 'left',
        playerArtwork: false,
        playerAmbience: false
      }
    })
    checkEqual('appearance: a theme patch deep-merges', appearanceSettings.theme, 'light')
    checkEqual('appearance: an accent patch deep-merges', appearanceSettings.visuals.accent, 'rose')
    checkEqual('appearance: a density patch deep-merges', appearanceSettings.visuals.density, 'compact')
    checkEqual('appearance: a surface patch deep-merges', appearanceSettings.visuals.surface, 'accented')
    checkEqual('appearance: a motion patch deep-merges', appearanceSettings.visuals.motion, 'reduced')
    checkEqual('appearance: an artwork patch deep-merges', appearanceSettings.visuals.artworkShape, 'circle')
    checkEqual('appearance: a lyric-alignment patch deep-merges', appearanceSettings.visuals.lyricsAlign, 'left')
    checkEqual('appearance: a player-artwork patch deep-merges', appearanceSettings.visuals.playerArtwork, false)
    const resetAppearance = mergeSettings(appearanceSettings, DEFAULT_APPEARANCE)
    checkEqual('appearance: reset restores the default theme', resetAppearance.theme, 'dark')
    checkEqual('appearance: reset restores the default accent', resetAppearance.visuals.accent, 'blue')
    checkEqual('appearance: reset restores centred lyrics', resetAppearance.visuals.lyricsAlign, 'center')

    // Equaliser and ReplayGain math. These are the values the Web Audio graph
    // uses, so a wrong dB conversion is a wrong-sounding player, not a cosmetic
    // bug. The parser half is tested with ffmpeg's own summary shape.
    checkEqual('audio: the equalizer has ten bands', EQ_BAND_COUNT, 10)
    check(
      'audio: the bands run low to high',
      EQ_BAND_FREQUENCIES.every((frequency, index) => index === 0 || frequency > (EQ_BAND_FREQUENCIES[index - 1] as number))
    )
    check(
      'audio: every preset has one gain per band, inside the allowed range',
      EQ_PRESETS.every(
        (preset) =>
          preset.gains.length === EQ_BAND_COUNT &&
          preset.gains.every((gain) => gain >= -12 && gain <= 12)
      )
    )
    checkEqual('audio: the flat preset is the default curve', DEFAULT_AUDIO_SETTINGS.equalizer.bands.join(','), '0,0,0,0,0,0,0,0,0,0')
    check('audio: both effects start off', !DEFAULT_AUDIO_SETTINGS.equalizer.enabled && !DEFAULT_AUDIO_SETTINGS.normalization.enabled)
    check('audio: 0 dB is unity gain', Math.abs(dbToGain(0) - 1) < 1e-9)
    check('audio: +6 dB is about double', Math.abs(dbToGain(6) - 1.9952623) < 1e-6)
    const clipped = normalizationGain(6, -1, true)
    check(
      'audio: normalization stops at the measured true peak',
      Math.abs(clipped - 1 / dbToGain(-1)) < 1e-9,
      String(clipped)
    )
    check(
      'audio: a quieter track is not capped below its own gain',
      Math.abs(normalizationGain(-3, -1, true) - dbToGain(-3)) < 1e-9
    )
    check(
      'audio: disabling the clipping guard applies the full gain',
      Math.abs(normalizationGain(6, -1, false) - dbToGain(6)) < 1e-9
    )
    checkEqual('audio: -23 LUFS needs +5 dB to reach the -18 target', replayGainForLufs(-23), 5)
    checkEqual('audio: an impossible loudness is clamped', replayGainForLufs(100), -30)

    const repairedAudio = normalizeAudioSettings({
      equalizer: { preset: 'rock', bands: [99] },
      normalization: { enabled: 'yes' }
    })
    checkEqual('audio: a short saved curve is repaired from the preset', repairedAudio.equalizer.bands.length, EQ_BAND_COUNT)
    checkEqual('audio: a non-boolean switch falls back to off', repairedAudio.normalization.enabled, false)
    const audioPatch = sanitizeAudioPatch({ equalizer: { preset: 'rock' } })
    checkEqual('audio: choosing a preset carries its curve', audioPatch.equalizer?.bands?.length, EQ_BAND_COUNT)
    check(
      'audio: a patch with no bands does not invent one',
      !('bands' in (sanitizeAudioPatch({ equalizer: { enabled: true } }).equalizer ?? {}))
    )
    checkEqual(
      'audio: preamp values are clamped before reaching the graph',
      sanitizeAudioPatch({ equalizer: { preampDb: 99 } }).equalizer?.preampDb,
      12
    )
    const mergedAudio = mergeSettings(DEFAULT_SETTINGS, { audio: { equalizer: { enabled: true } } })
    checkEqual('audio: an equalizer switch deep-merges', mergedAudio.audio.equalizer.enabled, true)
    checkEqual('audio: the untouched bands survive the patch', mergedAudio.audio.equalizer.bands.length, EQ_BAND_COUNT)
    checkEqual('reset: restores equalizer defaults', mergeSettings(mergedAudio, DEFAULT_PREFERENCE_PATCH).audio.equalizer.enabled, false)

    const ffmpegSummary = [
      '[Parsed_ebur128_0 @ 000001] Summary:',
      '',
      '  Integrated loudness:',
      '    I:         -23.4 LUFS',
      '    Threshold: -33.7 LUFS',
      '',
      '  Loudness range:',
      '    LRA:         5.1 LU',
      '',
      '  True peak:',
      '    Peak:       -1.2 dBFS'
    ].join('\n')
    const parsedLoudness = parseEbur128Summary(ffmpegSummary)
    checkEqual('replay gain: ffmpeg integrated loudness is parsed', parsedLoudness?.integratedLufs ?? null, -23.4)
    checkEqual('replay gain: ffmpeg true peak is parsed', parsedLoudness?.peakDb ?? null, -1.2)
    checkEqual(
      'replay gain: the last summary wins when ffmpeg repeats one',
      parseEbur128Summary(`${ffmpegSummary}\nI: -18.0 LUFS\nPeak: -0.3 dBFS`)?.integratedLufs ?? null,
      -18
    )
    check('replay gain: output without a summary is rejected', parseEbur128Summary('no measurement here') === null)

    // Reset preferences is not reset-everything: a chosen folder is a location,
    // not a taste, and losing one silently would be the worst kind of reset.
    const beforeReset = mergeSettings(DEFAULT_SETTINGS, {
      libraryFolders: ['D:\\Music'],
      volume: 0.32,
      theme: 'light',
      visuals: { accent: 'rose', density: 'compact' },
      interaction: { librarySingleClick: 'play' },
      desktop: { closeToTray: true },
      startup: { startOnLogin: true },
      engine: { binDir: 'D:\\Tools', lastUpdateCheckAt: 123_456, importLimit: 42 },
      retention: { downloadFolder: 'D:\\Downloads', qualityTier: 'data-saver' }
    })
    const afterReset = mergeSettings(beforeReset, DEFAULT_PREFERENCE_PATCH)
    checkEqual('reset: keeps library folders', afterReset.libraryFolders[0], 'D:\\Music')
    checkEqual('reset: keeps the engine folder', afterReset.engine.binDir, 'D:\\Tools')
    checkEqual('reset: keeps the download folder', afterReset.retention.downloadFolder, 'D:\\Downloads')
    checkEqual('reset: keeps the last update timestamp', afterReset.engine.lastUpdateCheckAt, 123_456)
    checkEqual('reset: restores volume', afterReset.volume, DEFAULT_SETTINGS.volume)
    checkEqual('reset: restores the theme', afterReset.theme, 'dark')
    checkEqual('reset: restores the accent', afterReset.visuals.accent, 'blue')
    checkEqual('reset: restores click behaviour', afterReset.interaction.librarySingleClick, 'select')
    checkEqual('reset: restores closing to tray', afterReset.desktop.closeToTray, false)
    checkEqual('reset: restores starting with Windows', afterReset.startup.startOnLogin, false)
    checkEqual('reset: restores import limits', afterReset.engine.importLimit, DEFAULT_SETTINGS.engine.importLimit)
    checkEqual('reset: restores saving quality', afterReset.retention.qualityTier, 'high')
    check(
      'reset: the patch leaves path fields out entirely',
      !('libraryFolders' in DEFAULT_PREFERENCE_PATCH) &&
        !('binDir' in (DEFAULT_PREFERENCE_PATCH.engine ?? {})) &&
        !('downloadFolder' in (DEFAULT_PREFERENCE_PATCH.retention ?? {}))
    )

    let cacheNow = 1_000
    let cacheLoads = 0
    const cache = new AsyncTtlCache<number>({ ttlMs: 1_000, maxEntries: 2, now: () => cacheNow })
    const loadCached = async (): Promise<number> => {
      cacheLoads += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      return 42
    }
    const [cachedA, cachedB] = await Promise.all([cache.get('same', loadCached), cache.get('same', loadCached)])
    checkEqual('cache: simultaneous identical reads share one load', cacheLoads, 1)
    checkEqual('cache: both callers get the value', cachedA + cachedB, 84)
    await cache.get('same', loadCached)
    checkEqual('cache: a fresh hit does not load again', cacheLoads, 1)
    cacheNow += 1_001
    await cache.get('same', loadCached)
    checkEqual('cache: an expired entry is loaded again', cacheLoads, 2)

    let gateNow = 1_000
    const gate = new YouTubeGate({
      now: () => gateNow,
      cooldownMs: 60_000,
      longCooldownMs: 120_000,
      strikeWindowMs: 300_000
    })
    gate.assertReady()
    gate.recordFailure(new Error("ERROR: Sign in to confirm you're not a bot"))
    checkEqual('gate: a bot check pauses requests for five minutes', gate.remainingMs(), 60_000)
    let gateBlocked = false
    try {
      gate.assertReady()
    } catch (error) {
      gateBlocked = error instanceof Error && error.message.includes('paused')
    }
    check('gate: the cooldown refuses a new request with a human message', gateBlocked)
    gateNow += 60_001
    gate.assertReady()
    gate.recordFailure(new Error("Sign in to confirm you're not a bot"))
    checkEqual('gate: a repeat check inside the window pauses longer', gate.remainingMs(), 120_000)

    const scheduler = new RequestScheduler({ maxConcurrent: 2, minGapMs: 30, jitterMs: 0 })
    let schedulerActive = 0
    let schedulerPeak = 0
    const schedulerStarts: number[] = []
    const schedulerJob = async (): Promise<void> => {
      schedulerActive += 1
      schedulerPeak = Math.max(schedulerPeak, schedulerActive)
      schedulerStarts.push(Date.now())
      await new Promise((resolve) => setTimeout(resolve, 50))
      schedulerActive -= 1
    }
    await Promise.all([schedulerJob, schedulerJob, schedulerJob].map(() => scheduler.schedule(schedulerJob)))
    checkEqual('scheduler: concurrency stays at its cap', schedulerPeak, 2)
    check(
      'scheduler: starts are separated by the gap',
      schedulerStarts.length === 3 &&
        (schedulerStarts[1] ?? 0) - (schedulerStarts[0] ?? 0) >= 20 &&
        (schedulerStarts[2] ?? 0) - (schedulerStarts[1] ?? 0) >= 20
    )

    // A service that answers 429 is correcting the pace the scheduler guessed.
    // The pause must hold the next start, and must not leak past its own wait.
    const cooled = new RequestScheduler({ maxConcurrent: 1, minGapMs: 0, jitterMs: 0 })
    const cooledStarts: number[] = []
    await cooled.schedule(async () => {
      cooledStarts.push(Date.now())
      cooled.pause(80)
    })
    await cooled.schedule(async () => {
      cooledStarts.push(Date.now())
    })
    check(
      'scheduler: a cooldown holds the next start',
      cooledStarts.length === 2 && (cooledStarts[1] ?? 0) - (cooledStarts[0] ?? 0) >= 60,
      JSON.stringify(cooledStarts.map((at) => at - (cooledStarts[0] ?? 0)))
    )
    checkEqual('scheduler: the cooldown ends with its wait', cooled.cooldownMs, 0)

    // The policy behind that pause, before any request is made.
    checkEqual('retry: delta-seconds are honoured', retryAfterMs('2', 1_000), 2_000)
    checkEqual(
      'retry: an HTTP date is honoured',
      retryAfterMs(new Date(10_000).toUTCString(), 4_000),
      6_000
    )
    checkEqual('retry: a garbage header is no header', retryAfterMs('soon'), null)
    checkEqual('retry: a 429 without a header uses the backoff', retryWaitMs(429, new Headers(), 1), 400)
    checkEqual('retry: the second attempt backs off twice as far', retryWaitMs(429, null, 2), 800)
    checkEqual('retry: a huge header is capped', retryWaitMs(429, new Headers({ 'Retry-After': '600' }), 1), 5_000)
    checkEqual('retry: a 404 is not a rate limit', retryWaitMs(404, null, 1), null)

    const nestedError = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })
    })
    const nestedText = serializeDetails({ error: nestedError })
    check(
      'logging: a nested error keeps its message, cause and code',
      nestedText.includes('fetch failed') &&
        nestedText.includes('socket hang up') &&
        nestedText.includes('ECONNRESET')
    )
    const circular: Record<string, unknown> = { error: new Error('circular boom') }
    circular.self = circular
    check('logging: circular details are serialized safely', serializeDetails(circular).includes('circular boom'))
    checkEqual('logging: no details adds no suffix', serializeDetails(undefined), '')

    const diagnosticsDir = join(root, 'diagnostics')
    await mkdir(diagnosticsDir, { recursive: true })
    const diagnosticsLog = join(diagnosticsDir, 'suura.log')
    await writeFile(diagnosticsLog, 'first line\nsecond line\nthird line\n', 'utf8')
    const smallTail = readLogTail(diagnosticsLog, 4096)
    check(
      'diagnostics: a small log is read whole',
      smallTail.text.includes('third line') && !smallTail.truncated && smallTail.size > 0
    )
    const missingTail = readLogTail(join(diagnosticsDir, 'missing.log'))
    check(
      'diagnostics: a missing log is reported without throwing',
      missingTail.missing && missingTail.text === ''
    )
    const longLog = Array.from(
      { length: 80 },
      (_, index) => `line ${index.toString().padStart(2, '0')} ${'x'.repeat(40)}`
    ).join('\n')
    await writeFile(diagnosticsLog, `${longLog}\n`, 'utf8')
    const tail = readLogTail(diagnosticsLog, 240)
    check(
      'diagnostics: a large log is cut to its tail',
      tail.truncated && tail.text.includes('line 79') && !tail.text.includes('line 00')
    )
    check(
      'diagnostics: a truncated tail starts on a line boundary',
      tail.text.startsWith('line ')
    )
    const diagnosticsBundle = buildDiagnosticsBundle({
      summary: 'Suura 1.2.3\r\nOS Windows',
      logPath: diagnosticsLog,
      log: tail,
      generatedAt: new Date('2026-10-25T00:00:00Z')
    })
    check(
      'diagnostics: the bundle carries the summary, log path and timestamp',
      diagnosticsBundle.includes('Suura 1.2.3\nOS Windows') &&
        diagnosticsBundle.includes(diagnosticsLog) &&
        diagnosticsBundle.includes('2026-10-25T00:00:00.000Z')
    )
    check(
      'diagnostics: the bundle says when the log was truncated',
      diagnosticsBundle.includes(`last ${tail.included} of ${tail.size} bytes`)
    )
    check(
      'diagnostics: a missing log is called out in the bundle',
      buildDiagnosticsBundle({
        summary: '',
        logPath: diagnosticsLog,
        log: missingTail
      }).includes('not available')
    )
    const diagnosticsFile = join(diagnosticsDir, 'bundle.txt')
    const written = await writeDiagnosticsFile(diagnosticsFile, {
      summary: 'Suura 1.2.3\nOS Windows',
      logPath: diagnosticsLog,
      log: tail,
      generatedAt: new Date('2026-10-25T00:00:00Z')
    })
    checkEqual(
      'diagnostics: the bundle is written as the text that was returned',
      await readFile(diagnosticsFile, 'utf8'),
      written.content
    )
    check(
      'diagnostics: the written bundle reports its byte length',
      written.bytes === Buffer.byteLength(written.content, 'utf8')
    )
    checkEqual(
      'diagnostics: the renderer summary is capped',
      sanitizeDiagnosticsSummary('a'.repeat(DIAGNOSTICS_SUMMARY_LIMIT + 100)).length,
      DIAGNOSTICS_SUMMARY_LIMIT
    )
    checkEqual(
      'diagnostics: the renderer summary is normalised',
      sanitizeDiagnosticsSummary('a\r\nb\0c'),
      'a\nbc'
    )

    const crashDir = join(root, 'crash-reports')
    const crashEnvironment = {
      appVersion: '9.9.9',
      platform: 'win32',
      arch: 'x64',
      electron: '1.0.0',
      chromium: '2.0.0',
      node: '3.0.0'
    }
    let crashEnabled = false
    const crashReporter = new CrashReporter({
      dir: crashDir,
      log: silentLogger,
      enabled: () => crashEnabled,
      environment: () => crashEnvironment
    })
    const deniedReport = crashReporter.record({
      kind: 'renderer',
      reason: 'crashed',
      exitCode: 1337
    })
    check(
      'crash reports: the switch off writes nothing',
      deniedReport === null && listCrashReports(crashDir).length === 0
    )

    crashEnabled = true
    const firstReport = crashReporter.record({
      kind: 'renderer',
      reason: 'crashed',
      message: 'renderer died',
      stack: 'Error: boom\n  at render',
      exitCode: 1337,
      details: { url: 'player-media://track', extra: null }
    })
    check('crash reports: an enabled crash writes one file', firstReport !== null)
    const storedReport = firstReport
      ? (JSON.parse(await readFile(firstReport, 'utf8')) as Record<string, unknown>)
      : {}
    check(
      'crash reports: the file records the kind, reason, exit code and environment',
      storedReport.kind === 'renderer' &&
        storedReport.reason === 'crashed' &&
        storedReport.exitCode === 1337 &&
        (storedReport.environment as { appVersion?: string }).appVersion === '9.9.9'
    )
    const crashStatus = crashReporter.status()
    check(
      'crash reports: status reports the count, newest time and folder',
      crashStatus.enabled &&
        crashStatus.count === 1 &&
        crashStatus.latestAt !== null &&
        crashStatus.folder === crashDir
    )

    const circularCrash: Record<string, unknown> = { reason: 'loop' }
    circularCrash.self = circularCrash
    crashReporter.record({
      kind: 'main-exception',
      reason: 'uncaughtException:uncaughtException',
      message: 'loop',
      details: circularCrash
    })
    check(
      'crash reports: circular details are written safely',
      listCrashReports(crashDir).length === 2
    )
    const crashBundle = buildCrashReportBundle(crashDir, new Date('2026-11-03T12:00:00Z'))
    check(
      'crash reports: the bundle says it is local and includes the reports',
      crashBundle.includes('Written on this PC') &&
        crashBundle.includes('Reports: 2') &&
        crashBundle.includes('renderer died')
    )
    const clearedReports = clearCrashReports(crashDir)
    check(
      'crash reports: clearing removes every report',
      clearedReports === 2 && listCrashReports(crashDir).length === 0
    )

    const pruneDir = join(root, 'crash-prune')
    let crashTick = 0
    const pruneReporter = new CrashReporter({
      dir: pruneDir,
      log: silentLogger,
      enabled: () => true,
      environment: () => crashEnvironment,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, crashTick++)),
      keep: 2
    })
    for (const kind of ['main-rejection', 'renderer', 'child-process'] as const) {
      pruneReporter.record({ kind, reason: 'test' })
    }
    checkEqual(
      'crash reports: only the newest reports are kept',
      pruneReporter.list().length,
      2
    )
    check('crash reports: the default keep limit is bounded', CRASH_REPORT_KEEP >= 1)

    const malformedDir = join(root, 'crash-malformed')
    await mkdir(malformedDir, { recursive: true })
    await writeFile(join(malformedDir, 'crash-broken.json'), '{ not json', 'utf8')
    const malformedReports = listCrashReports(malformedDir)
    check(
      'crash reports: an unreadable file still counts as evidence',
      malformedReports.length === 1 && malformedReports[0]?.kind === 'unknown'
    )

    checkEqual('recovery: the first retry is quick', recoveryDelayMs(0), PLAYBACK_RECOVERY_DELAYS_MS[0])
    checkEqual('recovery: the retry delay grows', recoveryDelayMs(4), 8_000)
    checkEqual('recovery: the budget is finite', recoveryDelayMs(PLAYBACK_RECOVERY_DELAYS_MS.length), null)
    check('recovery: a network error in a stream is retryable', shouldRecoverPlayback(2, 'youtube', true))
    check('recovery: an unsupported stream source is retryable', shouldRecoverPlayback(4, 'youtube', true))
    check('recovery: a local-file error is not retried', !shouldRecoverPlayback(2, 'local', true))
    check('recovery: a paused listener is left alone', !shouldRecoverPlayback(2, 'youtube', false))
    check('recovery: a decode error is not retried', !shouldRecoverPlayback(3, 'youtube', true))

    const tokenId = '00000000-0000-4000-8000-000000000000'
    checkEqual('stream: the URL round-trips', parseStreamUrl(buildStreamUrl(tokenId))?.token, tokenId)
    check('stream: a foreign scheme is rejected', parseStreamUrl(`player-media://stream/${tokenId}`) === null)
    // A token is the whole authority for a stream: anything that is not the
    // exact UUID shape must never reach the proxy's map.
    check('stream: a path is not a token', parseStreamUrl('player-stream://stream/../../secret') === null)
    check('stream: an encoded path is not a token', parseStreamUrl('player-stream://stream/..%2F..%2Fsecret') === null)

    const payload = Buffer.alloc(4096)
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251

    let lastUserAgent = ''
    let lastUpstreamHeader = ''
    let flakyHits = 0
    let downHits = 0
    let recoverHits = 0
    let blipHits = 0
    const server = createServer((request, response) => {
      // Dropping the socket is the closest a local server gets to the outage in
      // the report: `fetch` rejects at the transport level, not with a status.
      if (request.url === '/flaky') {
        flakyHits += 1
        if (flakyHits <= 2) {
          request.destroy()
          return
        }
      }
      if (request.url === '/blip') {
        blipHits += 1
        if (blipHits === 1) {
          request.destroy()
          return
        }
      }
      if (request.url === '/down') {
        downHits += 1
        request.destroy()
        return
      }
      if (request.url === '/down-recover') {
        recoverHits += 1
        if (recoverHits <= 2) {
          request.destroy()
          return
        }
      }

      if (request.url === '/expired' || request.url === '/forbidden') {
        response.writeHead(403, { 'content-type': 'text/plain' })
        response.end('expired')
        return
      }

      lastUserAgent = String(request.headers['user-agent'] ?? '')
      lastUpstreamHeader = String(request.headers['x-upstream'] ?? '')

      const range = request.headers.range
      const match = typeof range === 'string' ? /^bytes=(\d+)-(\d*)$/.exec(range) : null
      if (match) {
        const start = Number(match[1])
        const end = match[2] ? Math.min(Number(match[2]), payload.length - 1) : payload.length - 1
        response.writeHead(206, {
          'content-type': 'audio/webm',
          'accept-ranges': 'bytes',
          'content-range': `bytes ${start}-${end}/${payload.length}`,
          'content-length': end - start + 1
        })
        response.end(payload.subarray(start, end + 1))
        return
      }

      response.writeHead(200, {
        'content-type': 'audio/webm',
        'accept-ranges': 'bytes',
        'content-length': payload.length
      })
      response.end(payload)
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = address && typeof address === 'object' ? address.port : 0
    const origin = `http://127.0.0.1:${port}`

    try {
      const upstream = (path: string): UpstreamMedia => ({
        url: `${origin}${path}`,
        headers: { 'User-Agent': 'PlayerSmoke/1.0', 'X-Upstream': 'yes' },
        mimeType: 'audio/webm',
        expiresAt: Date.now() + 60_000
      })

      const proxy = new RemoteStreamProxy(async () => upstream('/fresh'), silentLogger)
      const token = proxy.register('video-a', upstream('/audio'))

      const full = await proxy.handle(token, { range: null, method: 'GET' })
      const fullBody = Buffer.from(await full.arrayBuffer())
      checkEqual('stream: a full request is forwarded', full.status, 200)
      check('stream: the body arrives intact', fullBody.length === payload.length && fullBody[1234] === payload[1234])
      checkEqual('stream: the upstream User-Agent reaches the CDN', lastUserAgent, 'PlayerSmoke/1.0')
      checkEqual('stream: other upstream headers are forwarded too', lastUpstreamHeader, 'yes')
      checkEqual(
        'stream: allows Web Audio to read the samples',
        full.headers.get('access-control-allow-origin'),
        '*'
      )

      const partial = await proxy.handle(token, { range: 'bytes=100-199', method: 'GET' })
      const partialBody = Buffer.from(await partial.arrayBuffer())
      checkEqual('stream: a range request comes back as 206', partial.status, 206)
      checkEqual('stream: the range is forwarded', partial.headers.get('content-range'), `bytes 100-199/${payload.length}`)
      check('stream: the range body is the requested bytes', partialBody.length === 100 && partialBody[0] === payload[100])

      const expiredToken = proxy.register('video-b', upstream('/expired'))
      const retried = await proxy.handle(expiredToken, { range: null, method: 'GET' })
      checkEqual('stream: a 403 is retried after a re-resolve', retried.status, 200)
      checkEqual('stream: the retry uses the fresh URL', retried.headers.get('content-length'), String(payload.length))
      check('stream: the same token keeps working', (await proxy.handle(expiredToken, { range: null, method: 'GET' })).status === 200)

      const failing = new RemoteStreamProxy(async () => upstream('/forbidden'), silentLogger)
      const forbiddenToken = failing.register('video-c', upstream('/forbidden'))
      checkEqual(
        'stream: a second 403 becomes a 502',
        (await failing.handle(forbiddenToken, { range: null, method: 'GET' })).status,
        502
      )
      checkEqual(
        'stream: an unknown token is a 404',
        (await failing.handle('11111111-1111-4111-8111-111111111111', { range: null, method: 'GET' })).status,
        404
      )

      // A transport failure is not a dead link. The proxy retries it, and only
      // reports a failure once the small budget is spent.
      const retrying = new RemoteStreamProxy(async () => upstream('/fresh'), silentLogger, {
        attempts: 3,
        retryDelayMs: 1,
        sleep: async () => undefined,
        random: () => 0.5
      })
      const retryToken = retrying.register('video-flaky', upstream('/flaky'))
      const retriedResponse = await retrying.handle(retryToken, { range: null, method: 'GET' })
      checkEqual('stream: a dropped connection is retried', retriedResponse.status, 200)
      checkEqual('stream: the retry reaches the server again', flakyHits, 3)
      await retriedResponse.body?.cancel()

      let proxyNow = 1_000_000
      const down = new RemoteStreamProxy(async () => null, silentLogger, {
        attempts: 1,
        retryDelayMs: 1_000,
        sleep: async () => undefined,
        now: () => proxyNow,
        random: () => 0.5
      })
      const downToken = down.register('video-down', upstream('/down'))
      const firstDown = await down.handle(downToken, { range: null, method: 'GET' })
      checkEqual('stream: a transport failure answers 503', firstDown.status, 503)
      checkEqual('stream: a transport failure asks for a short wait', firstDown.headers.get('retry-after'), '1')

      const secondDown = await down.handle(downToken, { range: null, method: 'GET' })
      checkEqual('stream: a request inside the cooldown is refused', secondDown.status, 503)
      checkEqual('stream: the cooldown makes no upstream request', downHits, 1)

      proxyNow += 1_001
      const thirdDown = await down.handle(downToken, { range: null, method: 'GET' })
      checkEqual('stream: a request after the cooldown tries again', thirdDown.status, 503)
      checkEqual('stream: the cooldown expires into a real attempt', downHits, 2)

      // The reported case: one interruption, the network comes back, and the
      // same URL is fine again. No re-resolve should be needed for a blip.
      let blipNow = 100
      const blip = new RemoteStreamProxy(async () => null, silentLogger, {
        attempts: 1,
        retryDelayMs: 10,
        sleep: async () => undefined,
        now: () => blipNow,
        random: () => 0.5
      })
      const blipToken = blip.register('video-blip', upstream('/blip'))
      checkEqual(
        'stream: the interruption fails the first request',
        (await blip.handle(blipToken, { range: null, method: 'GET' })).status,
        503
      )
      blipNow += 11
      const afterBlip = await blip.handle(blipToken, { range: null, method: 'GET' })
      checkEqual('stream: the same URL works once the network returns', afterBlip.status, 200)
      checkEqual('stream: a blip recovers without a re-resolve', blipHits, 2)
      await afterBlip.body?.cancel()

      // Chromium asks again within milliseconds after a failed response. Two
      // simultaneous asks must share one upstream attempt, not race each other.
      downHits = 0
      const concurrent = new RemoteStreamProxy(async () => null, silentLogger, {
        attempts: 1,
        sleep: async () => undefined,
        now: () => proxyNow + 60_000,
        random: () => 0.5
      })
      const concurrentToken = concurrent.register('video-concurrent', upstream('/down'))
      const [concurrentA, concurrentB] = await Promise.all([
        concurrent.handle(concurrentToken, { range: null, method: 'GET' }),
        concurrent.handle(concurrentToken, { range: null, method: 'GET' })
      ])
      check('stream: both simultaneous callers are told to wait', concurrentA.status === 503 && concurrentB.status === 503)
      checkEqual('stream: simultaneous retries share one upstream request', downHits, 1)

      // A second failed cycle is the signal that the outage is not momentary, so
      // the proxy refreshes the signed URL before the listener has to act.
      let recoveryNow = 500_000
      let resolveCalls = 0
      const recovering = new RemoteStreamProxy(
        async () => {
          resolveCalls += 1
          return upstream('/fresh')
        },
        silentLogger,
        {
          attempts: 1,
          retryDelayMs: 1,
          sleep: async () => undefined,
          now: () => recoveryNow,
          refreshCooldownMs: 0,
          random: () => 0.5
        }
      )
      const recoveryToken = recovering.register('video-recover', upstream('/down-recover'))
      checkEqual(
        'stream: the first transport failure keeps the URL',
        (await recovering.handle(recoveryToken, { range: null, method: 'GET' })).status,
        503
      )
      checkEqual('stream: the first failure does not spend a resolve', resolveCalls, 0)
      recoveryNow += 10
      checkEqual(
        'stream: the second transport failure still answers 503',
        (await recovering.handle(recoveryToken, { range: null, method: 'GET' })).status,
        503
      )
      await new Promise((resolve) => setTimeout(resolve, 0))
      checkEqual('stream: the second failure refreshes the URL', resolveCalls, 1)
      recoveryNow += 10
      const recovered = await recovering.handle(recoveryToken, { range: null, method: 'GET' })
      checkEqual('stream: the refreshed URL recovers playback', recovered.status, 200)
      checkEqual('stream: recovery does not ask the dead URL again', recoverHits, 2)
      await recovered.body?.cancel()

      let expiryNow = 1_000
      let expiryRefreshes = 0
      const expiring = new RemoteStreamProxy(
        async () => {
          expiryRefreshes += 1
          return upstream('/fresh')
        },
        silentLogger,
        { now: () => expiryNow, refreshCooldownMs: 0, sleep: async () => undefined }
      )
      const expiringToken = expiring.register('video-expired', {
        ...upstream('/audio'),
        expiresAt: expiryNow - 1
      })
      const expiredServed = await expiring.handle(expiringToken, { range: null, method: 'GET' })
      checkEqual('stream: an expired URL is refreshed before it is used', expiryRefreshes, 1)
      checkEqual('stream: the refreshed URL serves the request', expiredServed.status, 200)
      await expiredServed.body?.cancel()

      const media: YtMediaInfo = {
        videoId: 'dQw4w9WgXcQ',
        webpageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'Smoke Test Video',
        artist: 'Smoke Tester',
        channel: 'Smoke Channel',
        durationSec: 200,
        thumbnailUrl: null,
        formatId: '251',
        ext: 'webm',
        codec: 'Opus',
        bitrateKbps: 130,
        sampleRateHz: 48000,
        channels: 2,
        fileSize: 4096,
        streamUrl: `${origin}/audio`,
        headers: { 'User-Agent': 'PlayerSmoke/1.0' },
        expiresAt: Date.now() + 3_600_000,
        mimeType: 'audio/webm'
      }
      let infoCalls = 0
      let clock = Date.now()
      const infoProvider: YtInfoProvider = {
        async fetchInfo() {
          infoCalls += 1
          return media
        }
      }
      const resolver = new YouTubeResolver({
        info: infoProvider,
        log: silentLogger,
        quality: () => 'best',
        now: () => clock
      })

      const link = await resolver.resolveLink('https://youtu.be/dQw4w9WgXcQ')
      checkEqual('youtube: a pasted link becomes a track draft', link.track.title, 'Smoke Test Video')
      checkEqual('youtube: the draft keeps the video id', link.track.sourceId, 'dQw4w9WgXcQ')
      check('youtube: the renderer gets a token, not a CDN URL', link.source.url.startsWith('player-stream://'))
      checkEqual('youtube: the source names its resolver', link.source.resolverId, 'yt-dlp')
      checkEqual('youtube: a paste resolves once', infoCalls, 1)

      const played = await resolver.resolve({
        id: -1,
        sourceKind: 'youtube',
        sourceId: 'dQw4w9WgXcQ',
        filePath: null
      })
      checkEqual('youtube: playback reuses the paste', infoCalls, 1)
      checkEqual('youtube: the token is stable across resolves', played.url, link.source.url)

      const parsedToken = parseStreamUrl(played.url)?.token
      const throughToken = parsedToken
        ? await resolver.proxy.handle(parsedToken, { range: 'bytes=0-9', method: 'GET' })
        : null
      check(
        'youtube: the token resolves to real bytes',
        throughToken?.status === 206 && (await throughToken.arrayBuffer()).byteLength === 10
      )

      clock = media.expiresAt + 1000
      await resolver.resolve({ id: -1, sourceKind: 'youtube', sourceId: 'dQw4w9WgXcQ', filePath: null })
      checkEqual('youtube: an expired URL is resolved again', infoCalls, 2)

      // A prefetch is the next track's resolve, run while the current one plays.
      // It has to warm exactly the cache playback reads, so the play that follows
      // costs an IPC round trip and no sidecar.
      clock = Date.now()
      const beforePrefetch = infoCalls
      await resolver.prefetch({ id: -2, sourceKind: 'youtube', sourceId: 'aaaaaaaaaaa', filePath: null })
      checkEqual('youtube: prefetching the next track warms the cache', infoCalls, beforePrefetch + 1)
      await resolver.resolve({ id: -2, sourceKind: 'youtube', sourceId: 'aaaaaaaaaaa', filePath: null })
      checkEqual('youtube: a prefetched track needs no second sidecar', infoCalls, beforePrefetch + 1)

      let rejected = false
      try {
        await resolver.resolveLink('https://example.com/watch?v=dQw4w9WgXcQ')
      } catch {
        rejected = true
      }
      check('youtube: a non-YouTube link is rejected', rejected)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  // --- the resolver registry ----------------------------------------------
  // Prefetch is optional on a resolver and best-effort at the registry, so an
  // unclaimed track, a resolver that cannot warm anything, and a warm-up that
  // throws must all be quiet no-ops rather than errors.
  {
    const registry = new ResolverRegistry()
    let warmed = 0
    let resolved = 0
    registry.register({
      id: 'has-prefetch',
      capabilities: { streaming: true, search: false, download: false },
      canResolve: (track) => track.sourceKind === 'youtube',
      resolve: async () => {
        resolved += 1
        throw new Error('the registry test never resolves')
      },
      prefetch: async () => {
        warmed += 1
      }
    })
    registry.register({
      id: 'no-prefetch',
      capabilities: { streaming: true, search: false, download: false },
      canResolve: (track) => track.sourceKind === 'local',
      resolve: async () => {
        resolved += 1
        throw new Error('the registry test never resolves')
      }
    })

    await registry.prefetch({ id: -3, sourceKind: 'youtube', sourceId: 'dQw4w9WgXcQ', filePath: null })
    checkEqual('resolvers: a prefetch reaches the resolver that claims the track', warmed, 1)
    await registry.prefetch({ id: 1, sourceKind: 'local', sourceId: null, filePath: 'C:\\music\\a.flac' })
    checkEqual('resolvers: a resolver without a prefetch is simply skipped', warmed, 1)
    checkEqual('resolvers: a prefetch is a warm-up, not a resolve', resolved, 0)

    const failing = new ResolverRegistry()
    failing.register({
      id: 'failing-prefetch',
      capabilities: { streaming: true, search: false, download: false },
      canResolve: () => true,
      resolve: async () => {
        throw new Error('the registry test never resolves')
      },
      prefetch: async () => {
        throw new Error('the sidecar is not installed')
      }
    })
    let threw = false
    try {
      await failing.prefetch({ id: -5, sourceKind: 'youtube', sourceId: 'dQw4w9WgXcQ', filePath: null })
    } catch {
      threw = true
    }
    check('resolvers: a failed prefetch never reaches the caller', !threw)
  }

  // --- the online history -------------------------------------------------
  // A link is remembered when it is pasted and ordered by its most recent
  // activity, added or played. That ordering is the repository's job, so it is
  // tested against a real database file rather than a stub.
  {
    const root = await mkdtemp(join(tmpdir(), 'player-online-'))
    const handle = openLibraryDatabase(join(root, 'library.db'), silentLogger)
    try {
      const repo = new OnlineRepository(handle.db)
      checkEqual('online: a fresh history is empty', repo.list().length, 0)

      const first = repo.upsert(
        {
          videoId: 'aaaaaaaaaaa',
          title: 'First Song',
          artist: 'First Artist',
          channel: 'First Channel',
          album: null,
          durationMs: 210_000,
          sourceUrl: youtubeWatchUrl('aaaaaaaaaaa'),
          artworkKey: `${'a'.repeat(40)}.jpg`
        },
        1000
      )
      checkEqual('online: a pasted link becomes a row', repo.list().length, 1)
      checkEqual('online: the row keeps the video id', first.videoId, 'aaaaaaaaaaa')
      checkEqual(
        'online: the artist and channel are stored separately',
        `${first.artist} / ${first.channel}`,
        'First Artist / First Channel'
      )
      checkEqual(
        'online: the canonical watch URL is stored',
        first.sourceUrl,
        'https://www.youtube.com/watch?v=aaaaaaaaaaa'
      )
      checkEqual('online: the add time is recorded', first.addedAt, 1000)
      check('online: a fresh row has not been played', first.lastPlayedAt === null)

      repo.upsert(
        {
          videoId: 'bbbbbbbbbbb',
          title: 'Second Song',
          artist: null,
          channel: null,
          album: null,
          durationMs: null,
          sourceUrl: youtubeWatchUrl('bbbbbbbbbbb'),
          artworkKey: null
        },
        2000
      )
      checkEqual('online: the newest paste is first', repo.list()[0]?.videoId, 'bbbbbbbbbbb')

      const again = repo.upsert(
        {
          videoId: 'aaaaaaaaaaa',
          title: 'First Song (Remastered)',
          artist: 'First Artist',
          channel: 'First Channel',
          album: null,
          durationMs: 215_000,
          sourceUrl: youtubeWatchUrl('aaaaaaaaaaa'),
          artworkKey: null
        },
        3000
      )
      checkEqual('online: pasting the same link does not duplicate it', repo.list().length, 2)
      checkEqual('online: the existing row is refreshed', again.title, 'First Song (Remastered)')
      checkEqual('online: a re-paste moves the row to the top', repo.list()[0]?.videoId, 'aaaaaaaaaaa')
      checkEqual('online: a re-paste keeps the cached artwork', repo.list()[0]?.artworkKey, `${'a'.repeat(40)}.jpg`)
      checkEqual('online: a re-paste never invents a play', repo.list()[0]?.lastPlayedAt, null)

      repo.touch('bbbbbbbbbbb', 4000)
      checkEqual('online: playing a link lifts it above a newer paste', repo.list()[0]?.videoId, 'bbbbbbbbbbb')

      const top = repo.list()[0]
      const mapped = top ? onlineEntryToTrack(top) : null
      check('online: a row becomes a stream track', Boolean(mapped) && mapped?.sourceKind === 'youtube')
      checkEqual('online: the stream track names the video', mapped?.sourceId, 'bbbbbbbbbbb')
      checkEqual('online: the stream track id is negative and derived from the row', mapped?.id, top ? -top.id : null)
      check('online: the stream track has no file', mapped?.filePath === null)
      check(
        'online: a history row is not mistaken for an imported entry',
        mapped === null || !isImportedPlaylistTrackId(mapped.id)
      )

      // A cover is downloaded after the row exists, so the key is written on a
      // later pass. That is also what repairs rows added before thumbnails decoded.
      repo.setArtworkKey('bbbbbbbbbbb', `${'b'.repeat(40)}.png`)
      checkEqual('online: a thumbnail fetched later is stored', repo.getByVideoId('bbbbbbbbbbb')?.artworkKey, `${'b'.repeat(40)}.png`)
      checkEqual('online: storing a thumbnail leaves the order alone', repo.list()[0]?.videoId, 'bbbbbbbbbbb')

      checkEqual('online: count agrees with the list', repo.count(), 2)
      repo.remove(first.id)
      checkEqual('online: removing a link forgets it', repo.count(), 1)
      checkEqual('online: clearing removes the rest', repo.clear(), 1)
      checkEqual('online: the history is empty again', repo.list().length, 0)

      // Importing a list takes its entries back out of the history, so a 50-track
      // import can never leave 50 echoes of itself behind.
      repo.upsert(
        {
          videoId: 'ccccccccccc',
          title: 'Third Song',
          artist: null,
          channel: null,
          album: null,
          durationMs: null,
          sourceUrl: youtubeWatchUrl('ccccccccccc'),
          artworkKey: null
        },
        5000
      )
      repo.upsert(
        {
          videoId: 'ddddddddddd',
          title: 'Fourth Song',
          artist: null,
          channel: null,
          album: null,
          durationMs: null,
          sourceUrl: youtubeWatchUrl('ddddddddddd'),
          artworkKey: null
        },
        5001
      )
      checkEqual(
        'online: removing by video id forgets only what it names',
        repo.removeByVideoIds(['ccccccccccc', 'eeeeeeeeeee']),
        1
      )
      checkEqual('online: the history keeps the rows that were not named', repo.count(), 1)
      checkEqual('online: removing a missing video id is harmless', repo.removeByVideoIds(['zzzzzzzzzzz']), 0)
    } finally {
      handle.close()
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  // --- imported online playlists -----------------------------------------
  // A snapshot, not a mirror: importing the same list again replaces its
  // entries in place, and an entry's position is what "play from here" uses.
  {
    const root = await mkdtemp(join(tmpdir(), 'player-online-lists-'))
    const handle = openLibraryDatabase(join(root, 'library.db'), silentLogger)
    try {
      const repo = new OnlinePlaylistRepository(handle.db)
      checkEqual('online lists: a fresh index is empty', repo.list().length, 0)

      const album = repo.upsert(
        {
          listId: 'OLAK5uy_test',
          kind: 'album',
          title: 'head or heart',
          owner: 'Christina Perri',
          sourceUrl: 'https://www.youtube.com/playlist?list=OLAK5uy_test',
          coverKey: `${'c'.repeat(40)}.png`,
          totalCount: 3
        },
        [
          { videoId: 'aaaaaaaaaaa', title: 'a thousand years', artist: 'Christina Perri', album: 'head or heart', durationMs: 285_000 },
          { videoId: 'bbbbbbbbbbb', title: 'human', artist: 'Christina Perri', album: 'head or heart', durationMs: 250_000 },
          { videoId: 'ccccccccccc', title: 'jar of hearts', artist: 'Christina Perri', album: 'head or heart', durationMs: 250_000 }
        ],
        1000
      )
      checkEqual('online lists: the album is indexed', repo.list().length, 1)
      checkEqual('online lists: the kind is kept', album.kind, 'album')
      checkEqual('online lists: the entry count is computed', album.trackCount, 3)
      checkEqual('online lists: the total YouTube reported is kept', album.totalCount, 3)
      checkEqual('online lists: entries keep the source order', repo.items(album.id).map((item) => item.videoId).join(','), 'aaaaaaaaaaa,bbbbbbbbbbb,ccccccccccc')
      checkEqual('online lists: positions start at zero', repo.items(album.id)[0]?.position, 0)
      // A list without a sleeve shows its first entry's still on the Online card.
      checkEqual('online lists: the first entry is the card cover fallback', album.firstVideoId, 'aaaaaaaaaaa')

      const item = repo.findItemByVideo('bbbbbbbbbbb')
      checkEqual('online lists: a video can be found for its first play', item?.artist, 'Christina Perri')
      checkEqual('online lists: the found entry names its album', item?.album, 'head or heart')

      const entryTrack = item ? onlinePlaylistItemToTrack(item, album) : null
      check(
        'online lists: an entry is recognised as an imported track',
        entryTrack !== null && isImportedPlaylistTrackId(entryTrack.id)
      )

      const reimported = repo.upsert(
        {
          listId: 'OLAK5uy_test',
          kind: 'album',
          title: 'head or heart (deluxe)',
          owner: 'Christina Perri',
          sourceUrl: 'https://www.youtube.com/playlist?list=OLAK5uy_test',
          coverKey: null,
          totalCount: 2
        },
        [
          { videoId: 'ccccccccccc', title: 'jar of hearts', artist: 'Christina Perri', album: 'head or heart (deluxe)', durationMs: 250_000 },
          { videoId: 'ddddddddddd', title: 'distance', artist: 'Christina Perri', album: 'head or heart (deluxe)', durationMs: 240_000 }
        ],
        2000
      )
      checkEqual('online lists: a re-import replaces the snapshot', repo.list().length, 1)
      checkEqual('online lists: the playlist keeps its row id', reimported.id, album.id)
      checkEqual('online lists: the re-import count is the new one', reimported.trackCount, 2)
      checkEqual('online lists: a re-import keeps a cover it could not fetch again', reimported.coverKey, `${'c'.repeat(40)}.png`)
      checkEqual('online lists: the re-import moves the playlist to the top', repo.list()[0]?.id, album.id)

      // A mix's automatic name is its first track, so the user can give it one
      // that is actually theirs. It lives apart from YouTube's title: a later
      // re-import refreshes the snapshot without undoing the name.
      const renamed = repo.rename(album.id, '  My album  ')
      checkEqual('online lists: a custom name is trimmed', renamed?.title, 'My album')
      const afterRename = repo.upsert(
        {
          listId: 'OLAK5uy_test',
          kind: 'album',
          title: 'head or heart (deluxe)',
          owner: 'Christina Perri',
          sourceUrl: 'https://www.youtube.com/playlist?list=OLAK5uy_test',
          coverKey: null,
          totalCount: 2
        },
        [
          { videoId: 'ccccccccccc', title: 'jar of hearts', artist: 'Christina Perri', album: 'head or heart (deluxe)', durationMs: 250_000 },
          { videoId: 'ddddddddddd', title: 'distance', artist: 'Christina Perri', album: 'head or heart (deluxe)', durationMs: 240_000 }
        ],
        2500
      )
      checkEqual('online lists: a re-import keeps the custom name', afterRename.title, 'My album')
      checkEqual('online lists: a re-import still refreshes the entries', afterRename.trackCount, 2)
      checkEqual('online lists: renaming a missing playlist is a no-op', repo.rename(999_999, 'nobody'), null)

      const removedPlaylistId = repo.removeItem(repo.items(album.id)[0]?.id ?? -1)
      checkEqual('online lists: removing an entry names its playlist', removedPlaylistId, album.id)
      checkEqual('online lists: positions close the gap', repo.items(album.id)[0]?.position, 0)
      checkEqual('online lists: the remaining entry is the right one', repo.items(album.id)[0]?.videoId, 'ddddddddddd')
      checkEqual('online lists: the card fallback follows the snapshot', repo.get(album.id)?.firstVideoId, 'ddddddddddd')

      const mix = repo.upsert(
        {
          listId: 'RDaaaaaaaaaaa',
          kind: 'mix',
          title: 'Mix - a thousand years',
          owner: null,
          sourceUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa&list=RDaaaaaaaaaaa&start_radio=1',
          coverKey: null,
          totalCount: null
        },
        [{ videoId: 'eeeeeeeeeee', title: 'some mix track', artist: null, album: null, durationMs: null }],
        3000
      )
      checkEqual('online lists: a mix is its own playlist', mix.kind, 'mix')
      checkEqual('online lists: a mix offers its first still as a card cover', mix.firstVideoId, 'eeeeeeeeeee')
      checkEqual('online lists: the newest import is first', repo.list()[0]?.id, mix.id)

      check('online lists: deleting removes the playlist', repo.delete(mix.id))
      checkEqual('online lists: the deleted playlist is gone', repo.list().length, 1)
      checkEqual('online lists: the deleted entries are gone too', repo.items(mix.id).length, 0)
      check('online lists: deleting something already gone is harmless', !repo.delete(mix.id))
    } finally {
      handle.close()
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  // --- one live search across local and imported --------------------------
  // The merge is what keeps the Imported shelf honest: a downloaded copy hides
  // the remembered video, and a video repeated across history and a list shows
  // once. The repository searches feed it, so both run against a real database.
  {
    const root = await mkdtemp(join(tmpdir(), 'player-search-'))
    const handle = openLibraryDatabase(join(root, 'library.db'), silentLogger)
    try {
      const history = new OnlineRepository(handle.db)
      const playlists = new OnlinePlaylistRepository(handle.db)
      const now = Date.now()
      const seeded = [
        { videoId: 'searchaaaaa', title: 'Search One', artist: 'Search Artist' },
        { videoId: 'searchbbbbb', title: 'Search Two', artist: null }
      ]
      seeded.forEach((entry, at) => {
        history.upsert(
          {
            ...entry,
            channel: null,
            album: null,
            durationMs: null,
            sourceUrl: youtubeWatchUrl(entry.videoId),
            artworkKey: null
          },
          now - at * 1000
        )
      })
      playlists.upsert(
        {
          listId: 'PLsearchtest',
          kind: 'playlist',
          title: 'Search List',
          owner: null,
          sourceUrl: 'https://www.youtube.com/playlist?list=PLsearchtest',
          coverKey: null,
          totalCount: 2
        },
        [
          { videoId: 'searchbbbbb', title: 'Search Two', artist: null, album: null, durationMs: null },
          { videoId: 'searchccccc', title: 'Search Three', artist: null, album: null, durationMs: null }
        ],
        now
      )

      const merged = mergeLibrarySearch(
        [],
        history.search('Search', 30),
        playlists.search('Search', 30),
        30
      )
      checkEqual(
        'search: a repeated video appears once on Imported',
        merged.imported.map((row) => row.track.sourceId).join(','),
        'searchaaaaa,searchbbbbb,searchccccc'
      )
      checkEqual(
        'search: every imported row names its source',
        merged.imported.map((row) => row.source).join(','),
        'History,History,Search List'
      )

      const remembered = history.getByVideoId('searchaaaaa')
      const localCopy = remembered
        ? {
            ...onlineEntryToTrack(remembered),
            id: 7,
            sourceKind: 'local' as const,
            filePath: 'C:/music/search-one.flac',
            originKind: 'youtube' as const,
            originId: 'searchaaaaa'
          }
        : null
      const hidden = mergeLibrarySearch(
        localCopy ? [localCopy] : [],
        history.search('Search', 30),
        playlists.search('Search', 30),
        30
      )
      checkEqual(
        'search: a downloaded copy hides the remembered video',
        hidden.imported[0]?.track.sourceId,
        'searchbbbbb'
      )
      checkEqual(
        'search: the local shelf keeps the downloaded copy',
        hidden.local.map((track) => track.id).join(','),
        '7'
      )

      const capped = mergeLibrarySearch([], history.search('Search', 30), playlists.search('Search', 30), 1)
      checkEqual('search: the Imported shelf honours its cap', capped.imported.length, 1)
      checkEqual(
        'search: the repository search ignores unrelated text',
        history.search('Unrelated', 30).length + playlists.search('Unrelated', 30).length,
        0
      )

      // The prefetch gate is pure, so its edges are checked here rather than
      // through a live resolve. Search may warm a result only for the case the
      // guess is meant for: an empty local answer, one best match, no work
      // already in flight, and a quiet minute behind it.
      const gate: SearchPrefetchGate = {
        enabled: true,
        submitted: true,
        localCount: 0,
        importedCount: 0,
        bestVideoId: 'searchbbbbb',
        inFlight: false,
        now: 1_000_000,
        lastAttemptAt: null,
        blockedUntil: 0,
        cooldownMs: 45_000
      }
      const allows = (patch: Partial<SearchPrefetchGate>): boolean =>
        canPrefetchSearchMatch({ ...gate, ...patch })
      check('search: an empty shelf with a best match may be warmed', allows({}))
      check('search: the prefetch setting turns the guess off', !allows({ enabled: false }))
      check('search: nothing is warmed before the query is submitted', !allows({ submitted: false }))
      check('search: a device hit needs no warm-up', !allows({ localCount: 1 }))
      check('search: an imported hit needs no warm-up', !allows({ importedCount: 1 }))
      check('search: no best match means no warm-up', !allows({ bestVideoId: null }))
      check('search: only one warm-up may be in flight', !allows({ inFlight: true }))
      check(
        'search: a second warm-up waits for the cooldown',
        !allows({ lastAttemptAt: gate.now - gate.cooldownMs + 1 })
      )
      check(
        'search: the cooldown ends on its boundary',
        allows({ lastAttemptAt: gate.now - gate.cooldownMs })
      )
      check(
        'search: a bot check pauses the guess',
        !allows({ blockedUntil: gate.now + 5 * 60_000 })
      )
      check('search: a passed block allows a guess again', allows({ blockedUntil: gate.now - 1 }))
    } finally {
      handle.close()
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  // --- tag writing ---------------------------------------------------------
  // The write path is the only code that modifies a user's music, so every
  // container it claims to support is exercised on a real file: fields are
  // written, read back through the library's own parser, and the original is
  // kept under `backups/tags`. A writer that "succeeds" but produces a file the
  // scanner cannot read would show up here, not in a user's library.
  const tagRoot = await mkdtemp(join(tmpdir(), 'player-tags-'))
  try {
    const tagWriter = new TagWriter({
      backupDir: join(tagRoot, 'backups'),
      resolveFfmpeg: async () => ffmpegPath
    })

    const makeTagFixture = async (
      fileName: string,
      codec: string[],
      extra: Array<[string, string]> = []
    ): Promise<string> => {
      const target = join(tagRoot, fileName)
      await execFileAsync(
        ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1.2',
          ...codec,
          '-metadata',
          'title=Old Title',
          '-metadata',
          'artist=Old Artist',
          '-metadata',
          'album=Old Album',
          '-metadata',
          'comment=https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          ...extra.flatMap(([key, value]) => ['-metadata', `${key}=${value}`]),
          target
        ],
        { timeout: 60_000 }
      )
      return target
    }

    const edited: TagFields = {
      title: 'Naya Gaana — নতুন',
      artist: 'Arijit Singh',
      albumArtist: 'Arijit Singh',
      album: 'Album One',
      trackNo: 3,
      trackTotal: 12,
      discNo: 1,
      discTotal: 2,
      year: 2024,
      genre: 'Filmi',
      lyrics: 'first line\nsecond line\nতৃতীয় লাইন'
    }

    const parseTags = async (filePath: string) => {
      const parseFile = await loadMetadataParser()
      return await parseFile(filePath, { duration: false, skipCovers: true })
    }
    const lyricsOf = async (filePath: string): Promise<string | null> =>
      rawLyricsOf((await parseTags(filePath)).native)

    const containers: Array<{ name: string; file: string; codec: string[] }> = [
      { name: 'mp3', file: 'track.mp3', codec: ['-c:a', 'libmp3lame'] },
      { name: 'flac', file: 'track.flac', codec: ['-c:a', 'flac'] },
      { name: 'm4a', file: 'track.m4a', codec: ['-c:a', 'aac'] },
      { name: 'ogg', file: 'track.ogg', codec: ['-c:a', 'libvorbis'] },
      { name: 'opus', file: 'track.opus', codec: ['-c:a', 'libopus'] }
    ]

    const written = new Map<string, TagWriteResult>()
    for (const container of containers) {
      const filePath = await makeTagFixture(container.file, container.codec)
      let result: TagWriteResult | null = null
      let failure: unknown = null
      try {
        result = await tagWriter.write(filePath, edited)
      } catch (error) {
        failure = error
      }
      check(`tags: ${container.name} accepts every field`, result !== null, String(failure))
      if (!result) continue
      written.set(container.name, result)

      const metadata = await extractMetadata(filePath)
      checkEqual(
        `tags: ${container.name} reads back the names`,
        [metadata.title, metadata.artist, metadata.albumArtist, metadata.album].join(' | '),
        'Naya Gaana — নতুন | Arijit Singh | Arijit Singh | Album One'
      )
      checkEqual(
        `tags: ${container.name} reads back year, genre, track and disc`,
        [metadata.year, metadata.genre, metadata.trackNo, metadata.discNo].join(' | '),
        '2024 | Filmi | 3 | 1'
      )
      checkEqual(`tags: ${container.name} keeps the lyrics`, await lyricsOf(filePath), edited.lyrics ?? null)
      const parsedForComment = await parseTags(filePath)
      checkEqual(
        `tags: ${container.name} keeps the YouTube comment`,
        // MP3 stores ffmpeg's comment as `TXXX:comment`, which music-metadata
        // keeps native rather than mapping onto `common.comment`.
        youtubeOriginOf(parsedForComment.common.comment) ??
          youtubeOriginOfNative(parsedForComment.native),
        'dQw4w9WgXcQ'
      )
      check(
        `tags: ${container.name} leaves no temp file behind`,
        readdirSync(tagRoot).every((name) => !isTagTempFile(name))
      )
      check(
        `tags: ${container.name} keeps a backup of the original`,
        Boolean(result.backupPath && existsSync(result.backupPath))
      )
    }

    // The regression that started this milestone: ffmpeg's MP3 lyrics are a
    // `TXXX:USLT` text frame that no reader maps back to lyrics.
    const mp3Frames = (await parseTags(join(tagRoot, 'track.mp3'))).native
    const frameIds = Object.values(mp3Frames).flatMap((frames) =>
      frames.map((frame) => (frame as { id?: string }).id ?? '')
    )
    check('tags: MP3 lyrics are a real USLT frame', frameIds.includes('USLT'))

    const mp3Backup = written.get('mp3')?.backupPath
    checkEqual(
      'tags: the backup still holds the old tags',
      mp3Backup ? (await extractMetadata(mp3Backup)).title : null,
      'Old Title'
    )

    // Clearing is a distinct operation from leaving a field alone: a blank input
    // must remove the frame, not write an empty one.
    const clearTarget = await makeTagFixture('clear.flac', ['-c:a', 'flac'])
    await tagWriter.write(clearTarget, { title: 'Kept Title', album: 'Gone Album', lyrics: 'to be removed' })
    await tagWriter.write(clearTarget, { album: null, lyrics: null })
    const cleared = await extractMetadata(clearTarget)
    checkEqual(
      'tags: clearing removes only the fields that were cleared',
      JSON.stringify([cleared.title, cleared.album]),
      JSON.stringify(['Kept Title', null])
    )
    checkEqual('tags: clearing the lyrics removes them', await lyricsOf(clearTarget), null)

    // Long text is where a naive writer truncates or corrupts the frame.
    const longPath = await makeTagFixture('long.mp3', ['-c:a', 'libmp3lame'])
    const longLyrics = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`).join('\n')
    await tagWriter.write(longPath, { lyrics: longLyrics })
    checkEqual('tags: a 3 KB lyric survives intact', (await lyricsOf(longPath))?.length ?? 0, longLyrics.length)

    // LRC is stored verbatim; the reader is what turns it into timed lines.
    const lrcPath = await makeTagFixture('lrc.flac', ['-c:a', 'flac'])
    const lrc = '[00:00.00]first line\n[00:12.50]second line'
    await tagWriter.write(lrcPath, { lyrics: lrc })
    checkEqual('tags: LRC text is stored verbatim', await lyricsOf(lrcPath), lrc)
    const lrcParsed = await parseTags(lrcPath)
    checkEqual(
      'tags: LRC becomes timed lines when read back',
      lrcParsed.common.lyrics?.[0]?.syncText.length ?? 0,
      2
    )

    let unsupported: unknown = null
    await tagWriter.write(join(tagRoot, 'sample.wav'), { title: 'x' }).catch((error) => {
      unsupported = error
    })
    checkEqual(
      'tags: a container with no writer is refused',
      unsupported instanceof TagWriteError ? unsupported.code : 'no-error',
      'unsupported'
    )

    let missing: unknown = null
    await tagWriter.write(join(tagRoot, 'nope.mp3'), { title: 'x' }).catch((error) => {
      missing = error
    })
    checkEqual(
      'tags: a missing file is refused',
      missing instanceof TagWriteError ? missing.code : 'no-error',
      'missing'
    )

    // A read-only file is the closest thing to "another program has it open"
    // that a test can set up on Windows. The write must fail *and* leave the
    // original byte-for-byte intact.
    const lockedPath = await makeTagFixture('locked.mp3', ['-c:a', 'libmp3lame'])
    const lockedBefore = await readFile(lockedPath)
    await chmod(lockedPath, 0o444)
    let locked: unknown = null
    await tagWriter.write(lockedPath, { title: 'Should not stick' }).catch((error) => {
      locked = error
    })
    await chmod(lockedPath, 0o666)
    checkEqual(
      'tags: a read-only file is reported as locked',
      locked instanceof TagWriteError ? locked.code : 'no-error',
      'locked'
    )
    checkEqual(
      'tags: a refused write leaves the original untouched',
      (await readFile(lockedPath)).equals(lockedBefore),
      true
    )
    check(
      'tags: a refused write leaves no temp file behind',
      readdirSync(tagRoot).every((name) => !isTagTempFile(name))
    )

    // A crash between the temp write and the rename can only leave the temp
    // file, so the scanner has to know both to skip it and to sweep it later.
    const sweepDir = join(tagRoot, 'sweep')
    await mkdir(sweepDir, { recursive: true })
    const staleName = `${TAG_TEMP_PREFIX}stale.mp3`
    const freshName = `${TAG_TEMP_PREFIX}fresh.mp3`
    await writeFile(join(sweepDir, staleName), 'x')
    await writeFile(join(sweepDir, freshName), 'x')
    const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(join(sweepDir, staleName), longAgo, longAgo)
    await sweepTagTempFile(sweepDir, staleName)
    await sweepTagTempFile(sweepDir, freshName)
    check('tags: an abandoned temp file is swept', !existsSync(join(sweepDir, staleName)))
    check('tags: a fresh temp file is left for its writer', existsSync(join(sweepDir, freshName)))
    check('tags: temp files are recognisable by name', isTagTempFile(freshName) && !isTagTempFile('track.mp3'))

    // --- cover art writing -------------------------------------------------
    // Embedding a picture is the second write path in this milestone, and the
    // containers disagree about how to hold one. MP3 needs a real APIC frame;
    // FLAC and M4A take an attached-picture stream through ffmpeg. Ogg/Opus
    // cannot carry one at all with this ffmpeg build, so that must be refused
    // before the text edit beside it silently lands.
    const tagCoverPath = join(tagRoot, 'cover.png')
    await execFileAsync(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=#ff5533:s=96x96', '-frames:v', '1', tagCoverPath],
      { timeout: 60_000 }
    )
    const coverBytes = await readFile(tagCoverPath)
    const cover = { data: new Uint8Array(coverBytes), mime: 'image/png' }

    for (const name of ['mp3', 'flac', 'm4a'] as const) {
      const target = join(tagRoot, `track.${name}`)
      const before = (await stat(target)).size
      const result = await tagWriter.write(target, { artwork: cover })
      check(`tags: ${name} accepts a cover on its own`, result.artworkWritten)
      check(`tags: ${name} grew by more than the cover's overhead`, (await stat(target)).size > before)
      const written = await extractArtwork(target)
      check(`tags: ${name} reads the cover back`, Boolean(written && written.data.length > 0))
      checkEqual(`tags: ${name} kept the cover's type`, written?.mime, 'image/png')

      await tagWriter.write(target, { artwork: null })
      checkEqual(`tags: ${name} can remove the cover`, await extractArtwork(target), null)
      // The text tags written earlier must not have been collateral damage.
      const kept = await extractMetadata(target)
      checkEqual(`tags: ${name} keeps its title when the cover changes`, kept.title, edited.title)
    }

    for (const name of ['ogg', 'opus'] as const) {
      const target = join(tagRoot, `track.${name}`)
      let refusal: unknown = null
      await tagWriter.write(target, { artwork: cover }).catch((error) => {
        refusal = error
      })
      checkEqual(
        `tags: ${name} refuses a cover rather than half-writing it`,
        refusal instanceof TagWriteError ? refusal.code : 'no-error',
        'unsupported'
      )
    }

    // --- the edit as a whole ---------------------------------------------
    // The writer is only half of it: the row has to be rebuilt from the file
    // afterwards, and a position or origin the editor did not touch must
    // survive the rewrite. This is the path the dialog actually calls.
    const editedPath = await makeTagFixture('service.mp3', ['-c:a', 'libmp3lame'], [
      ['track', '3/12'],
      ['disc', '1/2']
    ])
    // A database of its own: the main one belongs to the scan block above and
    // is closed by the time this runs.
    const servicePaths = resolveAppPaths(join(tagRoot, 'userData'))
    ensureAppDirectories(servicePaths)
    const serviceDb = openLibraryDatabase(servicePaths.database, silentLogger)
      try {
      const serviceRepo = new TrackRepository(serviceDb.db)
      const serviceSettings = new SettingsService(servicePaths.config, silentLogger)
      const editedId = serviceRepo.insert(
        {
          contentKey: 'smoke-tag-service',
          sourceKind: 'local',
          sourceId: null,
          originKind: 'youtube',
          originId: 'dQw4w9WgXcQ',
          title: 'Old Title',
          artist: 'Old Artist',
          albumArtist: null,
          album: 'Old Album',
          trackNo: 3,
          discNo: 1,
          trackTotal: 12,
          discTotal: 2,
          year: 2001,
          genre: null,
          durationMs: 1200,
          codec: 'mp3',
          bitrateKbps: null,
          sampleRate: null,
          channels: null,
          fileSize: null,
          fileMtimeMs: null,
          filePath: editedPath
        },
        Date.now()
      )
      const tagLibrary = new LibraryService(serviceRepo, serviceSettings, silentLogger, {}, tagWriter)
      const editedRow = await tagLibrary.updateTags(editedId, { title: 'Edited Title', genre: 'Filmi' })
      checkEqual(
        'tags: the row is rebuilt from the rewritten file',
        [editedRow.title, editedRow.genre].join(' | '),
        'Edited Title | Filmi'
      )
      checkEqual(
        'tags: an untouched track total survives the edit',
        [editedRow.trackNo, editedRow.trackTotal, editedRow.discNo, editedRow.discTotal].join('/'),
        '3/12/1/2'
      )
      checkEqual(
        'tags: the video origin survives the edit',
        [editedRow.originKind, editedRow.originId].join(':'),
        'youtube:dQw4w9WgXcQ'
      )

      // Changing one half of `3/12` sends the other half from the row, because
      // the container holds them in one frame. A missing fill would silently
      // rewrite the number as `0/5` or drop the track number entirely.
      const totalOnly = await tagLibrary.updateTags(editedId, { trackTotal: 5 })
      checkEqual(
        'tags: editing only the total keeps the track number',
        [totalOnly.trackNo, totalOnly.trackTotal].join('/'),
        '3/5'
      )
      const clearedDisc = await tagLibrary.updateTags(editedId, { discNo: null })
      checkEqual(
        'tags: clearing the disc number clears both halves',
        [clearedDisc.discNo, clearedDisc.discTotal].join('/'),
        '/'
      )
      checkEqual(
        'tags: the row and the file agree after the edit',
        (await extractMetadata(editedPath)).title,
        'Edited Title'
      )

      // A cover-only save is still a save: the writer embeds the bytes, and the
      // row remembers the cache key so the UI serves the chosen picture rather
      // than re-extracting the file.
      const chosenKey = 'b'.repeat(40) + '.png'
      const withCover = await tagLibrary.updateTags(editedId, {}, { image: cover, key: chosenKey })
      checkEqual('tags: an artwork-only save is accepted', withCover.artworkKey, chosenKey)
      checkEqual(
        'tags: the chosen cache key is remembered on the row',
        serviceRepo.artworkState(editedId)?.artworkKey,
        chosenKey
      )
      check('tags: the cover is in the file after an artwork-only save', Boolean(await extractArtwork(editedPath)))
      const withoutCover = await tagLibrary.updateTags(editedId, {}, { image: null, key: '' })
      checkEqual('tags: removing the cover records "no cover" on the row', withoutCover.artworkKey, null)
      checkEqual('tags: removing the cover removes it from the file', await extractArtwork(editedPath), null)

      let remoteEdit: unknown = null
      const remoteId = serviceRepo.insert(
        {
          contentKey: 'smoke-tag-remote',
          sourceKind: 'youtube',
          sourceId: 'dQw4w9WgXcQ',
          originKind: null,
          originId: null,
          title: 'Remote Only',
          artist: null,
          albumArtist: null,
          album: null,
          trackNo: null,
          discNo: null,
          trackTotal: null,
          discTotal: null,
          year: null,
          genre: null,
          durationMs: 1000,
          codec: null,
          bitrateKbps: null,
          sampleRate: null,
          channels: null,
          fileSize: null,
          fileMtimeMs: null,
          filePath: null
        },
        Date.now()
      )
      await tagLibrary.updateTags(remoteId, { title: 'Nope' }).catch((error) => {
        remoteEdit = error
      })
      check(
        'tags: a stream-only track cannot be edited',
        remoteEdit instanceof Error && remoteEdit.message.includes('Only files')
      )
    } finally {
      serviceDb.close()
    }

    // The bridge sanitises before anything reaches the writer, because these
    // values are written into the file and read back as the truth later.
    checkEqual(
      'tags: blank text clears instead of writing an empty frame',
      JSON.stringify(sanitizeTagFields({ title: '   ', album: 'A\r\nB' })),
      JSON.stringify({ title: null, album: 'A\nB' })
    )
    checkEqual(
      'tags: the sanitiser keeps only the keys it was given',
      JSON.stringify(Object.keys(sanitizeTagFields({ title: 'T' }))),
      JSON.stringify(['title'])
    )
    const rejects = (input: unknown): boolean => {
      try {
        sanitizeTagFields(input)
        return false
      } catch {
        return true
      }
    }
    check('tags: an over-long lyric is refused', rejects({ lyrics: 'x'.repeat(100_001) }))
    check('tags: a year outside 1000-3000 is refused', rejects({ year: 99 }))
    check('tags: a fractional track number is refused', rejects({ trackNo: 1.5 }))
    check('tags: a non-string title is refused', rejects({ title: 7 }))
    check('tags: an empty edit is refused', rejects({}))
    checkEqual(
      'tags: a cleared year is allowed',
      JSON.stringify(sanitizeTagFields({ year: null })),
      JSON.stringify({ year: null })
    )

    // Artwork keys become file names, so the shape is enforced rather than
    // trusted: anything that is not a content hash plus a known extension is
    // refused before it can reach the cache directory.
    const validKey = 'a'.repeat(40) + '.jpg'
    checkEqual('artwork: a well-formed key passes', sanitizeArtworkKey(validKey), validKey)
    checkEqual('artwork: an empty key means "no cover"', sanitizeArtworkKey('   '), null)
    checkEqual('artwork: an absent key stays absent', sanitizeArtworkKey(undefined), null)
    const rejectsKey = (input: unknown): boolean => {
      try {
        sanitizeArtworkKey(input)
        return false
      } catch {
        return true
      }
    }
    check('artwork: a path traversal is refused', rejectsKey('../../secret.jpg'))
    check('artwork: a wrong extension is refused', rejectsKey('a'.repeat(40) + '.exe'))
    check('artwork: a short hash is refused', rejectsKey('abc.jpg'))
    check('artwork: a non-string key is refused', rejectsKey(7))
    checkEqual(
      'artwork: an artwork-only edit is allowed when asked for',
      JSON.stringify(sanitizeTagFields({}, { allowEmpty: true })),
      JSON.stringify({})
    )
    checkEqual('artwork: PNG extension reads back as image/png', mimeForExtension('.png'), 'image/png')
    checkEqual('artwork: JPEG extension reads back as image/jpeg', mimeForExtension('.jpg'), 'image/jpeg')
    checkEqual('artwork: an unknown extension falls back to JPEG', mimeForExtension('.xyz'), 'image/jpeg')
  } finally {
    await rm(tagRoot, { recursive: true, force: true }).catch(() => undefined)
  }

  // --- auto-tag ------------------------------------------------------------
  // "Which of these two matches is better" is the whole feature, so the scoring
  // is pinned down here rather than left to whatever a provider answered today.
  // The parsers and the client come after: they decide what a match is and what
  // happens when one of the two services is down.
  {
    checkEqual(
      'auto-tag: bracketed noise, case and accents fold away',
      normalizeMatchText('Beyoncé - Halo (Official Video) [HD]'),
      'beyonce halo'
    )
    checkEqual('auto-tag: an ampersand reads as and', normalizeMatchText('Simon & Garfunkel'), 'simon and garfunkel')

    checkEqual('auto-tag: an identical name is a perfect match', textSimilarity('Kesariya', 'Kesariya'), 1)
    check(
      'auto-tag: a typo still scores high',
      textSimilarity('Kesariya', 'Kesariyaa') > 0.85,
      String(textSimilarity('Kesariya', 'Kesariyaa'))
    )
    check(
      'auto-tag: two unrelated names score low',
      textSimilarity('Kesariya', 'Bohemian Rhapsody') < 0.3,
      String(textSimilarity('Kesariya', 'Bohemian Rhapsody'))
    )
    checkEqual('auto-tag: an empty name matches nothing', textSimilarity('', 'Kesariya'), 0)

    const messy: TagLookupQuery = {
      title: 'Arijit Singh - Kesariya (Official Video)',
      artist: 'Arijit Singh',
      album: null,
      durationMs: null
    }
    check(
      'auto-tag: the artist prefix and the dash tail are both tried',
      titleVariants(messy).some((variant) => normalizeMatchText(variant) === 'kesariya'),
      JSON.stringify(titleVariants(messy))
    )

    checkEqual('auto-tag: two seconds of drift is the same recording', durationScore(268_000, 270_000), 1)
    checkEqual('auto-tag: five seconds of drift is close', durationScore(268_000, 273_000), 0.8)
    checkEqual('auto-tag: ten seconds of drift is a maybe', durationScore(268_000, 278_000), 0.5)
    checkEqual('auto-tag: half a minute is a different recording', durationScore(268_000, 298_000), 0)
    checkEqual('auto-tag: a missing length is not scored at all', durationScore(268_000, null), null)

    const base: TagCandidate = {
      provider: 'itunes',
      providerId: '1',
      title: 'Kesariya',
      artist: 'Arijit Singh',
      albumArtist: 'Arijit Singh',
      album: 'Brahmastra',
      year: 2022,
      genre: null,
      trackNo: 3,
      trackTotal: 12,
      discNo: 1,
      discTotal: 1,
      durationMs: 268_000,
      artworkUrl: null,
      score: 0,
      confidence: 'weak'
    }
    const exactQuery: TagLookupQuery = {
      title: 'Kesariya',
      artist: 'Arijit Singh',
      album: null,
      durationMs: 268_000
    }
    checkEqual('auto-tag: an exact match scores 1', scoreCandidate(exactQuery, base), 1)
    check(
      'auto-tag: a wrong artist lowers the score',
      scoreCandidate({ ...exactQuery, artist: 'Someone Else' }, base) < 0.8,
      String(scoreCandidate({ ...exactQuery, artist: 'Someone Else' }, base))
    )
    // A row with no artist must not be punished for the missing signal: the
    // available ones are renormalised rather than the absent one scored zero.
    checkEqual(
      'auto-tag: a missing artist is dropped, not scored zero',
      scoreCandidate({ ...exactQuery, artist: null }, base),
      1
    )

    const ranked = rankCandidates(
      exactQuery,
      [
        base,
        { ...base, provider: 'musicbrainz', providerId: 'mb-1' },
        { ...base, providerId: '2', title: 'Something Else Entirely', artist: 'Nobody', albumArtist: null, album: null },
        { ...base, providerId: '3', title: 'Kesariya (Reprise)' },
        { ...base, providerId: '4', title: 'Kesariya Reprise', album: 'Brahmastra Deluxe' }
      ],
      2
    )
    checkEqual('auto-tag: ranking keeps the best few', ranked.length, 2)
    checkEqual('auto-tag: the same answer from both providers appears once', ranked[0]?.provider, 'itunes')
    check(
      'auto-tag: a weak match is filtered out',
      ranked.every((candidate) => candidate.title !== 'Something Else Entirely')
    )
    check(
      'auto-tag: every kept match carries its confidence',
      ranked.every((candidate) => ['strong', 'likely', 'weak'].includes(candidate.confidence))
    )

    // --- AcoustID fingerprint fallback ------------------------------------
    checkEqual('fingerprint: a valid key is kept', normalizeAcoustidKey(' cSpUJKpD '), 'cSpUJKpD')
    check('fingerprint: a key with punctuation is refused', normalizeAcoustidKey('not a key!') === null)
    check('fingerprint: a blank key means not configured', normalizeAcoustidKey('  ') === null)
    const acoustidUrl = new URL(acoustidLookupUrl('cSpUJKpD', 212.6, 'AQADt'))
    checkEqual('fingerprint: the lookup carries the key', acoustidUrl.searchParams.get('client'), 'cSpUJKpD')
    checkEqual('fingerprint: the duration is rounded', acoustidUrl.searchParams.get('duration'), '213')
    checkEqual(
      'fingerprint: the lookup asks for recordings and releases',
      acoustidUrl.searchParams.get('meta'),
      'recordings+releases'
    )

    const acoustidPayload = {
      status: 'ok',
      results: [
        {
          score: 0.8,
          recordings: [
            { id: 'rec-1', title: 'Kesariya', artists: [{ name: 'Arijit Singh' }] }
          ]
        },
        {
          score: 0.95,
          recordings: [
            { id: 'rec-1', title: 'Kesariya', artists: [{ name: 'Arijit Singh' }] },
            { id: 'rec-2', title: 'Kesariya (Reprise)', artists: [{ name: 'Arijit Singh' }] }
          ]
        }
      ]
    }
    const acoustidMatches = parseAcoustidLookup(acoustidPayload)
    checkEqual('fingerprint: a recording appears once, at its best score', acoustidMatches.length, 2)
    checkEqual('fingerprint: the best score wins', acoustidMatches[0]?.recordingId, 'rec-1')
    checkEqual('fingerprint: the score is preserved', acoustidMatches[0]?.score, 0.95)
    checkEqual('fingerprint: artist names are read', acoustidMatches[0]?.artists.join(', '), 'Arijit Singh')

    let refusedKey: unknown = null
    try {
      parseAcoustidLookup({ status: 'error', error: { code: 4, message: 'invalid API key' } })
    } catch (error) {
      refusedKey = error
    }
    check(
      'fingerprint: an error payload is an AcoustID failure',
      refusedKey instanceof AcoustidError && refusedKey.code === 4
    )
    check(
      'fingerprint: a refused key points at Settings',
      refusedKey instanceof AcoustidError &&
        describeAcoustidFailure(refusedKey).includes('Settings \u2192 Misc'),
      refusedKey instanceof AcoustidError ? describeAcoustidFailure(refusedKey) : String(refusedKey)
    )

    const recordingPayload = {
      id: 'rec-1',
      title: 'Kesariya',
      length: 268_000,
      'artist-credit': [{ name: 'Arijit Singh', joinphrase: '' }],
      genres: [{ name: 'Bollywood' }],
      releases: [
        {
          id: 'rel-comp',
          title: 'Compilation',
          date: '2023',
          media: [
            {
              position: 1,
              'track-count': 10,
              track: [{ number: '2', recording: { id: 'other-recording' } }]
            }
          ]
        },
        {
          id: 'rel-real',
          title: 'Brahmastra',
          date: '2022-09-09',
          media: [
            {
              position: 1,
              'track-count': 12,
              track: [{ number: '3', recording: { id: 'rec-1' } }]
            }
          ]
        }
      ]
    }
    const fingerprintCandidate = candidateFromAcoustidRecording(recordingPayload, 0.91)
    checkEqual('fingerprint: the provider is acoustid', fingerprintCandidate?.provider, 'acoustid')
    checkEqual('fingerprint: the release that lists the recording wins', fingerprintCandidate?.album, 'Brahmastra')
    checkEqual('fingerprint: the track number comes from that release', fingerprintCandidate?.trackNo, 3)
    checkEqual('fingerprint: the track total comes from the medium', fingerprintCandidate?.trackTotal, 12)
    checkEqual('fingerprint: the release year is read', fingerprintCandidate?.year, 2022)
    checkEqual(
      'fingerprint: the cover is the release front image',
      fingerprintCandidate?.artworkUrl,
      'https://coverartarchive.org/release/rel-real/front-500'
    )
    checkEqual('fingerprint: the AcoustID score is kept', fingerprintCandidate?.score, 0.91)

    // The whole point of a fingerprint is that the text tags were useless, so
    // ranking must not rescore the answer against those tags.
    const fingerprintRanked = rankCandidates(
      { title: 'track01', artist: 'Unknown', album: null, durationMs: null },
      fingerprintCandidate ? [fingerprintCandidate] : []
    )
    checkEqual('fingerprint: a match survives unusable tags', fingerprintRanked.length, 1)
    checkEqual('fingerprint: ranking keeps the audio score', fingerprintRanked[0]?.score, 0.91)

    checkEqual(
      'fpcalc: the arguments ask for JSON and the standard window',
      fpcalcArgs('C:\\music\\a.flac').join(' '),
      '-json -length 120 C:\\music\\a.flac'
    )
    const print = parseFpcalcOutput('{"duration": 212.6, "fingerprint": "AQADt"}')
    checkEqual('fpcalc: the whole-file duration is read', print.durationSeconds, 212.6)
    checkEqual('fpcalc: the fingerprint is read', print.fingerprint, 'AQADt')
    let badPrint: unknown = null
    try {
      parseFpcalcOutput('{"duration": 0, "fingerprint": ""}')
    } catch (error) {
      badPrint = error
    }
    check('fpcalc: an empty answer is a sentence, not a lookup', badPrint instanceof Error)
    let brokenPrint: unknown = null
    try {
      parseFpcalcOutput('not json')
    } catch (error) {
      brokenPrint = error
    }
    check('fpcalc: unreadable output is refused', brokenPrint instanceof Error)


    // --- provider payloads -------------------------------------------------
    const itunesPayload = {
      resultCount: 1,
      results: [
        {
          trackId: 1440833098,
          trackName: 'Kesariya',
          artistName: 'Arijit Singh',
          collectionArtistName: 'Various Artists',
          collectionName: 'Brahmastra',
          releaseDate: '2022-09-09T07:00:00Z',
          primaryGenreName: 'Bollywood',
          trackNumber: 3,
          trackCount: 12,
          discNumber: 1,
          discCount: 2,
          trackTimeMillis: 268_000,
          artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/abc/100x100bb.jpg'
        },
        { trackName: 'No artist, so not a candidate' }
      ]
    }
    const fromItunes = candidatesFromItunes(itunesPayload)
    checkEqual('auto-tag: iTunes yields the usable rows only', fromItunes.length, 1)
    const itunesHit = fromItunes[0]
    checkEqual('auto-tag: iTunes title and artist are read', `${itunesHit?.title}|${itunesHit?.artist}`, 'Kesariya|Arijit Singh')
    checkEqual('auto-tag: iTunes keeps the collection artist', itunesHit?.albumArtist, 'Various Artists')
    checkEqual('auto-tag: iTunes release date becomes a year', itunesHit?.year, 2022)
    checkEqual(
      'auto-tag: iTunes positions are read whole',
      `${itunesHit?.trackNo}/${itunesHit?.trackTotal} ${itunesHit?.discNo}/${itunesHit?.discTotal}`,
      '3/12 1/2'
    )
    checkEqual('auto-tag: iTunes length is read', itunesHit?.durationMs, 268_000)
    check(
      'auto-tag: the 100px iTunes cover is asked for at 600px',
      itunesHit?.artworkUrl === 'https://is1-ssl.mzstatic.com/image/thumb/abc/600x600bb.jpg',
      itunesHit?.artworkUrl ?? 'null'
    )

    const mbPayload = {
      recordings: [
        {
          id: 'rec-1',
          title: 'Kesariya',
          length: 268_000,
          'artist-credit': [
            { name: 'Arijit Singh', joinphrase: ' & ' },
            { name: 'Pritam' }
          ],
          releases: [
            {
              id: 'rel-1',
              title: 'Brahmastra',
              date: '2022-09-09',
              'track-count': 12,
              media: [
                {
                  position: 1,
                  'track-count': 12,
                  track: [{ number: '3', title: 'Kesariya' }]
                }
              ]
            }
          ]
        }
      ]
    }
    const fromMb = candidatesFromMusicBrainz(mbPayload)
    checkEqual('auto-tag: MusicBrainz yields one recording', fromMb.length, 1)
    const mbHit = fromMb[0]
    checkEqual('auto-tag: a MusicBrainz credit is joined', mbHit?.artist, 'Arijit Singh & Pritam')
    checkEqual('auto-tag: MusicBrainz release facts are read', `${mbHit?.album}|${mbHit?.year}`, 'Brahmastra|2022')
    checkEqual(
      'auto-tag: MusicBrainz track numbers are read',
      `${mbHit?.trackNo}/${mbHit?.trackTotal} ${mbHit?.discNo}/${mbHit?.discTotal}`,
      '3/12 1/1'
    )
    checkEqual(
      'auto-tag: MusicBrainz points at the Cover Art Archive',
      mbHit?.artworkUrl,
      'https://coverartarchive.org/release/rel-1/front-500'
    )

    // --- request building --------------------------------------------------
    const searchUrl = new URL(itunesUrl({ title: 'Kesariya (Official Video)', artist: 'Arijit Singh', album: null, durationMs: null }))
    checkEqual('auto-tag: the iTunes search drops bracketed noise', searchUrl.searchParams.get('term'), 'Kesariya Arijit Singh')
    checkEqual('auto-tag: the iTunes search asks for songs only', searchUrl.searchParams.get('entity'), 'song')
    checkEqual(
      'auto-tag: MusicBrainz gets a quoted Lucene query',
      musicBrainzQuery({ title: 'Say "Hi" [Live]', artist: 'A:B', album: null, durationMs: null }),
      'recording:"Say \\"Hi\\"" AND artist:"A:B"'
    )

    // --- the client, with the network replaced -----------------------------
    // One provider down must still leave the other's matches: a review dialog
    // with half an answer is useful, an error page is not.
    const calls: string[] = []
    const userAgents: string[] = []
    const itunesOnlyFetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
      const url = String(input)
      calls.push(url)
      if (url.startsWith('https://musicbrainz.org')) {
        return new Response('busy', { status: 503, headers: { 'Retry-After': '0' } })
      }
      if (init?.headers?.['User-Agent']) userAgents.push(init.headers['User-Agent'])
      return new Response(JSON.stringify(itunesPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch

    const partial = await createTagLookup({ log: silentLogger, fetch: itunesOnlyFetch, schedule: (work) => work() }).lookup(exactQuery)
    check(
      'auto-tag: one provider being down still returns the other',
      partial.candidates.length === 1 && partial.candidates[0]?.provider === 'itunes',
      JSON.stringify(partial.candidates.map((candidate) => candidate.provider))
    )
    checkEqual(
      'auto-tag: a failed provider is reported, not thrown',
      partial.providers.find((provider) => provider.provider === 'musicbrainz')?.ok,
      false
    )
    checkEqual(
      'auto-tag: the failure reads as a sentence',
      partial.providers.find((provider) => provider.provider === 'musicbrainz')?.message,
      'MusicBrainz could not be reached.'
    )

    // A 429 is "later", not "no": the batch has to wait the header's short wait
    // and ask again, or a large selection develops holes wherever the service
    // asked for a breather.
    const rateCalls: string[] = []
    const itunesRateLimitedOnce = (async (input: unknown) => {
      const url = String(input)
      rateCalls.push(url)
      const itunesCalls = rateCalls.filter((call) => call.startsWith('https://itunes')).length
      if (url.startsWith('https://musicbrainz.org')) {
        return new Response(JSON.stringify({ recordings: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      if (itunesCalls === 1) {
        return new Response(null, { status: 429, headers: { 'Retry-After': '0' } })
      }
      return new Response(JSON.stringify(itunesPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch
    const recovered = await createTagLookup({
      log: silentLogger,
      fetch: itunesRateLimitedOnce,
      schedule: (work) => work()
    }).lookup(exactQuery)
    checkEqual(
      'auto-tag: a 429 is retried, and the match still arrives',
      recovered.candidates.map((candidate) => candidate.provider).join(','),
      'itunes'
    )
    checkEqual(
      'auto-tag: the retry is one extra request',
      rateCalls.filter((call) => call.startsWith('https://itunes')).length,
      2
    )
    checkEqual(
      'auto-tag: a recovered provider is reported as answering',
      recovered.providers.find((provider) => provider.provider === 'itunes')?.ok,
      true
    )

    const refusedCalls: string[] = []
    const persistentRateLimit = (async (input: unknown) => {
      refusedCalls.push(String(input))
      return new Response(null, { status: 429, headers: { 'Retry-After': '0' } })
    }) as unknown as typeof fetch
    const refused = await createTagLookup({
      log: silentLogger,
      fetch: persistentRateLimit,
      schedule: (work) => work()
    }).lookup(exactQuery)
    checkEqual(
      'auto-tag: a second 429 ends the retries',
      refusedCalls.filter((call) => call.startsWith('https://itunes')).length,
      2
    )
    checkEqual(
      'auto-tag: a persistent rate limit is its own sentence',
      refused.providers.find((provider) => provider.provider === 'itunes')?.message,
      'iTunes is rate-limiting requests. Try again in a moment.'
    )

    const bothFetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
      const url = String(input)
      if (url.startsWith('https://musicbrainz.org')) {
        userAgents.push(init?.headers?.['User-Agent'] ?? '')
        // The same song as iTunes answered, so the two providers have to
        // collapse into one row rather than show the same match twice.
        const twin = {
          recordings: [
            {
              id: 'rec-1',
              title: 'Kesariya',
              length: 268_000,
              'artist-credit': [{ name: 'Arijit Singh' }],
              releases: [
                {
                  id: 'rel-1',
                  title: 'Brahmastra',
                  date: '2022-09-09',
                  'track-count': 12,
                  media: [
                    {
                      position: 1,
                      'track-count': 12,
                      track: [{ number: '3' }]
                    }
                  ]
                }
              ]
            }
          ]
        }
        return new Response(JSON.stringify(twin), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      return new Response(JSON.stringify(itunesPayload), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }) as unknown as typeof fetch

    const both = await createTagLookup({ log: silentLogger, fetch: bothFetch, schedule: (work) => work() }).lookup(exactQuery)
    checkEqual('auto-tag: both providers answering still dedupes', both.candidates.length, 1)
    checkEqual(
      'auto-tag: every provider is reported',
      both.providers.map((provider) => `${provider.provider}:${provider.ok}`).join(','),
      'itunes:true,musicbrainz:true'
    )
    check(
      'auto-tag: MusicBrainz is told who is calling',
      userAgents.some((agent) => agent.startsWith('Suura/')),
      userAgents.join(' | ')
    )

    // A row with no title cannot be looked up: there is nothing to search with,
    // and asking anyway would spend two requests to get noise back.
    calls.length = 0
    const blank = await createTagLookup({ log: silentLogger, fetch: itunesOnlyFetch, schedule: (work) => work() }).lookup({
      title: '   ',
      artist: 'Arijit Singh',
      album: null,
      durationMs: null
    })
    checkEqual('auto-tag: a blank title makes no request', calls.length, 0)
    checkEqual('auto-tag: a blank title comes back empty', blank.candidates.length, 0)

    // --- fingerprint lookup wiring -----------------------------------------
    const fingerprintCalls: string[] = []
    const fingerprintFetch = (async (input: unknown) => {
      const url = String(input)
      fingerprintCalls.push(url)
      if (url.startsWith('https://api.acoustid.org')) {
        return new Response(
          JSON.stringify({
            status: 'ok',
            results: [
              {
                score: 0.93,
                recordings: [
                  { id: 'rec-1', title: 'Kesariya', artists: [{ name: 'Arijit Singh' }] }
                ]
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }
      if (url.startsWith('https://musicbrainz.org/ws/2/recording/rec-1')) {
        return new Response(JSON.stringify(recordingPayload), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      return new Response(null, { status: 404 })
    }) as unknown as typeof fetch

    const fingerprintLookup = await createTagLookup({
      log: silentLogger,
      fetch: fingerprintFetch,
      schedule: (work) => work(),
      getAcoustidKey: () => 'cSpUJKpD',
      fingerprint: async () => ({ durationSeconds: 268, fingerprint: 'AQADt' })
    }).lookupFingerprint(exactQuery, 'C:\\music\\a.flac')
    checkEqual('fingerprint: the lookup returns the recording', fingerprintLookup.candidates.length, 1)
    checkEqual(
      'fingerprint: the candidate is labelled AcoustID',
      fingerprintLookup.candidates[0]?.provider,
      'acoustid'
    )
    checkEqual(
      'fingerprint: the AcoustID score survives the lookup',
      fingerprintLookup.candidates[0]?.score,
      0.93
    )
    check(
      'fingerprint: the request used the key and the fingerprint',
      fingerprintCalls.some((url) => url.includes('client=cSpUJKpD') && url.includes('fingerprint=AQADt')),
      fingerprintCalls.join(' | ')
    )

    // AcoustID answers a refused key with HTTP 400 and an error body. The dialog
    // must point at Settings instead of calling the service unreachable.
    const refusedLookup = await createTagLookup({
      log: silentLogger,
      fetch: (async () =>
        new Response(
          JSON.stringify({ status: 'error', error: { code: 4, message: 'invalid API key' } }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )) as unknown as typeof fetch,
      schedule: (work) => work(),
      getAcoustidKey: () => 'cSpUJKpD',
      fingerprint: async () => ({ durationSeconds: 268, fingerprint: 'AQADt' })
    }).lookupFingerprint(exactQuery, 'C:\\music\\a.flac')
    checkEqual(
      'fingerprint: a 400 key refusal is a failed provider',
      refusedLookup.providers[0]?.ok,
      false
    )
    check(
      'fingerprint: a 400 key refusal points at Settings',
      (refusedLookup.providers[0]?.message ?? '').includes('Settings \u2192 Misc'),
      refusedLookup.providers[0]?.message ?? ''
    )

    let noKeyCalls = 0
    const noKeyLookup = await createTagLookup({
      log: silentLogger,
      fetch: (async () => {
        noKeyCalls += 1
        return new Response(null, { status: 500 })
      }) as unknown as typeof fetch,
      getAcoustidKey: () => null,
      fingerprint: async () => ({ durationSeconds: 268, fingerprint: 'AQADt' })
    }).lookupFingerprint(exactQuery, 'C:\\music\\a.flac')
    checkEqual('fingerprint: no key makes no request', noKeyCalls, 0)
    checkEqual('fingerprint: no key is a sentence', noKeyLookup.providers[0]?.ok, false)
    check(
      'fingerprint: the sentence points at the Misc tab',
      (noKeyLookup.providers[0]?.message ?? '').includes('Misc'),
      noKeyLookup.providers[0]?.message ?? ''
    )
  }

  // --- lyrics --------------------------------------------------------------
  // The parser is pure and decides both what the panel draws and whether the
  // file counts as timed, so its edges are pinned down before the file path is
  // exercised. The service is then run against real containers: a tag has to
  // come back from every format the writer supports, and a `.lrc` beside the
  // file has to win over it.
  {
    const lrc = '[ti:Song]\n[00:12.50]second line\n[00:00.00]first line\n[00:20.00][00:40.00]chorus'
    const parsed = parseLyrics(lrc)
    checkEqual(
      'lyrics: timestamps are read, repeated and sorted',
      parsed.lines.map((line) => `${line.timeMs}:${line.text}`).join('|'),
      '0:first line|12500:second line|20000:chorus|40000:chorus'
    )
    checkEqual('lyrics: a metadata tag is not a line', parseLyrics('[ar:Someone]').lines.length, 0)
    checkEqual('lyrics: plain text has no timed lines', parseLyrics('just words\nand more').lines.length, 0)
    checkEqual('lyrics: two fractional digits are centiseconds', parseLyrics('[00:01.25]a').lines[0]?.timeMs, 1250)
    checkEqual('lyrics: three fractional digits are milliseconds', parseLyrics('[00:01.234]a').lines[0]?.timeMs, 1234)
    checkEqual('lyrics: a file offset tag is read', parseLyrics('[offset:+500]\n[00:01.00]a').fileOffsetMs, 500)
    checkEqual('lyrics: the offset tag is not a line', parseLyrics('[offset:100]').lines.length, 0)

    const timed = parseLyrics('[00:01.00]one\n[00:05.00]two').lines
    checkEqual('lyrics: nothing is current before the first line', activeLyricIndex(timed, 500), -1)
    checkEqual('lyrics: a line is current on its own timestamp', activeLyricIndex(timed, 1000), 0)
    checkEqual('lyrics: the last line stays current', activeLyricIndex(timed, 9000), 1)
    checkEqual('lyrics: a positive offset shows the line later', activeLyricIndex(timed, 1000, 500), -1)

    checkEqual(
      'lyrics: an offset is shown in seconds',
      [formatLyricsOffset(0), formatLyricsOffset(500), formatLyricsOffset(-500)].join(' '),
      `0.0 s +0.5 s \u22120.5 s`
    )
    const rejectsOffset = (value: unknown): boolean => {
      try {
        sanitizeLyricsOffset(value)
        return false
      } catch {
        return true
      }
    }
    check(
      'lyrics: an offset outside the range is refused',
      rejectsOffset(LYRICS_OFFSET_MAX + 1) && rejectsOffset(-LYRICS_OFFSET_MAX - 1)
    )
    check('lyrics: a fractional offset is refused', rejectsOffset(0.5))
    checkEqual(
      'lyrics: the offset limits themselves are allowed',
      [sanitizeLyricsOffset(LYRICS_OFFSET_MAX), sanitizeLyricsOffset(-LYRICS_OFFSET_MAX)].join('|'),
      `${LYRICS_OFFSET_MAX}|-${LYRICS_OFFSET_MAX}`
    )

    const utf16Text = '[00:01.00]গান গান গান'
    checkEqual(
      'lyrics: a UTF-8 BOM is dropped',
      decodeLyricsFile(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi', 'utf8')])),
      'hi'
    )
    checkEqual(
      'lyrics: UTF-16 LE with a BOM is read',
      decodeLyricsFile(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(utf16Text, 'utf16le')])),
      utf16Text
    )
    checkEqual(
      'lyrics: UTF-16 LE without a BOM is detected',
      decodeLyricsFile(Buffer.from(utf16Text, 'utf16le')),
      utf16Text
    )
  }

  // The finder is a network feature, but the rules that decide what to show are
  // pure. They are pinned down here before any file or service is involved: a
  // payload shape, a score, and a bridge check are the whole contract.
  {
    const query = { title: 'Song', artist: 'Artist', album: 'Album', durationMs: 212_000 }
    const exactPayload = {
      id: 42,
      trackName: 'Song',
      artistName: 'Artist',
      albumName: 'Album',
      duration: 212.4,
      instrumental: false,
      plainLyrics: 'plain words',
      syncedLyrics: '[00:01.00]synced words'
    }
    const exactCandidate = candidatesFromLrclib(exactPayload)[0]
    checkEqual(
      'lyrics finder: an exact match is parsed',
      [
        exactCandidate?.providerId,
        exactCandidate?.title,
        exactCandidate?.artist,
        exactCandidate?.album,
        exactCandidate?.durationMs,
        exactCandidate?.synced,
        exactCandidate?.text
      ].join('|'),
      '42|Song|Artist|Album|212400|true|[00:01.00]synced words'
    )

    const searchCandidates = candidatesFromLrclib([
      {
        id: 1,
        trackName: 'Song',
        artistName: 'Artist',
        duration: 212,
        plainLyrics: 'plain words',
        syncedLyrics: null
      },
      {
        id: 2,
        trackName: 'Song',
        artistName: 'Artist',
        duration: 212,
        plainLyrics: null,
        syncedLyrics: '[00:01.00]timed words'
      },
      {
        id: 3,
        trackName: 'Instrumental',
        artistName: 'Artist',
        duration: 212,
        instrumental: true,
        plainLyrics: 'not lyrics'
      },
      { id: 4, trackName: 'No lyrics', artistName: 'Artist', duration: 212 }
    ])
    checkEqual(
      'lyrics finder: search rows are parsed and empty or instrumental rows skipped',
      searchCandidates.length,
      2
    )
    checkEqual('lyrics finder: a plain row is not marked synced', searchCandidates[0]?.synced, false)
    checkEqual('lyrics finder: a timed row is marked synced', searchCandidates[1]?.synced, true)

    const ranked = rankLyricsCandidates(query, searchCandidates)
    checkEqual('lyrics finder: a tie prefers the synced copy', ranked[0]?.providerId, '2')

    const unrelated = candidatesFromLrclib([
      {
        id: 10,
        trackName: 'Completely Different',
        artistName: 'Nobody',
        duration: 212,
        plainLyrics: 'x'
      }
    ])
    checkEqual(
      'lyrics finder: an unrelated title is dropped',
      rankLyricsCandidates(query, unrelated).length,
      0
    )

    const many = Array.from({ length: 8 }, (_, index) => ({
      id: 100 + index,
      trackName: 'Song',
      artistName: 'Artist',
      duration: 212,
      plainLyrics: `words ${index}`
    }))
    checkEqual(
      'lyrics finder: at most five matches are shown',
      rankLyricsCandidates(query, candidatesFromLrclib(many)).length,
      LYRICS_CANDIDATE_LIMIT
    )

    const bridged = sanitizeLyricsCandidate(ranked[0])
    checkEqual(
      'lyrics finder: a candidate survives the bridge',
      [bridged.provider, bridged.providerId, bridged.synced].join('|'),
      'lrclib|2|true'
    )
    checkEqual(
      'lyrics finder: CRLF is normalized before storing',
      sanitizeLyricsCandidate({ ...ranked[0], text: '[00:01.00]a\r\n[00:02.00]b' }).text,
      '[00:01.00]a\n[00:02.00]b'
    )
    const rejectsCandidate = (value: unknown): boolean => {
      try {
        sanitizeLyricsCandidate(value)
        return false
      } catch {
        return true
      }
    }
    check(
      'lyrics finder: an unknown provider is refused',
      rejectsCandidate({ ...ranked[0], provider: 'somewhere' })
    )
    check(
      'lyrics finder: empty lyrics are refused',
      rejectsCandidate({ ...ranked[0], text: '   ' })
    )
    check(
      'lyrics finder: over-long lyrics are refused',
      rejectsCandidate({ ...ranked[0], text: 'x'.repeat(100_001) })
    )
    check(
      'lyrics finder: a negative length is refused',
      rejectsCandidate({ ...ranked[0], durationMs: -1 })
    )

    const getUrl = new URL(lrclibGetUrl(query))
    checkEqual(
      'lyrics finder: the exact URL carries the length in seconds',
      getUrl.searchParams.get('duration'),
      '212'
    )
    checkEqual(
      'lyrics finder: the exact URL strips bracketed noise',
      new URL(lrclibGetUrl({ ...query, title: 'Song (Official Video)' })).searchParams.get(
        'track_name'
      ),
      'Song'
    )
    checkEqual(
      'lyrics finder: the search URL keeps the artist',
      new URL(lrclibSearchUrl(query)).searchParams.get('artist_name'),
      'Artist'
    )

    const requests: string[] = []
    const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      requests.push(url)
      if (url.includes('/api/get')) return new Response(null, { status: 404 })
      return new Response(
        JSON.stringify([
          {
            id: 7,
            trackName: 'Song',
            artistName: 'Artist',
            duration: 212,
            syncedLyrics: '[00:01.00]found'
          }
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    const lookup = createLyricsLookup({
      log: silentLogger,
      fetch: fakeFetch as typeof fetch,
      timeoutMs: 2_000
    })
    const lookupResult = await lookup.lookup(query)
    checkEqual('lyrics finder: an exact miss falls back to search', requests.length, 2)
    checkEqual('lyrics finder: the fallback match is returned', lookupResult.candidates[0]?.providerId, '7')
    checkEqual('lyrics finder: an empty answer is not a failure', lookupResult.message, null)

    const exactRequests: string[] = []
    const exactFetch = async (input: string | URL | Request): Promise<Response> => {
      exactRequests.push(String(input))
      return new Response(
        JSON.stringify({
          id: 8,
          trackName: 'Song',
          artistName: 'Artist',
          duration: 212,
          syncedLyrics: '[00:01.00]exact'
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }
    const exactLookup = createLyricsLookup({
      log: silentLogger,
      fetch: exactFetch as typeof fetch,
      timeoutMs: 2_000
    })
    const exactResult = await exactLookup.lookup(query)
    checkEqual('lyrics finder: an exact hit makes one request', exactRequests.length, 1)
    checkEqual('lyrics finder: the exact hit is returned', exactResult.candidates[0]?.providerId, '8')

    const failingLookup = createLyricsLookup({
      log: silentLogger,
      fetch: (async () => {
        throw new TypeError('offline')
      }) as typeof fetch,
      timeoutMs: 2_000
    })
    const failedLookup = await failingLookup.lookup(query)
    checkEqual(
      'lyrics finder: an unreachable service is a sentence, not a throw',
      failedLookup.message,
      'LRCLIB could not be reached.'
    )

    // LRCLIB answers 429 when a batch runs long. The retry keeps the track in
    // the batch instead of turning one rate-limit answer into a missing lyric.
    const rateLimitedRequests: string[] = []
    const rateLimitedOnce = (async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      rateLimitedRequests.push(url)
      if (rateLimitedRequests.length === 1) {
        return new Response(null, { status: 429, headers: { 'Retry-After': '0' } })
      }
      return new Response(
        JSON.stringify({
          id: 9,
          trackName: 'Song',
          artistName: 'Artist',
          duration: 212,
          syncedLyrics: '[00:01.00]after the wait'
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as typeof fetch
    const rateLimitedLookup = createLyricsLookup({
      log: silentLogger,
      fetch: rateLimitedOnce,
      timeoutMs: 2_000
    })
    const recoveredLyrics = await rateLimitedLookup.lookup(query)
    checkEqual(
      'lyrics finder: a 429 is retried, and the lyric still arrives',
      recoveredLyrics.candidates[0]?.providerId,
      '9'
    )
    checkEqual('lyrics finder: the retry is one extra request', rateLimitedRequests.length, 2)

    // ---- Genius, the plain-text source ------------------------------------
    // Their pages are HTML, so the parser is pinned down against a trimmed copy
    // of a real one: several lyric containers, a contributor header that is
    // not lyrics, and the entities the words are wrapped in. This is the part
    // that breaks silently when their markup changes.
    checkEqual(
      'genius: br is the line break and containers are joined',
      lyricsFromGeniusHtml(
        '<div data-lyrics-container="true">[Intro]<br/>first line<br/><br/>second line</div>'
      ),
      '[Intro]\nfirst line\n\nsecond line'
    )
    const messyPage = [
      '<div data-lyrics-container="true">',
      '<div data-exclude-from-selection="true"><span>531 Contributors</span><button>Translations</button></div>',
      '[Intro]<br/>Is this the real life? It&#x27;s just fantasy<br/>',
      '<a href="/12/Song/lyrics"><span>caught in a landslide</span></a><br/><br/>',
      'You might also like',
      '</div>',
      '<div data-exclude-from-selection="true">ads that are not lyrics</div>',
      '<div data-lyrics-container="true">no escape from reality</div>'
    ].join('')
    const messy = lyricsFromGeniusHtml(messyPage) ?? ''
    check('genius: the header block is not lyrics', !messy.includes('Contributors'))
    check('genius: an excluded block is not lyrics', !messy.includes('ads that are not lyrics'))
    check('genius: boilerplate is dropped', !messy.includes('You might also like'))
    check('genius: entities are decoded', messy.includes("It's just fantasy"))
    check('genius: annotation links keep their text', messy.includes('caught in a landslide'))
    checkEqual(
      'genius: a page with no lyric containers has no lyrics',
      lyricsFromGeniusHtml('<div class="SongPage__LyricsWrapper">nothing here</div>'),
      null
    )

    const searchQuery = { title: 'Song (Official Video)', artist: 'Artist', album: null, durationMs: null }
    const searchUrl = new URL(geniusSearchUrl(searchQuery))
    checkEqual('genius: the search drops bracketed noise', searchUrl.searchParams.get('q'), 'Song Artist')
    checkEqual('genius: the search asks for three pages at most', searchUrl.searchParams.get('per_page'), '3')
    check('genius: only https pages are ever opened', isGeniusUrl('https://genius.com/Artist-song-lyrics'))
    check('genius: another host is not opened', !isGeniusUrl('https://evil.example/Artist-song-lyrics'))
    check('genius: another scheme is not opened', !isGeniusUrl('http://genius.com/Artist-song-lyrics'))

    const geniusSearchPayload = {
      response: {
        sections: [
          {
            type: 'top_hit',
            hits: [
              {
                type: 'song',
                result: {
                  id: 1,
                  title: 'Song',
                  artist_names: 'Artist',
                  url: 'https://genius.com/Artist-song-lyrics'
                }
              }
            ]
          },
          {
            type: 'song',
            hits: [
              {
                type: 'song',
                result: {
                  id: 1,
                  title: 'Song',
                  artist_names: 'Artist',
                  url: 'https://genius.com/Artist-song-lyrics'
                }
              },
              {
                type: 'song',
                result: {
                  id: 2,
                  title: 'Song (Live)',
                  artist_names: 'Artist',
                  url: 'https://genius.com/Artist-song-live-lyrics'
                }
              },
              {
                type: 'song',
                result: {
                  id: 3,
                  title: 'Song',
                  artist_names: 'Artist',
                  url: 'https://evil.example/not-genius',
                  instrumental: false
                }
              },
              {
                type: 'song',
                result: {
                  id: 4,
                  title: 'Song',
                  artist_names: 'Artist',
                  url: 'https://genius.com/Artist-song-lyrics',
                  instrumental: true
                }
              },
              { type: 'lyric', hits: [] }
            ]
          },
          { type: 'video', hits: [] }
        ]
      }
    }
    const hits = geniusHits(geniusSearchPayload)
    checkEqual(
      'genius: hits are collected once, off site, and off instrumentals',
      hits.map((hit) => hit.providerId).join('|'),
      '1|2'
    )
    checkEqual('genius: a hit keeps its page for the link back', hits[0]?.url, 'https://genius.com/Artist-song-lyrics')

    const geniusRequests: string[] = []
    const geniusFetch = async (input: string | URL | Request): Promise<Response> => {
      const url = String(input)
      geniusRequests.push(url)
      if (url.includes('/api/search/multi')) {
        return new Response(JSON.stringify(geniusSearchPayload), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      return new Response('<div data-lyrics-container="true">line one<br/>line two</div>', { status: 200 })
    }
    const genius = createGeniusProvider({
      log: silentLogger,
      fetch: geniusFetch as typeof fetch,
      timeoutMs: 2_000
    })
    const geniusAnswer = await genius.lookup(searchQuery)
    checkEqual('genius: the provider answered', geniusAnswer.ok, true)
    checkEqual('genius: one request per shortlisted page, plus the search', geniusRequests.length, 3)
    checkEqual(
      'genius: the words arrive as plain text with the page',
      [geniusAnswer.candidates[0]?.synced, geniusAnswer.candidates[0]?.text, geniusAnswer.candidates[0]?.url].join('|'),
      'false|line one\nline two|https://genius.com/Artist-song-lyrics'
    )

    const geniusPageOnly = createGeniusProvider({
      log: silentLogger,
      fetch: (async (input: string | URL | Request) =>
        String(input).includes('/api/search/multi')
          ? new Response(JSON.stringify(geniusSearchPayload), { status: 200 })
          : new Response('<div class="SongPage__LyricsWrapper">no lyrics here</div>', {
              status: 200
            })) as typeof fetch,
      timeoutMs: 2_000
    })
    const geniusPageAnswer = await geniusPageOnly.lookup(searchQuery)
    check(
      'genius: a page that no longer carries lyrics is not a failure',
      geniusPageAnswer.ok && geniusPageAnswer.candidates.length === 0
    )

    const geniusDown = createGeniusProvider({
      log: silentLogger,
      fetch: (async () => new Response(null, { status: 503, headers: { 'Retry-After': '0' } })) as typeof fetch,
      timeoutMs: 2_000
    })
    const geniusDownAnswer = await geniusDown.lookup(searchQuery)
    checkEqual(
      'genius: a 5xx reads as "temporarily unavailable"',
      geniusDownAnswer.message,
      'Genius is temporarily unavailable.'
    )

    const geniusRateLimited = createGeniusProvider({
      log: silentLogger,
      fetch: (async () => new Response(null, { status: 429, headers: { 'Retry-After': '0' } })) as typeof fetch,
      timeoutMs: 2_000
    })
    checkEqual(
      'genius: a 429 reads as rate limiting',
      (await geniusRateLimited.lookup(searchQuery)).message,
      'Genius is rate-limiting requests. Try again in a moment.'
    )

    // The search is retried once, so a brief rate limit does not empty the
    // provider for that track. The pages it leads to are not retried: they run
    // together, and asking three times in parallel is the burst being refused.
    const geniusRateCalls: string[] = []
    const geniusRecovers = createGeniusProvider({
      log: silentLogger,
      fetch: (async (input: string | URL | Request) => {
        const url = String(input)
        geniusRateCalls.push(url)
        if (url.includes('/api/search/multi')) {
          if (geniusRateCalls.filter((call) => call.includes('/api/search/multi')).length === 1) {
            return new Response(null, { status: 429, headers: { 'Retry-After': '0' } })
          }
          return new Response(JSON.stringify(geniusSearchPayload), { status: 200 })
        }
        return new Response('<div data-lyrics-container="true">line one</div>', { status: 200 })
      }) as typeof fetch,
      timeoutMs: 2_000
    })
    const geniusRecovered = await geniusRecovers.lookup(searchQuery)
    check(
      'genius: a 429 is retried, and the search still answers',
      geniusRecovered.ok && geniusRecovered.candidates.length > 0,
      JSON.stringify(geniusRecovered)
    )
    checkEqual(
      'genius: the retry costs one extra search',
      geniusRateCalls.filter((call) => call.includes('/api/search/multi')).length,
      2
    )

    // ---- the merge over both services --------------------------------------
    const geniusMatch = {
      provider: 'genius' as const,
      providerId: 'genius-1',
      title: 'Song',
      artist: 'Artist',
      album: null,
      durationMs: null,
      synced: false,
      text: 'plain words',
      instrumental: false,
      url: 'https://genius.com/Artist-song-lyrics',
      score: 0,
      confidence: 'weak' as const
    }
    const answerFor = (
      name: LyricsProvider['name'],
      candidates: typeof geniusMatch[] | LyricsCandidate[],
      answer: Partial<{ ok: boolean; message: string | null }> = {}
    ): LyricsProvider => ({
      name,
      lookup: async () => ({
        candidates: candidates as LyricsCandidate[],
        ok: answer.ok ?? true,
        message: answer.message ?? null
      })
    })
    const downLrclib = answerFor('lrclib', [], { ok: false, message: 'LRCLIB is temporarily unavailable.' })
    const merge = createLyricsFinder({ log: silentLogger, providers: [downLrclib, answerFor('genius', [geniusMatch])] })
    const merged = await merge.lookup(query)
    checkEqual('lyrics merge: one provider down still shows the other', merged.candidates.length, 1)
    checkEqual('lyrics merge: one provider answering leaves the message clear', merged.message, null)
    checkEqual(
      'lyrics merge: each provider gets a report',
      merged.providers.map((report) => `${report.provider}:${report.ok}:${report.count}`).join('|'),
      'lrclib:false:0|genius:true:1'
    )

    const bothDown = createLyricsFinder({
      log: silentLogger,
      providers: [downLrclib, answerFor('genius', [], { ok: false, message: 'Genius could not be reached.' })]
    })
    const bothDownAnswer = await bothDown.lookup(query)
    checkEqual(
      'lyrics merge: every provider down is one sentence',
      bothDownAnswer.message,
      'No lyrics service could be reached.'
    )
    checkEqual('lyrics merge: nothing is proposed when nobody answered', bothDownAnswer.candidates.length, 0)

    const throwing = createLyricsFinder({
      log: silentLogger,
      providers: [
        {
          name: 'genius',
          lookup: async () => {
            throw new Error('boom')
          }
        }
      ]
    })
    const throwingAnswer = await throwing.lookup(query)
    check(
      'lyrics merge: a provider that throws is reported, not fatal',
      throwingAnswer.message === 'No lyrics service could be reached.'
    )

    // A timed LRC and the same song's plain text from Genius are different
    // releases of one recording: the sync makes the first the better match.
    const crossProvider = rankLyricsCandidates(query, [
      { ...geniusMatch, providerId: 'genius-2' },
      {
        ...geniusMatch,
        provider: 'lrclib' as const,
        providerId: 'lrclib-2',
        durationMs: 212_000,
        synced: true,
        url: null,
        text: '[00:01.00]synced words'
      }
    ])
    checkEqual('lyrics merge: the synced copy wins a tie across providers', crossProvider[0]?.provider, 'lrclib')
    checkEqual('lyrics merge: the plain copy is still offered', crossProvider[1]?.provider, 'genius')
    checkEqual(
      'lyrics merge: the same page is not offered twice',
      rankLyricsCandidates(query, [geniusMatch, { ...geniusMatch }]).length,
      1
    )

    const bridgedGenius = sanitizeLyricsCandidate({ ...geniusMatch, score: 0.9, confidence: 'likely' })
    checkEqual(
      'lyrics finder: a genius match keeps its page for the link back',
      bridgedGenius.url,
      'https://genius.com/Artist-song-lyrics'
    )
    check(
      'lyrics finder: a page from anywhere else is refused',
      rejectsCandidate({ ...geniusMatch, url: 'https://evil.example/Artist-song-lyrics' })
    )
    check('lyrics finder: a genius match with no page is refused', rejectsCandidate({ ...geniusMatch, url: null }))
    check(
      'lyrics finder: a plain-text match is never timed',
      bridgedGenius.synced === false && parseLyrics(bridgedGenius.text).lines.length === 0
    )
  }

  const lyricsRoot = await mkdtemp(join(tmpdir(), 'player-lyrics-'))
  try {
    const lyricsPaths = resolveAppPaths(join(lyricsRoot, 'userData'))
    ensureAppDirectories(lyricsPaths)
    const lyricsDb = openLibraryDatabase(lyricsPaths.database, silentLogger)
    try {
      const lyricsRepo = new TrackRepository(lyricsDb.db)
      const writer = new TagWriter({
        backupDir: join(lyricsRoot, 'backups'),
        resolveFfmpeg: async () => ffmpegPath
      })

      // The network is replaced, not exercised. The service's own work is what
      // is under test here: which row wins, what is stored, and what a write
      // does to the file.
      const fetchedText = '[00:00.10]fetched first\n[00:00.90]fetched second'
      const findQueries: Array<Parameters<LyricsLookup['lookup']>[0]> = []
      const fakeLookup: LyricsLookup = {
        lookup: async (query) => {
          findQueries.push(query)
          return {
            query,
            candidates: [
              {
                provider: 'lrclib',
                providerId: 'smoke-lrclib',
                title: 'Lyrics',
                artist: 'Smoke',
                album: null,
                durationMs: 1200,
                synced: true,
                text: fetchedText,
                instrumental: false,
                url: null,
                score: 0.95,
                confidence: 'strong'
              }
            ],
            providers: [{ provider: 'lrclib', ok: true, message: null, count: 1 }],
            message: null
          }
        }
      }
      const streamStore = new StreamLyricsRepository(lyricsDb.db)
      const lyricsService = new LyricsService(
        lyricsRepo,
        new LyricsRepository(lyricsDb.db),
        silentLogger,
        writer,
        fakeLookup,
        streamStore
      )

      const makeLyricsFixture = async (fileName: string, codec: string[]): Promise<string> => {
        const target = join(lyricsRoot, fileName)
        await execFileAsync(
          ffmpegPath,
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=440:duration=1.2',
            ...codec,
            target
          ],
          { timeout: 60_000 }
        )
        return target
      }

      const insertTrack = (
        contentKey: string,
        filePath: string | null,
        sourceKind: 'local' | 'youtube' = 'local',
        title = 'Lyrics'
      ): number =>
        lyricsRepo.insert(
          {
            contentKey,
            sourceKind,
            sourceId: sourceKind === 'youtube' ? 'dQw4w9WgXcQ' : null,
            originKind: null,
            originId: null,
            title,
            artist: null,
            albumArtist: null,
            album: null,
            trackNo: null,
            discNo: null,
            trackTotal: null,
            discTotal: null,
            year: null,
            genre: null,
            durationMs: 1200,
            codec: null,
            bitrateKbps: null,
            sampleRate: null,
            channels: null,
            fileSize: null,
            fileMtimeMs: null,
            filePath
          },
          Date.now()
        )

      const embeddedText = '[00:01.00]first line\n[00:03.00]second line'
      const containers: Array<{ name: string; file: string; codec: string[] }> = [
        { name: 'mp3', file: 'embedded.mp3', codec: ['-c:a', 'libmp3lame'] },
        { name: 'flac', file: 'embedded.flac', codec: ['-c:a', 'flac'] },
        { name: 'm4a', file: 'embedded.m4a', codec: ['-c:a', 'aac'] },
        { name: 'ogg', file: 'embedded.ogg', codec: ['-c:a', 'libvorbis'] },
        { name: 'opus', file: 'embedded.opus', codec: ['-c:a', 'libopus'] }
      ]
      for (const container of containers) {
        const filePath = await makeLyricsFixture(container.file, container.codec)
        await writer.write(filePath, { lyrics: embeddedText })
        const id = insertTrack(`smoke-lyrics-${container.name}`, filePath)
        const found = await lyricsService.read(id)
        checkEqual(
          `lyrics: ${container.name} lyrics are found in the file`,
          [found?.source, found?.synced, found?.text].join('|'),
          `embedded|true|${embeddedText}`
        )
      }

      // A sidecar is the copy a user can edit without rewriting the audio, so it
      // is the one the player shows when both exist.
      const sidecarFile = await makeLyricsFixture('sidecar.flac', ['-c:a', 'flac'])
      await writer.write(sidecarFile, { lyrics: '[00:01.00]tag version' })
      const sidecarId = insertTrack('smoke-lyrics-sidecar', sidecarFile)
      const tagOnly = await lyricsService.read(sidecarId)
      checkEqual('lyrics: an embedded tag is used when there is no sidecar', tagOnly?.source, 'embedded')

      await writeFile(join(lyricsRoot, 'sidecar.lrc'), '[00:02.00]sidecar version', 'utf8')
      const withSidecar = await lyricsService.read(sidecarId)
      checkEqual(
        'lyrics: a .lrc beside the file wins over the tag',
        [withSidecar?.source, withSidecar?.origin, withSidecar?.text].join('|'),
        'sidecar|sidecar.lrc|[00:02.00]sidecar version'
      )

      // The timing correction belongs to the user, not the file, so re-reading
      // the same sidecar must not reset it.
      checkEqual('lyrics: an offset is remembered', lyricsService.setOffset(sidecarId, 1500)?.offsetMs, 1500)
      checkEqual('lyrics: reading the file again keeps the offset', (await lyricsService.read(sidecarId))?.offsetMs, 1500)

      // The finder asks with the row's values, and a chosen match is stored as
      // its own source. It wins over the sidecar because choosing it was an
      // explicit act, and it can be dropped again with one call.
      const found = await lyricsService.find(sidecarId)
      const asked = findQueries[0]
      checkEqual(
        'lyrics: the finder asks with the row values',
        [asked?.title, asked?.artist, asked?.durationMs].join('|'),
        'Lyrics||1200'
      )
      checkEqual('lyrics: the finder returns the injected match', found.candidates[0]?.providerId, 'smoke-lrclib')
      const fetched = found.candidates[0]
      if (!fetched) throw new Error('the injected lyrics match disappeared')
      const chosen = await lyricsService.use(sidecarId, fetched)
      checkEqual(
        'lyrics: a chosen match is stored and labelled',
        [chosen?.source, chosen?.text, chosen?.synced].join('|'),
        `lrclib|${fetchedText}|true`
      )
      checkEqual('lyrics: fetched lyrics win over a sidecar', (await lyricsService.read(sidecarId))?.source, 'lrclib')
      checkEqual('lyrics: the offset works on fetched lyrics', lyricsService.setOffset(sidecarId, 500)?.offsetMs, 500)
      let writeRefusal = ''
      await lyricsService.writeToFile(sidecarId).catch((error) => {
        writeRefusal = error instanceof Error ? error.message : String(error)
      })
      check('lyrics: writing is refused while a .lrc wins', writeRefusal.includes('.lrc'))
      const backToFile = await lyricsService.useFile(sidecarId)
      checkEqual(
        'lyrics: use file lyrics drops the fetched copy',
        [backToFile?.source, backToFile?.text].join('|'),
        'sidecar|[00:02.00]sidecar version'
      )
      checkEqual('lyrics: the fetched row is gone', (await lyricsService.read(sidecarId))?.source, 'sidecar')

      await writeFile(join(lyricsRoot, 'sidecar.lrc'), '[00:02.00]edited sidecar', 'utf8')
      const editedSidecar = await lyricsService.read(sidecarId)
      checkEqual(
        'lyrics: a changed sidecar keeps the timing correction',
        [editedSidecar?.text, editedSidecar?.offsetMs].join('|'),
        '[00:02.00]edited sidecar|1500'
      )

      await rm(join(lyricsRoot, 'sidecar.lrc'))
      checkEqual(
        'lyrics: removing the sidecar falls back to the tag',
        (await lyricsService.read(sidecarId))?.source,
        'embedded'
      )

      const bareFile = await makeLyricsFixture('bare.flac', ['-c:a', 'flac'])
      const bareId = insertTrack('smoke-lyrics-none', bareFile)
      checkEqual('lyrics: a file with no lyrics returns null', await lyricsService.read(bareId), null)
      checkEqual('lyrics: an offset with no lyrics is refused', lyricsService.setOffset(bareId, 500), null)

      // A fetched lyric is not a file lyric until the user writes it. Doing so
      // makes the tag the source, and the fetched row is removed so the label
      // and the next read agree with the file.
      const writeFixture = await makeLyricsFixture('write.flac', ['-c:a', 'flac'])
      const writeId = insertTrack('smoke-lyrics-write', writeFixture)
      const forWriting = (await lyricsService.find(writeId)).candidates[0]
      if (!forWriting) throw new Error('the injected lyrics match disappeared')
      await lyricsService.use(writeId, forWriting)
      checkEqual(
        'lyrics: a fetched lyric is shown before it is written',
        (await lyricsService.read(writeId))?.source,
        'lrclib'
      )
      const written = await lyricsService.writeToFile(writeId)
      checkEqual(
        'lyrics: writing into the file makes the tag the source',
        [written?.source, written?.text].join('|'),
        `embedded|${fetchedText}`
      )
      checkEqual(
        'lyrics: reading after the write keeps the file lyrics',
        (await lyricsService.read(writeId))?.source,
        'embedded'
      )
      let noFetchRefusal = ''
      await lyricsService.writeToFile(writeId).catch((error) => {
        noFetchRefusal = error instanceof Error ? error.message : String(error)
      })
      check('lyrics: writing again without a fetch is refused', noFetchRefusal.includes('no fetched'))

      await lyricsService.use(bareId, forWriting)
      checkEqual('lyrics: use file lyrics can mean no lyrics', await lyricsService.useFile(bareId), null)

      // ---- streaming tracks -------------------------------------------------
      // A stream has no file and no row in `tracks`, so its lyrics are keyed by
      // the video id: one copy follows the song no matter which route into it
      // the queue row came from.
      const streamTarget: StreamLyricsTarget = {
        sourceKind: 'youtube',
        videoId: 'dQw4w9WgXcQ',
        title: 'Lyrics',
        artist: null,
        album: null,
        durationMs: 1200
      }
      checkEqual('lyrics: a stream starts with no lyrics', await lyricsService.read(streamTarget), null)
      checkEqual('lyrics: a stream has no file lyrics', await lyricsService.readFile(streamTarget), null)

      const streamFound = await lyricsService.find(streamTarget)
      const streamAsked = findQueries[findQueries.length - 1]
      checkEqual(
        'lyrics: a stream is searched with the values it carries',
        [streamAsked?.title, streamAsked?.artist, streamAsked?.durationMs].join('|'),
        'Lyrics||1200'
      )
      const streamChoice = streamFound.candidates[0]
      if (!streamChoice) throw new Error('the injected lyrics match disappeared')
      const streamChosen = await lyricsService.use(streamTarget, streamChoice)
      checkEqual('lyrics: a stream lyric has no library row', streamChosen?.trackId ?? 'none', 'none')
      checkEqual('lyrics: a stream lyric is keyed by its video', streamChosen?.videoId, 'dQw4w9WgXcQ')
      checkEqual('lyrics: a stream lyric is labelled with its source', streamChosen?.source, 'lrclib')
      checkEqual('lyrics: a stream lyric keeps the fetched text', streamChosen?.text, fetchedText)
      checkEqual(
        'lyrics: the same video reads the same lyric again',
        (await lyricsService.read(streamTarget))?.text,
        fetchedText
      )
      checkEqual(
        'lyrics: a stream offset is remembered',
        lyricsService.setOffset(streamTarget, 750)?.offsetMs,
        750
      )
      checkEqual(
        'lyrics: a stream offset survives a re-read',
        (await lyricsService.read(streamTarget))?.offsetMs,
        750
      )
      // One video can arrive under several negative track ids; the store is
      // keyed by the video, so a different one is a different song.
      checkEqual(
        'lyrics: another video has no lyric of its own',
        await lyricsService.read({ ...streamTarget, videoId: '9bZkp7q19f0' }),
        null
      )
      // A stream's negative id still cannot stand in for a library row.
      let streamById = ''
      await lyricsService.find(-33).catch((error) => {
        streamById = error instanceof Error ? error.message : String(error)
      })
      check('lyrics: a stream id is not a library track', streamById.includes('Only files'))
      let streamWrite = ''
      await lyricsService.writeToFile(streamTarget).catch((error) => {
        streamWrite = error instanceof Error ? error.message : String(error)
      })
      check('lyrics: a stream has no file to write into', streamWrite.includes('Only files'))
      checkEqual(
        'lyrics: forgetting a stream lyric leaves nothing',
        await lyricsService.useFile(streamTarget),
        null
      )
      checkEqual(
        'lyrics: a forgotten stream lyric stays gone',
        await lyricsService.read(streamTarget),
        null
      )

      // ---- Genius through the service ---------------------------------------
      // Same storage rules, one more shape of text and a page to link back to.
      // Genius is plain text, so it can be written into a file with no sidecar.
      const geniusText = 'Is this the real life? Is this just fantasy?\nNo escape from reality'
      const geniusChoice = sanitizeLyricsCandidate({
        provider: 'genius',
        providerId: '1063',
        title: 'Lyrics',
        artist: 'Smoke',
        album: null,
        durationMs: null,
        synced: false,
        text: geniusText,
        instrumental: false,
        url: 'https://genius.com/Smoke-lyrics-1063',
        score: 0.9,
        confidence: 'likely'
      })
      const geniusFile = await makeLyricsFixture('genius.flac', ['-c:a', 'flac'])
      const geniusId = insertTrack('smoke-lyrics-genius', geniusFile)
      const geniusShown = await lyricsService.use(geniusId, geniusChoice)
      checkEqual(
        'lyrics: a genius match is stored with its page and labelled',
        [geniusShown?.source, geniusShown?.synced, geniusShown?.origin, geniusShown?.text].join('|'),
        `genius|false|https://genius.com/Smoke-lyrics-1063|${geniusText}`
      )
      checkEqual(
        'lyrics: a genius match has no timed lines',
        parseLyrics(geniusShown?.text ?? '').lines.length,
        0
      )
      const fileSide = await lyricsService.readFile(geniusId)
      checkEqual(
        'lyrics: the file view ignores a genius match, as the tag editor needs',
        fileSide,
        null
      )
      const geniusWritten = await lyricsService.writeToFile(geniusId)
      checkEqual(
        'lyrics: a genius match is written as the file’s own lyrics',
        [geniusWritten?.source, geniusWritten?.text].join('|'),
        `embedded|${geniusText}`
      )

      // Choosing from one service drops the other's row, so the panel never
      // shows a hidden second fetch the user could not get back to.
      const twinFixture = await makeLyricsFixture('twin.flac', ['-c:a', 'flac'])
      const twinId = insertTrack('smoke-lyrics-twin', twinFixture)
      const twinStore = new LyricsRepository(lyricsDb.db)
      twinStore.saveFetched(twinId, 'lrclib', {
        language: null,
        synced: true,
        text: fetchedText
      })
      twinStore.saveFetched(twinId, 'genius', {
        language: null,
        synced: false,
        text: geniusText,
        origin: 'https://genius.com/Smoke-lyrics-1063'
      })
      checkEqual(
        'lyrics: only one fetched row is kept at a time',
        [
          twinStore.get(twinId, 'lrclib') === null,
          twinStore.get(twinId, 'genius') !== null,
          twinStore.fetched(twinId)?.source
        ].join('|'),
        'true|true|genius'
      )

      // ---- batch lyrics -----------------------------------------------------
      // The scan is the slow half, so it is driven by a lookup that can answer,
      // miss or fail per title. Nothing is stored until apply, and undo has to
      // survive a lyric the user changed in between.
      const batchLookup: LyricsLookup = {
        lookup: async (query) => {
          if (query.title === 'Batch Broken') throw new Error('The lookup exploded.')
          if (query.title === 'Batch Nothing') {
            return {
              query,
              candidates: [],
              providers: [{ provider: 'lrclib', ok: true, message: null, count: 0 }],
              message: null
            }
          }
          const weak = query.title === 'Batch Weak'
          return {
            query,
            candidates: [
              {
                provider: 'lrclib',
                providerId: `batch-${query.title}`,
                title: query.title,
                artist: 'Smoke',
                album: null,
                durationMs: 1200,
                synced: true,
                text: `[00:00.10]${query.title}`,
                instrumental: false,
                url: null,
                score: weak ? 0.45 : 0.95,
                confidence: weak ? 'weak' : 'strong'
              }
            ],
            providers: [{ provider: 'lrclib', ok: true, message: null, count: 1 }],
            message: null
          }
        }
      }
      const batchLyrics = new LyricsService(
        lyricsRepo,
        new LyricsRepository(lyricsDb.db),
        silentLogger,
        writer,
        batchLookup
      )
      const batchProgress: Array<{ phase: string; scanned: number; total: number }> = []
      const reviewWaiters = new Map<string, (snapshot: LyricsBatchSnapshot | null) => void>()
      let batchService: LyricsBatchService
      batchService = new LyricsBatchService({
        repo: lyricsRepo,
        lyrics: batchLyrics,
        log: silentLogger,
        onProgress: (update) => {
          batchProgress.push({ phase: update.phase, scanned: update.scanned, total: update.total })
          if (update.phase !== 'review') return
          reviewWaiters.get(update.jobId)?.(batchService.get(update.jobId))
        }
      })
      const waitForReview = (jobId: string): Promise<LyricsBatchSnapshot | null> =>
        new Promise((resolve) => {
          reviewWaiters.set(jobId, resolve)
          const found = batchService.get(jobId)
          if (found) resolve(found)
        })

      const batchMatchFile = await makeLyricsFixture('batch-match.flac', ['-c:a', 'flac'])
      const batchMatchId = insertTrack('smoke-batch-match', batchMatchFile, 'local', 'Batch Match')
      const batchSkipFile = await makeLyricsFixture('batch-skip.flac', ['-c:a', 'flac'])
      await writer.write(batchSkipFile, { lyrics: '[00:00.20]already here' })
      const batchSkipId = insertTrack('smoke-batch-skip', batchSkipFile, 'local', 'Batch Skip')
      const batchNoneFile = await makeLyricsFixture('batch-none.flac', ['-c:a', 'flac'])
      const batchNoneId = insertTrack('smoke-batch-none', batchNoneFile, 'local', 'Batch Nothing')
      const batchWeakFile = await makeLyricsFixture('batch-weak.flac', ['-c:a', 'flac'])
      const batchWeakId = insertTrack('smoke-batch-weak', batchWeakFile, 'local', 'Batch Weak')
      const batchBrokenFile = await makeLyricsFixture('batch-broken.flac', ['-c:a', 'flac'])
      const batchBrokenId = insertTrack('smoke-batch-broken', batchBrokenFile, 'local', 'Batch Broken')

      const batchStarted = batchService.start([
        batchMatchId,
        batchSkipId,
        batchNoneId,
        batchWeakId,
        batchBrokenId
      ])
      check('lyrics batch: start returns a job id at once', batchStarted.jobId.length > 0)
      const batchSnapshot = await waitForReview(batchStarted.jobId)
      if (!batchSnapshot) throw new Error('the batch scan never finished')
      const itemOf = (trackId: number) => batchSnapshot.items.find((item) => item.trackId === trackId)
      const matchItem = itemOf(batchMatchId)
      const skipItem = itemOf(batchSkipId)
      const noneItem = itemOf(batchNoneId)
      const weakItem = itemOf(batchWeakId)
      const brokenItem = itemOf(batchBrokenId)
      checkEqual('lyrics batch: a file with no lyrics is a match', matchItem?.status, 'match')
      checkEqual('lyrics batch: the match carries the provider summary', matchItem?.match?.provider, 'lrclib')
      checkEqual('lyrics batch: a file with lyrics is skipped', skipItem?.status, 'skipped')
      checkEqual('lyrics batch: the skip says why', skipItem?.message, 'Already has lyrics.')
      checkEqual('lyrics batch: an empty answer is no match', noneItem?.status, 'no-match')
      checkEqual('lyrics batch: a weak match is still offered', weakItem?.match?.confidence, 'weak')
      checkEqual('lyrics batch: a throwing lookup is a failure', brokenItem?.status, 'failed')
      check('lyrics batch: the failure keeps its reason', (brokenItem?.message ?? '').includes('exploded'))
      checkEqual(
        'lyrics batch: progress reaches every track',
        [
          batchProgress[0]?.phase,
          batchProgress.at(-1)?.phase,
          batchProgress.at(-1)?.scanned,
          batchProgress.at(-1)?.total
        ].join('|'),
        'scanning|review|5|5'
      )
      checkEqual(
        'lyrics batch: the provider report totals the answered lookups',
        batchSnapshot.providers.find((report) => report.provider === 'lrclib')?.count,
        2
      )
      checkEqual('lyrics batch: a scan stores nothing', await batchLyrics.read(batchMatchId), null)

      // Applying stores only what was named. The copy is the provider's text,
      // and undo removes it because it still holds the batch's words.
      if (!matchItem) throw new Error('the batch match disappeared')
      const storedOnly = await batchService.apply(batchStarted.jobId, [matchItem.id], false)
      checkEqual(
        'lyrics batch: apply stores the accepted match',
        [storedOnly.stored, storedOnly.written].join('|'),
        '1|0'
      )
      checkEqual(
        'lyrics batch: the stored copy is the match text',
        (await batchLyrics.read(batchMatchId))?.text,
        '[00:00.10]Batch Match'
      )
      const storedUndo = await batchService.undo(batchStarted.jobId)
      checkEqual(
        'lyrics batch: undo removes the stored copy',
        [storedUndo.removed, storedUndo.restored].join('|'),
        '1|0'
      )
      checkEqual('lyrics batch: the row is gone after undo', await batchLyrics.read(batchMatchId), null)

      // A lyric fetched again after the batch is the user's, not the batch's.
      await batchService.apply(batchStarted.jobId, [matchItem.id], false)
      await batchLyrics.use(batchMatchId, {
        provider: 'genius',
        providerId: 're-fetched',
        title: 'Batch Match',
        artist: 'Smoke',
        album: null,
        durationMs: 1200,
        synced: false,
        text: 'words the user chose later',
        instrumental: false,
        url: null,
        score: 0.9,
        confidence: 'likely'
      })
      const guardedUndo = await batchService.undo(batchStarted.jobId)
      checkEqual(
        'lyrics batch: undo leaves a changed lyric alone',
        [guardedUndo.removed, guardedUndo.skipped].join('|'),
        '0|1'
      )
      checkEqual(
        'lyrics batch: the user’s later choice survives',
        (await batchLyrics.read(batchMatchId))?.text,
        'words the user chose later'
      )
      await batchLyrics.useFile(batchMatchId)

      // Writing into the file is the permanent half. The backup the writer
      // keeps is what makes undo able to put the file back.
      const batchWriteFile = await makeLyricsFixture('batch-write.flac', ['-c:a', 'flac'])
      const batchWriteId = insertTrack('smoke-batch-write', batchWriteFile, 'local', 'Batch Write')
      const writeStarted = batchService.start([batchWriteId])
      const writeSnapshot = await waitForReview(writeStarted.jobId)
      const writeItem = writeSnapshot?.items.find((item) => item.trackId === batchWriteId)
      if (!writeItem) throw new Error('the batch write item disappeared')
      const writtenBatch = await batchService.apply(writeStarted.jobId, [writeItem.id], true)
      checkEqual(
        'lyrics batch: writing reports the file write',
        [writtenBatch.stored, writtenBatch.written].join('|'),
        '0|1'
      )
      checkEqual(
        'lyrics batch: the file is the source after writing',
        (await batchLyrics.read(batchWriteId))?.source,
        'embedded'
      )
      const writeUndo = await batchService.undo(writeStarted.jobId)
      checkEqual('lyrics batch: undo restores the file from its backup', writeUndo.restored, 1)
      checkEqual('lyrics batch: the restored file has no lyrics again', await batchLyrics.read(batchWriteId), null)

      // A sidecar that appeared between the scan and apply wins over the tag, so
      // the write is refused; the copy is still stored and still undoable.
      const batchLrcFile = await makeLyricsFixture('batch-lrc.flac', ['-c:a', 'flac'])
      const batchLrcId = insertTrack('smoke-batch-lrc', batchLrcFile, 'local', 'Batch LRC')
      const lrcStarted = batchService.start([batchLrcId])
      const lrcSnapshot = await waitForReview(lrcStarted.jobId)
      const lrcItem = lrcSnapshot?.items.find((item) => item.trackId === batchLrcId)
      if (!lrcItem) throw new Error('the batch lrc item disappeared')
      await writeFile(join(lyricsRoot, 'batch-lrc.lrc'), '[00:00.30]sidecar words', 'utf8')
      const lrcApplied = await batchService.apply(lrcStarted.jobId, [lrcItem.id], true)
      checkEqual(
        'lyrics batch: a .lrc refuses the file write but keeps the copy',
        [lrcApplied.stored, lrcApplied.written].join('|'),
        '1|0'
      )
      check('lyrics batch: the refusal names the .lrc', (lrcApplied.failed[0]?.message ?? '').includes('.lrc'))
      const lrcUndo = await batchService.undo(lrcStarted.jobId)
      checkEqual('lyrics batch: undo removes the copy a refused write left', lrcUndo.removed, 1)
      await rm(join(lyricsRoot, 'batch-lrc.lrc'))

      // The playing file is stored but not rewritten, because Windows will not
      // replace it while it is open. The result says so and undo still works.
      const guardedStarted = batchService.start([batchMatchId])
      const guardedSnapshot = await waitForReview(guardedStarted.jobId)
      const guardedItem = guardedSnapshot?.items.find((item) => item.trackId === batchMatchId)
      if (!guardedItem) throw new Error('the guarded item disappeared')
      const playingApply = await batchService.apply(
        guardedStarted.jobId,
        [guardedItem.id],
        true,
        () => false
      )
      checkEqual(
        'lyrics batch: a playing file is stored but not written',
        [playingApply.stored, playingApply.written].join('|'),
        '1|0'
      )
      check(
        'lyrics batch: the playback guard says why',
        (playingApply.failed[0]?.message ?? '').includes('open for playback')
      )
      const playingUndo = await batchService.undo(guardedStarted.jobId)
      checkEqual('lyrics batch: undo removes the stored copy after the guard', playingUndo.removed, 1)

      // Cancelling stops before the next track and leaves no review behind.
      const slowLookup: LyricsLookup = {
        lookup: (query) =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  query,
                  candidates: [],
                  providers: [{ provider: 'lrclib', ok: true, message: null, count: 0 }],
                  message: null
                }),
              50
            )
          )
      }
      const slowService = new LyricsBatchService({
        repo: lyricsRepo,
        lyrics: new LyricsService(
          lyricsRepo,
          new LyricsRepository(lyricsDb.db),
          silentLogger,
          writer,
          slowLookup
        ),
        log: silentLogger,
        onProgress: () => undefined
      })
      const slowStarted = slowService.start([batchNoneId, batchWeakId])
      slowService.cancel(slowStarted.jobId)
      await new Promise((resolve) => setTimeout(resolve, 250))
      checkEqual(
        'lyrics batch: a cancelled scan has no review',
        slowService.get(slowStarted.jobId),
        null
      )
    } finally {
      lyricsDb.close()
    }
  } finally {
    await rm(lyricsRoot, { recursive: true, force: true }).catch(() => undefined)
  }

  // ---- batch tags --------------------------------------------------------
  // The rule that decides what a match may write is pure, so its edges are
  // pinned down first. The service is then run against real files: a fill has
  // to leave what the user already wrote, a replace has to overwrite it, and
  // undo has to put the file back only while it is still the batch's version.
  {
    const tagged: Track = {
      id: 1,
      sourceKind: 'local',
      sourceId: null,
      originKind: null,
      originId: null,
      title: 'Tagged',
      artist: 'Old Artist',
      albumArtist: null,
      album: null,
      trackNo: null,
      discNo: null,
      trackTotal: null,
      discTotal: null,
      year: null,
      genre: null,
      durationMs: 1200,
      codec: null,
      bitrateKbps: null,
      sampleRate: null,
      channels: null,
      fileSize: null,
      missingAt: null,
      filePath: 'C:\\music\\tagged.flac',
      artworkKey: null,
      replayGainDb: null,
      replayGainPeak: null,
      addedAt: 0,
      playCount: 0,
      lastPlayedAt: null
    }
    const candidate: TagCandidate = {
      provider: 'itunes',
      providerId: 'rule-1',
      title: 'Tagged',
      artist: 'New Artist',
      albumArtist: 'New Artist',
      album: 'New Album',
      year: 2022,
      genre: 'Pop',
      trackNo: 3,
      trackTotal: 12,
      discNo: 1,
      discTotal: 2,
      durationMs: 1200,
      artworkUrl: null,
      score: 0.95,
      confidence: 'strong'
    }
    const ruleChanges = tagBatchChanges(tagged, candidate)
    checkEqual(
      'tag batch: every difference is listed in dialog order',
      ruleChanges.map((change) => change.field).join(','),
      'artist,albumArtist,album,genre,year,track,disc'
    )
    checkEqual(
      'tag batch: a blank field is a fill and an occupied one is not',
      [ruleChanges[0]?.fills, ruleChanges[2]?.fills].join('|'),
      'false|true'
    )
    checkEqual(
      'tag batch: fill writes only the blank fields',
      JSON.stringify(tagBatchFields(ruleChanges, 'fill')),
      JSON.stringify({
        albumArtist: 'New Artist',
        album: 'New Album',
        genre: 'Pop',
        year: 2022,
        trackNo: 3,
        trackTotal: 12,
        discNo: 1,
        discTotal: 2
      })
    )
    checkEqual(
      'tag batch: replace writes the occupied ones too',
      JSON.stringify(tagBatchFields(ruleChanges, 'replace')),
      JSON.stringify({
        artist: 'New Artist',
        albumArtist: 'New Artist',
        album: 'New Album',
        genre: 'Pop',
        year: 2022,
        trackNo: 3,
        trackTotal: 12,
        discNo: 1,
        discTotal: 2
      })
    )
    checkEqual(
      'tag batch: a row that already agrees has nothing to change',
      tagBatchChanges(tagged, { ...candidate, artist: 'Old Artist', albumArtist: null, album: null, genre: null, year: null, trackNo: null, trackTotal: null, discNo: null, discTotal: null }).length,
      0
    )
    checkEqual(
      'tag batch: a position is written as the editor shows it',
      [positionText(3, 12), positionText(3, null), positionText(null, 12)].join('|'),
      '3 of 12|3|'
    )
    checkEqual(
      'tag batch: a fill reads as a proposal, a replace as a change',
      [
        describeTagBatchChange({ field: 'album', label: 'Album', from: null, to: 'A', fills: true, fields: {} }),
        describeTagBatchChange({ field: 'artist', label: 'Artist', from: 'A', to: 'B', fills: false, fields: {} })
      ].join(' | '),
      'Album: A | Artist: A → B'
    )

    const tagBatchRoot = await mkdtemp(join(tmpdir(), 'player-tag-batch-'))
    try {
      const batchPaths = resolveAppPaths(join(tagBatchRoot, 'userData'))
      ensureAppDirectories(batchPaths)
      const batchDb = openLibraryDatabase(batchPaths.database, silentLogger)
      try {
        const batchRepo = new TrackRepository(batchDb.db)
        const batchSettings = new SettingsService(batchPaths.config, silentLogger)
        const batchWriter = new TagWriter({
          backupDir: join(tagBatchRoot, 'backups'),
          resolveFfmpeg: async () => ffmpegPath
        })
        const batchLibrary = new LibraryService(
          batchRepo,
          batchSettings,
          silentLogger,
          {},
          batchWriter
        )

        const makeBatchFixture = async (
          fileName: string,
          metadata: Record<string, string>
        ): Promise<string> => {
          const target = join(tagBatchRoot, fileName)
          await execFileAsync(
            ffmpegPath,
            [
              '-hide_banner',
              '-loglevel',
              'error',
              '-y',
              '-f',
              'lavfi',
              '-i',
              'sine=frequency=440:duration=1.2',
              '-c:a',
              'flac',
              ...Object.entries(metadata).flatMap(([key, value]) => ['-metadata', `${key}=${value}`]),
              target
            ],
            { timeout: 60_000 }
          )
          return target
        }

        const insertBatchRow = (input: {
          contentKey: string
          filePath: string | null
          sourceKind?: 'local' | 'youtube'
          title: string
          artist?: string | null
          album?: string | null
          year?: number | null
        }): number =>
          batchRepo.insert(
            {
              contentKey: input.contentKey,
              sourceKind: input.sourceKind ?? 'local',
              sourceId: input.sourceKind === 'youtube' ? 'dQw4w9WgXcQ' : null,
              originKind: null,
              originId: null,
              title: input.title,
              artist: input.artist ?? null,
              albumArtist: null,
              album: input.album ?? null,
              trackNo: null,
              discNo: null,
              trackTotal: null,
              discTotal: null,
              year: input.year ?? null,
              genre: null,
              durationMs: 1200,
              codec: null,
              bitrateKbps: null,
              sampleRate: null,
              channels: null,
              fileSize: null,
              fileMtimeMs: null,
              filePath: input.filePath
            },
            Date.now()
          )

        const candidateFor = (title: string, over: Partial<TagCandidate> = {}): TagCandidate => ({
          provider: 'itunes',
          providerId: `itunes-${title}`,
          title,
          artist: 'New Artist',
          albumArtist: null,
          album: 'New Album',
          year: 2022,
          genre: 'Pop',
          trackNo: null,
          trackTotal: null,
          discNo: null,
          discTotal: null,
          durationMs: 1200,
          artworkUrl: null,
          score: 0.95,
          confidence: 'strong',
          ...over
        })

        const batchLookup: TagLookup = {
          lookupFingerprint: async (query) => ({
            query,
            candidates: [],
            providers: [{ provider: 'acoustid', ok: true, message: null, count: 0 }]
          }),
          lookup: async (query) => {
            if (query.title === 'Tag Broken') throw new Error('The tag lookup exploded.')
            if (query.title === 'Tag None') {
              return {
                query,
                candidates: [],
                providers: [{ provider: 'itunes', ok: true, message: null, count: 0 }]
              }
            }
            if (query.title === 'Tag Same') {
              return {
                query,
                candidates: [
                  candidateFor('Tag Same', {
                    artist: 'Same Artist',
                    album: null,
                    year: null,
                    genre: null
                  })
                ],
                providers: [{ provider: 'itunes', ok: true, message: null, count: 1 }]
              }
            }
            if (query.title === 'Tag Stale') {
              return {
                query,
                candidates: [candidateFor('Tag Stale', { album: null, year: null, genre: null })],
                providers: [{ provider: 'itunes', ok: true, message: null, count: 1 }]
              }
            }
            if (query.title === 'Tag Replace') {
              return {
                query,
                candidates: [candidateFor('Tag Replace', { year: null, genre: null })],
                providers: [{ provider: 'itunes', ok: true, message: null, count: 1 }]
              }
            }
            return {
              query,
              candidates: [candidateFor(query.title)],
              providers: [{ provider: 'itunes', ok: true, message: null, count: 1 }]
            }
          }
        }

        const progress: Array<{ phase: string; scanned: number; total: number }> = []
        const reviewWaiters = new Map<string, (snapshot: TagBatchSnapshot | null) => void>()
        let batchService: TagBatchService
        batchService = new TagBatchService({
          repo: batchRepo,
          library: batchLibrary,
          tagLookup: batchLookup,
          log: silentLogger,
          onProgress: (update) => {
            progress.push({ phase: update.phase, scanned: update.scanned, total: update.total })
            if (update.phase !== 'review') return
            reviewWaiters.get(update.jobId)?.(batchService.get(update.jobId))
          }
        })
        const waitForReview = (jobId: string): Promise<TagBatchSnapshot | null> =>
          new Promise((resolve) => {
            reviewWaiters.set(jobId, resolve)
            const found = batchService.get(jobId)
            if (found) resolve(found)
          })

        const fillFile = await makeBatchFixture('fill.flac', { title: 'Tag Fill' })
        const fillId = insertBatchRow({ contentKey: 'smoke-tag-fill', filePath: fillFile, title: 'Tag Fill' })
        const sameFile = await makeBatchFixture('same.flac', {
          title: 'Tag Same',
          artist: 'Same Artist'
        })
        const sameId = insertBatchRow({
          contentKey: 'smoke-tag-same',
          filePath: sameFile,
          title: 'Tag Same',
          artist: 'Same Artist'
        })
        const noneFile = await makeBatchFixture('none.flac', { title: 'Tag None' })
        const noneId = insertBatchRow({ contentKey: 'smoke-tag-none', filePath: noneFile, title: 'Tag None' })
        const brokenFile = await makeBatchFixture('broken.flac', { title: 'Tag Broken' })
        const brokenId = insertBatchRow({
          contentKey: 'smoke-tag-broken',
          filePath: brokenFile,
          title: 'Tag Broken'
        })
        const streamId = insertBatchRow({
          contentKey: 'smoke-tag-stream',
          filePath: null,
          sourceKind: 'youtube',
          title: 'Tag Stream'
        })

        const started = batchService.start([fillId, sameId, noneId, brokenId, streamId])
        check('tag batch: start returns a job id at once', started.jobId.length > 0)
        const snapshot = await waitForReview(started.jobId)
        if (!snapshot) throw new Error('the tag batch scan never finished')
        const itemOf = (trackId: number) => snapshot.items.find((item) => item.trackId === trackId)
        const fillItem = itemOf(fillId)
        const sameItem = itemOf(sameId)
        const noneItem = itemOf(noneId)
        const brokenItem = itemOf(brokenId)
        const streamItem = itemOf(streamId)
        checkEqual('tag batch: a file with blanks is a match', fillItem?.status, 'match')
        checkEqual(
          'tag batch: the match carries the fields it would write',
          fillItem?.match?.changes.map((change) => change.field).join(','),
          'artist,album,genre,year'
        )
        checkEqual('tag batch: a row that already agrees is skipped', sameItem?.status, 'skipped')
        checkEqual('tag batch: the skip says why', sameItem?.message, 'Tags already match.')
        checkEqual('tag batch: an empty answer is no match', noneItem?.status, 'no-match')
        checkEqual('tag batch: a throwing lookup is a failure', brokenItem?.status, 'failed')
        check('tag batch: the failure keeps its reason', (brokenItem?.message ?? '').includes('exploded'))
        checkEqual('tag batch: a stream is not a file to tag', streamItem?.status, 'skipped')
        checkEqual('tag batch: a stream is skipped for the right reason', streamItem?.message, 'Not a file in the library.')
        checkEqual(
          'tag batch: progress reaches every track',
          [progress[0]?.phase, progress.at(-1)?.phase, progress.at(-1)?.scanned, progress.at(-1)?.total].join('|'),
          'scanning|review|5|5'
        )
        checkEqual(
          'tag batch: the provider report totals the answered lookups',
          snapshot.providers.find((report) => report.provider === 'itunes')?.count,
          2
        )
        checkEqual(
          'tag batch: a scan writes nothing',
          (await extractMetadata(fillFile)).artist,
          null
        )

        if (!fillItem) throw new Error('the fill item disappeared')
        const fillApply = await batchService.apply(started.jobId, [fillItem.id], 'fill')
        checkEqual('tag batch: fill writes the chosen file', fillApply.written, 1)
        checkEqual(
          'tag batch: fill leaves the occupied field alone',
          (await extractMetadata(fillFile)).artist,
          'New Artist'
        )
        checkEqual(
          'tag batch: the row is rebuilt from the written file',
          [batchRepo.getById(fillId)?.artist, batchRepo.getById(fillId)?.album].join('|'),
          'New Artist|New Album'
        )
        const fillUndo = await batchService.undo(started.jobId)
        checkEqual('tag batch: undo restores the file from its backup', fillUndo.restored, 1)
        checkEqual(
          'tag batch: the restored file has no artist again',
          (await extractMetadata(fillFile)).artist,
          null
        )

        // A stale decision is not a write: the row gained an artist after the
        // scan, so fill now has nothing to do even though the scan said it did.
        const staleFile = await makeBatchFixture('stale.flac', { title: 'Tag Stale' })
        const staleId = insertBatchRow({
          contentKey: 'smoke-tag-stale',
          filePath: staleFile,
          title: 'Tag Stale'
        })
        const staleStarted = batchService.start([staleId])
        const staleSnapshot = await waitForReview(staleStarted.jobId)
        const staleItem = staleSnapshot?.items.find((item) => item.trackId === staleId)
        if (!staleItem) throw new Error('the stale item disappeared')
        await batchLibrary.updateTags(staleId, { artist: 'Filled Later' })
        const staleApply = await batchService.apply(staleStarted.jobId, [staleItem.id], 'fill')
        checkEqual(
          'tag batch: apply recomputes against the live row',
          [staleApply.written, staleApply.skipped].join('|'),
          '0|1'
        )
        checkEqual(
          'tag batch: the value added after the scan survives',
          (await extractMetadata(staleFile)).artist,
          'Filled Later'
        )

        // Replace is the explicit choice: the same match now overwrites the
        // artist the file already has.
        const replaceFile = await makeBatchFixture('replace.flac', {
          title: 'Tag Replace',
          artist: 'Old Artist'
        })
        const replaceId = insertBatchRow({
          contentKey: 'smoke-tag-replace',
          filePath: replaceFile,
          title: 'Tag Replace',
          artist: 'Old Artist'
        })
        const replaceStarted = batchService.start([replaceId])
        const replaceSnapshot = await waitForReview(replaceStarted.jobId)
        const replaceItem = replaceSnapshot?.items.find((item) => item.trackId === replaceId)
        if (!replaceItem) throw new Error('the replace item disappeared')
        const replaced = await batchService.apply(replaceStarted.jobId, [replaceItem.id], 'replace')
        checkEqual('tag batch: replace writes the file', replaced.written, 1)
        checkEqual(
          'tag batch: replace overwrites the occupied field',
          (await extractMetadata(replaceFile)).artist,
          'New Artist'
        )
        const replaceUndo = await batchService.undo(replaceStarted.jobId)
        checkEqual('tag batch: undo of a replace restores the original', replaceUndo.restored, 1)
        checkEqual(
          'tag batch: the original artist is back after undo',
          (await extractMetadata(replaceFile)).artist,
          'Old Artist'
        )

        // The playback guard is the same one the single editor uses: a file
        // Windows has open cannot be replaced, and the row says so.
        const guardFile = await makeBatchFixture('guard.flac', { title: 'Tag Fill' })
        const guardId = insertBatchRow({ contentKey: 'smoke-tag-guard', filePath: guardFile, title: 'Tag Fill' })
        const guardStarted = batchService.start([guardId])
        const guardSnapshot = await waitForReview(guardStarted.jobId)
        const guardItem = guardSnapshot?.items.find((item) => item.trackId === guardId)
        if (!guardItem) throw new Error('the guard item disappeared')
        const guarded = await batchService.apply(guardStarted.jobId, [guardItem.id], 'fill', () => false)
        checkEqual('tag batch: a playing file is not written', guarded.written, 0)
        check(
          'tag batch: the playback guard says why',
          (guarded.failed[0]?.message ?? '').includes('open for playback')
        )

        // A file edited after the batch is the user's: undo leaves it alone.
        const laterFile = await makeBatchFixture('later.flac', { title: 'Tag Fill' })
        const laterId = insertBatchRow({ contentKey: 'smoke-tag-later', filePath: laterFile, title: 'Tag Fill' })
        const laterStarted = batchService.start([laterId])
        const laterSnapshot = await waitForReview(laterStarted.jobId)
        const laterItem = laterSnapshot?.items.find((item) => item.trackId === laterId)
        if (!laterItem) throw new Error('the later item disappeared')
        await batchService.apply(laterStarted.jobId, [laterItem.id], 'fill')
        await batchWriter.write(laterFile, { artist: 'User Edit' })
        const laterUndo = await batchService.undo(laterStarted.jobId)
        checkEqual(
          'tag batch: undo leaves a file edited after the batch alone',
          [laterUndo.restored, laterUndo.skipped].join('|'),
          '0|1'
        )
        checkEqual(
          'tag batch: the later edit survives',
          (await extractMetadata(laterFile)).artist,
          'User Edit'
        )

        // Cancelling stops before the next track and leaves no review behind.
        const slowLookup: TagLookup = {
          lookupFingerprint: async (query) => ({
            query,
            candidates: [],
            providers: [{ provider: 'acoustid', ok: true, message: null, count: 0 }]
          }),
          lookup: (query) =>
            new Promise((resolve) =>
              setTimeout(
                () =>
                  resolve({
                    query,
                    candidates: [],
                    providers: [{ provider: 'itunes', ok: true, message: null, count: 0 }]
                  }),
                50
              )
            )
        }
        const slowService = new TagBatchService({
          repo: batchRepo,
          library: batchLibrary,
          tagLookup: slowLookup,
          log: silentLogger,
          onProgress: () => undefined
        })
        const slowStarted = slowService.start([fillId, sameId])
        slowService.cancel(slowStarted.jobId)
        await new Promise((resolve) => setTimeout(resolve, 250))
        checkEqual('tag batch: a cancelled scan has no review', slowService.get(slowStarted.jobId), null)
      } finally {
        batchDb.close()
      }
    } finally {
      await rm(tagBatchRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  // ---- deferred writes ----------------------------------------------------
  // A file open for playback cannot be replaced, so tag and lyric writes aimed
  // at it are queued instead of refused. The queue is pure, so its rules are
  // pinned down here rather than through a window.
  {
    const notices: PendingWriteNotice[] = []
    // The failure report waits out a grace period, so the clock is driven here
    // rather than the suite sleeping through it.
    const clock = { now: 1_000_000 }
    const queue = new PendingWrites({
      log: silentLogger,
      now: () => clock.now,
      onResult: (notice) => notices.push(notice)
    })

    // Last write wins: the second edit already contains the first, and writing
    // both would rewrite the same file twice.
    const order: string[] = []
    queue.enqueue(1, 'tags', async () => order.push('first'))
    queue.enqueue(1, 'tags', async () => order.push('second'))
    checkEqual('deferred writes: one entry per track and kind', queue.size, 1)
    const firstFlush = await queue.flush(() => false)
    checkEqual('deferred writes: a successful flush runs the write', order.join(','), 'second')
    checkEqual('deferred writes: a successful flush empties the queue', queue.size, 0)
    checkEqual(
      'deferred writes: a success is reported once',
      [firstFlush.written, notices.filter((notice) => notice.ok).length].join('|'),
      '1|1'
    )

    // Tags and lyrics for the same track are different writes and must not
    // replace one another.
    queue.enqueue(2, 'tags', async () => undefined)
    queue.enqueue(2, 'lyrics', async () => undefined)
    checkEqual('deferred writes: tags and lyrics are separate entries', queue.size, 2)
    await queue.flush(() => false)
    checkEqual('deferred writes: both kinds drain together', queue.size, 0)

    // A file that is still open stays queued, and the write is not attempted.
    let busyAttempts = 0
    queue.enqueue(3, 'tags', async () => {
      busyAttempts += 1
    })
    const busy = await queue.flush((trackId) => trackId === 3)
    checkEqual('deferred writes: a playing file is not written', busy.written, 0)
    checkEqual('deferred writes: a playing file stays queued', queue.size, 1)
    checkEqual('deferred writes: a playing file is not even attempted', busyAttempts, 0)

    // Once playback moves on, the same entry runs.
    const resumed = await queue.flush(() => false)
    checkEqual('deferred writes: the entry runs after playback', resumed.written, 1)
    checkEqual('deferred writes: the entry leaves the queue', queue.size, 0)

    // A write that fails because the file is still held is retried inside the
    // same drain: stopping playback is the moment the file becomes writable, and
    // waiting for some later state change could take hours.
    let failOnce = true
    let transientAttempts = 0
    queue.enqueue(4, 'lyrics', async () => {
      transientAttempts += 1
      if (failOnce) {
        failOnce = false
        throw new Error('the file is still open')
      }
    })
    const recovered = await queue.flush(() => false)
    checkEqual('deferred writes: a transient failure is retried at once', transientAttempts, 2)
    checkEqual('deferred writes: the retry counts as written', recovered.written, 1)
    checkEqual('deferred writes: a recovered write is not failed', recovered.failed, 0)
    checkEqual('deferred writes: a recovered write leaves the queue', queue.size, 0)
    checkEqual(
      'deferred writes: a transient failure is not reported',
      notices.filter((notice) => !notice.ok).length,
      0
    )

    // A write queued while a flush is running belongs to the newer edit; the
    // finishing entry must not delete it.
    let queuedDuringFlush = false
    queue.enqueue(5, 'tags', async () => {
      queue.enqueue(5, 'tags', async () => {
        queuedDuringFlush = true
      })
    })
    await queue.flush(() => false)
    checkEqual('deferred writes: a newer entry survives the flush', queue.size, 1)
    await queue.flush(() => false)
    checkEqual('deferred writes: the newer entry then runs', queuedDuringFlush, true)

    // A state change that arrives while a pass is running earns another pass.
    // The running pass read the queue before that change, so without the rerun
    // the freed write would wait for an unrelated event.
    let openGate = (): void => undefined
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    let joinedRan = false
    queue.enqueue(7, 'tags', () => gate)
    const firstPass = queue.flush(() => false)
    queue.enqueue(7, 'lyrics', async () => {
      joinedRan = true
    })
    const joinedPass = queue.flush(() => false)
    checkEqual(
      'deferred writes: a flush during a pass joins the running one',
      joinedPass === firstPass,
      true
    )
    openGate()
    await Promise.all([firstPass, joinedPass])
    checkEqual('deferred writes: a write queued during a pass runs in that drain', joinedRan, true)
    checkEqual('deferred writes: the joined flush empties the queue', queue.size, 0)

    // A permanent failure is retried a few times inside one drain. It is not
    // announced straight away: a locked file is the case the queue exists for,
    // and a banner moments after stopping would be noise. After the grace
    // period it is reported once, and it stays queued.
    notices.length = 0
    let permanentAttempts = 0
    queue.enqueue(6, 'tags', async () => {
      permanentAttempts += 1
      throw new Error('permission denied')
    })
    const permanent = await queue.flush(() => false)
    checkEqual('deferred writes: a permanent failure is tried a few times', permanentAttempts, 4)
    checkEqual(
      'deferred writes: a failure inside the grace period is not announced',
      notices.filter((notice) => !notice.ok).length,
      0
    )
    clock.now += 20_000
    await queue.flush(() => false)
    const reported = notices.filter((notice) => !notice.ok)
    checkEqual('deferred writes: a lasting failure is reported once', reported.length, 1)
    checkEqual(
      'deferred writes: the report names the track and reason',
      `${reported[0]?.trackId}|${reported[0]?.kind}|${reported[0]?.message}`,
      '6|tags|permission denied'
    )
    checkEqual('deferred writes: a permanent failure stays queued', queue.size, 1)
    checkEqual('deferred writes: the drain reports what is left', permanent.failed, 1)
    await queue.flush(() => false)
    checkEqual(
      'deferred writes: a reported failure is not reported again',
      notices.filter((notice) => !notice.ok).length,
      1
    )

    // A second save while the first is still queued must not drop a field the
    // first one touched: both patches are measured against the same unchanged
    // row, so only the merge knows about both edits.
    const firstTagSave = mergeDeferredTagWrite(undefined, {
      fields: { genre: 'Deferred Genre' },
      artwork: undefined
    })
    const secondTagSave = mergeDeferredTagWrite(firstTagSave, {
      fields: { year: 2000 },
      artwork: undefined
    })
    checkEqual(
      'deferred writes: a later tag save keeps a field the earlier one touched',
      `${secondTagSave.fields.genre}|${secondTagSave.fields.year}`,
      'Deferred Genre|2000'
    )
    const replaced = mergeDeferredTagWrite(secondTagSave, {
      fields: { genre: 'Replaced Genre' },
      artwork: undefined
    })
    checkEqual(
      'deferred writes: a later tag save wins for the field it changes',
      replaced.fields.genre,
      'Replaced Genre'
    )
    const cleared = mergeDeferredTagWrite(replaced, {
      fields: { genre: null },
      artwork: undefined
    })
    checkEqual(
      'deferred writes: a later blank is an explicit clear, not a dropped edit',
      `${String(cleared.fields.genre)}|${cleared.fields.year}`,
      'null|2000'
    )

    // The cover is part of the same queued write, and follows the same rule.
    const cover = { image: { data: new Uint8Array([1, 2, 3]), mime: 'image/png' }, key: 'one' }
    const coverSave = mergeDeferredTagWrite(undefined, { fields: {}, artwork: cover })
    const noCoverChange = mergeDeferredTagWrite(coverSave, {
      fields: { genre: 'Deferred Genre' },
      artwork: undefined
    })
    checkEqual(
      'deferred writes: a later tag save keeps the cover the earlier one chose',
      noCoverChange.artwork?.key,
      'one'
    )
    const removedCover = mergeDeferredTagWrite(noCoverChange, {
      fields: {},
      artwork: { image: null, key: '' }
    })
    checkEqual(
      'deferred writes: a later cover removal wins',
      `${removedCover.artwork?.key}|${String(removedCover.artwork?.image)}`,
      '|null'
    )
  }

  // The scale budgets are a pure decision, so they are held to their edges here
  // rather than by building a 10,000-file library in the smoke test. `npm run
  // perf` is what measures the real numbers; this is what proves the gate says
  // no when it should.
  const scaleSummary = (patch: Partial<ScaleSummary>): ScaleSummary => ({
    tracks: 10_000,
    copyMs: 0,
    scanMs: 1_000,
    rescanMs: 500,
    pageMs: 10,
    searchMs: 5,
    databaseBytes: 8 * 1024 * 1024,
    rssBytes: 200 * 1024 * 1024,
    ...patch
  })
  const scaleReport = (summary: ScaleSummary): { failures: number; lines: string[] } => {
    const lines: string[] = []
    return { failures: checkScaleBudgets(summary, (line) => lines.push(line)), lines }
  }

  const healthyScale = scaleReport(scaleSummary({}))
  checkEqual('scale: a library inside every budget passes', healthyScale.failures, 0)
  check(
    'scale: a passing run ends on one line',
    healthyScale.lines.length === 1 && (healthyScale.lines[0]?.includes('core budgets: met') ?? false),
    healthyScale.lines.join(' | ')
  )

  const atTheEdge = scaleReport(scaleSummary({ searchMs: SEARCH_BUDGET_MS }))
  checkEqual('scale: a measurement exactly on its budget passes', atTheEdge.failures, 0)

  const overSearch = scaleReport(scaleSummary({ searchMs: SEARCH_BUDGET_MS + 1 }))
  checkEqual('scale: one millisecond over the search budget fails', overSearch.failures, 1)
  check(
    'scale: the miss names the metric, the number and the budget',
    overSearch.lines.some(
      (line) =>
        line.includes('core search') &&
        line.includes(`${SEARCH_BUDGET_MS + 1} ms`) &&
        line.includes(`budget ${SEARCH_BUDGET_MS} ms`) &&
        line.includes('MISSED')
    ),
    overSearch.lines.join(' | ')
  )

  const everythingOver = scaleReport(
    scaleSummary({
      scanMs: SCAN_BUDGET_MS + 1,
      rescanMs: RESCAN_BUDGET_MS + 1,
      pageMs: PAGE_BUDGET_MS + 1,
      searchMs: SEARCH_BUDGET_MS + 1,
      databaseBytes: DATABASE_BUDGET_BYTES + 1,
      rssBytes: RSS_BUDGET_BYTES + 1
    })
  )
  checkEqual('scale: every budget is checked, not just the first', everythingOver.failures, 6)

  const overDatabase = scaleReport(scaleSummary({ databaseBytes: DATABASE_BUDGET_BYTES * 2 }))
  check(
    'scale: a byte budget is reported in megabytes',
    overDatabase.lines.some((line) => line.includes('core database') && line.includes('MB')),
    overDatabase.lines.join(' | ')
  )

  // --- M8: fetch-on-first-use sidecars ------------------------------------
  {
    const engineRoot = await mkdtemp(join(tmpdir(), 'player-sidecars-'))

    // Every table is checked, not just the one this machine will download: a
    // wrong digest on the Linux row is a release failure that a Windows CI run
    // would otherwise never see.
    for (const [platform, assets] of Object.entries(sidecarAssetsByPlatform())) {
      const ids = new Set(assets.map((asset) => asset.id))
      checkEqual(`sidecar: ${platform} ids appear once`, ids.size, assets.length)
      check(
        `sidecar: ${platform} digests are lower-case SHA-256`,
        assets.every((asset) => /^[0-9a-f]{64}$/.test(asset.sha256)),
        assets.map((asset) => `${asset.id}=${asset.sha256}`).join(' ')
      )
      check(
        `sidecar: ${platform} sizes are positive`,
        assets.every((asset) => Number.isSafeInteger(asset.bytes) && asset.bytes > 0)
      )
      check(
        `sidecar: ${platform} URLs are immutable https releases`,
        assets.every(
          (asset) => asset.url.startsWith('https://') && asset.url.includes('/releases/download/')
        ),
        assets.map((asset) => asset.url).join(' ')
      )
      check(
        `sidecar: ${platform} zip assets name the exact member`,
        assets.every((asset) => asset.kind !== 'zip' || Boolean(asset.entry))
      )
      check(
        `sidecar: ${platform} optional assets are only fpcalc`,
        assets.filter((asset) => asset.optional).every((asset) => asset.id === 'fpcalc')
      )
      check(
        `sidecar: ${platform} ships yt-dlp and ffmpeg`,
        assets.some((asset) => asset.id === 'yt-dlp') && assets.some((asset) => asset.id === 'ffmpeg')
      )
    }
    checkEqual(
      'sidecar: only fpcalc is optional',
      SIDECAR_ASSETS.filter((asset) => asset.optional)
        .map((asset) => asset.id)
        .join(','),
      process.platform === 'win32' ? 'fpcalc' : ''
    )
    check('sidecar: this build uses its platform table', assetsForPlatform(process.platform) === SIDECAR_ASSETS)
    checkEqual('sidecar: lookup by id returns its row', sidecarAsset('yt-dlp').id, 'yt-dlp')
    let unknownSidecar = ''
    try {
      sidecarAsset('nope' as SidecarId)
    } catch (error) {
      unknownSidecar = error instanceof Error ? error.message : String(error)
    }
    check('sidecar: an unknown id is refused', unknownSidecar.includes('No sidecar'), unknownSidecar)

    // The archive reader.
    const memberZip = buildZip([
      { name: 'folder/', data: Buffer.alloc(0), method: 0 },
      { name: 'folder/fpcalc.exe', data: Buffer.from('fake-binary') }
    ])
    check(
      'sidecar: a deflated archive member is extracted',
      readZipEntry(memberZip, 'folder/fpcalc.exe').toString() === 'fake-binary'
    )
    check(
      'sidecar: a stored archive member is extracted',
      readZipEntry(buildZip([{ name: 'a.exe', data: Buffer.from('plain'), method: 0 }]), 'a.exe').toString() ===
        'plain'
    )
    check('sidecar: a safe nested member name is accepted', isSafeEntryName('vendor-1.6.2/fpcalc.exe'))
    check('sidecar: a traversal member name is refused', !isSafeEntryName('../evil.exe'))
    check('sidecar: an absolute member name is refused', !isSafeEntryName('/etc/passwd'))
    check('sidecar: a drive-qualified member name is refused', !isSafeEntryName('C:/Windows/evil.exe'))
    check('sidecar: a backslash member name is refused', !isSafeEntryName('folder\\evil.exe'))
    check('sidecar: an empty member name is refused', !isSafeEntryName(''))

    let traversal = ''
    try {
      readZipEntry(memberZip, '../evil.exe')
    } catch (error) {
      traversal = error instanceof Error ? error.message : String(error)
    }
    check('sidecar: extracting outside the folder is refused', traversal.includes('unsafe'), traversal)

    let missingMember = ''
    try {
      readZipEntry(memberZip, 'folder/missing.exe')
    } catch (error) {
      missingMember = error instanceof Error ? error.message : String(error)
    }
    check(
      'sidecar: a member that is not in the archive is refused',
      missingMember.includes('does not contain'),
      missingMember
    )

    // A local server stands in for GitHub: the installer only cares about bytes.
    const payload = Buffer.from('pinned-sidecar-bytes-'.repeat(64))
    const payloadDigest = createHash('sha256').update(payload).digest('hex')
    const zipPayload = Buffer.from('fpcalc-binary')
    const zipBuffer = buildZip([{ name: 'chromaprint-fpcalc-test/fpcalc.exe', data: zipPayload }])
    const zipDigest = createHash('sha256').update(zipBuffer).digest('hex')
    let fileRequests = 0

    const server = createServer((request, response) => {
      switch (request.url) {
        case '/file':
          fileRequests += 1
          response.writeHead(200, { 'content-length': payload.length })
          response.end(payload)
          return
        case '/wrong':
          response.writeHead(200, { 'content-length': payload.length })
          response.end(Buffer.from(payload).fill(9))
          return
        case '/short':
          response.writeHead(200, { 'content-length': 4 })
          response.end(payload.subarray(0, 4))
          return
        case '/oversize':
          response.writeHead(200, { 'content-length': payload.length })
          response.end(payload)
          return
        case '/zip':
          response.writeHead(200, { 'content-length': zipBuffer.length })
          response.end(zipBuffer)
          return
        case '/slow':
          response.writeHead(200, { 'content-length': payload.length * 100 })
          response.write(payload.subarray(0, 16))
          return
        default:
          response.writeHead(404, { 'content-type': 'text/plain' })
          response.end('missing')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const base = `http://127.0.0.1:${port}`

    const asset = (patch: Partial<SidecarAsset> & Pick<SidecarAsset, 'url'>): SidecarAsset => ({
      id: 'fpcalc',
      version: 'test-1',
      sha256: payloadDigest,
      bytes: payload.length,
      file: 'fpcalc.exe',
      kind: 'file',
      license: 'test-only',
      ...patch
    })

    try {
      // A successful install, with progress and a record.
      const okDir = join(engineRoot, 'ok')
      const progress: SidecarProgress[] = []
      const first = await installAsset(asset({ url: `${base}/file` }), {
        dir: okDir,
        log: silentLogger,
        onProgress: (event) => progress.push(event)
      })
      check('sidecar: a valid download installs', first.installed)
      checkEqual('sidecar: the installed file has the pinned bytes', (await readFile(join(okDir, 'fpcalc.exe'))).length, payload.length)
      checkEqual('sidecar: the last progress event reports the whole file', progress.at(-1)?.receivedBytes, payload.length)
      checkEqual('sidecar: progress names the asset', progress.at(-1)?.id, 'fpcalc')
      const states = await sidecarStates(okDir, [asset({ url: `${base}/file` })])
      check('sidecar: the record makes the file current', states[0]?.installed === true)

      // A second press is harmless and makes no request.
      const second = await installAsset(asset({ url: `${base}/file` }), { dir: okDir, log: silentLogger })
      check('sidecar: a current file is not installed again', !second.installed)
      checkEqual('sidecar: a current file is not downloaded again', fileRequests, 1)

      // Forced re-install does download again.
      const third = await installAsset(asset({ url: `${base}/file` }), {
        dir: okDir,
        log: silentLogger,
        force: true
      })
      check('sidecar: a forced install replaces the file', third.installed)
      checkEqual('sidecar: a forced install makes a request', fileRequests, 2)

      // A digest mismatch is discarded.
      const wrongDir = join(engineRoot, 'wrong')
      let wrongMessage = ''
      try {
        await installAsset(asset({ url: `${base}/wrong` }), { dir: wrongDir, log: silentLogger })
      } catch (error) {
        wrongMessage = error instanceof Error ? error.message : String(error)
      }
      check('sidecar: a wrong checksum is refused', wrongMessage.includes('checksum'), wrongMessage)
      check('sidecar: a refused download leaves no binary', !existsSync(join(wrongDir, 'fpcalc.exe')))
      checkEqual('sidecar: a refused download leaves no temporary file', (await readdir(wrongDir)).length, 0)

      // A truncated body fails the size check.
      const shortDir = join(engineRoot, 'short')
      let shortMessage = ''
      try {
        await installAsset(asset({ url: `${base}/short` }), { dir: shortDir, log: silentLogger })
      } catch (error) {
        shortMessage = error instanceof Error ? error.message : String(error)
      }
      check('sidecar: a short download is refused', shortMessage.includes('checksum'), shortMessage)

      // A body larger than the pinned size is stopped early.
      const overDir = join(engineRoot, 'over')
      let overMessage = ''
      try {
        await installAsset(asset({ url: `${base}/oversize`, bytes: payload.length - 1 }), {
          dir: overDir,
          log: silentLogger
        })
      } catch (error) {
        overMessage = error instanceof Error ? error.message : String(error)
      }
      check('sidecar: an oversized download is refused', overMessage.includes('larger than'), overMessage)

      // A 404 says what happened instead of failing silently.
      const missingDir = join(engineRoot, 'missing')
      let missingMessage = ''
      try {
        await installAsset(asset({ url: `${base}/nope` }), { dir: missingDir, log: silentLogger })
      } catch (error) {
        missingMessage = error instanceof Error ? error.message : String(error)
      }
      check('sidecar: an unreachable release names the HTTP status', missingMessage.includes('HTTP 404'), missingMessage)

      // A zip asset becomes the member it names.
      const zipDir = join(engineRoot, 'zip')
      const zipAsset = asset({
        url: `${base}/zip`,
        sha256: zipDigest,
        bytes: zipBuffer.length,
        kind: 'zip',
        entry: 'chromaprint-fpcalc-test/fpcalc.exe'
      })
      const zipResult = await installAsset(zipAsset, { dir: zipDir, log: silentLogger })
      check('sidecar: a zip asset installs', zipResult.installed)
      check(
        'sidecar: the zip member is the installed binary',
        (await readFile(join(zipDir, 'fpcalc.exe'))).toString() === zipPayload.toString()
      )
      const zipStates = await sidecarStates(zipDir, [zipAsset])
      check('sidecar: a zip asset is current after install', zipStates[0]?.installed === true)
      checkEqual('sidecar: a current zip names the engine folder', zipStates[0]?.source, 'managed')
      const zipAgain = await installAsset(zipAsset, { dir: zipDir, log: silentLogger })
      check('sidecar: a current zip asset is not installed again', !zipAgain.installed)

      // A record written by the build that compared the extracted file with the
      // archive's size must not force a second download.
      await writeFile(
        join(zipDir, 'install-record.json'),
        JSON.stringify({
          version: 1,
          files: {
            fpcalc: {
              version: 'test-1',
              sha256: zipDigest,
              bytes: zipBuffer.length,
              installedAt: 1
            }
          }
        }),
        'utf8'
      )
      const legacyZipStates = await sidecarStates(zipDir, [zipAsset])
      check('sidecar: a legacy zip record still counts as current', legacyZipStates[0]?.installed === true)

      // A binary outside the engine folder is usable, so Settings must not call
      // it missing just because the app-managed copy was never downloaded.
      const externalDir = join(engineRoot, 'external')
      await mkdir(externalDir, { recursive: true })
      await writeFile(join(externalDir, 'yt-dlp.exe'), 'external-yt-dlp', 'utf8')
      const externalAsset = asset({
        id: 'yt-dlp',
        file: 'yt-dlp.exe',
        url: `${base}/file`
      })
      const originalPath = process.env.PATH
      process.env.PATH = ''
      try {
        const externalStates = await sidecarStates(join(engineRoot, 'empty'), [externalAsset], {
          extraDirs: [externalDir]
        })
        check('sidecar: a binary outside the engine folder is available', externalStates[0]?.available === true)
        checkEqual('sidecar: the external source is named', externalStates[0]?.source, 'well-known')
      } finally {
        process.env.PATH = originalPath
      }

      // Cancel stops the transfer and cleans up.
      const cancelDir = join(engineRoot, 'cancel')
      const controller = new AbortController()
      let cancelError = ''
      try {
        await installAsset(asset({ url: `${base}/slow` }), {
          dir: cancelDir,
          log: silentLogger,
          signal: controller.signal,
          onProgress: () => controller.abort()
        })
      } catch (error) {
        cancelError = error instanceof Error ? error.message : String(error)
      }
      check('sidecar: a cancelled download rejects', cancelError.length > 0)
      check('sidecar: a cancelled download leaves no binary', !existsSync(join(cancelDir, 'fpcalc.exe')))
      checkEqual('sidecar: a cancelled download removes its partial file', (await readdir(cancelDir)).length, 0)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(engineRoot, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  // --- M8: yt-dlp last-known-good rollback --------------------------------
  {
    const root = await mkdtemp(join(tmpdir(), 'player-rollback-'))
    try {
      const dir = join(root, 'engine')
      await mkdir(dir, { recursive: true })
      const binaryName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'
      const target = join(dir, binaryName)
      await writeFile(target, 'version-1')

      check('rollback: no fallback exists before an update', !(await ytDlpRollbackStatus(dir)).available)

      await saveLastKnownGood(dir, target, '2026.10.26', () => 1_000)
      const saved = await ytDlpRollbackStatus(dir)
      check('rollback: saving makes a fallback available', saved.available)
      checkEqual('rollback: the saved version is reported', saved.version, '2026.10.26')
      checkEqual('rollback: the saved time is reported', saved.savedAt, 1_000)
      check('rollback: the managed binary is recognised', isManagedBinary(dir, target))
      check('rollback: a PATH binary is not managed', !isManagedBinary(dir, join(root, 'other', binaryName)))

      // Simulate an update that replaced the binary with something that cannot start.
      await writeFile(target, 'broken')
      const restored = await restoreLastKnownGood(dir, target, () => 2_000)
      check('rollback: the previous binary is restored', restored.restored)
      checkEqual('rollback: the restored bytes are the saved ones', (await readFile(target)).toString(), 'version-1')
      const afterRestore = await ytDlpRollbackStatus(dir)
      check('rollback: a restore consumes the fallback', !afterRestore.available)
      checkEqual('rollback: the restore time is recorded', afterRestore.lastRestoredAt, 2_000)

      const again = await restoreLastKnownGood(dir, target)
      check('rollback: restoring twice does nothing', !again.restored)

      // A fresh engine download clears the fallback.
      await saveLastKnownGood(dir, target, '2026.11.01', () => 3_000)
      checkEqual('rollback: a new save replaces the fallback', (await ytDlpRollbackStatus(dir)).version, '2026.11.01')
      await clearLastKnownGood(dir)
      check('rollback: a fresh install clears the fallback', !(await ytDlpRollbackStatus(dir)).available)
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  const passed = results.length - failed
  console.log(`\n${passed}/${results.length} checks passed`)
  if (failed > 0) {
    console.log(`${failed} FAILED`)
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  console.error('\nSmoke test crashed:')
  console.error(error)
  process.exitCode = 1
})
