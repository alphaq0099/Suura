import { execFile } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, BrowserWindow, clipboard, net } from 'electron'
import { probeExecutable } from '@engine/sidecar/locate'
import { IPC_EVENTS } from '@shared/ipc'
import { buildMediaUrl } from '@shared/media-url'
import { buildStreamUrl } from '@shared/stream-url'
import { youtubeWatchUrl } from '@shared/youtube'
import { broadcast } from './broadcast'
import type { AppContainer } from './services/container'

const execFileAsync = promisify(execFile)

/**
 * End-to-end self-test for the thin slice, run with `npm run selftest`.
 *
 * It exists because the most important behaviour in this app is the seam that a
 * unit test cannot reach: renderer -> IPC -> resolver -> player-media:// protocol
 * -> range request -> decoded audio. A renderer that never mounts, or a protocol
 * handler that refuses every request, otherwise just shows a blank window.
 *
 * It runs against a throwaway userData directory (set up in index.ts), so it
 * never touches the real library.
 */
export async function runSelfTest(window: BrowserWindow, container: AppContainer): Promise<number> {
  const log = container.log.child('selftest')
  let failures = 0

  const record = (ok: boolean, name: string, detail?: unknown): void => {
    if (!ok) failures += 1
    const suffix = !ok && detail !== undefined ? `  <- ${describe(detail)}` : ''
    console.log(`SELFTEST ${ok ? 'PASS' : 'FAIL'}  ${name}${suffix}`)
    if (!ok) log.warn('selftest check failed', { name, detail })
  }

  const watchdog = setTimeout(() => {
    console.log('SELFTEST FAIL  test harness timed out after 90s')
    app.exit(1)
  }, 90_000)

  try {
    // Let the first render and the initial IPC round-trips settle.
    await delay(1200)

    // ---- 1. the renderer actually mounted -------------------------------
    const boot = await evaluate<{
      hasBridge: boolean
      hasReactRoot: boolean
      hasSidebar: boolean
      hasPlayerBar: boolean
      title: string
    }>(
      window,
      `(() => ({
         hasBridge: typeof window.player === 'object' && typeof window.player.listTracks === 'function',
         hasReactRoot: Boolean(document.querySelector('.app, .boot-screen')),
         hasSidebar: Boolean(document.querySelector('.sidebar')),
         hasPlayerBar: Boolean(document.querySelector('.player-bar')),
         title: document.title
       }))()`
    )
    record(boot.hasBridge, 'preload exposes the Player bridge on window.player')
    record(boot.hasReactRoot, 'React mounted a view')
    record(boot.hasSidebar, 'sidebar rendered')
    record(boot.hasPlayerBar, 'player bar rendered')
    record(boot.title === 'Player', 'document title is set', boot.title)

    // ---- 2. the engine layer can find ffmpeg ---------------------------
    const ffmpeg = await probeExecutable('ffmpeg', { versionArgs: ['-version'] })
    record(ffmpeg.found, 'ffmpeg is available to generate a fixture', ffmpeg.error)
    if (!ffmpeg.found || !ffmpeg.path) {
      return finish(failures, 'cannot continue without ffmpeg')
    }

    // ---- 3. index real files through the renderer's IPC path -----------
    // Two files on purpose: one with an embedded cover and one without, so the
    // artwork checks below can prove both the real image and the placeholder.
    const fixtureDir = join(container.paths.userData, 'selftest-media')
    await mkdir(fixtureDir, { recursive: true })
    const coverPath = join(fixtureDir, 'cover.png')
    // Deliberately 3:2 rather than square. Cover art that is not square is the
    // case the artwork-fit setting exists for, and a square fixture would make
    // "crop" and "fit" produce byte-identical frames — no test could tell them
    // apart, and neither could a screenshot.
    await execFileAsync(
      ffmpeg.path,
      ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=#3355ff:s=96x64', '-frames:v', '1', coverPath],
      { timeout: 60_000 }
    )

    const fixturePath = join(fixtureDir, 'Selftest Tone.flac')
    await execFileAsync(
      ffmpeg.path,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=3',
        '-i',
        coverPath,
        '-map',
        '0:a',
        '-map',
        '1:v',
        '-c:a',
        'flac',
        '-c:v',
        'copy',
        '-disposition:v',
        'attached_pic',
        '-metadata',
        'title=Selftest Tone',
        '-metadata',
        'artist=Selftest',
        '-metadata',
        'album=Selftest Album',
        fixturePath
      ],
      { timeout: 60_000 }
    )

    const plainPath = join(fixtureDir, 'Selftest Silent.flac')
    await execFileAsync(
      ffmpeg.path,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=660:duration=2',
        '-c:a',
        'flac',
        '-metadata',
        'title=Selftest Silent',
        // A distinct artist keeps this row below the covered one in the default
        // artist/album/track order, so the click test still lands on "Tone".
        '-metadata',
        'artist=Zzz Uncovered',
        '-metadata',
        'album=Selftest Album',
        plainPath
      ],
      { timeout: 60_000 }
    )

    const fixtureSize = (await stat(fixturePath)).size
    record(fixtureSize > 0, 'fixture was generated', fixtureSize)

    const scanStats = await evaluate<{ tracks: number } | null>(
      window,
      `(async () => await window.player.scanLibrary(${JSON.stringify(fixtureDir)}))()`
    )
    record(scanStats?.tracks === 2, 'scan through the IPC bridge indexed the fixtures', scanStats)

    // ---- 4. the UI click path ------------------------------------------
    // Clicking a row is the actual user interaction: React onClick/onDoubleClick
    // -> playQueue -> resolveSource -> <audio>. A single click selects (so the
    // selection model is usable), a double click plays.
    const click = await evaluate<{
      clicked: boolean
      selected: boolean
      playedOnSingleClick: boolean
      reason: string | null
      hasCurrentRow: boolean
      title: string
      isPlaying: boolean
    }>(
      window,
      `(async () => {
         const out = { clicked: false, selected: false, playedOnSingleClick: false, reason: null, hasCurrentRow: false, title: '', isPlaying: false }
         const waitFor = async (select, timeout) => {
           const deadline = Date.now() + timeout
           for (;;) {
             const found = document.querySelector(select)
             if (found) return found
             if (Date.now() > deadline) return null
             await new Promise((r) => setTimeout(r, 100))
           }
         }

         const row = await waitFor('.track-row', 8000)
         if (!row) { out.reason = 'no track row rendered'; return out }

         row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await new Promise((r) => setTimeout(r, 200))
         out.selected = Boolean(document.querySelector('.track-row.selected'))
         out.playedOnSingleClick = Boolean(document.querySelector('.track-row.current'))

         row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
         out.clicked = true

         const current = await waitFor('.track-row.current', 8000)
         out.hasCurrentRow = Boolean(current)
         const titleEl = document.querySelector('.player-title')
         out.title = titleEl ? titleEl.textContent : ''
         // The transport button's tooltip flips to "Pause" once audio is playing.
         const button = document.querySelector('.player-bar .icon-button.primary')
         out.isPlaying = Boolean(button) && button.getAttribute('title') === 'Pause'
         return out
       })()`
    )
    record(click.clicked, 'a library row rendered and accepted a click', click.reason)
    record(click.selected, 'a single click selects a row')
    record(!click.playedOnSingleClick, 'a single click does not start playback')
    record(click.hasCurrentRow, 'a double click plays the row')
    record(click.title === 'Selftest Tone', 'the player bar shows the clicked track', click.title)
    record(click.isPlaying, 'the player switched to its playing state', click.title)

    // ---- 5. playback through the custom protocol ----------------------
    const playback = await evaluate<{
      played: boolean
      duration: number
      seeked: boolean
      seekTime: number
      mimeType: string | null
      resolverId: string
      error: string | null
    }>(
      window,
      `(async () => {
         const out = { played: false, duration: 0, seeked: false, seekTime: 0, mimeType: null, resolverId: '', error: null }
         try {
           const tracks = await window.player.listTracks({ limit: 5 })
           if (!tracks.tracks.length) { out.error = 'no tracks in the library'; return out }
           const track = tracks.tracks[0]
           const source = await window.player.resolveSource({
             id: track.id,
             sourceKind: track.sourceKind,
             sourceId: track.sourceId,
             filePath: track.filePath
           })
           out.mimeType = source.mimeType
           out.resolverId = source.resolverId

           const audio = new Audio(source.url)
           audio.preload = 'auto'
           await audio.play()
           await new Promise((resolve, reject) => {
             const timer = setTimeout(() => reject(new Error('playback did not start')), 8000)
             const tick = () => {
               if (audio.currentTime > 0.05) { clearTimeout(timer); resolve() }
             }
             audio.addEventListener('timeupdate', tick)
             tick()
           })
           out.played = true
           out.duration = audio.duration

           // Seeking is the observable proof that range requests work: without
           // byte ranges Chromium can only replay from the start. Pause first so
           // playback cannot advance past the target and mask the result, and
           // wait for the seeked event rather than guessing a delay.
           audio.pause()
           audio.currentTime = 1.5
           await new Promise((resolve) => {
             const timer = setTimeout(resolve, 3000)
             audio.addEventListener('seeked', () => { clearTimeout(timer); resolve() }, { once: true })
           })
           out.seekTime = audio.currentTime
           out.seeked = Math.abs(audio.currentTime - 1.5) < 0.25
           audio.src = ''
           return out
         } catch (error) {
           out.error = error && error.message ? error.message : String(error)
           return out
         }
       })()`
    )
    record(playback.played, 'audio decoded and played through player-media://', playback.error ?? playback)
    record(playback.seeked, 'seeking landed at the requested position', playback.seekTime)
    record(
      Math.abs((playback.duration ?? 0) - 3) < 0.5,
      'reported duration matches the 3s fixture',
      playback.duration
    )
    record(playback.mimeType === 'audio/flac', 'resolver reported the right MIME type', playback.mimeType)
    record(playback.resolverId === 'local-file', 'the local resolver handled the track', playback.resolverId)

    // ---- 6. protocol contract, asserted directly -----------------------
    const allowedUrl = buildMediaUrl(fixturePath)

    const full = await net.fetch(allowedUrl)
    record(full.status === 200, 'protocol serves a library file with 200', full.status)
    record(full.headers.get('accept-ranges') === 'bytes', 'protocol advertises byte ranges')
    const fullBody = await full.arrayBuffer()
    record(fullBody.byteLength === fixtureSize, 'full response length matches the file', [
      fullBody.byteLength,
      fixtureSize
    ])

    const ranged = await net.fetch(allowedUrl, { headers: { Range: 'bytes=0-99' } })
    record(ranged.status === 206, 'a range request returns 206', ranged.status)
    record(ranged.headers.get('content-length') === '100', 'range response is 100 bytes', ranged.headers.get('content-length'))
    const rangedBody = await ranged.arrayBuffer()
    record(rangedBody.byteLength === 100, 'range response body is 100 bytes', rangedBody.byteLength)

    const outsideLibrary = await net.fetch(buildMediaUrl(join(tmpdir(), 'definitely-not-in-library.flac')))
    record(outsideLibrary.status === 403, 'a path outside every library folder is refused with 403', outsideLibrary.status)

    const missingInside = await net.fetch(buildMediaUrl(join(fixtureDir, 'missing.flac')))
    record(missingInside.status === 404, 'a missing file inside the library returns 404', missingInside.status)

    const malformed = await net.fetch(buildMediaUrl(''))
    record(malformed.status >= 400, 'an empty path is rejected', malformed.status)

    // ---- 6b. the remote stream scheme ----------------------------------
    // yt-dlp needs a network and 7-10 s, so the sidecar is not part of a 90 s
    // UI test. What *is* part of it: a token registered in the proxy must play
    // through player-stream:// inside the real renderer, with the production
    // CSP and the custom protocol privileges in force. A local HTTP server
    // stands in for the CDN.
    const streamBytes = await readFile(fixturePath)
    const streamServer = createServer((request, response) => {
      const range = request.headers.range
      const match = typeof range === 'string' ? /^bytes=(\d+)-(\d*)$/.exec(range) : null
      if (match) {
        const start = Number(match[1])
        const end = match[2] ? Math.min(Number(match[2]), streamBytes.length - 1) : streamBytes.length - 1
        response.writeHead(206, {
          'content-type': 'audio/flac',
          'accept-ranges': 'bytes',
          'content-range': `bytes ${start}-${end}/${streamBytes.length}`,
          'content-length': end - start + 1
        })
        response.end(streamBytes.subarray(start, end + 1))
        return
      }
      response.writeHead(200, {
        'content-type': 'audio/flac',
        'accept-ranges': 'bytes',
        'content-length': streamBytes.length
      })
      response.end(streamBytes)
    })
    await new Promise<void>((resolve) => streamServer.listen(0, '127.0.0.1', resolve))

    try {
      const streamAddress = streamServer.address()
      const streamPort = streamAddress && typeof streamAddress === 'object' ? streamAddress.port : 0
      const streamToken = container.youtube.proxy.register('selftest-stream', {
        url: `http://127.0.0.1:${streamPort}/audio.flac`,
        headers: { 'User-Agent': 'PlayerSelftest/1.0' },
        mimeType: 'audio/flac',
        expiresAt: Date.now() + 60_000
      })
      const streamUrl = buildStreamUrl(streamToken)

      const streamed = await evaluate<{
        metadata: boolean
        duration: number
        playing: boolean
        seeked: boolean
        error: string | null
      }>(
        window,
        `(async () => {
           const out = { metadata: false, duration: 0, playing: false, seeked: false, error: null }
           try {
             const audio = new Audio(${JSON.stringify(streamUrl)})
             audio.preload = 'auto'
             await new Promise((resolve, reject) => {
               const timer = setTimeout(() => reject(new Error('metadata timeout')), 6000)
               audio.addEventListener('loadedmetadata', () => { clearTimeout(timer); resolve() }, { once: true })
               audio.addEventListener('error', () => {
                 clearTimeout(timer)
                 reject(new Error('media error ' + (audio.error ? audio.error.code : '?')))
               }, { once: true })
             })
             out.metadata = true
             out.duration = audio.duration
             await audio.play()
             out.playing = !audio.paused
             audio.currentTime = 1.4
             await new Promise((resolve, reject) => {
               const timer = setTimeout(() => reject(new Error('seek timeout')), 6000)
               audio.addEventListener('seeked', () => { clearTimeout(timer); resolve() }, { once: true })
             })
             out.seeked = Math.abs(audio.currentTime - 1.4) < 0.5
             audio.pause()
           } catch (cause) {
             out.error = cause && cause.message ? cause.message : String(cause)
           }
           return out
         })()`
      )

      record(
        streamed.metadata && Math.abs(streamed.duration - 3) < 0.5,
        'player-stream:// delivers metadata and the right duration',
        streamed.error ?? streamed.duration
      )
      record(streamed.playing, 'a proxied URL plays through the stream scheme', streamed.error)
      record(streamed.seeked, 'seeking a proxied stream lands where asked', streamed.error)
    } finally {
      await new Promise<void>((resolve) => streamServer.close(() => resolve()))
    }

    // ---- 7. queue and transport ----------------------------------------
    // Repeat and shuffle are settings that the player reads; this proves the
    // buttons reach them and that the queue view reflects the real queue.
    const transport = await evaluate<{
      itemCount: number
      hasCurrentItem: boolean
      queueCountLabel: string
      repeatTitle: string
      repeatAfterClick: string
      shufflePressed: string
      shuffleAfterClick: string
    }>(
      window,
      `(async () => {
         const out = { itemCount: 0, hasCurrentItem: false, queueCountLabel: '', repeatTitle: '', repeatAfterClick: '', shufflePressed: '', shuffleAfterClick: '' }
         const wait = (ms) => new Promise((r) => setTimeout(r, ms))
         const clickNav = (label) => {
           const button = [...document.querySelectorAll('.nav-item')].find((el) => (el.textContent || '').trim().startsWith(label))
           if (button) button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
           return Boolean(button)
         }

         clickNav('Queue')
         await wait(300)
         out.itemCount = document.querySelectorAll('.queue-item').length
         out.hasCurrentItem = Boolean(document.querySelector('.queue-item.current'))
         const count = document.querySelector('.queue-count')
         out.queueCountLabel = count ? count.textContent : ''

         const repeat = document.querySelector('.player-buttons button[title^="Repeat"]')
         out.repeatTitle = repeat ? repeat.getAttribute('title') : 'missing'
         if (repeat) repeat.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await wait(300)
         const repeatAfter = document.querySelector('.player-buttons button[title^="Repeat"]')
         out.repeatAfterClick = repeatAfter ? repeatAfter.getAttribute('title') : 'missing'

         const shuffle = document.querySelector('.player-buttons button[title^="Shuffle"]')
         out.shufflePressed = shuffle ? String(shuffle.getAttribute('aria-pressed')) : 'missing'
         if (shuffle) shuffle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await wait(300)
         const shuffleAfter = document.querySelector('.player-buttons button[title^="Shuffle"]')
         out.shuffleAfterClick = shuffleAfter ? String(shuffleAfter.getAttribute('aria-pressed')) : 'missing'

         clickNav('Library')
         await wait(200)
         return out
       })()`
    )
    record(transport.itemCount >= 1, 'the played track is in the queue', transport.itemCount)
    record(transport.hasCurrentItem, 'the queue marks the track that is playing')
    // Double-clicking a row queues the whole loaded list, so with two fixtures
    // both are queued.
    record(transport.queueCountLabel === '2', 'the player bar counts the queue', transport.queueCountLabel)
    record(
      transport.repeatTitle === 'Repeat off' && transport.repeatAfterClick === 'Repeat all',
      'the repeat button cycles off -> all',
      `${transport.repeatTitle} -> ${transport.repeatAfterClick}`
    )
    record(
      transport.shufflePressed === 'false' && transport.shuffleAfterClick === 'true',
      'the shuffle button toggles',
      `${transport.shufflePressed} -> ${transport.shuffleAfterClick}`
    )

    // ---- 8. artwork ----------------------------------------------------
    // The full path: embedded cover -> nativeImage resize -> cache file ->
    // player-art:// -> an <img> that actually decodes. Only the last of those is
    // visible from the renderer, which is why it is the one asserted.
    const artwork = await evaluate<{
      coveredKey: string | null
      coveredKeyAgain: string | null
      plainKey: string | null
      rowImg: string
      rowImgLoaded: boolean
      rowImgScheme: string
      placeholder: string
      playerArt: string
      playerArtLoaded: boolean
      playerTitle: string
    }>(
      window,
      `(async () => {
         const out = { coveredKey: null, coveredKeyAgain: null, plainKey: null, rowImg: '', rowImgLoaded: false, rowImgScheme: '', placeholder: '', playerArt: '', playerArtLoaded: false, playerTitle: '' }
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
         const rowFor = (title) => {
           for (const row of document.querySelectorAll('.track-row')) {
             const text = row.querySelector('.row-title-text')
             if (text && text.textContent === title) return row
           }
           return null
         }

         const page = await window.player.listTracks({ limit: 10 })
         const covered = page.tracks.find((track) => track.title === 'Selftest Tone')
         const plain = page.tracks.find((track) => track.title === 'Selftest Silent')
         if (covered) {
           out.coveredKey = await window.player.getArtwork(covered.id)
           out.coveredKeyAgain = await window.player.getArtwork(covered.id)
         }
         if (plain) out.plainKey = await window.player.getArtwork(plain.id)

         // Rows fetch their own artwork, so the image arrives on its own time:
         // poll for it rather than assuming it is there on the first frame.
         const coveredRow = rowFor('Selftest Tone')
         if (coveredRow) {
           const deadline = Date.now() + 8000
           for (;;) {
             const found = coveredRow.querySelector('.row-art')
             if (found && found.tagName === 'IMG' && found.naturalWidth > 0) {
               out.rowImg = found.tagName
               out.rowImgScheme = found.getAttribute('src') || ''
               out.rowImgLoaded = true
               break
             }
             if (Date.now() > deadline) {
               const late = coveredRow.querySelector('.row-art')
               out.rowImg = late ? late.tagName : 'missing'
               out.rowImgScheme = late ? String(late.getAttribute('src')) : ''
               break
             }
             await sleep(100)
           }
         }

         const plainRow = rowFor('Selftest Silent')
         if (plainRow) {
           const art = plainRow.querySelector('.row-art')
           out.placeholder = art ? String(art.getAttribute('data-artwork')) : 'missing'
         }

         // The player bar follows whatever is playing, and playback has been
         // running long enough for the 3s fixture to have ended and advanced to
         // the next queue entry. Play the covered row again so the assertion is
         // about artwork rather than about which track happens to be current.
         if (coveredRow) {
           coveredRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
           const deadline = Date.now() + 8000
           for (;;) {
             const barArt = document.querySelector('.player-art')
             const title = (document.querySelector('.player-title') || {}).textContent || ''
             if (barArt && barArt.getAttribute('data-artwork') === 'ready' && barArt.naturalWidth > 0) {
               out.playerArt = 'ready'
               out.playerArtLoaded = true
               out.playerTitle = title
               break
             }
             if (Date.now() > deadline) {
               out.playerArt = barArt ? String(barArt.getAttribute('data-artwork')) : 'missing'
               out.playerTitle = title
               break
             }
             await sleep(100)
           }
         }
         return out
       })()`
    )
    record(
      typeof artwork.coveredKey === 'string' && /^[0-9a-f]{40}\.(jpg|png)$/.test(artwork.coveredKey),
      'the embedded cover was extracted and cached',
      artwork.coveredKey
    )
    record(artwork.coveredKeyAgain === artwork.coveredKey, 'asking twice returns the cached key', artwork.coveredKeyAgain)
    record(artwork.plainKey === null, 'a file with no cover reports none', artwork.plainKey)
    record(artwork.rowImgScheme.startsWith('player-art://art/'), 'the row points at the artwork scheme', artwork.rowImgScheme)
    record(artwork.rowImgLoaded, 'the row artwork decoded in the renderer', artwork.rowImg)
    record(artwork.placeholder === 'none', 'a track with no cover falls back to the placeholder', artwork.placeholder)
    record(
      artwork.playerArt === 'ready',
      'the player bar shows artwork for the playing track',
      `${artwork.playerArt} (${artwork.playerTitle})`
    )

    // ---- 9. the full-window player -------------------------------------
    // Opened by clicking the now-playing area of the bar. This is the one part
    // that cannot be checked without a real window: the backdrop is a blurred
    // copy of the cover, and that only resolves once the artwork key exists.
    const fullPlayer = await evaluate<{
      opened: boolean
      backdropImage: string
      backdropBlurred: boolean
      backdropBrightened: boolean
      hasWash: boolean
      noSeparator: boolean
      artTag: string
      artLoaded: boolean
      title: string
      hasSeek: boolean
      controls: number
      closingAnimated: boolean
      closedByEscape: boolean
    }>(
      window,
      `(async () => {
         const out = { opened: false, backdropImage: '', backdropBlurred: false, backdropBrightened: false, hasWash: false, noSeparator: false, artTag: 'missing', artLoaded: false, title: '', hasSeek: false, controls: 0, closingAnimated: false, closedByEscape: false }
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

         // The 3s fixture has probably ended and auto-advanced by now, and the
         // cover is the whole point of this view, so make sure the covered track
         // is the current one before opening it.
         const barTitle = () => ((document.querySelector('.player-title') || {}).textContent || '')
         if (barTitle() !== 'Selftest Tone') {
           for (const row of document.querySelectorAll('.track-row')) {
             const text = row.querySelector('.row-title-text')
             if (text && text.textContent === 'Selftest Tone') {
               row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
               break
             }
           }
           await sleep(500)
         }

         const open = document.querySelector('.player-track')
         if (open) open.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(400)

         const view = document.querySelector('.now-playing')
         out.opened = Boolean(view)
         if (!view) return out

         const backdrop = view.querySelector('.np-backdrop')
         if (backdrop) {
           const style = getComputedStyle(backdrop)
           out.backdropImage = String(style.backgroundImage || '').slice(0, 60)
           out.backdropBlurred = String(style.filter || '').includes('blur')
           // The regression that put this here: left at 60% opacity and
           // un-brightened, a dark cover reads as a smudge in one corner rather
           // than as a background.
           out.backdropBrightened =
             Number(style.opacity) >= 0.8 && String(style.filter || '').includes('brightness')
         }
         out.hasWash = Boolean(view.querySelector('.np-wash'))

         const band = view.querySelector('.np-bottom')
         out.noSeparator = Boolean(band) && getComputedStyle(band).borderTopWidth === '0px'

         // The backdrop and the large cover are both waiting on the same artwork
         // key, so this polls rather than assuming the first frame has it.
         const deadline = Date.now() + 8000
         for (;;) {
           const img = view.querySelector('.np-art')
           out.artTag = img ? img.tagName : 'missing'
           if (img && img.tagName === 'IMG' && img.naturalWidth > 0) {
             out.artLoaded = true
             break
           }
           if (Date.now() > deadline) break
           await sleep(100)
         }

         out.title = ((view.querySelector('.np-title') || {}).textContent || '')
         out.hasSeek = Boolean(view.querySelector('.np-seek input[type="range"]'))
         out.controls = view.querySelectorAll('.np-transport button').length

         // Escape is the keyboard way out, and the app's global handler owns it.
         // Closing is animated, so the element is still mounted a moment later
         // carrying the closing class — sampling that is what proves the fade
         // plays instead of the view simply vanishing.
         window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
         await sleep(50)
         out.closingAnimated = Boolean(document.querySelector('.now-playing.np-closing'))
         await sleep(450)
         out.closedByEscape = !document.querySelector('.now-playing')
         return out
       })()`
    )
    record(fullPlayer.opened, 'clicking the now-playing area opens the full-window player')
    record(
      fullPlayer.backdropImage.includes('player-art://'),
      'the player backdrop is the album art itself',
      fullPlayer.backdropImage
    )
    record(fullPlayer.backdropBlurred, 'the backdrop is blurred rather than a flat colour')
    record(fullPlayer.backdropBrightened, 'the backdrop is brightened so a dark cover still fills the frame')
    record(fullPlayer.hasWash, 'the player background has a wash so no corner is left dead')
    record(fullPlayer.noSeparator, 'the control band has no hard separator line')
    record(fullPlayer.artLoaded, 'the large album art decoded in the player window', fullPlayer.artTag)
    record(fullPlayer.title.length > 0, 'the player window names the track', fullPlayer.title)
    record(fullPlayer.hasSeek, 'the player window has a scrubber')
    record(fullPlayer.controls >= 5, 'the player window has transport and function buttons', fullPlayer.controls)
    record(fullPlayer.closingAnimated, 'closing the player window plays an exit animation')
    record(fullPlayer.closedByEscape, 'Escape closes the player window')

    // The Online view is a layout too, so its history is seeded before the size
    // sweep: an empty state fits any window and would prove nothing.
    //
    // Two rows are given a real cached cover — the fixture drawn above — so the
    // row artwork path is exercised with no network. The third has none, and is
    // given an id that is not a video id on purpose, so asking for its cover
    // resolves to nothing instead of reaching out to YouTube's image CDN.
    const onlineSeed = Date.now()
    const seededArtwork = await container.artwork.cacheRemote(await readFile(coverPath), 'image/png')
    if (container.onlineRepo.count() === 0) {
      container.onlineRepo.upsert(
        {
          videoId: 'selftestaa1',
          title: 'Online Tone One',
          artist: 'Selftest Streamer',
          album: null,
          durationMs: 210_000,
          sourceUrl: youtubeWatchUrl('selftestaa1'),
          artworkKey: seededArtwork
        },
        onlineSeed
      )
      container.onlineRepo.upsert(
        {
          videoId: 'selftestbb2',
          title: 'Online Tone Two with a deliberately long name that has to truncate instead of widening its row',
          artist: 'Selftest Streamer',
          album: null,
          durationMs: 90_000,
          sourceUrl: youtubeWatchUrl('selftestbb2'),
          artworkKey: seededArtwork
        },
        onlineSeed + 1000
      )
      container.onlineRepo.upsert(
        {
          videoId: 'not-a-video-id',
          title: 'Online Tone Three',
          artist: null,
          album: null,
          durationMs: null,
          sourceUrl: youtubeWatchUrl('not-a-video-id'),
          artworkKey: null
        },
        onlineSeed - 1000
      )
    }
    record(
      container.onlineRepo.count() === 3,
      'online: the history is seeded before the layout sweep',
      container.onlineRepo.count()
    )

    // ---- 10. layout: no view may overflow sideways ---------------------
    // The window resizes down to 940x580, and both views have to fit at any size
    // in between without a horizontal scrollbar. Nothing else catches this class
    // of bug: the app looks fine until a user drags the window edge, and then the
    // cards slide out of view. Measuring the DOM is the only honest check.
    for (const [width, height] of [
      [1200, 780],
      [940, 580]
    ] as const) {
      window.setSize(width, height)
      await delay(250)

      const showView = async (label: 'Library' | 'Online' | 'Settings' | 'Queue'): Promise<void> => {
        await evaluate(
          window,
          `(async () => {
             const button = [...document.querySelectorAll('.nav-item')].find((el) => (el.textContent || '').trim().startsWith(${JSON.stringify(label)}))
             if (button) button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
             await new Promise((resolve) => setTimeout(resolve, 250))
             return Boolean(button)
           })()`
        )
      }

      await showView('Library')
      const library = await evaluate<LayoutProbe>(window, LAYOUT_PROBE)
      record(
        library.hasTable && library.main === 0 && library.table === 0 && library.bar === 0 && library.page === 0,
        `library view fits with no horizontal overflow at ${width}x${height}`,
        library
      )

      await showView('Settings')
      const settings = await evaluate<LayoutProbe>(window, LAYOUT_PROBE)
      record(
        settings.hasCards && settings.main === 0 && settings.cards === 0 && settings.bar === 0 && settings.page === 0,
        `settings view fits with no horizontal overflow at ${width}x${height}`,
        settings
      )

      await showView('Queue')
      const queue = await evaluate<LayoutProbe>(window, LAYOUT_PROBE)
      record(
        queue.hasQueue && queue.main === 0 && queue.bar === 0 && queue.page === 0,
        `queue view fits with no horizontal overflow at ${width}x${height}`,
        queue
      )

      await showView('Online')
      const onlineLayout = await evaluate<LayoutProbe>(window, LAYOUT_PROBE)
      record(
        onlineLayout.hasOnline && onlineLayout.main === 0 && onlineLayout.online === 0 && onlineLayout.bar === 0 && onlineLayout.page === 0,
        `online view fits with no horizontal overflow at ${width}x${height}`,
        onlineLayout
      )

      // The full-window player has to fit as well. It is the only view with a
      // fixed-position, over-scaled backdrop, and a blur that sampled past the
      // window edge would show up here as a sideways scroll.
      await evaluate(
        window,
        `(async () => {
           const open = document.querySelector('.player-track')
           if (open) open.dispatchEvent(new MouseEvent('click', { bubbles: true }))
           await new Promise((resolve) => setTimeout(resolve, 350))
           return true
         })()`
      )
      const player = await evaluate<LayoutProbe>(window, LAYOUT_PROBE)
      record(
        player.hasNowPlaying && player.nowPlaying === 0 && player.page === 0,
        `the full-window player fits with no horizontal overflow at ${width}x${height}`,
        player
      )

      await evaluate(
        window,
        `(async () => {
           const close = document.querySelector('.np-close')
           if (close) close.dispatchEvent(new MouseEvent('click', { bubbles: true }))
           await new Promise((resolve) => setTimeout(resolve, 450))
           return true
         })()`
      )
    }

    // ---- 11. artwork preferences, bar ambience, volume -----------------
    // The Visuals setting is published as data attributes on `.app`, so the whole
    // UI follows from one place. This drives it through the actual <select>
    // elements rather than the IPC channel, because `useSettings` only learns
    // about changes it made itself — going through the UI is both the honest test
    // and the only one that would catch a control that is not wired up.
    const visuals = await evaluate<{
      shapeReachesThumbnails: boolean
      fitIsProportional: boolean
      fitRatio: number
      fitIsLive: boolean
      fitIsPlayerOnly: boolean
      fitIsDisabledWhenRound: boolean
      circleCropsTheBox: boolean
      settingsRestored: boolean
      barGlowOnBar: boolean
      tileGlowGone: boolean
      glowMasked: boolean
      volumeBefore: number
      volumeMuted: number
      mutePressed: string
      volumeRestored: number
      volumeBeforeWheel: number
      volumeAfterWheel: number
      volumeWheelTop: number
      volumeWheelBottom: number
      wheelCancelled: boolean
      panelClosedByOutsidePress: boolean
      panelStayedOpenOnInsidePress: boolean
      popoverHidden: boolean
      panelAtRest: boolean
      queueRows: number
      queueLabels: string
      queueCurrent: number
      truncates: boolean
      panelOpened: boolean
      panelRowsFit: boolean
      shadowFades: boolean
      shadowStyle: string
      jumped: boolean
      panelStayedOpen: boolean
      escapeHidPanel: boolean
      panelCloseState: string
      escapeKeptWindow: boolean
      escapeClosedWindow: boolean
    }>(
      window,
      `(async () => {
         const out = { shapeReachesThumbnails: false, fitIsProportional: false, fitRatio: -1, fitIsLive: false, fitIsPlayerOnly: false, fitIsDisabledWhenRound: false, circleCropsTheBox: false, settingsRestored: false, barGlowOnBar: false, tileGlowGone: false, glowMasked: false, volumeBefore: -1, volumeMuted: -1, mutePressed: '', volumeRestored: -1, volumeBeforeWheel: -1, volumeAfterWheel: -1, volumeWheelTop: -1, volumeWheelBottom: -1, wheelCancelled: false, panelClosedByOutsidePress: false, panelStayedOpenOnInsidePress: false, popoverHidden: false, panelAtRest: false, queueRows: 0, queueLabels: '', queueCurrent: 0, truncates: false, panelOpened: false, panelRowsFit: false, shadowFades: false, shadowStyle: '', jumped: false, panelStayedOpen: false, escapeHidPanel: false, escapeKeptWindow: false, escapeClosedWindow: false, panelCloseState: '' }
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
         const pick = (selector) => document.querySelector(selector)
         const press = (element) => { if (element) element.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
         // The tone fixture is three seconds long, so anything that inspects the
         // artwork has to stop it first: left running it advances to the fixture
         // with no cover, and every check afterwards reads the wrong track.
         const pause = () => {
           const play = pick('.np-play')
           if (play && play.getAttribute('title') === 'Pause') press(play)
         }
         const fitField = () => {
           for (const field of document.querySelectorAll('.field')) {
             const title = field.querySelector('span')
             if (title && title.textContent === 'When a cover is not square') return field.querySelector('select')
           }
           return null
         }
         const thumb = () => pick('.player-art')
         const art = () => pick('.np-art')
         const panel = () => pick('.np-queue-panel')
         // The panel hides on a 360ms transition, and the computed style only
         // reports it once a frame has been produced. Under load (or on a
         // throttled window) that can take longer than any fixed wait, so the
         // checks below poll for the settled state instead of guessing at a
         // number - what matters is that the panel ends up shut, not when.
         const panelHidden = async (timeoutMs) => {
           const deadline = Date.now() + timeoutMs
           for (;;) {
             const node = panel()
             if (node && getComputedStyle(node).visibility === 'hidden') return true
             if (Date.now() > deadline) return false
             await new Promise((resolve) => setTimeout(resolve, 50))
           }
         }
         const rows = () => [...document.querySelectorAll('.np-queue-row')]
         const dialog = () => pick('.now-playing')
         const pressEscape = () => {
           const target = dialog()
           if (target) target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
         }

         const nav = (label) => {
           const button = [...document.querySelectorAll('.nav-item')].find((el) => (el.textContent || '').trim().startsWith(label))
           if (button) button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         }
         const setField = (label, value) => {
           for (const field of document.querySelectorAll('.field')) {
             const title = field.querySelector('span')
             if (title && title.textContent === label) {
               const select = field.querySelector('select')
               if (select) {
                 select.value = value
                 select.dispatchEvent(new Event('change', { bubbles: true }))
                 return true
               }
             }
           }
           return false
         }
         // Shape is about artwork everywhere, so a thumbnail is the honest place to
         // look for it. Fitting is only about the large artwork in the player window,
         // which does not exist until the window is opened — so the shape is set
         // first, on its own, and the fit is left on 'contain' for what follows.
         nav('Settings')
         await sleep(400)
         setField('Artwork shape', 'square')
         setField('When a cover is not square', 'contain')
         await sleep(400)

         // Play the fixture that has a cover before opening the window, and stop it,
         // so the three-second tone cannot roll on to the one that has not.
         nav('Library')
         await sleep(300)
         const barTitle = () => ((pick('.player-title') || {}).textContent || '')
         if (barTitle() !== 'Selftest Tone') {
           for (const row of document.querySelectorAll('.track-row')) {
             const text = row.querySelector('.row-title-text')
             if (text && text.textContent === 'Selftest Tone') {
               row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
               break
             }
           }
           await sleep(500)
         }
         press(pick('.player-track'))
         await sleep(500)
         pause()
         await sleep(200)

         // The fixture cover is 96x64, so a box that took its proportions is 3:2
         // rather than square. This is the whole point of the setting: the border and
         // the shadow follow the cover instead of tracing a square around it.
         out.fitIsProportional = art() ? art().getAttribute('data-sizing') === 'fit' : false
         out.fitRatio =
           art() && art().offsetHeight > 0
             ? Math.round((art().offsetWidth / art().offsetHeight) * 100) / 100
             : -1
         // ...and nothing else follows it. A 24px row thumbnail with a letterbox in
         // it would be less readable than the crop, so the setting stops there.
         out.fitIsPlayerOnly = thumb() ? thumb().getAttribute('data-sizing') !== 'fit' : false

         // Toggling the setting with the window already open has to work as well.
         // The cover is decoded by then and will not fire a second load event, so
         // without the complete-image path the box just stays square.
         setField('When a cover is not square', 'cover')
         await sleep(400)
         setField('When a cover is not square', 'contain')
         await sleep(400)
         out.fitIsLive =
           art() && art().offsetHeight > 0
             ? Math.abs(art().offsetWidth / art().offsetHeight - 1.5) < 0.1
             : false

         // Round is the one combination where the two settings cannot both win: an
         // oval would cut the corners off the cover that fitting promised to show
         // whole. The shape takes precedence, and the control says so.
         nav('Settings')
         await sleep(400)
         setField('Artwork shape', 'circle')
         await sleep(400)
         out.shapeReachesThumbnails = thumb() ? getComputedStyle(thumb()).borderRadius === '50%' : false
         out.fitIsDisabledWhenRound = fitField() ? fitField().disabled === true : false
         out.circleCropsTheBox =
           art() && art().offsetWidth > 0 ? Math.abs(art().offsetWidth - art().offsetHeight) <= 1 : false

         // Back to the defaults, driving the real controls, and the box squares up.
         setField('Artwork shape', 'square')
         await sleep(300)
         setField('When a cover is not square', 'cover')
         await sleep(400)
         out.settingsRestored =
           (art() ? art().offsetWidth === art().offsetHeight : false) &&
           (thumb() ? getComputedStyle(thumb()).borderRadius !== '50%' : false)

         // The ambience belongs to the whole bar, not to the now-playing tile.
         nav('Library')
         await sleep(300)
         const bar = document.querySelector('.player-bar')
         const glow = bar ? bar.querySelector('.player-bar-glow') : null
         out.barGlowOnBar = Boolean(glow)
         out.tileGlowGone = !document.querySelector('.player-track-glow')
         if (glow) {
           const mask = String(getComputedStyle(glow).webkitMaskImage || getComputedStyle(glow).maskImage || '')
           out.glowMasked = mask.includes('gradient')
         }

         // Volume: click mutes, click again restores the level that was there. The
         // window is already open from the artwork checks above.
         const slider = () => document.querySelector('.np-volume-slider')
         const button = () => document.querySelector('.np-volume button')
         const pop = () => document.querySelector('.np-volume-pop')
         // Folded away by default: a slider that is always on screen is the thing
         // this replaced.
         out.popoverHidden = pop() ? getComputedStyle(pop()).visibility === 'hidden' : false
         out.volumeBefore = slider() ? Number(slider().value) : -1
         if (button()) button().dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(300)
         out.volumeMuted = slider() ? Number(slider().value) : -1
         out.mutePressed = button() ? String(button().getAttribute('aria-pressed')) : ''
         if (button()) button().dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(300)
         out.volumeRestored = slider() ? Number(slider().value) : -1

         // ---- volume by wheel -----------------------------------------------
         // Hovering the control and scrolling is the gesture people reach for, so
         // it is driven where the pointer would be: on the box that holds both the
         // button and the folded-away slider.
         const volumeBox = pick('.np-volume')
         const setLevel = async (value) => {
           const element = slider()
           if (!element) return
           // The slider carries a React value prop, so writing .value directly would
           // be seen by React's value tracker as "no change" and no event would reach
           // the handler. Going through the prototype setter updates the DOM value
           // without telling the tracker, so the input event below counts as a real
           // edit — the same trick a testing library uses.
           const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')
           if (descriptor && descriptor.set) descriptor.set.call(element, String(value))
           element.dispatchEvent(new Event('input', { bubbles: true }))
           await sleep(150)
         }
         const roll = async (deltaY, times) => {
           for (let i = 0; i < times; i += 1) {
             if (volumeBox) volumeBox.dispatchEvent(new WheelEvent('wheel', { deltaY: deltaY, bubbles: true, cancelable: true }))
             await sleep(40)
           }
         }
         await setLevel(0.5)
         out.volumeBeforeWheel = slider() ? Number(slider().value) : -1
         let oneWheel = null
         if (volumeBox) {
           oneWheel = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true })
           volumeBox.dispatchEvent(oneWheel)
         }
         await sleep(200)
         out.volumeAfterWheel = slider() ? Number(slider().value) : -1
         // Cancelling the wheel is the reason the listener is native rather than
         // React's: a passive one would let whatever is underneath scroll as well.
         out.wheelCancelled = Boolean(oneWheel) && oneWheel.defaultPrevented
         await roll(-100, 14)
         out.volumeWheelTop = slider() ? Number(slider().value) : -1
         await roll(100, 26)
         out.volumeWheelBottom = slider() ? Number(slider().value) : -1
         await setLevel(out.volumeBeforeWheel)

         // ---- the queue panel ----------------------------------------------
         // It has to be in the DOM to animate, and out of the way when closed, so
         // "hidden" is the check rather than "absent".
         out.panelAtRest = await panelHidden(2000)
         out.queueRows = rows().length
         out.queueLabels = rows()
           .slice(0, 2)
           .map((row) => {
             const title = row.querySelector('.np-queue-title')
             const time = row.querySelector('.np-queue-time')
             return (title ? title.textContent : '') + ' / ' + (time ? time.textContent : '')
           })
           .join(' | ')
         out.queueCurrent = rows().filter((row) => row.classList.contains('current')).length
         const titleCell = rows().length ? rows()[0].querySelector('.np-queue-title') : null
         const titleStyle = titleCell ? getComputedStyle(titleCell) : null
         out.truncates =
           Boolean(titleStyle) && titleStyle.textOverflow === 'ellipsis' && titleStyle.whiteSpace === 'nowrap'

         press(pick('.np-queue'))
         await sleep(400)
         out.panelOpened = panel() ? getComputedStyle(panel()).visibility === 'visible' : false
         out.panelRowsFit = panel() ? panel().scrollWidth <= panel().clientWidth + 1 : false

         // The panel's depth is a gradient that is masked away at both ends. A
         // box-shadow instead sits at full strength from the panel's first pixel
         // down, and the host clips it, so it started at a hard corner. Computed
         // styles resolve transparent to rgba(0, 0, 0, 0), which is what the ends
         // of the mask have to be.
         const before = panel() ? getComputedStyle(panel(), '::before') : null
         const mask = before ? before.maskImage : ''
         out.shadowFades =
           Boolean(before) &&
           getComputedStyle(panel()).boxShadow === 'none' &&
           before.backgroundImage.includes('linear-gradient') &&
           mask.startsWith('linear-gradient') &&
           mask.includes('rgba(0, 0, 0, 0) 0%') &&
           mask.includes('rgba(0, 0, 0, 0) 100%')
         out.shadowStyle = getComputedStyle(panel()).boxShadow + ' | ' + mask

         // Picking from the panel plays that track and leaves the list where it is:
         // choosing the next track is not the same as leaving the queue.
         const other = rows().findIndex((row) => !row.classList.contains('current'))
         if (other >= 0) rows()[other].dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(500)
         out.jumped = rows().findIndex((row) => row.classList.contains('current')) === other
         out.panelStayedOpen = panel() ? getComputedStyle(panel()).visibility === 'visible' : false

         // ---- pressing outside the panel -------------------------------------
         // The rest of the window is a press target too: the black space beside the
         // artwork, the artwork itself and the transport row all behave like the
         // queue button. A press inside the panel is left alone, because a row is
         // how a track is picked and that already leaves the panel open.
         const pressAt = (element) => {
           if (element) element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }))
         }
         pressAt(pick('.np-stage'))
         await sleep(400)
         out.panelClosedByOutsidePress = await panelHidden(2000)
         out.panelCloseState = panel() ? (panel().className + ' / ' + getComputedStyle(panel()).visibility + ' / stage ' + Boolean(pick('.np-stage')) + ' / queueBtn ' + Boolean(pick('.np-queue'))) : 'no panel'
         press(pick('.np-queue'))
         await sleep(400)
         pressAt(rows().length ? rows()[0] : null)
         await sleep(400)
         out.panelStayedOpenOnInsidePress = panel() ? getComputedStyle(panel()).visibility === 'visible' : false

         // Escape unwinds one layer at a time, and both layers are checked: the
         // panel first, then the window.
         pressEscape()
         await sleep(400)
         out.escapeHidPanel = await panelHidden(2000)
         out.escapeKeptWindow = Boolean(dialog())
         pressEscape()
         await sleep(500)
         out.escapeClosedWindow = !dialog()
         return out
       })()`
    )
    record(visuals.shapeReachesThumbnails, 'the artwork shape setting reaches every piece of artwork')
    record(
      visuals.fitIsProportional && Math.abs(visuals.fitRatio - 1.5) < 0.1,
      'fitting gives the player artwork the cover\'s own proportions',
      `box ratio ${visuals.fitRatio} (the fixture cover is 3:2)`
    )
    record(visuals.fitIsPlayerOnly, 'fitting stops at the player window; thumbnails still crop')
    record(visuals.fitIsLive, 'turning fitting on while the player window is open still reshapes the box')
    record(
      visuals.fitIsDisabledWhenRound && visuals.circleCropsTheBox,
      'round artwork stays a circle: the fit control is disabled and the box crops to a square'
    )
    record(visuals.settingsRestored, 'artwork settings can be set back')
    record(visuals.barGlowOnBar, 'the player bar ambience spans the whole bar')
    record(visuals.tileGlowGone, 'the now-playing tile no longer paints its own glow')
    record(visuals.glowMasked, 'the bar ambience is masked so it has no hard edge')
    record(
      visuals.volumeBefore > 0 && visuals.volumeMuted === 0 && visuals.mutePressed === 'true',
      'clicking the volume button mutes',
      `${visuals.volumeBefore} -> ${visuals.volumeMuted} (pressed=${visuals.mutePressed})`
    )
    record(
      visuals.volumeRestored === visuals.volumeBefore,
      'clicking it again restores the previous level',
      `${visuals.volumeRestored} vs ${visuals.volumeBefore}`
    )
    record(visuals.popoverHidden, 'the volume slider stays folded away until it is asked for')
    record(
      visuals.volumeBeforeWheel === 0.5 && Math.abs(visuals.volumeAfterWheel - 0.55) < 0.001,
      'one wheel notch over the volume control moves the level by five percent',
      `${visuals.volumeBeforeWheel} -> ${visuals.volumeAfterWheel}`
    )
    record(
      visuals.volumeWheelTop === 1 && visuals.volumeWheelBottom === 0,
      'the volume wheel stops at the ends of the scale',
      `top ${visuals.volumeWheelTop} / bottom ${visuals.volumeWheelBottom}`
    )
    record(visuals.wheelCancelled, 'the volume wheel swallows the scroll instead of passing it on')
    record(visuals.panelAtRest, 'the queue panel is hidden until it is asked for')
    record(
      visuals.queueRows >= 2 && visuals.queueCurrent === 1,
      'the panel lists the whole queue and marks the one playing',
      `${visuals.queueRows} rows, ${visuals.queueCurrent} marked current`
    )
    record(
      visuals.queueLabels.includes('Selftest Tone') && /\d:\d\d/.test(visuals.queueLabels),
      'each row is a name and a duration, and nothing else',
      visuals.queueLabels
    )
    record(visuals.truncates, 'long names in the panel are truncated rather than wrapped')
    record(visuals.panelOpened, 'the queue button slides the panel in')
    record(
      visuals.shadowFades,
      'the panel\'s shadow fades in and out instead of starting at a hard corner',
      visuals.shadowStyle
    )
    record(visuals.panelRowsFit, 'the queue panel fits its own width with no sideways overflow')
    record(
      visuals.jumped && visuals.panelStayedOpen,
      'picking a track from the panel jumps to it and leaves the panel open'
    )
    record(
      visuals.panelClosedByOutsidePress,
      'pressing the black space or the artwork shuts the queue panel',
      visuals.panelCloseState
    )
    record(visuals.panelStayedOpenOnInsidePress, 'pressing inside the queue panel leaves it open')
    record(
      visuals.escapeHidPanel && visuals.escapeKeptWindow,
      'Escape shuts the panel without shutting the player window'
    )
    record(visuals.escapeClosedWindow, 'Escape shuts the player window once the panel is shut')

    // ---- 12. artwork size and click behaviour ---------------------------
    // Both preferences only matter for what they change on screen, so both are
    // driven through the real controls and then measured, rather than read back
    // out of the settings object they were written to.
    const prefs = await evaluate<{
      sizeReachesDom: boolean
      smallBox: number
      xlargeBox: number
      artFitsBand: boolean
      singleClickPlays: boolean
      singleClickSelectsOnly: boolean
      footNote: string
      seekBarFollows: boolean
      seekBarDetail: string
      seekBarFollowsPlaying: boolean
      seekBarPlayingDetail: string
    }>(
      window,
      `(async () => {
         const out = { sizeReachesDom: false, smallBox: -1, xlargeBox: -1, artFitsBand: false, singleClickPlays: false, singleClickSelectsOnly: false, footNote: '', seekBarFollows: false, seekBarDetail: '', seekBarFollowsPlaying: false, seekBarPlayingDetail: '' }
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
         const pick = (s) => document.querySelector(s)
         const press = (el) => { if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
         const nav = (label) => {
           const b = [...document.querySelectorAll('.nav-item')].find((el) => (el.textContent || '').trim().startsWith(label))
           if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         }
         const setField = (label, value) => {
           for (const f of document.querySelectorAll('.field')) {
             const t = f.querySelector('span')
             if (t && t.textContent === label) {
               const s = f.querySelector('select')
               if (s) { s.value = value; s.dispatchEvent(new Event('change', { bubbles: true })); return true }
             }
           }
           return false
         }
         const rows = () => [...document.querySelectorAll('.track-row')]
         const rowFor = (title) => rows().find((row) => {
           const t = row.querySelector('.row-title-text')
           return t && t.textContent === title
         })
         const barTitle = () => ((pick('.player-title') || {}).textContent || '')
         const art = () => pick('.np-art')
         const pause = () => {
           const play = pick('.np-play')
           if (play && play.getAttribute('title') === 'Pause') press(play)
         }

         // --- artwork size -------------------------------------------------
         nav('Library')
         await sleep(300)
         if (barTitle() !== 'Selftest Tone') {
           const tone = rowFor('Selftest Tone')
           if (tone) tone.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
           await sleep(500)
         }
         press(pick('.player-track'))
         await sleep(600)
         // The tone fixture is three seconds: left running it would advance to the
         // track with no cover while this is measuring.
         pause()
         await sleep(200)

         // The Settings view stays mounted behind the overlay, so the window picks
         // each size up live and the two can be compared in one pass.
         nav('Settings')
         await sleep(400)
         setField('Artwork size', 'small')
         await sleep(400)
         out.smallBox = art() ? art().offsetHeight : -1

         setField('Artwork size', 'xlarge')
         await sleep(400)
         out.xlargeBox = art() ? art().offsetHeight : -1
         out.sizeReachesDom = out.smallBox > 0 && out.xlargeBox > out.smallBox

         // A square box is the worst case: a 3:2 cover fitted into the band is only
         // two thirds as tall. The window is at its smallest here — section 10 left
         // it at 940x580 — which is exactly where a proportion of the viewport can
         // overshoot. The stage's own 4px vertical padding is part of the budget.
         const stage = pick('.np-stage')
         out.artFitsBand = Boolean(stage) && Boolean(art()) && art().offsetHeight + 8 <= stage.clientHeight

         // Back to the default before anything else looks at the artwork.
         setField('Artwork size', 'medium')
         await sleep(300)
         press(pick('.np-close'))
         await sleep(500)

         // --- click behaviour ----------------------------------------------
         nav('Settings')
         await sleep(400)
         setField('Single click', 'play')
         nav('Library')
         await sleep(300)
         const silent = rowFor('Selftest Silent')
         if (silent) silent.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(400)
         out.singleClickPlays = barTitle() === 'Selftest Silent'

         // ...and on the shipped default, the same click must start nothing.
         nav('Settings')
         await sleep(400)
         setField('Single click', 'select')
         nav('Library')
         await sleep(300)
         const tone = rowFor('Selftest Tone')
         if (tone) tone.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(400)
         out.singleClickSelectsOnly = barTitle() === 'Selftest Silent' && Boolean(pick('.track-row.selected'))
         out.footNote = ((pick('.table-footnote') || {}).textContent || '')

         // --- the scrubber keeps up with a seek -----------------------------
         // The element reports its time a few times a second, so a seek that only
         // moved currentTime left the bar showing the position from before it, and
         // the next seek was then measured against that stale number — the bar sat
         // one drag behind the audio. Paused on purpose: no timeupdate can paper
         // over it, and nothing drifts between the two seeks.
         const barPlay = pick('.player-bar .icon-button.primary')
         if (barPlay && barPlay.getAttribute('title') === 'Pause') press(barPlay)
         await sleep(300)

         const seekBar = () => pick('.player-seek')
         const seekRange = () => pick('.player-seek input[type="range"]')
         const progressOf = () => {
           const bar = seekBar()
           const raw = bar ? getComputedStyle(bar).getPropertyValue('--seek-progress') : ''
           return parseFloat(raw)
         }
         const drive = async (fraction) => {
           const input = seekRange()
           if (!input) return -1
           input.value = String(Math.round(Number(input.max) * fraction))
           const snapped = Number(input.value)
           input.dispatchEvent(new Event('input', { bubbles: true }))
           await sleep(60)
           input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
           return snapped
         }
         const seekMax = seekRange() ? Number(seekRange().max) : 0
         const firstTarget = await drive(0.2)
         const firstShown = progressOf()
         const secondTarget = await drive(0.8)
         const secondShown = progressOf()
         out.seekBarFollows =
           seekMax > 0 &&
           Math.abs(firstShown - (firstTarget / seekMax) * 100) < 1 &&
           Math.abs(secondShown - (secondTarget / seekMax) * 100) < 1
         out.seekBarDetail =
           firstTarget + ' -> ' + firstShown + '% then ' + secondTarget + ' -> ' + secondShown + '% of ' + seekMax

         // ...and the same while it is playing, because pausing is what makes the
         // numbers above exact, not what makes the fix work. Park near the start
         // first so the track has its whole length left to run, then the window can
         // be wide enough for a few milliseconds of playback drift.
         await drive(0.05)
         if (barPlay) press(barPlay)
         await sleep(300)
         const playingTarget = await drive(0.15)
         const playingShown = progressOf()
         const playingTarget2 = await drive(0.45)
         const playingShown2 = progressOf()
         out.seekBarFollowsPlaying =
           seekMax > 0 &&
           playingShown > (playingTarget / seekMax) * 100 - 3 &&
           playingShown < (playingTarget / seekMax) * 100 + 7 &&
           playingShown2 > (playingTarget2 / seekMax) * 100 - 3 &&
           playingShown2 < (playingTarget2 / seekMax) * 100 + 7
         out.seekBarPlayingDetail =
           playingTarget + ' -> ' + playingShown + '% then ' + playingTarget2 + ' -> ' + playingShown2 + '% of ' + seekMax
         if (barPlay) press(barPlay)
         return out
       })()`
    )
    record(
      prefs.sizeReachesDom,
      'the artwork size setting resizes the artwork in the player window',
      `${prefs.smallBox}px at small, ${prefs.xlargeBox}px at extra large`
    )
    record(prefs.artFitsBand, 'the largest artwork still fits its band at the smallest window')
    record(prefs.singleClickPlays, 'a single click plays when the setting says it should')
    record(
      prefs.singleClickSelectsOnly && prefs.footNote.includes('Click: select'),
      'a single click selects without playing on the default setting',
      prefs.footNote.trim().slice(0, 64)
    )
    record(
      prefs.seekBarFollows,
      'the scrubber shows the position that was just seeked to, not the one before it',
      prefs.seekBarDetail
    )
    record(
      prefs.seekBarFollowsPlaying,
      'the scrubber still follows a seek while the track is playing',
      prefs.seekBarPlayingDetail
    )

    // ---- 13. the library keeps up with the disk by itself ----------------
    // File watching is the difference between "the album I just copied in is
    // missing" and it appearing on its own. The fixture folder is already being
    // watched (adding it was what step 3 scanned), so a real file arriving and
    // leaving exercises the whole feature: fs event -> debounce -> scan -> UI.
    const arrivalPath = join(fixtureDir, 'Selftest Arrival.flac')
    await copyFile(fixturePath, arrivalPath)
    const arrived = await waitUntil(() => container.repo.stats().tracks === 3, 15_000)
    record(arrived, 'a file copied into a watched folder is indexed with no user action', container.repo.stats().tracks)

    await rm(arrivalPath, { force: true })
    const departed = await waitUntil(() => container.repo.stats().tracks === 2, 15_000)
    record(departed, 'a deleted file is forgotten with no user action', container.repo.stats().tracks)

    // The switch has to reach the watcher, not just the config file: with watching
    // off, a change on disk must not touch the library at all.
    container.settings.update({ library: { watchForChanges: false } })
    await delay(150)
    const ignoredPath = join(fixtureDir, 'Selftest Ignored.flac')
    await copyFile(fixturePath, ignoredPath)
    await delay(2500)
    record(
      container.repo.stats().tracks === 2,
      'with watching switched off a change on disk is ignored',
      container.repo.stats().tracks
    )
    await rm(ignoredPath, { force: true })
    container.settings.update({ library: { watchForChanges: true } })

    // ---- 14. playlists ----------------------------------------------------
    // Everything here goes through the real controls: the sidebar entry, the
    // create form, the selection bar's menu, the row's context menu, Alt+arrow,
    // a synthesized drag, the row's remove button, and the player window's
    // "Save as playlist". The point is that a playlist's *order* survives the
    // whole path from a gesture to SQLite and back, because that is the part no
    // unit test can see.
    //
    // The window is 1200x780 here on purpose: above the 1040px point where the
    // index moves beside the list, and narrow enough that the playlist list is
    // left with ~670px once the sidebar and the index have taken their share.
    // That is the width where the fixed columns used to eat the title column
    // whole (a 1180px window on a 125%-scaled display looks exactly like this).
    window.setSize(1200, 780)
    await delay(400)
    const lists = await evaluate<{
      emptyState: boolean
      created: boolean
      sidebarCount: string
      menuOpened: boolean
      addedViaBar: boolean
      barStatus: string
      contextMenuOpened: boolean
      addedViaContext: boolean
      contextStatus: string
      countAfterAdds: number
      rowsAfterAdds: number
      keyboardOrder: string
      dropLine: boolean
      dragOrder: string
      listWidth: number
      titleWidth: number
      artistWidth: number
      headerOverflow: boolean
      formatVisible: boolean
      indexBefore: number
      indexDragged: number
      indexKeyboardDelta: number
      viewOverflow: number
      listOverflow: number
      actionsInside: boolean
      rowsAfterRemove: number
      playedTitle: string
      renamed: string
      queueMenuOpened: boolean
      queueStatus: string
      countAfterQueueSave: number
      deleted: boolean
      emptyAfterDelete: boolean
    }>(
      window,
      `(async () => {
         const out = {
           emptyState: false, created: false, sidebarCount: '', menuOpened: false,
           addedViaBar: false, barStatus: '', contextMenuOpened: false,
           addedViaContext: false, contextStatus: '', countAfterAdds: -1,
           rowsAfterAdds: -1, keyboardOrder: '', dropLine: false, dragOrder: '',
           viewOverflow: -1, listOverflow: -1, actionsInside: false,
           rowsAfterRemove: -1, playedTitle: '', renamed: '', queueMenuOpened: false,
           queueStatus: '', countAfterQueueSave: -1, deleted: false, emptyAfterDelete: false
         }
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
         const pick = (s) => document.querySelector(s)
         const pickAll = (s) => [...document.querySelectorAll(s)]
         const press = (el) => { if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
         const nav = (label) => {
           const b = pickAll('.nav-item').find((el) => (el.textContent || '').trim().startsWith(label))
           if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
           return Boolean(b)
         }
         const text = (el) => ((el || {}).textContent || '')
         const setInput = (el, value) => {
           if (!el) return false
           const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
           desc.set.call(el, value)
           el.dispatchEvent(new Event('input', { bubbles: true }))
           return true
         }
         const titles = () => pickAll('.track-row .row-title-text').map((el) => el.textContent)
         const rowFor = (title) => pickAll('.track-row').find((row) => text(row.querySelector('.row-title-text')) === title)
         const barTitle = () => text(pick('.player-title'))
         const buttonWith = (scope, label) => pickAll(scope + ' button').find((el) => text(el).trim().indexOf(label) === 0)
         const countInIndex = () => {
           const raw = text(pick('.playlist-count')).replace(/[^0-9]/g, '')
           return raw.length > 0 ? Number(raw) : -1
         }
         const menuItem = (scope, name) => {
           const menu = pick(scope)
           if (!menu) return null
           return [...menu.querySelectorAll('.atp-item')].find((el) => text(el.querySelector('.atp-name')) === name) || null
         }

         // --- the view exists and starts empty
         nav('Playlists')
         await sleep(450)
         out.emptyState = Boolean(pick('.playlists-view')) && text(pick('.empty-state h2')) === 'No playlists yet'

         // --- create one through the form
         press(buttonWith('.view-header', 'New playlist'))
         await sleep(250)
         setInput(pick('.playlist-input'), 'Selftest Mix')
         await sleep(150)
         press(pick('.playlist-new button[type="submit"]'))
         await sleep(600)
         out.created = text(pick('.playlist-name')) === 'Selftest Mix'
         out.sidebarCount = text(pickAll('.nav-item').find((el) => text(el).trim().indexOf('Playlists') === 0).querySelector('.nav-count')).trim()

         // --- add a track from the library's selection bar
         nav('Library')
         await sleep(450)
         press(rowFor('Selftest Tone'))
         await sleep(300)
         const addButton = buttonWith('.selection-bar', 'Add to playlist')
         out.menuOpened = Boolean(addButton)
         press(addButton)
         await sleep(300)
         press(menuItem('.add-to-playlist', 'Selftest Mix'))
         await sleep(450)
         out.barStatus = text(pick('.atp-status')).trim()
         out.addedViaBar = out.barStatus.indexOf('1 track added') === 0

         // --- add the other one through the row's context menu
         const silentRow = rowFor('Selftest Silent')
         if (silentRow) {
           const box = silentRow.getBoundingClientRect()
           silentRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: box.left + 60, clientY: box.top + 12 }))
         }
         await sleep(350)
         const context = pick('.context-menu')
         out.contextMenuOpened = Boolean(context)
         press(context ? [...context.querySelectorAll('.context-item')].find((el) => text(el).indexOf('Add to playlist') >= 0) : null)
         await sleep(300)
         press(menuItem('.context-menu .add-to-playlist', 'Selftest Mix'))
         await sleep(450)
         out.contextStatus = text(pick('.context-menu .atp-status')).trim()
         out.addedViaContext = out.contextStatus.indexOf('1 track added') === 0
         await sleep(1500)

         // --- the playlist now holds both, in the order they were added
         nav('Playlists')
         await sleep(550)
         out.countAfterAdds = countInIndex()
         out.rowsAfterAdds = titles().length

         // --- Alt+Down moves the focused row down one place
         const grid = pick('.list-scroll')
         if (grid) grid.focus()
         await sleep(200)
         if (grid) {
           grid.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
         }
         await sleep(600)
         out.keyboardOrder = titles().join(' | ')

         // --- a drag: row two dropped on the top half of row one
         const rows = pickAll('.track-row')
         if (rows.length === 2) {
           const data = new DataTransfer()
           const fromRow = rows[1]
           const toRow = rows[0]
           const box = toRow.getBoundingClientRect()
           fromRow.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: data }))
           await sleep(150)
           toRow.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: data, clientX: box.left + 60, clientY: box.top + 4 }))
           await sleep(200)
           out.dropLine = Boolean(pick('.track-row.drop-before'))
           toRow.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: data, clientX: box.left + 60, clientY: box.top + 4 }))
           await sleep(700)
         }
         out.dragOrder = titles().join(' | ')

         // --- columns respond to the width of the list itself, not the window:
         // at this window size the playlist list is only ~670px wide, and the
         // title must still have a column (see the container queries in
         // styles.css). A playlist also has no Format column.
         const listEl = pick('.playlist-pane .track-list')
         const titleCell = pick('.playlist-pane .track-row .col-title')
         const artistCell = pick('.playlist-pane .track-row .col-artist')
         const headCells = [...document.querySelectorAll('.playlist-pane .head-cell')].filter((el) => el.offsetWidth > 0)
         out.listWidth = listEl ? Math.round(listEl.getBoundingClientRect().width) : -1
         out.titleWidth = titleCell ? Math.round(titleCell.getBoundingClientRect().width) : -1
         out.artistWidth = artistCell ? Math.round(artistCell.getBoundingClientRect().width) : -1
         out.headerOverflow = headCells.some((el) => el.scrollWidth > el.clientWidth + 1)
         out.formatVisible = Boolean(pick('.playlist-pane .col-format'))

         // --- the index is resizable: a pointer drag, then two arrow keys
         const splitter = pick('.playlist-splitter')
         const indexPane = pick('.playlist-index')
         const indexBox = () => (indexPane ? Math.round(indexPane.getBoundingClientRect().width) : -1)
         const beforeDrag = indexBox()
         if (splitter) {
           splitter.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 1, clientX: 300, clientY: 300 }))
           await sleep(80)
           splitter.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 1, clientX: 364, clientY: 300 }))
           await sleep(80)
           splitter.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1, clientX: 364, clientY: 300 }))
           await sleep(700)
         }
         out.indexBefore = beforeDrag
         out.indexDragged = beforeDrag < 0 ? -1 : indexBox() - beforeDrag
         const beforeKeys = indexBox()
         if (splitter) {
           splitter.focus()
           splitter.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' }))
           await sleep(120)
           splitter.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowLeft' }))
           await sleep(700)
         }
         out.indexKeyboardDelta = beforeKeys < 0 ? 0 : indexBox() - beforeKeys

         // --- nothing spills out of the pane at this window size
         const viewEl = pick('.playlists-view')
         const scroller = pick('.playlist-pane .list-scroll')
         if (viewEl) out.viewOverflow = viewEl.scrollWidth - viewEl.clientWidth
         if (scroller) out.listOverflow = scroller.scrollWidth - scroller.clientWidth
         const actionsCell = pick('.track-row .col-actions')
         const actionButtons = actionsCell ? [...actionsCell.querySelectorAll('button')] : []
         const lastButton = actionButtons[actionButtons.length - 1]
         if (listEl && lastButton) {
           out.actionsInside = lastButton.getBoundingClientRect().right <= listEl.getBoundingClientRect().right + 1
         }

         // --- remove one row with its own button
         const secondRow = pickAll('.track-row')[1]
         press(secondRow ? secondRow.querySelector('button[title="Remove from playlist"]') : null)
         await sleep(600)
         out.rowsAfterRemove = titles().length

         // --- play the playlist
         press(buttonWith('.playlist-pane-head', 'Play'))
         await sleep(800)
         out.playedTitle = barTitle()

         // --- rename it
         press(pick('.playlist-row .icon-button[title="Rename playlist"]'))
         await sleep(300)
         setInput(pick('.playlist-rename .playlist-input'), 'Selftest Renamed')
         await sleep(150)
         press(pick('.playlist-rename button[type="submit"]'))
         await sleep(500)
         out.renamed = text(pick('.playlist-name'))

         // --- save the queue as a playlist from the player window
         nav('Library')
         await sleep(400)
         const toneRow = rowFor('Selftest Tone')
         if (toneRow) toneRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
         await sleep(700)
         press(pick('.player-track'))
         await sleep(700)
         press(pick('.np-queue'))
         await sleep(500)
         press(pick('.np-queue-save'))
         await sleep(350)
         const queueMenu = pick('.np-queue-panel .add-to-playlist')
         out.queueMenuOpened = Boolean(queueMenu)
         press(menuItem('.np-queue-panel .add-to-playlist', 'Selftest Renamed'))
         await sleep(500)
         out.queueStatus = text(pick('.np-queue-panel .atp-status')).trim()
         press(pick('.np-close'))
         await sleep(600)
         nav('Playlists')
         await sleep(500)
         out.countAfterQueueSave = countInIndex()

         // --- delete it (the bin asks once)
         press(pick('.playlist-row .icon-button[title="Delete playlist"]'))
         await sleep(250)
         press(pick('.playlist-row .icon-button[aria-label^="Confirm deleting"]'))
         await sleep(700)
         out.deleted = !pick('.playlist-row')
         out.emptyAfterDelete = text(pick('.empty-state h2')) === 'No playlists yet'
         return out
       })()`
    )

    record(lists.emptyState, 'the Playlists view starts with an empty state')
    record(lists.created, 'a playlist can be created from the form', lists.created)
    record(lists.sidebarCount === '1', 'the sidebar counts the playlists', lists.sidebarCount)
    record(lists.menuOpened && lists.addedViaBar, 'the selection bar adds the selected tracks to a playlist', lists.barStatus)
    record(lists.contextMenuOpened && lists.addedViaContext, 'a row’s context menu adds that track to a playlist', lists.contextStatus)
    record(
      lists.countAfterAdds === 2 && lists.rowsAfterAdds === 2,
      'the playlist lists what was added, in the order it was added',
      `${lists.countAfterAdds} in the index, ${lists.rowsAfterAdds} rows`
    )
    record(
      lists.keyboardOrder === 'Selftest Silent | Selftest Tone',
      'Alt+Down moves the focused row down one place',
      lists.keyboardOrder
    )
    record(
      lists.dropLine && lists.dragOrder === 'Selftest Tone | Selftest Silent',
      'dragging a row onto another moves it there, with a drop line while it hovers',
      lists.dragOrder
    )
    record(
      lists.listWidth > 0 && lists.titleWidth >= 200 && !lists.headerOverflow,
      'the title keeps its column when the list is narrow, and no header label paints over another',
      `list ${lists.listWidth}px, title ${lists.titleWidth}px, header overflow ${lists.headerOverflow}`
    )
    record(
      !lists.formatVisible && lists.artistWidth > 100,
      'a playlist shows the artist and drops the format column',
      `format ${lists.formatVisible}, artist ${lists.artistWidth}px`
    )
    record(
      lists.indexDragged >= 50,
      'dragging the splitter widens the playlist index',
      `moved ${lists.indexDragged}px`
    )
    record(
      lists.indexKeyboardDelta === -32,
      'arrow keys resize the playlist index by one step each',
      `moved ${lists.indexKeyboardDelta}px`
    )
    record(
      container.settings.get().playlists.indexWidth ===
        lists.indexBefore + lists.indexDragged + lists.indexKeyboardDelta,
      'the chosen index width is written to settings',
      `stored ${container.settings.get().playlists.indexWidth}px`
    )
    record(
      lists.viewOverflow === 0 && lists.listOverflow === 0 && lists.actionsInside,
      'the playlist fits its pane: no sideways overflow, every row button inside the card',
      `view ${lists.viewOverflow}, list ${lists.listOverflow}, actions inside ${lists.actionsInside}`
    )
    record(lists.rowsAfterRemove === 1, 'a row can be removed from the playlist', lists.rowsAfterRemove)
    record(lists.playedTitle === 'Selftest Tone', 'playing a playlist puts it in the queue', lists.playedTitle)
    record(lists.renamed === 'Selftest Renamed', 'a playlist can be renamed', lists.renamed)
    record(
      lists.queueMenuOpened && lists.queueStatus.length > 0 && lists.countAfterQueueSave === 2,
      'the queue can be saved as a playlist from the player window',
      `${lists.queueStatus || 'no status'} · count ${lists.countAfterQueueSave}`
    )
    record(lists.deleted && lists.emptyAfterDelete, 'deleting a playlist needs a confirmation and removes it')

    // An imported playlist is seeded here rather than before the layout sweep:
    // section 14a starts from a genuinely empty app, and the sweep does not visit
    // Playlists. `totalCount` is larger than the snapshot on purpose, so the
    // "first N of M" note has something to say.
    container.onlinePlaylists.upsert(
      {
        listId: 'OLAK5uy_selftest',
        kind: 'album',
        title: 'Selftest Album',
        owner: 'Selftest Streamer',
        sourceUrl: 'https://www.youtube.com/playlist?list=OLAK5uy_selftest',
        coverKey: seededArtwork,
        totalCount: 3
      },
      [
        {
          videoId: 'selftestaa1',
          title: 'Online Tone One',
          artist: 'Selftest Streamer',
          album: 'Selftest Album',
          durationMs: 210_000
        },
        {
          videoId: 'selftestbb2',
          title: 'Online Tone Two',
          artist: 'Selftest Streamer',
          album: 'Selftest Album',
          durationMs: 90_000
        }
      ],
      onlineSeed
    )
    // A real import broadcasts; the test announces the seeded one the same way
    // instead of faking a UI state.
    broadcast(IPC_EVENTS.onlineChanged, null)
    record(
      container.onlinePlaylists.count() === 1,
      'online lists: an imported album is seeded as an Online playlist',
      container.onlinePlaylists.count()
    )

    // ---- 14b. the Online view --------------------------------------------
    // Only the paths that need no network are driven: pasting, inline
    // validation and the history actions. Resolving a real link costs a 7-10 s
    // sidecar run, which belongs in the M3 probe, not in a 90 s UI test.
    //
    // The rows were seeded before section 10 so the layout sweep could measure a
    // populated list; here they are read, acted on and finally cleared, which is
    // also where the empty state is checked.
    clipboard.writeText('https://www.youtube.com/watch?v=selftestaa1')
    const onlineView = await evaluate<{
      rows: number
      firstTitle: string
      firstArtist: string
      firstDuration: string
      sidebarCount: string
      rowCovers: number
      rowCoverLoaded: boolean
      rowPlaceholders: number
      pasteFilled: string
      playDisabled: boolean
      invalidError: string
      refusedError: string
      refusedPending: number
      pendingRows: number
      menuItems: string
      saveDisabled: boolean
      removedRows: number
      clearedRows: number
      emptyAfterClear: boolean
    }>(
      window,
      `(async () => {
         const out = { rows: 0, firstTitle: '', firstArtist: '', firstDuration: '', sidebarCount: '', rowCovers: 0, rowCoverLoaded: false, rowPlaceholders: 0, pasteFilled: '', playDisabled: false, invalidError: '', refusedError: '', refusedPending: 0, pendingRows: 0, menuItems: '', saveDisabled: false, removedRows: -1, clearedRows: -1, emptyAfterClear: false }
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
         const pick = (s) => document.querySelector(s)
         const pickAll = (s) => [...document.querySelectorAll(s)]
         const press = (el) => { if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
         const text = (el) => ((el || {}).textContent || '')
         const nav = (label) => {
           const b = pickAll('.nav-item').find((el) => (el.textContent || '').trim().startsWith(label))
           if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
           return Boolean(b)
         }
         const setInput = (el, value) => {
           if (!el) return false
           const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
           desc.set.call(el, value)
           el.dispatchEvent(new Event('input', { bubbles: true }))
           return true
         }
         const buttonWith = (label) => pickAll('.online-bar button').find((el) => text(el).trim().indexOf(label) === 0)

         // Leave and come back so the view mounts fresh and reads the seeded list.
         nav('Library')
         await sleep(400)
         nav('Online')
         await sleep(600)

         out.rows = pickAll('.online-item').length
         out.firstTitle = text(pick('.online-title')).trim()
         out.firstArtist = text(pick('.online-artist')).trim()
         out.firstDuration = text(pick('.online-time')).trim()
         const onlineNav = pickAll('.nav-item').find((el) => (el.textContent || '').trim().startsWith('Online'))
         out.sidebarCount = text(onlineNav ? onlineNav.querySelector('.nav-count') : null).trim()

         // A row draws the cover already on its entry; one with no cover resolves
         // it through the negative-id artwork lookup. The image only counts once
         // the browser has actually decoded it.
         const covers = () => pickAll('.online-art[data-artwork="ready"]')
         for (let i = 0; i < 20 && covers().length === 0; i += 1) await sleep(150)
         out.rowCovers = covers().length
         out.rowCoverLoaded = covers().length > 0 && covers()[0].naturalWidth > 0
         out.rowPlaceholders = pickAll('.online-art[data-artwork="none"]').length

         const play = buttonWith('Play now')
         out.playDisabled = Boolean(play && play.disabled)

         // The Paste button reads the real system clipboard through the bridge.
         press(pick('.online-paste'))
         await sleep(500)
         out.pasteFilled = (pick('.online-input input') || {}).value || ''

         // A link that is not YouTube is refused inline, before any request.
         setInput(pick('.online-input input'), 'not a youtube link')
         await sleep(200)
         press(play)
         await sleep(700)
         out.invalidError = text(pick('.banner')).trim()
         out.pendingRows = pickAll('.online-item.pending').length

         // An account list is refused before any request: the app has no cookies
         // and saying so is better than a yt-dlp failure 10 seconds later.
         setInput(pick('.online-input input'), 'https://www.youtube.com/playlist?list=WL')
         await sleep(200)
         press(play)
         await sleep(500)
         out.refusedError = text(pick('.banner')).trim()
         out.refusedPending = pickAll('.online-item.pending').length

         // Right-click a row: Copy and the (disabled) Save live in the menu.
         const jump = pick('.online-jump')
         if (jump) jump.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 260, clientY: 260 }))
         await sleep(250)
         const items = pickAll('.context-menu .context-item')
         out.menuItems = items.map((el) => text(el).trim()).join(' | ')
         const save = items.find((el) => text(el).indexOf('Save to library') === 0)
         out.saveDisabled = Boolean(save && save.disabled)
         press(items.find((el) => text(el).trim() === 'Copy link'))
         await sleep(300)

         // Remove one row with its own button, then clear the rest.
         press(pickAll('.online-item button[aria-label^="Remove"]')[0])
         await sleep(600)
         out.removedRows = pickAll('.online-item').length

         press(pick('.view-header .link-button'))
         await sleep(250)
         press(pick('.view-header .link-button'))
         await sleep(700)
         out.clearedRows = pickAll('.online-item').length
         out.emptyAfterClear = Boolean(pick('.empty-state'))
         return out
       })()`
    )
    record(onlineView.rows === 3, 'the Online view lists the remembered links', onlineView.rows)
    record(onlineView.firstTitle.indexOf('Online Tone Two') === 0, 'the newest link is listed first', onlineView.firstTitle)
    record(
      onlineView.firstArtist === 'Selftest Streamer',
      'the Online view shows the streaming artist',
      onlineView.firstArtist
    )
    record(onlineView.firstDuration === '1:30', 'the Online view shows the duration', onlineView.firstDuration)
    record(onlineView.sidebarCount === '3', 'the sidebar counts the remembered links', onlineView.sidebarCount)
    record(
      onlineView.rowCovers === 2 && onlineView.rowCoverLoaded && onlineView.rowPlaceholders === 1,
      "a remembered link shows its cover, and one with none shows the placeholder",
      `${onlineView.rowCovers} decoded covers, ${onlineView.rowPlaceholders} placeholders`
    )
    record(onlineView.playDisabled, 'Play now is disabled until a link is typed')
    record(
      onlineView.pasteFilled === 'https://www.youtube.com/watch?v=selftestaa1',
      'the Paste button fills the field from the system clipboard',
      onlineView.pasteFilled
    )
    record(
      onlineView.invalidError.toLowerCase().includes('youtube') && onlineView.pendingRows === 0,
      'a link that is not YouTube shows an inline error and adds no row',
      onlineView.invalidError || 'no error text'
    )
    record(
      onlineView.refusedError.toLowerCase().includes('account') && onlineView.refusedPending === 0,
      'an account list is refused inline, before any request',
      onlineView.refusedError || 'no error text'
    )
    record(
      onlineView.menuItems.indexOf('Play') === 0 &&
        onlineView.menuItems.includes('Add to queue') &&
        onlineView.menuItems.includes('Copy link') &&
        onlineView.menuItems.includes('Remove from history'),
      'a right-click menu offers the row actions',
      onlineView.menuItems
    )
    record(onlineView.saveDisabled, 'Save to library is present but disabled until M4')
    record(onlineView.removedRows === 2, 'a row can be removed from the history', onlineView.removedRows)
    record(
      onlineView.clearedRows === 0 && onlineView.emptyAfterClear,
      'clearing the history needs a confirmation and empties it',
      onlineView.clearedRows
    )

    // ---- 14c. imported playlists in the Playlists view -------------------
    // The album was seeded before the sweep. Here the two groups are read, the
    // album is opened, an entry is removed and the result is played. No network:
    // the snapshot and its cover are already in the database.
    const onlineLists = await evaluate<{
      groupTitles: string
      onlineRows: number
      kind: string
      paneTitle: string
      titles: string
      note: string
      hasReimport: boolean
      hasClear: boolean
      indexCount: string
      rowsAfterRemove: number
      playedTitle: string
      groupEmpty: boolean
      emptyAfterDelete: boolean
    }>(
      window,
      `(async () => {
         const out = { groupTitles: '', onlineRows: -1, kind: '', paneTitle: '', titles: '', note: '', hasReimport: false, hasClear: false, indexCount: '', rowsAfterRemove: -1, playedTitle: '', groupEmpty: false, emptyAfterDelete: false }
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
         const pick = (s) => document.querySelector(s)
         const pickAll = (s) => [...document.querySelectorAll(s)]
         const press = (el) => { if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
         const text = (el) => ((el || {}).textContent || '')
         const nav = (label) => {
           const b = pickAll('.nav-item').find((el) => (el.textContent || '').trim().startsWith(label))
           if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
           return Boolean(b)
         }
         const onlineGroup = () => pickAll('.playlist-group').find((el) => el.getAttribute('aria-label') === 'Online playlists')

         nav('Playlists')
         await sleep(700)

         out.groupTitles = pickAll('.playlist-group-title').map((el) => text(el).trim().split(/\\s+/)[0]).join(' | ')
         const group = onlineGroup()
         out.onlineRows = group ? group.querySelectorAll('.playlist-row').length : -1
         const row = group ? group.querySelector('.playlist-row') : null
         press(row ? row.querySelector('.playlist-open') : null)
         await sleep(600)

         out.kind = text(pick('.playlist-row.active .playlist-kind')).trim()
         out.paneTitle = text(pick('.playlist-pane-head h2')).trim()
         out.titles = pickAll('.track-row .row-title-text').map((el) => text(el)).join(' | ')
         out.note = text(pick('.playlist-note')).trim()
         const buttons = pickAll('.playlist-pane-head button')
         out.hasReimport = buttons.some((el) => text(el).trim().indexOf('Re-import') === 0)
         out.hasClear = buttons.some((el) => text(el).trim().indexOf('Clear') === 0)

         press(pick('.track-row button[title="Remove from this playlist"]'))
         await sleep(700)
         out.rowsAfterRemove = pickAll('.track-row').length
         const groupAfter = onlineGroup()
         out.indexCount = text(groupAfter ? groupAfter.querySelector('.playlist-count') : null).trim()

         press(pickAll('.playlist-pane-head button').find((el) => text(el).trim().indexOf('Play') === 0))
         await sleep(900)
         out.playedTitle = text(pick('.player-title'))

         const arm = pickAll('.playlist-pane-head .link-button').find((el) => text(el).trim().indexOf('Remove') === 0)
         press(arm)
         await sleep(250)
         const confirm = pickAll('.playlist-pane-head .link-button').find((el) => text(el).trim().indexOf('Remove') === 0)
         press(confirm)
         await sleep(800)
         const groupGone = onlineGroup()
         out.groupEmpty = Boolean(groupGone) && groupGone.querySelectorAll('.playlist-row').length === 0
         out.emptyAfterDelete = text(pick('.empty-state h2')).trim() === 'No playlists yet'
         return out
       })()`
    )

    record(onlineLists.groupTitles === 'Custom | Online', 'the Playlists index separates Custom from Online', onlineLists.groupTitles)
    record(onlineLists.onlineRows === 1, 'the imported album appears in the Online group', onlineLists.onlineRows)
    record(onlineLists.kind === 'Album', 'an imported album is labelled as one', onlineLists.kind)
    record(onlineLists.paneTitle === 'Selftest Album', 'opening the imported album shows its snapshot', onlineLists.paneTitle)
    record(
      onlineLists.titles === 'Online Tone One | Online Tone Two',
      'the imported album lists its tracks in source order',
      onlineLists.titles
    )
    record(
      onlineLists.note.indexOf('first 2') >= 0,
      'an import that hit the cap says how much of the list it kept',
      onlineLists.note
    )
    record(
      onlineLists.hasReimport && !onlineLists.hasClear,
      'an imported album offers Re-import rather than Clear',
      `re-import ${onlineLists.hasReimport}, clear ${onlineLists.hasClear}`
    )
    record(
      onlineLists.rowsAfterRemove === 1 && onlineLists.indexCount === '1',
      'removing an imported entry updates the snapshot and the index count',
      `${onlineLists.rowsAfterRemove} rows, index ${onlineLists.indexCount}`
    )
    record(
      onlineLists.playedTitle === 'Online Tone Two',
      'playing an imported album queues its remaining tracks, not the history',
      onlineLists.playedTitle
    )
    record(
      onlineLists.groupEmpty && onlineLists.emptyAfterDelete,
      'removing the imported album needs a confirmation and leaves an empty index',
      `group empty ${onlineLists.groupEmpty}, empty state ${onlineLists.emptyAfterDelete}`
    )
    const copiedLink = await clipboard.readText()
    record(
      copiedLink === 'https://www.youtube.com/watch?v=selftestbb2',
      'Copy link puts the canonical URL on the clipboard',
      copiedLink
    )

    // ---- 15. resuming ----------------------------------------------------
    // A restart cannot be faked from inside the page: the queue lives in a hook,
    // so the only way to know it survives is to throw the page away and let it
    // build itself again. What comes back is only what was written down.
    //
    // The track is left paused before the reload, which is also the awkward case
    // — a pause is an event in the middle of a track, not a track change, so it
    // is the moment a position is most likely to go unsaved.
    const beforeReload = await evaluate<{ title: string; progress: number; paused: boolean }>(
      window,
      `(async () => {
         const out = { title: '', progress: -1, paused: false }
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
         const pick = (s) => document.querySelector(s)
         const text = (el) => ((el || {}).textContent || '')
         const press = (el) => { if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }

         const navTo = [...document.querySelectorAll('.nav-item')].find(
           (el) => text(el).trim().indexOf('Library') === 0
         )
         if (navTo) press(navTo)
         await sleep(500)
         const row = [...document.querySelectorAll('.track-row')].find(
           (el) => text(el.querySelector('.row-title-text')) === 'Selftest Tone'
         )
         if (row) row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
         await sleep(1000)

         // Seek first, then pause: the pause is what pushes the snapshot out
         // immediately, so the position it carries has to be the new one.
         const input = pick('.player-seek input[type="range"]')
         if (input) {
           input.value = String(Math.round(Number(input.max) * 0.2))
           input.dispatchEvent(new Event('input', { bubbles: true }))
           await sleep(80)
           input.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
         }
         await sleep(150)
         const play = pick('.player-bar .icon-button.primary')
         if (play && play.getAttribute('title') === 'Pause') press(play)
         await sleep(400)

         out.title = text(pick('.player-title')).trim()
         const bar = pick('.player-seek')
         out.progress = bar ? parseFloat(getComputedStyle(bar).getPropertyValue('--seek-progress')) : -1
         out.paused = (pick('.player-bar .icon-button.primary') || {}).getAttribute('title') === 'Play'
         return out
       })()`
    )

    window.webContents.reload()

    let afterReload: { title: string; progress: number; paused: boolean; queue: number } | null = null
    const restoreDeadline = Date.now() + 15_000
    while (Date.now() < restoreDeadline) {
      try {
        afterReload = await evaluate<{ title: string; progress: number; paused: boolean; queue: number }>(
          window,
          `(() => {
             const pick = (s) => document.querySelector(s)
             const text = (el) => ((el || {}).textContent || '')
             const bar = pick('.player-seek')
             const raw = bar ? getComputedStyle(bar).getPropertyValue('--seek-progress') : ''
             const play = pick('.player-bar .icon-button.primary')
             const queue = pick('.queue-button')
             const digits = String(queue ? queue.getAttribute('title') : '').replace(/[^0-9]/g, '')
             return {
               title: text(pick('.player-title')).trim(),
               progress: raw ? parseFloat(raw) : -1,
               paused: (play ? play.getAttribute('title') : '') === 'Play',
               queue: digits.length > 0 ? Number(digits) : 0
             }
           })()`
        )
      } catch {
        afterReload = null
      }
      if (afterReload && afterReload.title.length > 0 && afterReload.progress > 0) break
      await delay(250)
    }

    record(
      beforeReload.title.length > 0 && afterReload?.title === beforeReload.title,
      'a restart brings back the track that was playing',
      `${beforeReload.title || 'nothing'} -> ${afterReload?.title || 'nothing'}`
    )
    record(
      afterReload !== null && Math.abs(afterReload.progress - beforeReload.progress) < 8,
      'and the position it was at',
      `${beforeReload.progress}% -> ${afterReload?.progress ?? -1}%`
    )
    record(
      afterReload?.paused === true,
      'restoring leaves it paused instead of making noise on its own',
      beforeReload.paused ? 'was already paused' : 'was playing'
    )
    record(
      afterReload?.queue === 2,
      'and the whole queue is back, not just the track',
      `${afterReload?.queue ?? -1} tracks in the queue`
    )
  } catch (error) {
    failures += 1
    console.log(`SELFTEST FAIL  harness threw: ${describe(error)}`)
    log.error('selftest harness threw', error)
  } finally {
    clearTimeout(watchdog)
  }

  return finish(failures)
}

function finish(failures: number, note?: string): number {
  if (note) console.log(`SELFTEST NOTE  ${note}`)
  const verdict = failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`
  console.log(`SELFTEST RESULT  ${verdict}`)
  return failures
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Polls a condition that something *outside* this process is responsible for —
 * a file system watcher, or a scan it started. There is no promise to await.
 */
async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return true
    await delay(100)
  }
  return condition()
}

interface LayoutProbe {
  width: number
  page: number
  main: number
  cards: number
  table: number
  bar: number
  nowPlaying: number
  hasCards: boolean
  hasTable: boolean
  hasQueue: boolean
  online: number
  hasOnline: boolean
  hasNowPlaying: boolean
}

/**
 * Reports how many pixels each scroll container overflows sideways. Zero means
 * the view fits; anything positive is a horizontal scrollbar the user can see.
 */
const LAYOUT_PROBE = `(() => {
  const overflow = (selector) => {
    const el = document.querySelector(selector)
    return el ? Math.max(0, el.scrollWidth - el.clientWidth) : 0
  }
  return {
    width: window.innerWidth,
    page: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    main: overflow('.main-view'),
    cards: overflow('.cards'),
    table: overflow('.list-scroll'),
    bar: overflow('.player-bar'),
    nowPlaying: overflow('.now-playing'),
    hasCards: Boolean(document.querySelector('.cards')),
    hasTable: Boolean(document.querySelector('.list-scroll') && document.querySelector('.track-head')),
    hasQueue: Boolean(document.querySelector('.queue-list')),
    online: overflow('.online-list'),
    hasOnline: Boolean(document.querySelector('.online-list')),
    hasNowPlaying: Boolean(document.querySelector('.now-playing')),
    offenders: (() => {
      // Elements whose right edge sits past the view's content box. This is what
      // actually pushes the scrollbar out: an element can be laid out wider than
      // its parent without ever reporting scrollWidth > clientWidth itself.
      const main = document.querySelector('.main-view')
      if (!main) return []
      const limit = main.getBoundingClientRect().right - 24
      const out = []
      main.querySelectorAll('*').forEach((el) => {
        const rect = el.getBoundingClientRect()
        if (rect.right > limit + 1) {
          out.push({
            tag: el.tagName,
            cls: (el.getAttribute('class') || '').slice(0, 40),
            right: Math.round(rect.right),
            w: Math.round(rect.width)
          })
        }
      })
      return out.sort((a, b) => b.right - a.right).slice(0, 5)
    })()
  }
})()`

async function evaluate<T>(window: BrowserWindow, expression: string): Promise<T> {
  // userGesture: true keeps Chromium's autoplay policy out of the way, since a
  // real user would have clicked by this point.
  return (await window.webContents.executeJavaScript(expression, true)) as T
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
