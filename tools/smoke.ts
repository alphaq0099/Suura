/**
 * Smoke test for everything that does not need a window.
 *
 * Run with `npm run smoke`. It builds a throwaway library in the temp folder
 * using ffmpeg, indexes it twice, searches it, resolves a playable URL and then
 * deletes a file to prove that pruning works. This is the check that a UI-only
 * test could never give you: that the core is correct on real files.
 */
import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { silentLogger } from '@core/logging/logger'
import { resolveAppPaths, ensureAppDirectories } from '@core/paths'
import { SettingsService } from '@core/settings/settings-service'
import { latestVersion, openLibraryDatabase } from '@core/db/database'
import { TrackRepository, buildFtsQuery, type ScanRunSummary } from '@core/library/track-repository'
import { LibraryService } from '@core/library/library-service'
import { FolderWatcher, isLibraryEvent, type FolderWatchEvent } from '@core/library/folder-watcher'
import { PlaylistRepository } from '@core/library/playlist-repository'
import { PlaylistService } from '@core/library/playlist-service'
import { OnlineRepository } from '@core/library/online-repository'
import { OnlinePlaylistRepository } from '@core/library/online-playlist-repository'
import { PlayStateRepository } from '@core/library/play-state-repository'
import { PlaybackService } from '@core/library/playback-service'
import { isPathInside, localContentKey, normalizePath } from '@core/library/content-key'
import { scanLibraryFolders } from '@core/library/scanner'
import { youtubeOriginOf, youtubeOriginOfNative } from '@core/library/metadata'
import { artworkKeyFor, extractArtwork, extensionForMime } from '@core/library/artwork'
import { LocalFileResolver } from '@engine/local-file-resolver'
import { getEngineStatus } from '@engine/sidecar/engine-status'
import type { YtInfoProvider, YtMediaInfo } from '@engine/sidecar/yt-dlp'
import {
  buildChannelArgs,
  buildDownloadArgs,
  buildInfoArgs,
  buildPlaylistArgs,
  buildSearchArgs,
  parseChannel,
  parsePlaylist,
  parseSearchResults
} from '@engine/sidecar/yt-dlp'
import { RemoteStreamProxy, type UpstreamMedia } from '@engine/stream-proxy'
import { ResolverRegistry } from '@engine/resolver'
import { YouTubeResolver } from '@engine/youtube-resolver'
import { PLAYLIST_INDEX_MAX, PLAYLIST_INDEX_MIN, clampPlaylistIndexWidth } from '@shared/playlists'
import { parseMediaUrl } from '@shared/media-url'
import { buildStreamUrl, parseStreamUrl } from '@shared/stream-url'
import {
  cleanYouTubeMetadata,
  describeYouTubeFailure,
  extractYouTubeVideoId,
  normalizeArtistName,
  parseYouTubeLink,
  youtubeChannelUrl,
  youtubeListTitle,
  youtubeListUrl,
  youtubeThumbnailCandidates,
  youtubeWatchUrl
} from '@shared/youtube'
import { buildArtworkUrl, parseArtworkUrl } from '@shared/artwork-url'
import { formatAudioSummary, formatCodec } from '@shared/format'
import { nextDecision, shuffleFrom, shuffled } from '@shared/queue'
import { parseRangeHeader } from '@shared/range'
import { isImportedPlaylistTrackId, onlineEntryToTrack, onlinePlaylistItemToTrack } from '@shared/online'
import { sanitizeFilePart, savePathParts } from '@shared/files'
import { cleanupAbandonedDownloads, DownloadService } from '../src/main/download-service'

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
    downloadConcurrency: 1,
    cookiesFromBrowser: null,
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
    const beforeClear = titlesOf(road.id).length
    const cleared = playlists.clear(road.id)
    checkEqual('clearing removes every entry', cleared, beforeClear)
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

    // Offline caching is deferred, so a config written by an older build (or a
    // hand edit) cannot leave the app claiming a cache that is not implemented.
    settings.update({ retention: { mode: 'cache' } })
    const rereadMode = new SettingsService(paths.config, silentLogger)
    checkEqual('offline cache is pinned off on load', rereadMode.get().retention.mode, 'stream')
    settings.update({ retention: { mode: 'stream' } })

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
    const seen: Array<{ status: string }> = []
    const cancellable = new DownloadService({
      settings,
      paths,
      repo,
      library,
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
      onChange: (progress) => seen.push(progress)
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

    // --- persistence ------------------------------------------------------
    database.close()
    const reopened = openLibraryDatabase(paths.database, silentLogger)
    checkEqual('database reopens at the current schema version', reopened.schemaVersion, latestVersion())
    reopened.close()
    check('the database file exists on disk', existsSync(paths.database))
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
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

    const tokenId = '00000000-0000-4000-8000-000000000000'
    checkEqual('stream: the URL round-trips', parseStreamUrl(buildStreamUrl(tokenId))?.token, tokenId)
    check('stream: a foreign scheme is rejected', parseStreamUrl(`player-media://stream/${tokenId}`) === null)

    const payload = Buffer.alloc(4096)
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251

    let lastUserAgent = ''
    let lastUpstreamHeader = ''
    const server = createServer((request, response) => {
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

      const media: YtMediaInfo = {
        videoId: 'dQw4w9WgXcQ',
        webpageUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'Smoke Test Video',
        artist: 'Smoke Tester',
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
