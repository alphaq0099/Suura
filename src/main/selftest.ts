import { execFile } from 'node:child_process'
import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, BrowserWindow, net } from 'electron'
import { probeExecutable } from '@engine/sidecar/locate'
import { buildMediaUrl } from '@shared/media-url'
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
    console.log('SELFTEST FAIL  test harness timed out after 60s')
    app.exit(1)
  }, 60_000)

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
           const source = await window.player.resolveSource(tracks.tracks[0].id)
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

      const showView = async (label: 'Library' | 'Settings' | 'Queue'): Promise<void> => {
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
      escapeKeptWindow: boolean
      escapeClosedWindow: boolean
    }>(
      window,
      `(async () => {
         const out = { shapeReachesThumbnails: false, fitIsProportional: false, fitRatio: -1, fitIsLive: false, fitIsPlayerOnly: false, fitIsDisabledWhenRound: false, circleCropsTheBox: false, settingsRestored: false, barGlowOnBar: false, tileGlowGone: false, glowMasked: false, volumeBefore: -1, volumeMuted: -1, mutePressed: '', volumeRestored: -1, volumeBeforeWheel: -1, volumeAfterWheel: -1, volumeWheelTop: -1, volumeWheelBottom: -1, wheelCancelled: false, panelClosedByOutsidePress: false, panelStayedOpenOnInsidePress: false, popoverHidden: false, panelAtRest: false, queueRows: 0, queueLabels: '', queueCurrent: 0, truncates: false, panelOpened: false, panelRowsFit: false, shadowFades: false, shadowStyle: '', jumped: false, panelStayedOpen: false, escapeHidPanel: false, escapeKeptWindow: false, escapeClosedWindow: false }
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
         out.panelAtRest = panel() ? getComputedStyle(panel()).visibility === 'hidden' : false
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
         out.panelClosedByOutsidePress = panel() ? getComputedStyle(panel()).visibility === 'hidden' : false
         press(pick('.np-queue'))
         await sleep(400)
         pressAt(rows().length ? rows()[0] : null)
         await sleep(400)
         out.panelStayedOpenOnInsidePress = panel() ? getComputedStyle(panel()).visibility === 'visible' : false

         // Escape unwinds one layer at a time, and both layers are checked: the
         // panel first, then the window.
         pressEscape()
         await sleep(400)
         out.escapeHidPanel = panel() ? getComputedStyle(panel()).visibility === 'hidden' : false
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
      'pressing the black space or the artwork shuts the queue panel'
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
