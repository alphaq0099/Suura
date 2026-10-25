/**
 * Smoke test for everything that does not need a window.
 *
 * Run with `npm run smoke`. It builds a throwaway library in the temp folder
 * using ffmpeg, indexes it twice, searches it, resolves a playable URL and then
 * deletes a file to prove that pruning works. This is the check that a UI-only
 * test could never give you: that the core is correct on real files.
 */
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { promisify } from 'node:util'

import {
  ACCENT_CHOICES,
  DENSITY_CHOICES,
  DENSITY_ROW_HEIGHT,
  DEFAULT_APPEARANCE,
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
import { serializeDetails, silentLogger } from '@core/logging/logger'
import {
  DIAGNOSTICS_SUMMARY_LIMIT,
  buildDiagnosticsBundle,
  readLogTail,
  sanitizeDiagnosticsSummary,
  writeDiagnosticsFile
} from '../src/main/diagnostics'
import { resolveAppPaths, ensureAppDirectories } from '@core/paths'
import { DEFAULT_SETTINGS, mergeSettings, normalizeRetention, SettingsService } from '@core/settings/settings-service'
import { DatabaseSchemaTooNewError, latestVersion, openLibraryDatabase } from '@core/db/database'
import {
  applyPendingRestore,
  createBackupBundle,
  createDatabaseBackup,
  ensureDailyBackup,
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
import { PlayStateRepository } from '@core/library/play-state-repository'
import { PlaybackService } from '@core/library/playback-service'
import { isPathInside, localContentKey, normalizePath } from '@core/library/content-key'
import { scanLibraryFolders } from '@core/library/scanner'
import { youtubeOriginOf, youtubeOriginOfNative } from '@core/library/metadata'
import { artworkKeyFor, extractArtwork, extensionForMime } from '@core/library/artwork'
import { LocalFileResolver } from '@engine/local-file-resolver'
import { parseEbur128Summary } from '@engine/replay-gain'
import { getEngineStatus } from '@engine/sidecar/engine-status'
import { RequestScheduler } from '@engine/sidecar/request-scheduler'
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
  normalizePoTokenProviderUrl,
  parseYouTubeLink,
  withBrowserCookies,
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
import { sanitizeFilePart, savePathParts } from '@shared/files'
import { AsyncTtlCache } from '../src/main/async-cache'
import { cleanupAbandonedDownloads, DownloadService } from '../src/main/download-service'
import { ReplayGainService } from '../src/main/replay-gain-service'

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

async function main(): Promise<void> {
  console.log('Player core smoke test\n')

  // Exercises the sidecar locator/version probe that the engine layer will use.
  const engine = await getEngineStatus({
    binDir: null,
    autoUpdate: false,
    lastUpdateCheckAt: null,
    downloadConcurrency: 1,
    cookiesFromBrowser: null,
    cookieBrowserProfile: null,
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
    if (toneA) {
      library.reportPlayback(toneA.id, 1000, false)
      checkEqual('a skipped listen is not counted as played', repo.getById(toneA.id)?.playCount ?? -1, 0)
      library.reportPlayback(toneA.id, 1000, true)
      checkEqual('a completed listen increments the play count', repo.getById(toneA.id)?.playCount ?? -1, 1)
      library.reportPlayback(toneA.id, 31_000, false)
      checkEqual('listening past the threshold counts as played', repo.getById(toneA.id)?.playCount ?? -1, 2)
      check('the last-played timestamp was recorded', Boolean(repo.getById(toneA.id)?.lastPlayedAt))
    }

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
    check('an unrelated JSON file is not mistaken for a playlist', foreignJson.includes('not a Player playlist'), foreignJson)

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
    const backupDirectory = nextBackupDirectory(join(root, 'manual-backups'), 'Player backup', new Date('2026-10-20T12:00:00Z'))
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

      // `clear` removes everything, pinned included.
      await cache.warm('dQw4w9WgXcQ', source('/ok'))
      cache.setPinned('dQw4w9WgXcQ', true)
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
    check('youtube: the bot-check classifier is shared', isYouTubeBotCheck('ERROR: Sign in to confirm you are not a bot'))
    check(
      'youtube: a failed cookie read is not mistaken for a bot check',
      !isYouTubeBotCheck('ERROR: could not find chrome cookies database')
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
    check('settings: closing the window quits by default', !DEFAULT_SETTINGS.desktop.closeToTray)
    check('settings: browser cookies are off by default', DEFAULT_SETTINGS.engine.cookiesFromBrowser === null)
    checkEqual('settings: cookie fallback is off by default', DEFAULT_SETTINGS.engine.cookieFallback, 'off')
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
    checkEqual('appearance: a player-artwork patch deep-merges', appearanceSettings.visuals.playerArtwork, false)
    const resetAppearance = mergeSettings(appearanceSettings, DEFAULT_APPEARANCE)
    checkEqual('appearance: reset restores the default theme', resetAppearance.theme, 'dark')
    checkEqual('appearance: reset restores the default accent', resetAppearance.visuals.accent, 'blue')

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
    const diagnosticsLog = join(diagnosticsDir, 'player.log')
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
      summary: 'Player 1.2.3\r\nOS Windows',
      logPath: diagnosticsLog,
      log: tail,
      generatedAt: new Date('2026-10-25T00:00:00Z')
    })
    check(
      'diagnostics: the bundle carries the summary, log path and timestamp',
      diagnosticsBundle.includes('Player 1.2.3\nOS Windows') &&
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
      summary: 'Player 1.2.3\nOS Windows',
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
