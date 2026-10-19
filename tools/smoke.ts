/**
 * Smoke test for everything that does not need a window.
 *
 * Run with `npm run smoke`. It builds a throwaway library in the temp folder
 * using ffmpeg, indexes it twice, searches it, resolves a playable URL and then
 * deletes a file to prove that pruning works. This is the check that a UI-only
 * test could never give you: that the core is correct on real files.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, unlink, utimes, writeFile } from 'node:fs/promises'
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
import { PlayStateRepository } from '@core/library/play-state-repository'
import { PlaybackService } from '@core/library/playback-service'
import { isPathInside, localContentKey, normalizePath } from '@core/library/content-key'
import { artworkKeyFor, extractArtwork, extensionForMime } from '@core/library/artwork'
import { LocalFileResolver } from '@engine/local-file-resolver'
import { getEngineStatus } from '@engine/sidecar/engine-status'
import { parseMediaUrl } from '@shared/media-url'
import { buildArtworkUrl, parseArtworkUrl } from '@shared/artwork-url'
import { formatAudioSummary, formatCodec } from '@shared/format'
import { nextDecision, shuffleFrom, shuffled } from '@shared/queue'
import { parseRangeHeader } from '@shared/range'

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
  tags: { title: string; artist: string; album: string; track: number; year: number },
  frequency: number
): Promise<string> {
  const target = join(dir, fileName)
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
      '-metadata',
      `title=${tags.title}`,
      '-metadata',
      `artist=${tags.artist}`,
      '-metadata',
      `album=${tags.album}`,
      '-metadata',
      `track=${tags.track}`,
      '-metadata',
      `date=${tags.year}`,
      target
    ],
    { timeout: 60_000 }
  )
  return target
}

async function main(): Promise<void> {
  console.log('Player core smoke test\n')

  // Exercises the sidecar locator/version probe that the engine layer will use.
  const engine = await getEngineStatus({ binDir: null, autoUpdate: false, downloadConcurrency: 1, cookiesFromBrowser: null })
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

    // --- persistence ------------------------------------------------------
    database.close()
    const reopened = openLibraryDatabase(paths.database, silentLogger)
    checkEqual('database reopens at the current schema version', reopened.schemaVersion, latestVersion())
    reopened.close()
    check('the database file exists on disk', existsSync(paths.database))
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined)
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
