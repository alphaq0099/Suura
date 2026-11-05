import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { app, BrowserWindow, clipboard, dialog, net } from 'electron'
import { probeExecutable } from '@engine/sidecar/locate'
import { extractMetadata } from '@core/library/metadata'
import { IPC_EVENTS } from '@shared/ipc'
import { mergeLibrarySearch } from '@shared/search'
import type { ArtworkChoice, TagLookupQuery } from '@shared/types'
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
    // The suite covers the whole app now, and a cold Windows launch plus the
    // media checks can sit well past the old two-minute guard. A timeout here
    // still fails the run; it just no longer cuts off a healthy one.
    console.log('SELFTEST FAIL  test harness timed out after 300s')
    app.exit(1)
  }, 300_000)

  try {
    // Let the first render and the initial IPC round-trips settle.
    await delay(1200)

    // ---- 1. the renderer actually mounted -------------------------------
    const boot = await evaluate<{
      hasBridge: boolean
      hasReactRoot: boolean
      hasSidebar: boolean
      hasPlayerBar: boolean
      fileBridge: { ok: boolean; detail: string }
      title: string
    }>(
      window,
      `(() => ({
         hasBridge: typeof window.player === 'object' && typeof window.player.listTracks === 'function',
         hasReactRoot: Boolean(document.querySelector('.app, .boot-screen')),
         hasSidebar: Boolean(document.querySelector('.sidebar')),
         hasPlayerBar: Boolean(document.querySelector('.player-bar')),
         fileBridge: (() => {
           try {
             const file = new File(['selftest'], 'selftest.txt', { type: 'text/plain' })
             const path = window.player.getPathForFile(file)
             return { ok: typeof path === 'string', detail: 'type ' + typeof path }
           } catch (error) {
             return { ok: false, detail: String(error) }
           }
         })(),
         title: document.title
       }))()`
    )
    record(boot.hasBridge, 'preload exposes the Suura bridge on window.player')
    record(boot.hasReactRoot, 'React mounted a view')
    record(boot.hasSidebar, 'sidebar rendered')
    record(boot.hasPlayerBar, 'player bar rendered')
    record(
      boot.fileBridge.ok,
      'preload can reach webUtils for dropped files under the renderer sandbox',
      boot.fileBridge.detail
    )
    const webPreferences = (
      window.webContents as unknown as {
        getLastWebPreferences?: () => Electron.WebPreferences
      }
    ).getLastWebPreferences?.()
    record(
      webPreferences?.sandbox === true &&
        webPreferences?.contextIsolation === true &&
        webPreferences?.nodeIntegration === false,
      'renderer keeps context isolation, no Node and the sandbox',
      {
        sandbox: webPreferences?.sandbox,
        contextIsolation: webPreferences?.contextIsolation,
        nodeIntegration: webPreferences?.nodeIntegration
      }
    )
    record(boot.title === 'Suura', 'document title is set', boot.title)

    // ---- 2. the engine layer can find ffmpeg ---------------------------
    const ffmpeg = await probeExecutable('ffmpeg', { versionArgs: ['-version'] })
    record(ffmpeg.found, 'ffmpeg is available to generate a fixture', ffmpeg.error)
    if (!ffmpeg.found || !ffmpeg.path) {
      return finish(failures, 'cannot continue without ffmpeg')
    }
    // Captured once: property narrowing does not survive into a callback.
    const ffmpegExe = ffmpeg.path

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
        // Timed on purpose: the lyrics panel is driven against a real LRC tag,
        // so it can tell a synced line from a plain one and can be asked to
        // follow the song.
        '-metadata',
        'lyrics=[00:00.50]first line\n[00:01.50]second line',
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

    // ---- 3b. home and the merged track list ------------------------------
    // Home is the first thing a new install shows, so these checks start there
    // before the rest of the suite moves to the Library. They exercise the same
    // merged feed the dashboard uses: files, listens and links in one list,
    // deduped and newest activity first, with each row naming its source.
    const home = await evaluate<{
      isHome: boolean
      activeNav: string
      heroTitle: string
      stats: string
      shelfTitles: string
      shelfAlbums: number
      artistCards: number
      allRows: number
      allBadges: string
      searchEmpty: boolean
      searchCleared: boolean
      artistKicker: string
      artistTitle: string
      artistRows: number
      artistBackWorks: boolean
      onLibrary: boolean
      heroAction: string
      heroActionCount: number
      heroResumeAfter: string
      heroHasLastScan: boolean
      heroScanNote: boolean
      shelfHints: number
      moreLabels: string
      moreFocusedList: boolean
      activeElement: string
      moreHeading: string
      moreChip: string
      moreOnlyLibrary: boolean
      chipCleared: boolean
      chipHeading: string
      statBlur: string
      statTint: string
      slideCount: number
      slideLayers: number
      activeSlides: number
      slideState: string
      reducedStops: boolean
      fullState: string
      heroMatchesRecent: boolean
      heroStatsInCopy: boolean
      heroStatsOutside: boolean
      heroTagline: boolean
      heroLightOpacity: string
      heroDarkOpacity: string
      heroActionsAfterLivePlay: number
      sourceHeading: string
      badgesInSource: number
      badgesInTitle: number
      toolsBelowHeading: boolean
      cardFocus: boolean
      cardLift: number
      cardRest: number
      livePlayShelf: boolean
      livePlayCard: string
    }>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const nav = (label) =>
           [...document.querySelectorAll('.nav-item')].find((el) =>
             (el.textContent || '').trim().startsWith(label)
           )
         const waitFor = async (select, timeout = 6000) => {
           const deadline = Date.now() + timeout
           while (Date.now() < deadline && !document.querySelector(select)) await sleep(100)
           return document.querySelector(select)
         }
         const allRows = () => [...document.querySelectorAll('.all-tracks-list .track-row')]
         const allBadges = () =>
           [...document.querySelectorAll('.all-tracks-list .track-row .row-badge')]
             .map((el) => (el.textContent || '').trim())
             .join('|')
         const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
         const translateY = (element) => {
           if (!element) return 0
           const transform = getComputedStyle(element).transform
           return transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42
         }

         const out = {
           isHome: false, activeNav: '', heroTitle: '', stats: '', shelfTitles: '',
           shelfAlbums: 0, artistCards: 0, allRows: 0, allBadges: '',
           searchEmpty: false, searchCleared: false,
           artistKicker: '', artistTitle: '', artistRows: 0, artistBackWorks: false,
           onLibrary: false,
           heroAction: '', heroActionCount: 0, heroResumeAfter: '', heroHasLastScan: false,
           heroScanNote: false,
           shelfHints: 0, moreLabels: '', moreFocusedList: false, moreHeading: '',
           activeElement: '',
           moreChip: '', moreOnlyLibrary: false, chipCleared: false, chipHeading: '',
           statBlur: '', statTint: '', slideCount: 0,
           slideLayers: 0, activeSlides: 0, slideState: '', reducedStops: false,
           fullState: '', heroMatchesRecent: false, heroStatsInCopy: false,
           heroStatsOutside: false, heroTagline: false, heroLightOpacity: '',
           heroDarkOpacity: '', heroActionsAfterLivePlay: -1, sourceHeading: '',
           badgesInSource: -1, badgesInTitle: -1, toolsBelowHeading: false,
           cardFocus: false, cardLift: 0, cardRest: 0,
           livePlayShelf: false, livePlayCard: ''
         }

         nav('Home')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(350)
         await waitFor('.all-tracks-list .track-row')
         await waitFor('.home-shelf .album-card')
         out.isHome = Boolean(document.querySelector('.home-view'))
         out.activeNav = (document.querySelector('.nav-item.active')?.textContent || '').trim()
         out.heroTitle = (document.querySelector('.home-hero-copy h2')?.textContent || '').trim()
         out.stats = [...document.querySelectorAll('.home-stat strong')]
           .map((el) => (el.textContent || '').trim())
           .join('|')
         out.shelfTitles = [...document.querySelectorAll('.home-section-head h2')]
           .map((el) => (el.textContent || '').trim())
           .join('|')
         out.shelfAlbums = document.querySelectorAll('.home-shelf .album-card').length
         out.artistCards = document.querySelectorAll('.artist-card').length
         out.allRows = allRows().length
         out.allBadges = allBadges()
         out.heroStatsInCopy = Boolean(document.querySelector('.home-hero-copy > .home-stats'))
         out.heroStatsOutside = Boolean(document.querySelector('.home-hero > .home-stats'))
         // The Source column replaces Album in the merged feed, and the badge
         // belongs in that cell rather than trailing the title.
         out.sourceHeading = (document.querySelector('.all-tracks-list .track-head .col-source')?.textContent || '').trim()
         out.badgesInSource = document.querySelectorAll('.all-tracks-list .track-row .col-source .row-badge').length
         out.badgesInTitle = document.querySelectorAll('.all-tracks-list .track-row .col-title .row-badge').length
         const toolsRow = document.querySelector('.all-tracks-tools')
         const headingBlock = document.querySelector('.all-tracks-head > div')
         out.toolsBelowHeading = Boolean(
           toolsRow && headingBlock &&
           toolsRow.getBoundingClientRect().top >= headingBlock.getBoundingClientRect().bottom - 1
         )

         // The stat boxes are glass over artwork: they need an accent wash and a
         // real backdrop blur, not a flat panel. The hero keeps one active image
         // layer at a time, and the motion preference only reaches it through the
         // root attribute the app already owns.
         const hero = document.querySelector('.home-hero')
         const stat = document.querySelector('.home-stat')
         const statStyle = stat ? getComputedStyle(stat) : null
         out.statBlur = statStyle ? statStyle.backdropFilter : ''
         out.statTint = statStyle ? statStyle.backgroundImage : ''
         out.slideCount = Number(hero?.getAttribute('data-slide-count') || 0)
         out.slideLayers = document.querySelectorAll('.home-hero > .home-hero-backdrop').length
         out.activeSlides = document.querySelectorAll('.home-hero > .home-hero-backdrop.active').length
         out.slideState = hero?.getAttribute('data-slide-state') || ''
         const root = document.documentElement
         const previousMotion = root.dataset.motion || 'system'
         root.dataset.motion = 'reduced'
         await sleep(160)
         out.reducedStops = hero?.getAttribute('data-slide-state') === 'still'
         root.dataset.motion = 'full'
         await sleep(160)
         out.fullState = hero?.getAttribute('data-slide-state') || ''
         root.dataset.motion = previousMotion
         await sleep(160)
         // The art is meant to be at full strength in both themes. Opacity is
         // read per theme because the light rule used to be the weak one; the
         // active layer is settled by now, and a theme switch does not restart
         // its opacity transition.
         const activeSlide = document.querySelector('.home-hero-backdrop.active')
         out.heroDarkOpacity = activeSlide ? getComputedStyle(activeSlide).opacity : ''
         const previousTheme = root.dataset.theme || 'dark'
         root.dataset.theme = 'light'
         await sleep(120)
         out.heroLightOpacity = activeSlide ? getComputedStyle(activeSlide).opacity : ''
         root.dataset.theme = previousTheme
         await sleep(120)

         // Card clicks are covered in the Home shelf section below: a single
         // plays, a real album opens its detail. Leaving them out here keeps the
         // library click test below starting from nothing already playing.

         const search = document.querySelector('.tracks-search input')
         if (search) {
           setValue.call(search, 'NoSuchAlbum')
           search.dispatchEvent(new Event('input', { bubbles: true }))
         }
         await waitFor('.all-tracks-empty')
         out.searchEmpty = Boolean(document.querySelector('.all-tracks-empty'))
         document.querySelector('.clear-search')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         let deadline = Date.now() + 5000
         while (Date.now() < deadline && allRows().length < 2) await sleep(100)
         out.searchCleared = allRows().length === 2

         // An artist card opens the artist's tracks. A credit can exist without
         // an album card, and the detail view is the honest place for both cases.
         const artistCard = [...document.querySelectorAll('.artist-card')].find(
           (card) => (card.querySelector('.artist-card-name')?.textContent || '').trim() === 'Selftest'
         )
         artistCard?.querySelector('.artist-card-main')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         const artistDeadline = Date.now() + 6000
         let artistDetail = null
         while (Date.now() < artistDeadline) {
           artistDetail = document.querySelector('.album-detail')
           if (artistDetail && artistDetail.querySelector('.track-row')) break
           await sleep(100)
         }
         out.artistKicker = (artistDetail?.querySelector('.home-kicker')?.textContent || '').trim()
         out.artistTitle = (artistDetail?.querySelector('.album-detail-copy h2')?.textContent || '').trim()
         out.artistRows = artistDetail?.querySelectorAll('.track-row').length || 0
         artistDetail?.querySelector('.home-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         const artistBackDeadline = Date.now() + 6000
         while (Date.now() < artistBackDeadline && !document.querySelector('.all-tracks-list')) await sleep(100)
         out.artistBackWorks = Boolean(document.querySelector('.all-tracks-list')) && !artistDetail?.isConnected

         // A shelf's More must lead somewhere real: it turns the list at the
         // bottom of Home into the full version of that shelf, filters it and
         // names the filter in a chip. The hero carries one contextual action,
         // never a copy of the header buttons and never a scan date.
         const heroText = (document.querySelector('.home-hero-copy')?.textContent || '').trim()
         out.heroAction = (document.querySelector('.home-hero-actions .primary')?.textContent || '').trim()
         out.heroActionCount = document.querySelectorAll('.home-hero-actions .primary').length
         out.heroHasLastScan = heroText.includes('Last scan')
         out.heroScanNote = Boolean(document.querySelector('.home-scan-note'))
         out.heroTagline = heroText.includes('full library one click away')
         out.shelfHints = document.querySelectorAll('.home-section-head > span').length
         out.moreLabels = [...document.querySelectorAll('.home-more')]
           .map((el) => el.getAttribute('aria-label'))
           .join('|')
         const moreAdded = [...document.querySelectorAll('.home-more')].find(
           (el) => el.getAttribute('aria-label') === 'More recently added tracks'
         )
         moreAdded?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         const moreDeadline = Date.now() + 6000
         while (Date.now() < moreDeadline) {
           const heading = (document.querySelector('.all-tracks-head h2')?.textContent || '').trim()
           const chip = (document.querySelector('.all-tracks-chip')?.textContent || '').trim()
           if (heading === 'Recently added' && chip.includes('Recently added') && allRows().length === 2) break
           await sleep(100)
         }
          const moreFocusDeadline = Date.now() + 4000
          while (
            Date.now() < moreFocusDeadline &&
            document.activeElement !== document.querySelector('.all-tracks-head h2')
          ) {
            await sleep(50)
          }
         out.moreFocusedList = document.activeElement === document.querySelector('.all-tracks-head h2')
         out.activeElement = document.activeElement
           ? document.activeElement.tagName + '.' + String(document.activeElement.className)
           : 'none'
         out.moreHeading = (document.querySelector('.all-tracks-head h2')?.textContent || '').trim()
         out.moreChip = (document.querySelector('.all-tracks-chip')?.textContent || '').trim()
         out.moreOnlyLibrary = allRows().length === 2 && allBadges() === 'Library|Library'
         document.querySelector('.all-tracks-chip')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         const chipDeadline = Date.now() + 6000
         while (Date.now() < chipDeadline) {
           const heading = (document.querySelector('.all-tracks-head h2')?.textContent || '').trim()
           if (heading === 'All tracks' && !document.querySelector('.all-tracks-chip') && allRows().length === 2) break
           await sleep(100)
         }
         out.chipCleared = !document.querySelector('.all-tracks-chip') && allRows().length === 2
         out.chipHeading = (document.querySelector('.all-tracks-head h2')?.textContent || '').trim()

         // Hover is not available to a script, so focus the card's own main
         // control: the same :focus-within state a keyboard user gets. The card
         // must move up rather than draw a shadow over its artwork.
         const liftCard = document.querySelector('.home-shelf .album-card')
         const liftMain = liftCard?.querySelector('.album-card-main')
         liftMain?.focus()
         await sleep(280)
         out.cardFocus = document.activeElement === liftMain
         out.cardLift = translateY(liftCard)

         liftMain?.blur()
         await sleep(280)
         out.cardRest = translateY(liftCard)

         // A counted listen must refresh Recently played while Home is still
         // mounted. Real playback sends this report as soon as a track crosses
         // the threshold; the check here proves the shelf reacts without a
         // navigation or a manual reload.
         const hadRecentShelf = [...document.querySelectorAll('.home-section-head h2')].some(
           (el) => (el.textContent || '').trim() === 'Recently played'
         )
         const tracksPage = await window.player.listTracks({ limit: 20 })
         const tone = tracksPage.tracks.find((track) => track.title === 'Selftest Tone')
         if (tone) await window.player.reportPlayback(tone.id, 31_000, false)
         deadline = Date.now() + 5000
         let recentShelf = null
         while (Date.now() < deadline) {
           recentShelf = [...document.querySelectorAll('.home-section')].find(
             (section) =>
               (section.querySelector('.home-section-head h2')?.textContent || '').trim() ===
               'Recently played'
           )
           if (recentShelf) break
           await sleep(100)
         }
         out.livePlayShelf = !hadRecentShelf && Boolean(recentShelf)
         // The two base fixtures share an album title but have different
         // artists, so each is a one-file release and the shelf's newest card
         // is the track card for the file that was just played.
         out.livePlayCard = (recentShelf?.querySelector('.album-card-title')?.textContent || '').trim()
         // The hero action follows that same shelf: it names the newest listen
         // as a resume instead of replaying a fixed album.
         out.heroResumeAfter = (
           document.querySelector('.home-hero-actions .primary')?.textContent || ''
         ).trim()
         out.heroActionsAfterLivePlay = document.querySelectorAll('.home-hero-actions .primary').length

         // The backdrop must be the art of that newest card, not a separate
         // album query that can lag behind what was actually played. Resolve
         // the card's own cover first, then wait for the crossfade to point at
         // the same cache key.
         const shelfCover = recentShelf
           ?.querySelector('.album-card .artwork[data-artwork="ready"]')
           ?.getAttribute('src') || ''
         const heroDeadline = Date.now() + 5000
         let heroSrc = ''
         while (Date.now() < heroDeadline) {
           heroSrc = document.querySelector('.home-hero-backdrop.active')?.getAttribute('src') || ''
           if (shelfCover && heroSrc === shelfCover) break
           await sleep(100)
         }
         out.heroMatchesRecent = Boolean(shelfCover) && heroSrc === shelfCover

          return out
        })()`
    )
    // Hover is independent of window focus, unlike :focus, so this is stable
    // even when the test window sits behind the terminal.
    let playHover = {
      hovered: false,
      background: '',
      text: '',
      accent: '',
      contrast: ''
    }
    // The box can go stale: Home keeps loading shelves in the background, and a
    // section appearing above a card moves its badge. Each attempt scrolls the
    // badge into view, measures it and moves the pointer, so a late shelf costs
    // one retry instead of failing a check about colour.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const hoverTarget = await evaluate<{ x: number; y: number }>(
        window,
        `(async () => {
           const badge = document.querySelector('.home-shelf .album-card .album-card-play')
           if (!badge) return { x: 0, y: 0 }
           badge.scrollIntoView({ block: 'center' })
           await new Promise((resolve) => setTimeout(resolve, 180))
           const box = badge.getBoundingClientRect()
           return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
         })()`
      )
      if (!(hoverTarget.x > 0 && hoverTarget.y > 0)) break
      window.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(hoverTarget.x),
        y: Math.round(hoverTarget.y)
      })
      await delay(220)
      playHover = await evaluate<typeof playHover>(
        window,
        `(() => {
           const badge = document.querySelector('.home-shelf .album-card .album-card-play')
           const probe = document.createElement('span')
           probe.style.background = 'var(--accent-strong)'
           document.body.append(probe)
           const accent = getComputedStyle(probe).backgroundColor
           probe.style.background = 'var(--accent-contrast)'
           const contrast = getComputedStyle(probe).backgroundColor
           probe.remove()
           return {
             hovered: Boolean(badge?.matches(':hover')),
             background: badge ? getComputedStyle(badge).backgroundColor : '',
             text: badge ? getComputedStyle(badge).color : '',
             accent,
             contrast
           }
         })()`
      )
      if (playHover.hovered) break
      await delay(250)
    }
    if (playHover.hovered) {
      window.webContents.sendInputEvent({ type: 'mouseMove', x: 2, y: 2 })
      await delay(60)
    }
    // ---- 3c. a played single with no album tag -------------------------
    // Recently played is an album shelf, so a file without an album tag has no
    // album card to appear on. A counted listen must still surface it, and the
    // only honest card for that case is the track itself. The fixtures both
    // belong to an album, so this inserts one temporary single into the same
    // DB, reports the listen through the service the IPC handler uses, reads
    // the live shelf back, and then removes the row again.
    const singleId = container.repo.insert(
      {
        contentKey: 'selftest-albumless-single',
        sourceKind: 'local',
        sourceId: null,
        originKind: null,
        originId: null,
        title: 'Selftest Single',
        artist: 'Selftest Artist',
        albumArtist: null,
        album: null,
        trackNo: null,
        discNo: null,
        trackTotal: null,
        discTotal: null,
        year: null,
        genre: null,
        durationMs: 180_000,
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
    container.library.reportPlayback(singleId, 31_000, false)
    const playedSingle = await evaluate<{
      found: boolean
      title: string
      meta: string
      playLabel: string
    }>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const deadline = Date.now() + 6000
         let card = null
         while (Date.now() < deadline) {
           card = [...document.querySelectorAll('.home-shelf .track-card')].find(
             (entry) =>
               ((entry.querySelector('.album-card-title')?.textContent || '').trim()) ===
               'Selftest Single'
           )
           if (card) break
           await sleep(100)
         }
         return {
           found: Boolean(card),
           title: (card?.querySelector('.album-card-title')?.textContent || '').trim(),
           meta: (card?.querySelector('.album-card-meta')?.textContent || '').trim(),
           playLabel: card?.querySelector('.album-card-play')?.getAttribute('aria-label') || ''
         }
       })()`
    )
    container.library.removeTracks([singleId])
    record(
      playedSingle.found &&
        playedSingle.title === 'Selftest Single' &&
        playedSingle.meta.includes('Selftest Artist') &&
        playedSingle.playLabel === 'Play Selftest Single',
      'home: a counted listen from a file with no album tag appears as a track card',
      playedSingle
    )

    home.onLibrary = await evaluate<boolean>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const nav = (label) =>
           [...document.querySelectorAll('.nav-item')].find((el) =>
             (el.textContent || '').trim().startsWith(label)
           )
         nav('Library')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         const deadline = Date.now() + 6000
         while (Date.now() < deadline && !document.querySelector('.track-row')) await sleep(100)
         return Boolean(document.querySelector('.track-row'))
       })()`
    )
    record(
      home.isHome && home.activeNav.startsWith('Home'),
      'home is the initial view and marks itself in the sidebar',
      { active: home.activeNav, stats: home.stats }
    )
    record(
      home.stats.startsWith('2|2|2|') &&
        home.heroTitle.includes('at a glance') &&
        home.shelfTitles.includes('Recently added') &&
        home.shelfAlbums === 2 &&
        home.artistCards === 2 &&
        home.allRows === 2 &&
        home.allBadges === 'Library|Library',
      'home shows library stats, shelves, artists and one merged track list',
      {
        stats: home.stats,
        shelves: home.shelfTitles,
        albums: home.shelfAlbums,
        artists: home.artistCards,
        rows: home.allRows,
        badges: home.allBadges
      }
    )
    record(
      home.heroStatsInCopy &&
        !home.heroStatsOutside &&
        !home.heroTagline &&
        home.heroActionCount === 0,
      'home: the hero puts stats under its heading and leaves the right side to the art',
      {
        statsInCopy: home.heroStatsInCopy,
        statsOutside: home.heroStatsOutside,
        tagline: home.heroTagline,
        action: home.heroActionCount
      }
    )
    record(
      home.heroDarkOpacity === '1' && home.heroLightOpacity === '1',
      'home: the hero art shows at full strength in both themes',
      { dark: home.heroDarkOpacity, light: home.heroLightOpacity }
    )
    record(
      home.sourceHeading === 'Source' &&
        home.badgesInSource === 2 &&
        home.badgesInTitle === 0 &&
        home.toolsBelowHeading,
      'home: All tracks names a Source column and puts its tools under the heading',
      {
        heading: home.sourceHeading,
        inSource: home.badgesInSource,
        inTitle: home.badgesInTitle,
        toolsBelow: home.toolsBelowHeading
      }
    )
    record(
      home.searchEmpty && home.searchCleared,
      'the track list can search down to nothing and clear again',
      { empty: home.searchEmpty, cleared: home.searchCleared }
    )
    record(
      home.artistKicker === 'Artist' &&
        home.artistTitle === 'Selftest' &&
        home.artistRows === 1 &&
        home.artistBackWorks,
      "an artist card opens the artist's tracks and returns to Home",
      {
        kicker: home.artistKicker,
        title: home.artistTitle,
        rows: home.artistRows,
        back: home.artistBackWorks
      }
    )
    record(
      home.moreLabels === 'More recently added tracks' &&
        home.shelfHints === 0 &&
        home.moreFocusedList &&
        home.moreHeading === 'Recently added' &&
        home.moreChip.includes('Recently added') &&
        home.moreOnlyLibrary &&
        home.chipCleared &&
        home.chipHeading === 'All tracks',
      'home: a shelf More filters the list below and a chip clears the filter',
      {
        more: home.moreLabels,
        hints: home.shelfHints,
        focusedList: home.moreFocusedList,
        active: home.activeElement,
        heading: home.moreHeading,
        chip: home.moreChip,
        sources: home.moreOnlyLibrary,
        cleared: home.chipCleared,
        clearedHeading: home.chipHeading
      }
    )
    record(
      home.heroActionCount === 0 &&
        home.heroActionsAfterLivePlay === 0 &&
        !home.heroHasLastScan &&
        !home.heroScanNote,
      'home: the hero never becomes a second transport or a scan readout',
      { action: home.heroAction, count: home.heroActionCount, lastScan: home.heroHasLastScan }
    )
    record(
      home.statBlur.includes('blur') &&
        home.statTint.includes('gradient') &&
        home.slideLayers === home.slideCount &&
        home.slideCount >= 1 &&
        home.activeSlides === 1 &&
        home.reducedStops &&
        home.fullState === (home.slideCount > 1 ? 'running' : 'still'),
      'home: stat cards take an accent-tinted blur and the hero crossfades its covers',
      {
        blur: home.statBlur,
        tint: home.statTint.slice(0, 80),
        slides: home.slideCount,
        layers: home.slideLayers,
        active: home.activeSlides,
        state: home.slideState,
        reduced: home.reducedStops,
        full: home.fullState
      }
    )
    record(
      home.heroMatchesRecent,
      'home: the hero backdrop follows the newest Recently played card',
      home.heroMatchesRecent
        ? 'the active layer uses the first card cover'
        : 'the active layer did not match the first card cover'
    )
    record(
      home.cardFocus && Math.abs(home.cardLift + 4) < 0.5 && Math.abs(home.cardRest) < 0.5,
      'home: album cards lift on keyboard focus instead of gaining a shadow',
      { focused: home.cardFocus, lift: home.cardLift, rest: home.cardRest }
    )
    record(
      playHover.hovered &&
        playHover.background === playHover.accent &&
        playHover.text === playHover.contrast &&
        Boolean(playHover.accent),
      'home: the card play badge keeps its accent on hover',
      playHover
    )
    record(
      home.livePlayShelf && home.livePlayCard === 'Selftest Tone',
      'home: a counted listen refreshes Recently played while the view stays open',
      { shelf: home.livePlayShelf, card: home.livePlayCard }
    )
    record(
      home.heroResumeAfter === '' && home.heroActionsAfterLivePlay === 0,
      'home: a counted listen still leaves the hero without a resume button',
      home.heroResumeAfter || 'no action'
    )
    record(home.onLibrary, 'the Home dashboard can hand off to the full library')

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
           // Exercise the CORS path the Web Audio chain uses, so a tainted
           // element cannot pass this check while producing silence.
           audio.crossOrigin = 'anonymous'
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
    record(
      full.headers.get('access-control-allow-origin') === '*',
      'protocol allows Web Audio to read the samples',
      full.headers.get('access-control-allow-origin')
    )
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
      queueHead: string
      queueHeadOverflow: boolean
      queueAligned: boolean
      queueCountLabel: string
      repeatTitle: string
      repeatAfterClick: string
      shufflePressed: string
      shuffleAfterClick: string
    }>(
      window,
      `(async () => {
         const out = { itemCount: 0, hasCurrentItem: false, queueHead: '', queueHeadOverflow: true, queueAligned: false, queueCountLabel: '', repeatTitle: '', repeatAfterClick: '', shufflePressed: '', shuffleAfterClick: '' }
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
         const queueHeads = [...document.querySelectorAll('.queue-head .head-cell')]
         out.queueHead = queueHeads.map((el) => (el.textContent || '').trim()).join(' | ')
         out.queueHeadOverflow = queueHeads.some((el) => el.offsetWidth > 0 && el.scrollWidth > el.clientWidth + 1)
         const visibleHeads = queueHeads.filter((el) => el.offsetWidth > 0)
         const jump = document.querySelector('.queue-item .queue-jump')
         const jumpCells = jump ? [...jump.children].filter((el) => el.offsetWidth > 0) : []
         const remove = document.querySelector('.queue-item .queue-remove')
         // The action column has no label now, so there are exactly as many header
         // cells as there are jump cells; the remove button sits in the label-less
         // last column.
         const cellsAligned =
           visibleHeads.length === jumpCells.length &&
           jumpCells.every(
             (cell, i) =>
               Math.abs(cell.getBoundingClientRect().left - visibleHeads[i].getBoundingClientRect().left) <= 1
           ) &&
           Boolean(remove)
         const subtitle = document.querySelector('.main-view .view-header .subtitle')
         const head = document.querySelector('.queue-head')
         const clearOfSubtitle =
           Boolean(subtitle) &&
           Boolean(head) &&
           head.getBoundingClientRect().top >= subtitle.getBoundingClientRect().bottom
         out.queueAligned = cellsAligned && clearOfSubtitle
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
      transport.queueHead === '# | Title | Artist | Source | Duration' &&
        !transport.queueHeadOverflow &&
        transport.queueAligned,
      'the queue header names the same columns as the library, sits over its rows and clears the subtitle',
      `${transport.queueHead || 'no header'}${transport.queueHeadOverflow ? ' (a label is clipped)' : ''}${
        transport.queueAligned ? '' : ' (misaligned or overlapping)'
      }`
    )
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

    // The YouTube view is a layout too, so its history is seeded before the size
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
          channel: 'Selftest Streamer',
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
          // A real artist that is not the uploader: the optional Artist column
          // must appear, stay aligned with Channel, and reveal an overlong name
          // with the hover scroll rather than widening the row.
          artist: 'Selftest Artist With A Deliberately Long Name',
          channel: 'Selftest Streamer',
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
          channel: null,
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

    // ---- 9b. library smart views ---------------------------------------
    // The chips are not a second list: they change what the same table shows.
    // These checks use the seeded fixtures and the seeded YouTube history, so
    // they exercise the real IPC queries and the stream rows, not a mock.
    const libraryViews = await evaluate<{
      chips: string
      youtubeActive: string
      streamRows: number
      streamTitles: string
      saveButtons: number
      queueButtons: number
      menuButtons: number
      removeFromMenu: boolean
      detailsInMenu: boolean
      neverActive: string
      neverRows: number
      neverHasStreams: boolean
      neverHasFixture: boolean
      allActive: string
      allRows: number
      allHasFixture: boolean
      allHasStream: boolean
    }>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const nav = [...document.querySelectorAll('.nav-item')].find((el) =>
           (el.textContent || '').trim().startsWith('Library')
         )
         nav?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(250)

         const chips = () => [...document.querySelectorAll('.library-filters .filter-chip')]
         const chip = (label) => chips().find((el) => (el.textContent || '').includes(label))
         const activeLabel = () =>
           (document.querySelector('.filter-chip[aria-pressed="true"]')?.textContent || '').trim()
         const titles = () =>
           [...document.querySelectorAll('.track-row .row-title-text')].map((el) => (el.textContent || '').trim())

         const chipLabels = chips().map((el) => (el.textContent || '').trim()).join('|')

         chip('YouTube')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(500)
         const streamRows = [...document.querySelectorAll('.track-row')]
         const buttonsWith = (title) =>
           streamRows.filter((row) =>
             [...row.querySelectorAll('button')].some((button) => button.getAttribute('title') === title)
           ).length

         const youtubeActive = activeLabel()
         const streamTitles = titles()
         const saveButtons = buttonsWith('Save to your library')
         const queueButtons = buttonsWith('Add to queue')
         const menuButtons = buttonsWith('More actions')

         // Remove and Details are behind the row menu now. Open one menu to
         // prove both entries are still there, then close it without acting.
         const firstMore = streamRows[0]
           ? [...streamRows[0].querySelectorAll('button')].find(
               (button) => button.getAttribute('title') === 'More actions'
             )
           : null
         firstMore?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(200)
         const menuLabels = [...document.querySelectorAll('.row-menu .context-item')].map((el) =>
           (el.textContent || '').trim()
         )
         document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
         await sleep(100)
         const removeFromMenu = menuLabels.includes('Remove from history')
         const detailsInMenu = menuLabels.includes('Details')

         chip('Never played')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(450)
         const neverActive = activeLabel()
         const neverTitles = titles()
         const neverRows = neverTitles.length
         const neverHasStreams = neverTitles.some((title) => title.startsWith('Online Tone'))
         const neverHasFixture = neverTitles.some((title) => title.startsWith('Selftest '))

         chip('All')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(450)
         const allActive = activeLabel()
         const allTitles = titles()
         const allRows = allTitles.length
         const allHasFixture = allTitles.some((title) => title.startsWith('Selftest '))
         const allHasStream = allTitles.some((title) => title.startsWith('Online Tone'))

         return {
           chips: chipLabels,
           youtubeActive,
           streamRows: streamRows.length,
           streamTitles: streamTitles.join('|'),
           saveButtons,
           queueButtons,
           menuButtons,
           removeFromMenu,
           detailsInMenu,
           neverActive,
           neverRows,
           neverHasStreams,
           neverHasFixture,
           allActive,
           allRows,
           allHasFixture,
           allHasStream
         }
       })()`
    )
    record(
      ['All', 'Recently added', 'Most played', 'Never played', 'YouTube'].every((label) =>
        libraryViews.chips.includes(label)
      ),
      'library: every smart view is reachable from one chip row',
      libraryViews.chips
    )
    record(
      libraryViews.youtubeActive.includes('YouTube') &&
        libraryViews.streamRows === 3 &&
        ['Online Tone One', 'Online Tone Two', 'Online Tone Three'].every((title) =>
          libraryViews.streamTitles.includes(title)
        ),
      'library: the YouTube chip lists the streamed history',
      libraryViews.streamTitles
    )
    record(
      libraryViews.saveButtons === 3 &&
        libraryViews.queueButtons === 3 &&
        libraryViews.menuButtons === 3 &&
        libraryViews.removeFromMenu &&
        libraryViews.detailsInMenu,
      'library: stream rows can be saved, queued, forgotten and inspected',
      {
        save: libraryViews.saveButtons,
        queue: libraryViews.queueButtons,
        menu: libraryViews.menuButtons,
        remove: libraryViews.removeFromMenu,
        details: libraryViews.detailsInMenu
      }
    )
    record(
      libraryViews.neverActive.includes('Never played') &&
        !libraryViews.neverHasStreams &&
        (libraryViews.neverRows === 0 || libraryViews.neverHasFixture),
      'library: a local smart view excludes the YouTube rows',
      { rows: libraryViews.neverRows, active: libraryViews.neverActive }
    )
    record(
      libraryViews.allActive.includes('All') &&
        libraryViews.allRows > 0 &&
        libraryViews.allHasFixture &&
        !libraryViews.allHasStream,
      'library: All returns to the local library and drops the stream rows',
      { rows: libraryViews.allRows, titles: libraryViews.allHasFixture }
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

      const showView = async (label: 'Home' | 'Library' | 'Search' | 'YouTube' | 'Settings' | 'Queue'): Promise<void> => {
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

      await showView('Home')
      const homeLayout = await evaluate<LayoutProbe>(window, LAYOUT_PROBE)
      record(
        homeLayout.hasHome &&
          homeLayout.homeStatsInside &&
          homeLayout.main === 0 &&
          homeLayout.home === 0 &&
          homeLayout.bar === 0 &&
          homeLayout.page === 0,
        `home hero and stats fit inside the view at ${width}x${height}`,
        homeLayout
      )

      await showView('Library')
      const library = await evaluate<LayoutProbe>(window, LAYOUT_PROBE)
      record(
        library.hasTable && library.main === 0 && library.table === 0 && library.bar === 0 && library.page === 0,
        `library view fits with no horizontal overflow at ${width}x${height}`,
        library
      )

      await showView('Search')
      const searchLayout = await evaluate<LayoutProbe>(window, LAYOUT_PROBE)
      record(
        searchLayout.hasDiscover &&
          searchLayout.discoverShrink === '0' &&
          searchLayout.main === 0 &&
          searchLayout.discover === 0 &&
          searchLayout.bar === 0 &&
          searchLayout.page === 0,
        `search view fits and can scroll vertically at ${width}x${height}`,
        searchLayout
      )

      // The result box, not the page, owns the scrollbar. A synthetic long list
      // proves the box scrolls while the view around it stays clipped; without
      // this, a later flex change could quietly hand the scroll back to the page.
      const searchScroll = await evaluate<{
        viewOverflow: string
        listOverflow: string
        listScrolls: boolean
        listScrolled: boolean
      }>(
        window,
        `(async () => {
           const view = document.querySelector('.discover-view')
           const box = document.createElement('div')
           box.className = 'discover-results'
           const list = document.createElement('ul')
           list.className = 'discover-list'
           for (let i = 0; i < 40; i += 1) {
             const row = document.createElement('li')
             row.className = 'discover-item'
             row.style.height = '40px'
             row.textContent = 'row ' + i
             list.appendChild(row)
           }
           box.appendChild(list)
           if (view) view.appendChild(box)
           // A timeout, not two animation frames: a hidden or occluded Electron
           // window can stop rAF indefinitely, and this probe is about layout,
           // not about frames actually being painted.
           await new Promise((resolve) => setTimeout(resolve, 80))
           const before = list.scrollTop
           list.scrollTop = 240
           const out = {
             viewOverflow: view ? getComputedStyle(view).overflowY : 'missing',
             listOverflow: getComputedStyle(list).overflowY,
             listScrolls: list.scrollHeight > list.clientHeight + 1,
             listScrolled: list.scrollTop > before
           }
           box.remove()
           return out
         })()`
      )
      record(
        searchScroll.viewOverflow === 'hidden' &&
          searchScroll.listOverflow === 'auto' &&
          searchScroll.listScrolls &&
          searchScroll.listScrolled,
        `search results scroll inside their own box at ${width}x${height}`,
        searchScroll
      )

      await showView('Settings')
      const settings = await evaluate<LayoutProbe>(window, LAYOUT_PROBE)
      record(
        settings.hasCards && settings.main === 0 && settings.cards === 0 && settings.bar === 0 && settings.page === 0,
        `settings view fits with no horizontal overflow at ${width}x${height}`,
        settings
      )

      const settingsTabs = await evaluate<{
        count: number
        labels: string
        appearanceVisible: boolean
        acoustidField: boolean
        onePanel: boolean
        restored: boolean
      }>(
        window,
        `(async () => {
           const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
           const tabs = [...document.querySelectorAll('.settings-tab')]
           const byLabel = (label) => tabs.find((el) => (el.textContent || '').trim() === label)
           byLabel('Appearance')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
           await sleep(160)
           const visible = [...document.querySelectorAll('.settings-panel')].filter((el) => !el.hidden)
           const appearanceVisible = visible.some((el) => el.id === 'settings-panel-appearance')
           const onePanel = visible.length === 1
           byLabel('Misc')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
           await sleep(160)
           const acoustidField = Boolean(
             document.querySelector('#settings-panel-misc input[placeholder*="AcoustID"]')
           )
           byLabel('General')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
           await sleep(120)
           const general = document.querySelector('#settings-panel-general')
           return {
             count: tabs.length,
             labels: tabs.map((el) => (el.textContent || '').trim()).join('|'),
             appearanceVisible,
             acoustidField,
             onePanel,
             restored: Boolean(general) && !general.hidden
           }
         })()`
      )
      record(
        settingsTabs.count === 5 &&
          settingsTabs.labels === 'General|Appearance|Streaming|Misc|About' &&
          settingsTabs.appearanceVisible &&
          settingsTabs.acoustidField &&
          settingsTabs.onePanel &&
          settingsTabs.restored,
        `settings has five tabs and shows one panel at a time at ${width}x${height}`,
        settingsTabs
      )

      // General is a direct two-column card grid, so it is the cleanest proof
      // that the grid folds to one column below 1120px. It scrolls vertically
      // once the audio cards are present; the horizontal fit is checked above,
      // so the point here is the column placement at each width.
      const settingsCards = await evaluate<{
        firstTop: number
        firstLeft: number
        secondTop: number
        secondLeft: number
        scrolls: boolean
      }>(
        window,
        `(async () => {
           const panel = document.querySelector('#settings-panel-general')
           const cards = panel ? [...panel.querySelectorAll(':scope > .cards > .card')] : []
           const a = cards[0] ? cards[0].getBoundingClientRect() : null
           const b = cards[1] ? cards[1].getBoundingClientRect() : null
           return {
             firstTop: a ? Math.round(a.top) : -1,
             firstLeft: a ? Math.round(a.left) : -1,
             secondTop: b ? Math.round(b.top) : -1,
             secondLeft: b ? Math.round(b.left) : -1,
             scrolls: Boolean(panel && panel.scrollHeight > panel.clientHeight + 1)
           }
         })()`
      )
      record(
        settingsCards.firstLeft >= 0 &&
          settingsCards.secondLeft >= 0 &&
          (width > 1120
            ? Math.abs(settingsCards.firstTop - settingsCards.secondTop) <= 1 &&
              settingsCards.secondLeft > settingsCards.firstLeft
            : settingsCards.secondTop > settingsCards.firstTop),
        `settings places General's cards side by side at ${width}x${height}`,
        settingsCards
      )

      // The settings panel clips its own overflow, so a hint bubble must live
      // outside it. Focusing a hint in the right-hand column also proves the
      // fixed-position fallback stays inside the window instead of disappearing
      // under the panel edge.
      const settingsHint = await evaluate<{
        cardFound: boolean
        triggerFound: boolean
        activeAfterFocus: boolean
        portal: boolean
        open: boolean
        visible: boolean
        within: boolean
        rect: string
        viewport: string
      }>(
        window,
        `(async () => {
           const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
           const card = [...document.querySelectorAll('#settings-panel-general .card')].find((el) =>
             (el.textContent || '').includes('Startup, window & resume')
           )
           const trigger = card ? card.querySelector('.info-hint-trigger') : null
           trigger?.focus()
           const activeAfterFocus = document.activeElement === trigger
           // A window that is not the foreground window can decline to deliver a
           // programmatic focus event on some Chromium builds. The hint is also
           // hoverable, so fall back to the path a mouse would take; the geometry
           // assertions below are what this check is really about.
           if (!document.querySelector('.info-hint-bubble.open')) {
             trigger?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }))
           }
           // Visibility is part of the bubble's 120ms transition; leave enough
           // room that a busy first pass at 1200px cannot sample it half-open.
           await sleep(320)
           const bubble = document.querySelector('.info-hint-bubble.open')
           const box = bubble ? bubble.getBoundingClientRect() : null
           const style = bubble ? getComputedStyle(bubble) : null
           const result = {
             cardFound: Boolean(card),
             triggerFound: Boolean(trigger),
             activeAfterFocus,
             portal: Boolean(bubble && bubble.parentElement === document.body),
             open: Boolean(bubble),
             visible: Boolean(style && style.visibility === 'visible' && style.opacity !== '0'),
             within: Boolean(
               box &&
                 box.left >= 0 &&
                 box.top >= 0 &&
                 box.right <= window.innerWidth + 0.5 &&
                 box.bottom <= window.innerHeight + 0.5
             ),
             rect: box
               ? [box.left, box.top, box.right, box.bottom].map((value) => Math.round(value)).join(',')
               : '',
             viewport: window.innerWidth + 'x' + window.innerHeight
           }
           trigger?.blur()
           await sleep(80)
           return result
         })()`
      )
      record(
        settingsHint.portal && settingsHint.open && settingsHint.visible && settingsHint.within,
        `settings tooltips escape the panel and stay in view at ${width}x${height}`,
        settingsHint
      )

      // A hint is read while hovering the control it describes, so it has to be
      // short enough not to bury that control. The bubbles are always in the
      // DOM (only their visibility changes), so every tab can be measured at once.
      const hintCopy = await evaluate<{
        count: number
        longest: number
        longestText: string
        over: string[]
      }>(
        window,
        `(() => {
           const texts = [...document.querySelectorAll('.info-hint-bubble')]
             .map((el) => ((el.textContent || '').trim()))
             .filter(Boolean)
           const over = texts.filter((value) => value.length > 100)
           const longestText = texts.reduce((longest, value) => (value.length > longest.length ? value : longest), '')
           return { count: texts.length, longest: longestText.length, longestText, over }
         })()`
      )
      record(
        hintCopy.count >= 30 && hintCopy.over.length === 0,
        'settings tooltips stay a sentence long',
        {
          count: hintCopy.count,
          longest: hintCopy.longest,
          text: hintCopy.longestText,
          over: hintCopy.over
        }
      )

      // A card explains itself once: either a description under the heading or
      // an ⓘ bubble beside it, never both. The duplicate reads as noise and was
      // repeated across every settings tab.
      const cardExplanations = await evaluate<{ both: string[] }>(
        window,
        `(() => {
           const both = []
           for (const card of document.querySelectorAll('.settings-panel .card')) {
             const header = card.querySelector(':scope > .card-header')
             if (!header || !header.querySelector('.info-hint-trigger')) continue
             const next = header.nextElementSibling
             if (next && next.classList.contains('card-hint')) {
               const title = header.querySelector('h2')
               both.push(((title ? title.textContent : '') || '').trim())
             }
           }
           return { both }
         })()`
      )
      record(
        cardExplanations.both.length === 0,
        'settings cards explain themselves once, not twice',
        cardExplanations
      )

      const settingsGrid = await evaluate<{
        appearance: { columns: number; cards: number; scrolls: boolean; content: number; height: number }
        streaming: { columns: number; cards: number; scrolls: boolean; content: number; height: number }
        misc: { columns: number; cards: number; scrolls: boolean; content: number; height: number }
      }>(
        window,
        `(async () => {
           const out = {}
           for (const id of ['appearance', 'streaming', 'misc']) {
             const tab = document.getElementById('settings-tab-' + id)
             if (tab) {
               tab.click()
               await new Promise((resolve) => setTimeout(resolve, 80))
             }
             const panel = document.getElementById('settings-panel-' + id)
             const cards = panel ? [...panel.querySelectorAll('.card')] : []
             const lefts = new Set(cards.map((card) => Math.round(card.getBoundingClientRect().left)))
             out[id] = {
               columns: lefts.size,
               cards: cards.length,
               scrolls: Boolean(panel && panel.scrollHeight > panel.clientHeight + 1),
               content: panel ? panel.scrollHeight : -1,
               height: panel ? panel.clientHeight : -1
             }
           }
           document.getElementById('settings-tab-general')?.click()
           await new Promise((resolve) => setTimeout(resolve, 80))
           return out
         })()`
      )
      const expectedColumns = width > 1120 ? 2 : 1
      record(
        settingsGrid.appearance.columns === expectedColumns &&
          settingsGrid.streaming.columns === expectedColumns &&
          settingsGrid.misc.columns === expectedColumns,
        `settings tabs use ${expectedColumns} card column(s) at ${width}x${height}`,
        settingsGrid
      )

      // Appearance used to leave a tall empty space beside the short right-hand
      // column and then repeat the List columns card under both columns. The
      // reset is now a compact card at the end of the left stack, and List
      // columns belongs to the right stack.
      const appearanceLayout = await evaluate<{
        resetInLeft: boolean
        resetOutsideCards: boolean
        listColumnsInRight: boolean
        notes: number
        resetHeight: number
      }>(
        window,
        `(async () => {
           const tab = document.getElementById('settings-tab-appearance')
           if (tab) tab.click()
           await new Promise((resolve) => setTimeout(resolve, 100))
           const panel = document.getElementById('settings-panel-appearance')
           const columns = panel ? [...panel.querySelectorAll(':scope > .cards > .cards-col')] : []
           const reset = panel ? panel.querySelector('.appearance-reset') : null
           const cardNamed = (name) =>
             [...(panel ? panel.querySelectorAll('.card') : [])].find((card) =>
               ((card.querySelector('h2') || {}).textContent || '').includes(name)
             )
           const listColumns = cardNamed('List columns')
           const out = {
             resetInLeft: Boolean(reset && columns[0] && columns[0].contains(reset)),
             resetOutsideCards: Boolean(panel && reset && reset.parentElement === panel),
             listColumnsInRight: Boolean(listColumns && columns[1] && columns[1].contains(listColumns)),
             notes: panel ? panel.querySelectorAll('.field-note').length : -1,
             resetHeight: reset ? Math.round(reset.getBoundingClientRect().height) : -1
           }
           document.getElementById('settings-tab-general')?.click()
           await new Promise((resolve) => setTimeout(resolve, 80))
           return out
         })()`
      )
      record(
        appearanceLayout.resetInLeft &&
          !appearanceLayout.resetOutsideCards &&
          appearanceLayout.listColumnsInRight &&
          appearanceLayout.notes === 0 &&
          appearanceLayout.resetHeight > 0 &&
          appearanceLayout.resetHeight < 160,
        `Appearance balances both columns and keeps Reset compact at ${width}x${height}`,
        appearanceLayout
      )

      const navCountOpacity = await evaluate<number>(
        window,
        `(() => {
           const counts = [...document.querySelectorAll('.nav-item .nav-count')]
           if (counts.length === 0) return -1
           // The real pointer can happen to rest over one row. Every count that
           // is not hovered must still be invisible, so the minimum is the
           // rest-state proof and one hovered row cannot make the check flaky.
           return Math.min(...counts.map((node) => parseFloat(getComputedStyle(node).opacity)))
         })()`
      )
      record(
        navCountOpacity === 0,
        `sidebar row counts stay quiet until hover at ${width}x${height}`,
        navCountOpacity
      )

      await showView('Queue')
      const queue = await evaluate<LayoutProbe>(window, LAYOUT_PROBE)
      record(
        queue.hasQueue && queue.main === 0 && queue.bar === 0 && queue.page === 0,
        `queue view fits with no horizontal overflow at ${width}x${height}`,
        queue
      )

      await showView('YouTube')
      const onlineLayout = await evaluate<LayoutProbe>(window, LAYOUT_PROBE)
      record(
        onlineLayout.hasOnline && onlineLayout.main === 0 && onlineLayout.online === 0 && onlineLayout.bar === 0 && onlineLayout.page === 0,
        `streaming view fits with no horizontal overflow at ${width}x${height}`,
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

    // ---- 10b. layout at the largest text size -----------------------------
    // Windows scaling does not change the CSS viewport: a 4K panel at 200%
    // reports the same 1920x1080 CSS pixels as a 1080p panel at 100%, and only
    // the device pixel ratio differs. What does change the layout is the
    // extra-large text setting, which multiplies every label by 1.3. The
    // combination that breaks such layouts is the minimum window with the
    // largest text, so this pass repeats the fit checks there. Cover sharpness
    // at 2x is the separate half of the same problem, handled by the artwork
    // cache cap and written down in docs/release/windows.md.
    window.setSize(940, 580)
    await delay(250)
    const previousTextSize = await evaluate<string>(
      window,
      `document.documentElement.dataset.textSize || 'medium'`
    )
    const xlargeScale = await evaluate<string>(
      window,
      `(async () => {
         document.documentElement.dataset.textSize = 'xlarge'
         await new Promise((resolve) => setTimeout(resolve, 250))
         return getComputedStyle(document.documentElement).getPropertyValue('--text-scale').trim()
       })()`
    )
    record(
      xlargeScale === '1.3',
      'the extra-large text setting scales the layout sweep by 1.3',
      xlargeScale
    )

    const xlargeChecks: Array<{
      label: 'Home' | 'Library' | 'Search' | 'Settings' | 'Queue' | 'YouTube'
      fits: (probe: LayoutProbe) => boolean
    }> = [
      {
        label: 'Home',
        fits: (probe) =>
          probe.hasHome &&
          probe.homeStatsInside &&
          probe.home === 0 &&
          probe.main === 0 &&
          probe.bar === 0 &&
          probe.page === 0
      },
      {
        label: 'Library',
        fits: (probe) =>
          probe.hasTable && probe.table === 0 && probe.main === 0 && probe.bar === 0 && probe.page === 0
      },
      {
        label: 'Search',
        fits: (probe) =>
          probe.hasDiscover &&
          probe.discoverShrink === '0' &&
          probe.discover === 0 &&
          probe.main === 0 &&
          probe.bar === 0 &&
          probe.page === 0
      },
      {
        label: 'Settings',
        fits: (probe) =>
          probe.hasCards && probe.cards === 0 && probe.main === 0 && probe.bar === 0 && probe.page === 0
      },
      {
        label: 'Queue',
        fits: (probe) => probe.hasQueue && probe.main === 0 && probe.bar === 0 && probe.page === 0
      },
      {
        label: 'YouTube',
        fits: (probe) =>
          probe.hasOnline && probe.online === 0 && probe.main === 0 && probe.bar === 0 && probe.page === 0
      }
    ]
    for (const { label, fits } of xlargeChecks) {
      await evaluate(
        window,
        `(async () => {
           const button = [...document.querySelectorAll('.nav-item')].find((el) => (el.textContent || '').trim().startsWith(${JSON.stringify(label)}))
           if (button) button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
           await new Promise((resolve) => setTimeout(resolve, 300))
           return Boolean(button)
         })()`
      )
      const probe = await evaluate<LayoutProbe>(window, LAYOUT_PROBE)
      record(fits(probe), `${label} fits at 940x580 with extra-large text`, probe)
    }

    // The full-window player grows its captions with the text scale while its
    // cover is sized from the viewport, so the cover must still land inside the
    // window rather than under an edge.
    const xlargePlayer = await evaluate<{
      hasNowPlaying: boolean
      nowPlaying: number
      page: number
      artWidth: number
      artInside: boolean
    }>(
      window,
      `(async () => {
         const open = document.querySelector('.player-track')
         if (open) open.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await new Promise((resolve) => setTimeout(resolve, 450))
         const overflow = (selector) => {
           const el = document.querySelector(selector)
           return el ? Math.max(0, el.scrollWidth - el.clientWidth) : 0
         }
         const art = document.querySelector('.np-art')
         const box = art ? art.getBoundingClientRect() : null
         return {
           hasNowPlaying: Boolean(document.querySelector('.now-playing')),
           nowPlaying: overflow('.now-playing'),
           page: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
           artWidth: box ? Math.round(box.width) : -1,
           artInside: Boolean(
             box &&
               box.left >= -0.5 &&
               box.top >= -0.5 &&
               box.right <= window.innerWidth + 0.5 &&
               box.bottom <= window.innerHeight + 0.5
           )
         }
       })()`
    )
    record(
      xlargePlayer.hasNowPlaying &&
        xlargePlayer.nowPlaying === 0 &&
        xlargePlayer.page === 0 &&
        xlargePlayer.artInside,
      'the full-window player and its cover fit at 940x580 with extra-large text',
      xlargePlayer
    )
    await evaluate(
      window,
      `(async () => {
         const close = document.querySelector('.np-close')
         if (close) close.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await new Promise((resolve) => setTimeout(resolve, 450))
         document.documentElement.dataset.textSize = ${JSON.stringify(previousTextSize)}
         return true
       })()`
    )

    // ---- 11. appearance: theme, accent, density, surface, motion --------
    // These are applied as data attributes on <html>, so the checks have to go
    // through the real controls and then read the computed result. Reading the
    // settings object back would only prove that a write happened, not that the
    // CSS and the virtualizer listened.
    //
    // The layout sweep leaves the window at 940px, where the container query has
    // already dropped Album. Bring it back to 1200px so both metadata columns
    // are visible and the hidden-column checks measure the setting, not the
    // responsive breakpoint.
    window.setSize(1200, 780)
    await delay(600)
    const appearance = await evaluate<{
      themeReachedRoot: boolean
      themeButtonPressed: string
      creamBackground: string
      accentReachedRoot: boolean
      accentVariable: string
      densityReachedRoot: boolean
      compactRowHeight: number
      compactCssHeight: string
      surfaceReachedRoot: boolean
      accentedBlur: string
      motionReachedRoot: boolean
      reducedTransitionMs: number
      textSizeReachedRoot: boolean
      xlargeBodyPx: number
      iconSetReachedRoot: boolean
      classicSidebarIconSet: string
      lyricsAlignReachedRoot: boolean
      albumHidden: boolean
      albumColumnDisplay: string
      baseAlbumSetting: string
      baseAlbumDisplay: string
      trackListClientWidth: number
      artistWidth: number
      albumWidth: number
      timeWidth: number
      titleWidth: number
      timeFits: boolean
      timeAligned: boolean
      actionsAligned: boolean
      hiddenTimeWidth: number
      hiddenTimeFits: boolean
      hiddenTimeAligned: boolean
      hiddenActionsAligned: boolean
      channelHidden: boolean
      channelColumnDisplay: string
      onlineArtistDisplay: string
      onlineNoOverflow: boolean
      onlineTimeFits: boolean
      resetTheme: string
      resetAccent: string
      resetDensity: string
      resetSurface: string
      resetMotion: string
      resetTextSize: string
      resetIconSet: string
      resetLyricsAlign: string
      resetAlbumColumn: string
      resetChannelColumn: string
      heroSlidePresent: boolean
      heroSlideSaved: number
      resetHeroSlide: string
      mediumBodyPx: number
      comfortableRowHeight: number
    }>(
      window,
      `(async () => {
         const out = {
           themeReachedRoot: false, themeButtonPressed: '', creamBackground: '',
           accentReachedRoot: false, accentVariable: '',
           densityReachedRoot: false, compactRowHeight: -1, compactCssHeight: '',
           surfaceReachedRoot: false, accentedBlur: '',
           motionReachedRoot: false, reducedTransitionMs: -1,
           textSizeReachedRoot: false, xlargeBodyPx: -1,
           iconSetReachedRoot: false, classicSidebarIconSet: '',
           lyricsAlignReachedRoot: false,
           albumHidden: false, albumColumnDisplay: '',
           baseAlbumSetting: '', baseAlbumDisplay: '', trackListClientWidth: -1,
           artistWidth: -1, albumWidth: -1, timeWidth: -1, titleWidth: -1,
           timeFits: false, timeAligned: false, actionsAligned: false,
           hiddenTimeWidth: -1, hiddenTimeFits: false, hiddenTimeAligned: false, hiddenActionsAligned: false,
           channelHidden: false, channelColumnDisplay: '', onlineArtistDisplay: '',
           onlineNoOverflow: false, onlineTimeFits: false,
           resetTheme: '', resetAccent: '', resetDensity: '', resetSurface: '', resetMotion: '',
           resetTextSize: '', resetIconSet: '', resetLyricsAlign: '',
           resetAlbumColumn: '', resetChannelColumn: '',
           heroSlidePresent: false, heroSlideSaved: -1, resetHeroSlide: '',
           mediumBodyPx: -1, comfortableRowHeight: -1
         }
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const press = (element) => { if (element) element.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
         const nav = (label) => {
           const button = [...document.querySelectorAll('.nav-item')].find((el) => (el.textContent || '').trim().startsWith(label))
           if (button) button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         }
         const tab = (label) => {
           const button = [...document.querySelectorAll('.settings-tab')].find((el) => (el.textContent || '').trim() === label)
           if (button) button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         }
         const choice = (attr, value) => document.querySelector('[' + attr + '="' + value + '"]')
         const transitionMs = (element) => {
           if (!element) return -1
           const raw = getComputedStyle(element).transitionDuration.split(',')[0].trim()
           return raw.endsWith('ms') ? parseFloat(raw) : parseFloat(raw) * 1000
         }
         const root = document.documentElement

         nav('Settings')
         await sleep(300)
         tab('Appearance')
         await sleep(200)

         press(choice('data-theme-choice', 'light'))
         await sleep(500)
         out.themeReachedRoot = root.dataset.theme === 'light'
         out.themeButtonPressed = choice('data-theme-choice', 'light')?.getAttribute('aria-pressed') || ''
         out.creamBackground = getComputedStyle(document.body).backgroundColor

         press(choice('data-accent-choice', 'rose'))
         await sleep(450)
         out.accentReachedRoot = root.dataset.accent === 'rose'
         out.accentVariable = getComputedStyle(root).getPropertyValue('--accent').trim()

         press(choice('data-density-choice', 'compact'))
         await sleep(450)
         out.densityReachedRoot = root.dataset.density === 'compact'
         nav('Library')
         await sleep(400)
         const compactRow = document.querySelector('.track-row')
         out.compactRowHeight = compactRow ? Math.round(compactRow.getBoundingClientRect().height) : -1
         out.compactCssHeight = compactRow ? getComputedStyle(compactRow).height : ''

         nav('Settings')
         await sleep(300)
         tab('Appearance')
         await sleep(200)
         press(choice('data-surface-choice', 'accented'))
         await sleep(450)
         out.surfaceReachedRoot = root.dataset.surface === 'accented'
         const sidebar = document.querySelector('.sidebar')
         out.accentedBlur = sidebar ? getComputedStyle(sidebar).backdropFilter : ''

         press(choice('data-motion-choice', 'reduced'))
         await sleep(450)
         out.motionReachedRoot = root.dataset.motion === 'reduced'
         out.reducedTransitionMs = transitionMs(choice('data-theme-choice', 'light'))

         // Text size and the sidebar glyphs are global choices; the Album column
         // is a layout choice. Check the DOM that each one actually changes.
         press(choice('data-text-size-choice', 'xlarge'))
         await sleep(450)
         out.textSizeReachedRoot = root.dataset.textSize === 'xlarge'
         out.xlargeBodyPx = parseFloat(getComputedStyle(document.body).fontSize)

         press(choice('data-icon-set-choice', 'classic'))
         await sleep(450)
         out.iconSetReachedRoot = document.querySelector('.app')?.dataset.iconSet === 'classic'
         out.classicSidebarIconSet = document.querySelector('.sidebar')?.dataset.iconSet || ''

         press(choice('data-lyrics-align-choice', 'left'))
         await sleep(450)
         out.lyricsAlignReachedRoot = root.dataset.lyricsAlign === 'left'

         const rect = (element) => (element ? element.getBoundingClientRect() : null)

         // Measure the full table at Extra Large before hiding Album. Artist and
         // Album must be equally wide, the title must be the flexible one, and
         // Duration and Actions must line up with the header and the row edge.
         nav('Library')
         await sleep(400)
         const baseRow = document.querySelector('.track-row')
         const baseHead = document.querySelector('.track-head')
         const baseRowRect = rect(baseRow)
         const baseArtistRect = rect(baseRow?.querySelector('.col-artist'))
         const baseAlbumRect = rect(baseRow?.querySelector('.col-album'))
         const baseTimeRect = rect(baseRow?.querySelector('.col-time'))
         const baseTitleRect = rect(baseRow?.querySelector('.col-title'))
         const baseActionsRect = rect(baseRow?.querySelector('.col-actions'))
         const baseHeadTimeRect = rect(baseHead?.querySelector('.col-time'))
         const baseTimeCell = baseRow?.querySelector('.col-time')
         const baseAlbumCell = baseRow?.querySelector('.col-album')
         const baseList = baseRow?.closest('.track-list')
         out.baseAlbumSetting = document.querySelector('.app')?.dataset.albumColumn || ''
         out.baseAlbumDisplay = baseAlbumCell ? getComputedStyle(baseAlbumCell).display : ''
         out.trackListClientWidth = baseList ? baseList.clientWidth : -1
         out.artistWidth = baseArtistRect ? Math.round(baseArtistRect.width) : -1
         out.albumWidth = baseAlbumRect ? Math.round(baseAlbumRect.width) : -1
         out.timeWidth = baseTimeRect ? Math.round(baseTimeRect.width) : -1
         out.titleWidth = baseTitleRect ? Math.round(baseTitleRect.width) : -1
         out.timeFits = Boolean(baseTimeCell && baseTimeCell.scrollWidth <= baseTimeCell.clientWidth + 1)
         out.timeAligned = Boolean(
           baseTimeRect && baseHeadTimeRect && Math.abs(baseTimeRect.left - baseHeadTimeRect.left) <= 1
         )
         out.actionsAligned = Boolean(
           baseActionsRect && baseRowRect && Math.abs(baseActionsRect.right - baseRowRect.right) <= 1
         )

         nav('Settings')
         await sleep(300)
         tab('Appearance')
         await sleep(200)
         const albumToggle = document.querySelector('[data-album-column-toggle]')
         if (albumToggle && albumToggle.checked) {
           press(albumToggle)
           await sleep(450)
         }
         out.albumHidden = document.querySelector('.app')?.dataset.albumColumn === 'hide'
         nav('Library')
         await sleep(400)
         const hiddenRow = document.querySelector('.track-row')
         const hiddenHead = document.querySelector('.track-head')
         const hiddenRowRect = rect(hiddenRow)
         const albumCell = hiddenRow?.querySelector('.col-album')
         const hiddenTimeCell = hiddenRow?.querySelector('.col-time')
         const hiddenTimeRect = rect(hiddenTimeCell)
         const hiddenHeadTimeRect = rect(hiddenHead?.querySelector('.col-time'))
         const hiddenActionsRect = rect(hiddenRow?.querySelector('.col-actions'))
         out.albumColumnDisplay = albumCell ? getComputedStyle(albumCell).display : ''
         out.hiddenTimeWidth = hiddenTimeRect ? Math.round(hiddenTimeRect.width) : -1
         out.hiddenTimeFits = Boolean(
           hiddenTimeCell && hiddenTimeCell.scrollWidth <= hiddenTimeCell.clientWidth + 1
         )
         out.hiddenTimeAligned = Boolean(
           hiddenTimeRect && hiddenHeadTimeRect && Math.abs(hiddenTimeRect.left - hiddenHeadTimeRect.left) <= 1
         )
         out.hiddenActionsAligned = Boolean(
           hiddenActionsRect && hiddenRowRect && Math.abs(hiddenActionsRect.right - hiddenRowRect.right) <= 1
         )
         nav('Settings')
         await sleep(300)
         tab('Appearance')
         await sleep(200)

         // Channel is its own promise, but YouTube Links always keep it. The
         // checkbox now only hides the column on imported playlists, so the
         // YouTube view must be unchanged after turning it off.
         const channelToggle = document.querySelector('[data-channel-column-toggle]')
         if (channelToggle && channelToggle.checked) {
           press(channelToggle)
           await sleep(450)
         }
         out.channelHidden = document.querySelector('.app')?.dataset.channelColumn === 'hide'
         nav('YouTube')
         await sleep(450)
         const channelCell = document.querySelector('.online-channel')
         out.channelColumnDisplay = channelCell ? getComputedStyle(channelCell).display : ''
         const onlineArtistCell = document.querySelector('.online-artist')
         out.onlineArtistDisplay = onlineArtistCell ? getComputedStyle(onlineArtistCell).display : ''
         const onlineList = document.querySelector('.online-list')
         const onlineTimeCell = document.querySelector('.online-jump .online-time')
         out.onlineNoOverflow = Boolean(onlineList && onlineList.scrollWidth <= onlineList.clientWidth + 1)
         out.onlineTimeFits = Boolean(onlineTimeCell && onlineTimeCell.scrollWidth <= onlineTimeCell.clientWidth + 1)
         nav('Settings')
         await sleep(300)
         tab('Appearance')
         await sleep(200)

         const heroSlider = document.querySelector('[data-hero-slide-slider]')
         out.heroSlidePresent = Boolean(heroSlider)
         if (heroSlider) {
           const setSlider = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
           setSlider.call(heroSlider, '30')
           heroSlider.dispatchEvent(new Event('input', { bubbles: true }))
           await sleep(450)
         }
         const savedHero = await window.player.getSettings()
         out.heroSlideSaved = savedHero?.visuals?.heroSlideSeconds ?? -1

         press(document.querySelector('.appearance-reset button'))
         await sleep(700)
         out.resetTheme = root.dataset.theme || ''
         out.resetAccent = root.dataset.accent || ''
         out.resetDensity = root.dataset.density || ''
         out.resetSurface = root.dataset.surface || ''
         out.resetMotion = root.dataset.motion || ''
         out.resetTextSize = root.dataset.textSize || ''
         out.resetIconSet = document.querySelector('.app')?.dataset.iconSet || ''
         out.resetLyricsAlign = root.dataset.lyricsAlign || ''
         out.resetAlbumColumn = document.querySelector('.app')?.dataset.albumColumn || ''
         out.resetChannelColumn = document.querySelector('.app')?.dataset.channelColumn || ''
         out.resetHeroSlide = document.querySelector('[data-hero-slide-slider]')?.value || ''

         nav('Library')
         await sleep(400)
         out.mediumBodyPx = parseFloat(getComputedStyle(document.body).fontSize)
         const comfortableRow = document.querySelector('.track-row')
         out.comfortableRowHeight = comfortableRow ? Math.round(comfortableRow.getBoundingClientRect().height) : -1
         nav('Settings')
         await sleep(300)
         tab('Appearance')
         await sleep(200)
         return out
       })()`
    )
    record(
      appearance.themeReachedRoot &&
        appearance.themeButtonPressed === 'true' &&
        appearance.creamBackground === 'rgb(242, 236, 225)',
      'appearance: Cream reaches <html> and paints the warm background',
      appearance
    )
    record(
      appearance.accentReachedRoot && appearance.accentVariable.toLowerCase() === '#b83272',
      'appearance: the accent reaches the CSS palette',
      appearance
    )
    record(
      appearance.densityReachedRoot && appearance.compactRowHeight === 32 && appearance.compactCssHeight === '32px',
      'appearance: Compact reaches the virtualized rows',
      appearance
    )
    record(
      appearance.surfaceReachedRoot && appearance.accentedBlur.includes('blur'),
      'appearance: Accented uses a CSS blur rather than native acrylic',
      appearance
    )
    record(
      appearance.motionReachedRoot && appearance.reducedTransitionMs <= 0.01,
      'appearance: Reduced motion folds transitions',
      appearance
    )
    record(
      appearance.textSizeReachedRoot &&
        appearance.xlargeBodyPx > 17 &&
        appearance.iconSetReachedRoot &&
        appearance.classicSidebarIconSet === 'classic' &&
        appearance.albumHidden &&
        appearance.albumColumnDisplay === 'none' &&
        appearance.channelHidden &&
        appearance.channelColumnDisplay !== 'none',
      'appearance: text size, sidebar icons and the Album/Channel columns reach the app',
      appearance
    )
    const albumWidthsMatch =
      appearance.artistWidth > 0 && Math.abs(appearance.artistWidth - appearance.albumWidth) <= 1
    // At Extra Large text a narrow viewport can be inside the list's own 820px
    // container query, which drops Album before the setting is touched. That is
    // a responsive layout, not a broken hidden-column rule: require the
    // setting to still say "show" and the list to actually be at or below the
    // breakpoint before accepting the narrow case.
    const albumDroppedByWidth =
      appearance.baseAlbumSetting === 'show' &&
      appearance.baseAlbumDisplay === 'none' &&
      appearance.trackListClientWidth > 0 &&
      appearance.trackListClientWidth <= 820
    record(
      (albumWidthsMatch || albumDroppedByWidth) &&
        appearance.titleWidth > appearance.artistWidth &&
        appearance.timeWidth > 0 &&
        appearance.timeFits &&
        appearance.timeAligned &&
        appearance.actionsAligned &&
        appearance.hiddenTimeWidth === appearance.timeWidth &&
        appearance.hiddenTimeFits &&
        appearance.hiddenTimeAligned &&
        appearance.hiddenActionsAligned,
      'appearance: only the title flexes; hiding Album leaves Duration and Actions in place at Extra Large',
      appearance
    )
    record(
      appearance.onlineNoOverflow && appearance.onlineTimeFits,
      'appearance: YouTube Links fit at Extra Large without clipping Duration',
      appearance
    )
    record(
      appearance.onlineArtistDisplay !== 'none',
      'appearance: YouTube Links keep the optional Artist column beside Channel',
      appearance
    )
    record(
      appearance.lyricsAlignReachedRoot && appearance.resetLyricsAlign === 'center',
      'appearance: lyric alignment reaches the app and Reset restores centred',
      appearance
    )
    record(
      appearance.resetTheme === 'dark' &&
        appearance.resetAccent === 'blue' &&
        appearance.resetDensity === 'comfortable' &&
        appearance.resetSurface === 'solid' &&
        appearance.resetMotion === 'system' &&
        appearance.resetTextSize === 'medium' &&
        appearance.resetIconSet === 'modern' &&
        appearance.resetAlbumColumn === 'show' &&
        appearance.resetChannelColumn === 'show' &&
        appearance.mediumBodyPx < 16,
      'appearance: Reset puts every choice back',
      appearance
    )
    record(
      appearance.heroSlidePresent &&
        appearance.heroSlideSaved === 30 &&
        appearance.resetHeroSlide === '12',
      'appearance: the Home hero pace is a setting and Reset restores it',
      {
        present: appearance.heroSlidePresent,
        saved: appearance.heroSlideSaved,
        reset: appearance.resetHeroSlide
      }
    )
    record(
      appearance.comfortableRowHeight === 38,
      'appearance: resetting density restores the 38px row',
      appearance
    )

    // ---- 11b. Settings keyboard tabs and the preference reset ----------
    // The tab strip is one tab stop with arrow-key movement, and the reset in
    // Misc must put a changed preference back without forgetting the folder that
    // makes the library a library.
    const runtimeProbe = await evaluate<Record<string, string>>(
      window,
      `window.player.getRuntimeInfo().catch((cause) => ({ error: String(cause) }))`
    )
    record(
      typeof runtimeProbe.appVersion === 'string' &&
        typeof runtimeProbe.electron === 'string' &&
        typeof runtimeProbe.chromium === 'string' &&
        typeof runtimeProbe.node === 'string',
      'preload exposes the app and runtime versions',
      runtimeProbe
    )

    const settingsSafety = await evaluate<{
      keyboardEnd: boolean
      keyboardHome: boolean
      watchTurnedOff: boolean
      behaviourChanged: boolean
      startupChanged: boolean
      wheelChanged: boolean
      resumeChanged: boolean
      retentionChanged: boolean
      resetConfirmShown: boolean
      resetStatusShown: boolean
      watchRestored: boolean
      behaviourRestored: boolean
      startupRestored: boolean
      wheelRestored: boolean
      resumeRestored: boolean
      retentionRestored: boolean
      foldersKept: boolean
      sectionKeptOther: boolean
      sectionResetRestored: boolean
      aboutRuntime: boolean
      diagnosticsCopied: boolean
      saveDiagnosticsButton: boolean
      backupCard: boolean
      exportButton: boolean
      backupsPath: boolean
      healthCard: boolean
      healthActions: boolean
    }>(
      window,
      `(async () => {
         const out = {
           keyboardEnd: false, keyboardHome: false, watchTurnedOff: false,
           behaviourChanged: false, startupChanged: false, wheelChanged: false,
           resumeChanged: false, retentionChanged: false, resetConfirmShown: false,
           resetStatusShown: false, watchRestored: false, behaviourRestored: false,
           startupRestored: false, wheelRestored: false, resumeRestored: false,
           retentionRestored: false, foldersKept: false, sectionKeptOther: false,
           sectionResetRestored: false, aboutRuntime: false, diagnosticsCopied: false,
           saveDiagnosticsButton: false, backupCard: false, exportButton: false,
           backupsPath: false, healthCard: false, healthActions: false
         }
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const press = (element) => { if (element) element.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
         const nav = (label) => {
           const button = [...document.querySelectorAll('.nav-item')].find((el) => (el.textContent || '').trim().startsWith(label))
           if (button) button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         }
         const tab = (label) => {
           const button = [...document.querySelectorAll('.settings-tab')].find((el) => (el.textContent || '').trim() === label)
           if (button) button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         }
         const watchInput = () => {
           const label = [...document.querySelectorAll('.field.checkbox')].find((el) => {
             const text = el.textContent || ''
             return text.includes('Watch') && text.toLowerCase().includes('folder')
           })
           return label ? label.querySelector('input') : null
         }
         const selectField = (label) => {
           for (const field of document.querySelectorAll('.field')) {
             const title = field.querySelector('span')
             if (title && title.textContent === label) return field.querySelector('select')
           }
           return null
         }
         const setSelect = (label, value) => {
           const select = selectField(label)
           if (!select) return false
           select.value = value
           select.dispatchEvent(new Event('change', { bubbles: true }))
           return true
         }
         const resumeInput = () => {
           const label = [...document.querySelectorAll('.field.checkbox')].find((el) =>
             (el.textContent || '').includes('Resume playback')
           )
           return label ? label.querySelector('input') : null
         }
         const numberField = (label) => {
           for (const field of document.querySelectorAll('.field')) {
             const title = field.querySelector('span')
             if (title && (title.textContent || '').includes(label)) {
               return field.querySelector('input[type="number"]')
             }
           }
           return null
         }
         const setNumber = (label, value) => {
           const input = numberField(label)
           if (!input) return false
           // Same React value-tracker trick as the volume slider: update the
           // prototype value, then dispatch the event a real edit would.
           const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')
           if (descriptor && descriptor.set) descriptor.set.call(input, String(value))
           input.dispatchEvent(new Event('input', { bubbles: true }))
           return true
         }
         const key = (element, key) => {
           if (element) element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
         }

         nav('Settings')
         await sleep(300)

         const generalTab = document.getElementById('settings-tab-general')
         generalTab?.focus()
         key(generalTab, 'End')
         await sleep(250)
         const aboutTab = document.getElementById('settings-tab-about')
         out.keyboardEnd =
           aboutTab?.getAttribute('aria-selected') === 'true' &&
           document.activeElement?.id === 'settings-tab-about'
         key(aboutTab, 'Home')
         await sleep(250)
         out.keyboardHome =
           generalTab?.getAttribute('aria-selected') === 'true' &&
           document.activeElement?.id === 'settings-tab-general'

         tab('General')
         await sleep(250)
         const foldersBefore = document.querySelectorAll('.folder-list li').length
         const watch = watchInput()
         if (watch && watch.checked) {
           watch.click()
           await sleep(500)
         }
         out.watchTurnedOff = watchInput()?.checked === false
         setSelect('Open at launch', 'search')
         await sleep(500)

         setSelect('Single click', 'play')
         setSelect('Volume wheel step', '10')
         const resume = resumeInput()
         if (resume && !resume.checked) resume.click()
         await sleep(700)

         // Switching tabs re-renders the controlled select. If the write never
         // reached settings, React would put it straight back to 'select' here.
         tab('Misc')
         await sleep(300)
         out.behaviourChanged = selectField('Single click')?.value === 'play'
         out.startupChanged = selectField('Open at launch')?.value === 'search'
         out.wheelChanged = selectField('Volume wheel step')?.value === '10'
         out.resumeChanged = resumeInput()?.checked === true
         setNumber('Automatic backups to keep', 7)
         await sleep(600)
         out.retentionChanged = numberField('Automatic backups to keep')?.value === '7'

         const resetTrigger = [...document.querySelectorAll('.settings-reset button')].find((el) =>
           (el.textContent || '').trim().startsWith('Reset preferences')
         )
         press(resetTrigger)
         await sleep(200)
         out.resetConfirmShown = Boolean(document.querySelector('.reset-confirm'))
         press(document.querySelector('.reset-confirm button.primary'))
         await sleep(700)
         out.resetStatusShown = Boolean(document.querySelector('.settings-reset [role=\"status\"]'))
         const backupHeading = [...document.querySelectorAll('.card h2')].find(
           (el) => (el.textContent || '').trim().startsWith('Backup & restore')
         )
         out.backupCard = Boolean(
           backupHeading &&
             [...document.querySelectorAll('.field-row button')].some((el) =>
               (el.textContent || '').trim().startsWith('Back up now')
             ) &&
             [...document.querySelectorAll('.field-row button')].some((el) =>
               (el.textContent || '').trim().startsWith('Restore from backup')
             )
         )
         out.exportButton = [...document.querySelectorAll('.field-row button')].some((el) =>
           (el.textContent || '').trim().startsWith('Export library as CSV')
         )
         out.backupsPath = [...document.querySelectorAll('.path-label')].some(
           (el) => (el.textContent || '').trim() === 'Backups'
         )
         const healthHeading = [...document.querySelectorAll('.card h2')].find(
           (el) => (el.textContent || '').trim().startsWith('Library health')
         )
         out.healthCard = Boolean(healthHeading)
         out.healthActions =
           Boolean(healthHeading) &&
           ['Find duplicates.', 'Merge duplicates.', 'Find moved files.'].every((label) =>
             [...healthHeading.closest('.card').querySelectorAll('button')].some(
               (el) => (el.textContent || '').trim() === label
             )
           )

         out.retentionRestored = numberField('Automatic backups to keep')?.value === '10'

         tab('General')
         await sleep(300)
         out.watchRestored = watchInput()?.checked === true
         out.startupRestored = selectField('Open at launch')?.value === 'last'
         out.foldersKept = document.querySelectorAll('.folder-list li').length === foldersBefore
         out.behaviourRestored = selectField('Single click')?.value === 'select'
         out.wheelRestored = selectField('Volume wheel step')?.value === '5'
         out.resumeRestored = resumeInput()?.checked === false

         // Per-section reset: change General and Playback, then reset only
         // Playback. The startup view must survive a Playback reset, and the
         // wheel step must go back to its default without touching the other
         // section.
         tab('General')
         await sleep(250)
         setSelect('Open at launch', 'online')
         setSelect('Volume wheel step', '10')
         await sleep(500)
         tab('Misc')
         await sleep(300)
         const resetPlayback = [...document.querySelectorAll('button')].find(
           (el) => (el.textContent || '').trim() === 'Reset Playback'
         )
         press(resetPlayback)
         await sleep(700)
         out.sectionKeptOther =
           selectField('Open at launch')?.value === 'online' &&
           selectField('Volume wheel step')?.value === '5'
         const resetGeneral = [...document.querySelectorAll('button')].find(
           (el) => (el.textContent || '').trim() === 'Reset General'
         )
         press(resetGeneral)
         await sleep(700)
         out.sectionResetRestored = selectField('Open at launch')?.value === 'last'

         tab('About')
         await sleep(700)
         const aboutCard = [...document.querySelectorAll('.card')].find((card) => {
           const heading = card.querySelector('h2')
           return heading && (heading.textContent || '').trim().startsWith('About')
         })
         const statusNames = aboutCard
           ? [...aboutCard.querySelectorAll('.status-name')].map((el) => (el.textContent || '').trim())
           : []
         const statusValues = aboutCard
           ? [...aboutCard.querySelectorAll('.status-value')].map((el) => (el.textContent || '').trim())
           : []
         out.aboutRuntime =
           ['Suura', 'Electron', 'Chromium', 'Node'].every((name) => statusNames.includes(name)) &&
           statusValues.some((value) => Number.isFinite(Number.parseFloat(value)))
         const copyButton = aboutCard
           ? [...aboutCard.querySelectorAll('button')].find((el) =>
               (el.textContent || '').trim().startsWith('Copy diagnostics')
             )
           : null
         if (copyButton) {
           press(copyButton)
           await sleep(800)
           out.diagnosticsCopied = Boolean(aboutCard.querySelector('[role="status"]'))
         }
         const saveButton = aboutCard
           ? [...aboutCard.querySelectorAll('button')].find((el) =>
               (el.textContent || '').trim().startsWith('Save diagnostics')
             )
           : null
         out.saveDiagnosticsButton = Boolean(saveButton && !saveButton.disabled)
         return out
       })()`
    )
    record(
      settingsSafety.keyboardEnd && settingsSafety.keyboardHome,
      'settings: the tab strip moves with End, Home and arrow-key focus',
      settingsSafety
    )
    record(
      settingsSafety.watchTurnedOff && settingsSafety.watchRestored,
      'settings: the watch switch reaches settings and reset restores it',
      settingsSafety
    )
    record(
      settingsSafety.behaviourChanged && settingsSafety.behaviourRestored,
      'settings: reset preferences restores a changed select',
      settingsSafety
    )
    record(
      settingsSafety.resetConfirmShown && settingsSafety.resetStatusShown && settingsSafety.foldersKept,
      'settings: reset asks first, confirms, and keeps the library folder',
      settingsSafety
    )
    record(
      settingsSafety.backupCard && settingsSafety.backupsPath,
      'settings: Misc exposes backup, restore and the backups folder',
      settingsSafety
    )
    record(
      settingsSafety.exportButton,
      'settings: Misc exports the library as CSV',
      settingsSafety
    )
    record(
      settingsSafety.healthCard && settingsSafety.healthActions,
      'settings: Misc offers duplicate and missing-file care',
      settingsSafety
    )
    record(
      settingsSafety.startupChanged && settingsSafety.startupRestored,
      'settings: startup view reaches settings and reset restores it',
      settingsSafety
    )
    record(
      settingsSafety.wheelChanged &&
        settingsSafety.wheelRestored &&
        settingsSafety.resumeChanged &&
        settingsSafety.resumeRestored,
      'settings: wheel step and automatic resume are wired and reset together',
      settingsSafety
    )
    record(
      settingsSafety.retentionChanged && settingsSafety.retentionRestored,
      'settings: backup retention is editable and reset restores ten',
      settingsSafety
    )
    record(
      settingsSafety.sectionKeptOther && settingsSafety.sectionResetRestored,
      'settings: a per-section reset leaves the other sections alone',
      settingsSafety
    )
    record(
      settingsSafety.aboutRuntime,
      'settings: About shows the app and runtime versions',
      settingsSafety
    )
    const diagnosticsText = await clipboard.readText()
    record(
      settingsSafety.diagnosticsCopied &&
        diagnosticsText.includes('Suura ') &&
        diagnosticsText.includes('Library folders') &&
        !/cookie/i.test(diagnosticsText),
      'settings: Copy diagnostics puts versions and paths on the clipboard without cookies',
      diagnosticsText.slice(0, 160)
    )
    record(
      settingsSafety.saveDiagnosticsButton,
      'settings: About offers a local log-bundle save',
      `button ${settingsSafety.saveDiagnosticsButton ? 'enabled' : 'missing'}`
    )
    // ---- 11a. keyboard and screen-reader surface ------------------------
    // The app is usable without a mouse: one main landmark, the current page
    // marked, the YouTube tabs on arrow keys, and a dialog that keeps Tab inside
    // itself and hands focus back to the row that opened it.
    const accessibility = await evaluate<{
      navLabel: string
      currentPage: boolean
      mainCount: number
      tabArrow: boolean
      tabHome: boolean
      rovingTabIndex: boolean
      seekText: string
      volumeText: string
      dialogOpened: boolean
      dialogFocusInside: boolean
      tabWrapped: boolean
      dialogClosed: boolean
      focusReturned: boolean
    }>(
      window,
      `(async () => {
         const out = {
           navLabel: '', currentPage: false, mainCount: 0, tabArrow: false, tabHome: false,
           rovingTabIndex: false, seekText: '', volumeText: '', dialogOpened: false,
           dialogFocusInside: false, tabWrapped: false, dialogClosed: false, focusReturned: false
         }
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const press = (element) => { if (element) element.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
         const key = (element, key, extra = {}) => {
           if (element) element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...extra }))
         }
         const nav = (label) => {
           const button = [...document.querySelectorAll('.nav-item')].find((el) => (el.textContent || '').trim().startsWith(label))
           if (button) press(button)
         }

         out.navLabel = document.querySelector('nav.sidebar')?.getAttribute('aria-label') || ''
         out.currentPage =
           document.querySelector('nav.sidebar .nav-item[aria-current="page"]')?.textContent?.trim().startsWith('Settings') === true
         out.mainCount = [...document.querySelectorAll('main')].filter(
           (el) => el.getClientRects().length > 0
         ).length

         nav('YouTube')
         await sleep(500)
         const tab = (label) =>
           [...document.querySelectorAll('.downloads-tab')].find((el) => (el.textContent || '').trim() === label)
         const links = tab('Links')
         links?.focus()
         key(links, 'ArrowRight')
         await sleep(350)
         const saved = tab('Saved')
         out.tabArrow =
           saved?.getAttribute('aria-selected') === 'true' &&
           document.activeElement === saved
         key(saved, 'End')
         await sleep(300)
         const cache = tab('Cache')
         key(cache, 'Home')
         await sleep(300)
         out.tabHome =
           tab('Links')?.getAttribute('aria-selected') === 'true' &&
           document.activeElement === tab('Links')
         out.rovingTabIndex =
           tab('Links')?.tabIndex === 0 &&
           tab('Saved')?.tabIndex === -1 &&
           tab('Cache')?.tabIndex === -1

         out.seekText = document.querySelector('.seek-bar input')?.getAttribute('aria-valuetext') || ''
         out.volumeText =
           document.querySelector('input[aria-label="Volume level"]')?.getAttribute('aria-valuetext') || ''

         nav('Library')
         await sleep(600)
         // The library row has no Details button of its own: that action lives
         // in the row menu. Open the menu from the row, then take Details from
         // it, which is also the path whose focus restore matters most.
         const opener = [...document.querySelectorAll('.track-row button')].find((el) =>
           (el.getAttribute('aria-label') || '').startsWith('More actions for ')
         )
         opener?.focus()
         press(opener)
         await sleep(400)
         const detailsItem = [...document.querySelectorAll('.context-item')].find(
           (el) => (el.textContent || '').trim() === 'Details…'
         )
         press(detailsItem)
         await sleep(600)
         const dialog = document.querySelector('.details-dialog')
         out.dialogOpened = Boolean(dialog)
         out.dialogFocusInside = Boolean(dialog && dialog.contains(document.activeElement))
         if (dialog) {
           const items = [...dialog.querySelectorAll(
             'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
           )].filter((el) => el.getClientRects().length > 0)
           const first = items[0]
           const last = items[items.length - 1]
           last?.focus()
           key(last, 'Tab')
           out.tabWrapped = document.activeElement === first
           key(document.activeElement, 'Escape')
           await sleep(500)
         }
         out.dialogClosed = !document.querySelector('.details-dialog')
         out.focusReturned = document.activeElement === opener && Boolean(opener?.isConnected)
         return out
       })()`
    )
    record(
      accessibility.navLabel === 'Main' &&
        accessibility.currentPage &&
        accessibility.mainCount === 1,
      'accessibility: the shell has one main landmark and marks the current page',
      accessibility
    )
    record(
      accessibility.tabArrow &&
        accessibility.tabHome &&
        accessibility.rovingTabIndex,
      'accessibility: YouTube tabs move with arrow, Home and End keys',
      accessibility
    )
    record(
      / of /.test(accessibility.seekText) && /%$/.test(accessibility.volumeText),
      'accessibility: seek and volume sliders announce time and percent',
      accessibility
    )
    record(
      accessibility.dialogOpened &&
        accessibility.dialogFocusInside &&
        accessibility.tabWrapped &&
        accessibility.dialogClosed &&
        accessibility.focusReturned,
      'accessibility: a dialog traps Tab, closes on Escape and restores focus',
      accessibility
    )

    const diagnosticsTarget = join(app.getPath('userData'), 'diagnostics-selftest.txt')
    const originalShowSaveDialog = dialog.showSaveDialog
    let diagnosticsSaved = false
    let diagnosticsSavedDetail = 'not attempted'
    try {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: diagnosticsTarget
      })) as unknown as typeof dialog.showSaveDialog
      const savedPath = await evaluate<string | null>(
        window,
        `window.player.saveDiagnostics(${JSON.stringify('Selftest diagnostics\nLibrary folders 2')})`
      )
      const savedText = await readFile(diagnosticsTarget, 'utf8')
      const expectedPackaged = `Packaged: ${app.isPackaged ? 'yes' : 'no'}`
      const checks = {
        path: savedPath === diagnosticsTarget,
        summary: savedText.includes('Selftest diagnostics'),
        folders: savedText.includes('Library folders 2'),
        log: savedText.includes('--- log ---'),
        packaged: savedText.includes(expectedPackaged)
      }
      diagnosticsSaved = Object.values(checks).every(Boolean)
      diagnosticsSavedDetail = `${savedPath ?? 'cancelled'} (${Object.entries(checks)
        .map(([name, ok]) => `${name} ${ok ? 'ok' : 'missing'}`)
        .join(', ')})`
    } catch (cause) {
      diagnosticsSavedDetail = cause instanceof Error ? cause.message : String(cause)
    } finally {
      dialog.showSaveDialog = originalShowSaveDialog
      await rm(diagnosticsTarget, { force: true })
    }
    record(
      diagnosticsSaved,
      'settings: Save diagnostics writes the snapshot and the recent log',
      diagnosticsSavedDetail
    )

    // ---- 11a bis. local crash reports -----------------------------------
    // A crash report is opt-in and local. The self-test proves the switch
    // reaches settings, a written report appears in Misc, the bundle is a file
    // the user chose, and clearing removes it without touching anything else.
    container.crashes.clear()
    const crashUi = await evaluate<{ card: boolean; toggle: boolean; enabled: boolean }>(
      window,
      `(async () => {
         const out = { card: false, toggle: false, enabled: false }
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const press = (element) => { if (element) element.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
         const nav = (label) => {
           const button = [...document.querySelectorAll('.nav-item')].find((el) => (el.textContent || '').trim().startsWith(label))
           if (button) press(button)
         }
         const tab = (label) => {
           const button = [...document.querySelectorAll('.settings-tab')].find((el) => (el.textContent || '').trim() === label)
           if (button) press(button)
         }
         nav('Settings')
         await sleep(300)
         tab('Misc')
         await sleep(400)
         const card = [...document.querySelectorAll('.card')].find(
           (candidate) => (candidate.querySelector('h2')?.textContent || '').trim().startsWith('Crash reports')
         )
         out.card = Boolean(card)
         const label = card
           ? [...card.querySelectorAll('.field.checkbox')].find((el) =>
               (el.textContent || '').includes('Keep crash reports on this PC')
             )
           : null
         const input = label ? label.querySelector('input') : null
         out.toggle = Boolean(input)
         if (input && !input.checked) {
           input.click()
           await sleep(600)
         }
         const settings = await window.player.getSettings()
         out.enabled = settings.diagnostics.crashReports === true
         return out
       })()`
    )
    record(
      crashUi.card && crashUi.toggle && crashUi.enabled,
      'settings: Misc exposes the local crash-report card and its opt-in switch',
      crashUi
    )

    const selftestCrashFile = container.crashes.record({
      kind: 'renderer',
      reason: 'crashed',
      message: 'selftest renderer crash',
      exitCode: 1337,
      details: { proof: 'selftest' }
    })
    const crashStatusAfterWrite = container.crashes.status()
    record(
      selftestCrashFile !== null && crashStatusAfterWrite.count === 1,
      'settings: an opted-in renderer crash writes a local report',
      { file: selftestCrashFile, count: crashStatusAfterWrite.count }
    )

    const crashPanel = await evaluate<{
      card: boolean
      countShown: boolean
      exportEnabled: boolean
      clearEnabled: boolean
    }>(
      window,
      `(async () => {
         const out = { card: false, countShown: false, exportEnabled: false, clearEnabled: false }
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const press = (element) => { if (element) element.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
         const nav = (label) => {
           const button = [...document.querySelectorAll('.nav-item')].find((el) => (el.textContent || '').trim().startsWith(label))
           if (button) press(button)
         }
         const tab = (label) => {
           const button = [...document.querySelectorAll('.settings-tab')].find((el) => (el.textContent || '').trim() === label)
           if (button) press(button)
         }
         nav('Library')
         await sleep(250)
         nav('Settings')
         await sleep(350)
         tab('Misc')
         await sleep(500)
         const card = [...document.querySelectorAll('.card')].find(
           (candidate) => (candidate.querySelector('h2')?.textContent || '').trim().startsWith('Crash reports')
         )
         out.card = Boolean(card)
         const text = card ? card.textContent || '' : ''
         out.countShown = text.includes('Saved reports') && /(^|\\D)1(\\D|$)/.test(text)
         const button = (label) =>
           card ? [...card.querySelectorAll('button')].find((el) => (el.textContent || '').trim().startsWith(label)) : null
         out.exportEnabled = Boolean(button('Save reports') && !button('Save reports').disabled)
         out.clearEnabled = Boolean(button('Clear reports') && !button('Clear reports').disabled)
         return out
       })()`
    )
    record(
      crashPanel.card && crashPanel.countShown && crashPanel.exportEnabled && crashPanel.clearEnabled,
      'settings: the crash-report card shows the saved count and its actions',
      crashPanel
    )

    const crashExportTarget = join(app.getPath('userData'), 'crash-reports-selftest.txt')
    const originalCrashSaveDialog = dialog.showSaveDialog
    let crashExportOk = false
    let crashExportDetail = 'not attempted'
    try {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: crashExportTarget
      })) as unknown as typeof dialog.showSaveDialog
      await evaluate<boolean>(
        window,
        `(async () => {
           const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
           const card = [...document.querySelectorAll('.card')].find(
             (candidate) => (candidate.querySelector('h2')?.textContent || '').trim().startsWith('Crash reports')
           )
           const button = card
             ? [...card.querySelectorAll('button')].find((el) => (el.textContent || '').trim().startsWith('Save reports'))
             : null
           if (button) button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
           await sleep(900)
           return Boolean(button)
         })()`
      )
      const crashExportText = await readFile(crashExportTarget, 'utf8')
      crashExportOk =
        crashExportText.includes('Suura crash reports') &&
        crashExportText.includes('selftest renderer crash') &&
        crashExportText.includes('Nothing here was uploaded') &&
        crashExportText.includes('--- crash-')
      crashExportDetail = `${crashExportText.length} chars`
    } catch (cause) {
      crashExportDetail = cause instanceof Error ? cause.message : String(cause)
    } finally {
      dialog.showSaveDialog = originalCrashSaveDialog
    }
    record(crashExportOk, 'settings: Save reports writes the local crash bundle', crashExportDetail)

    const crashClear = await evaluate<{ count: number; confirmed: boolean }>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const card = [...document.querySelectorAll('.card')].find(
           (candidate) => (candidate.querySelector('h2')?.textContent || '').trim().startsWith('Crash reports')
         )
         const clear = card
           ? [...card.querySelectorAll('button')].find((el) => (el.textContent || '').trim().startsWith('Clear reports'))
           : null
         if (clear) clear.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(250)
         const confirm = [...document.querySelectorAll('.reset-confirm button')].find(
           (el) => (el.textContent || '').trim() === 'Delete reports'
         )
         if (confirm) confirm.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(700)
         const status = await window.player.getCrashReports()
         return { count: status.count, confirmed: Boolean(confirm) }
       })()`
    )
    record(
      crashClear.confirmed && crashClear.count === 0,
      'settings: Clear reports asks first and empties the folder',
      crashClear
    )

    const optOut = await evaluate<{ ignored: boolean; count: number }>(
      window,
      `(async () => {
         await window.player.updateSettings({ diagnostics: { crashReports: false } })
         return { ignored: false, count: (await window.player.getCrashReports()).count }
       })()`
    )
    const optOutReport = container.crashes.record({ kind: 'main-exception', reason: 'opt-out test' })
    record(
      optOutReport === null && optOut.count === 0 && container.crashes.status().count === 0,
      'settings: turning crash reports off stops new files',
      { ignored: optOutReport === null, count: optOut.count }
    )
    await rm(crashExportTarget, { force: true })

    // ---- 11b. retention mode, cache IPC and save history ----------------
    // The mode control drives the same settings block the resolver reads. The
    // budget and age fields only exist in `cache` mode, so their presence is the
    // proof that the UI is following the mode rather than always rendering them.
    const retentionUi = await evaluate<{
      modeBefore: string
      cacheFieldsShown: boolean
      modeAfter: string
      budget: string
      age: string
      badgeGone: boolean
      restored: string
    }>(
      window,
      `(async () => {
         const out = { modeBefore: '', cacheFieldsShown: false, modeAfter: '', budget: '', age: '', badgeGone: false, restored: '' }
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const press = (element) => { if (element) element.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
         const nav = (label) => {
           const button = [...document.querySelectorAll('.nav-item')].find((el) => (el.textContent || '').trim().startsWith(label))
           if (button) press(button)
         }
         const tab = (label) => {
           const button = [...document.querySelectorAll('.settings-tab')].find((el) => (el.textContent || '').trim() === label)
           if (button) press(button)
         }
         const field = (label) => {
           for (const candidate of document.querySelectorAll('.field')) {
             const title = candidate.querySelector('span')
             if (title && (title.textContent || '').trim().startsWith(label)) return candidate
           }
           return null
         }
         const modeSelect = () => {
           const candidate = field('When a YouTube track plays')
           return candidate ? candidate.querySelector('select') : null
         }

         nav('Settings')
         await sleep(300)
         tab('Streaming')
         await sleep(300)

         out.modeBefore = modeSelect() ? modeSelect().value : ''
         out.badgeGone = ![...document.querySelectorAll('.badge')].some(
           (el) => (el.textContent || '').trim() === 'stream only'
         )
         const select = modeSelect()
         if (select) {
           select.value = 'cache'
           select.dispatchEvent(new Event('change', { bubbles: true }))
         }
         await sleep(700)
         out.modeAfter = modeSelect() ? modeSelect().value : ''
         const budgetField = field('Cache budget')
         const ageField = field('Keep cached tracks for')
         out.budget = budgetField?.querySelector('input')?.value || ''
         out.age = ageField?.querySelector('input')?.value || ''
         out.cacheFieldsShown = Boolean(out.budget && out.age)

         // Leave the app on the default before anything later reads a source.
         const restore = modeSelect()
         if (restore) {
           restore.value = 'stream'
           restore.dispatchEvent(new Event('change', { bubbles: true }))
         }
         await sleep(700)
         out.restored = modeSelect() ? modeSelect().value : ''
         return out
       })()`
    )
    record(retentionUi.modeBefore === 'stream', 'streaming: the retention control starts on Stream only', retentionUi)
    record(
      retentionUi.modeAfter === 'cache' && retentionUi.cacheFieldsShown,
      'streaming: choosing Cache reveals its budget and age controls',
      retentionUi
    )
    record(retentionUi.badgeGone, 'streaming: the old stream-only badge is gone', retentionUi)
    record(
      retentionUi.restored === 'stream' && container.settings.get().retention.mode === 'stream',
      'streaming: the retention mode is written back and can be restored',
      container.settings.get().retention
    )

    // The equalizer is a playback control now: Settings keeps a one-line way in,
    // the panel hangs off the player bar, and the keyboard opens, moves a band,
    // and closes it with Escape while returning focus to the opener. The long
    // normalization explanation is gone and its remaining action starts at the
    // card's own left edge.
    const audioUi = await evaluate<{
      openButton: boolean
      slidersInSettings: number
      panelOpen: boolean
      bands: number
      preamp: boolean
      focusedPanel: boolean
      panelTitle: string
      barOrder: string
      barEqButton: boolean
      panelClosedByEscape: boolean
      focusReturned: boolean
      normalizationHint: string
      scanAligned: string
      eqCardHint: string
      panelBottom: number
      barTop: number
      barHeight: number
      panelWidth: number
      panelHeight: number
      bandWidth: number
      bandHeight: number
      eqIconDistinct: boolean
      mergedAudio: boolean
    }>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const press = (element) => { if (element) element.click() }
         const text = (element) => ((element && element.textContent) || '').trim()
         const nav = (label) =>
           [...document.querySelectorAll('.nav-item')].find((el) => text(el).startsWith(label))
         const tab = (label) =>
           [...document.querySelectorAll('.settings-tab')].find((el) => text(el) === label)
         const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
         const out = {
           openButton: false, slidersInSettings: 0, panelOpen: false, bands: 0, preamp: false,
           focusedPanel: false, panelTitle: '', barOrder: '', barEqButton: false,
           panelClosedByEscape: false, focusReturned: false, normalizationHint: '',
           scanAligned: '', eqCardHint: '', panelBottom: 0, barTop: 0, barHeight: 0,
           panelWidth: 0, panelHeight: 0, bandWidth: 0, bandHeight: 0, eqIconDistinct: false,
           mergedAudio: false
         }

         press(nav('Settings'))
         await sleep(300)
         press(tab('General'))
         await sleep(350)

         const panel = document.querySelector('.settings-panel:not([hidden])')
         const open = [...(panel || document).querySelectorAll('button')].find(
           (button) => text(button) === 'Open equalizer'
         )
         const eqCard = [...(panel || document).querySelectorAll('.audio-card')].find(
           (card) => text(card.querySelector('h2')) === 'Audio'
         )
         const normalCard = eqCard
         out.mergedAudio = Boolean(
           eqCard &&
             eqCard.querySelector('button') &&
             eqCard.querySelectorAll('input[type="checkbox"]').length === 2
         )
         out.openButton = Boolean(open && eqCard)
         out.eqCardHint = text(eqCard?.querySelector('.card-hint'))
         out.slidersInSettings = (panel || document).querySelectorAll('.eq-band').length
         out.normalizationHint = [...(normalCard?.querySelectorAll('.card-hint') || [])]
           .map((hint) => text(hint))
           .join(' | ')
         const actionRows = [...(normalCard?.querySelectorAll('.card-actions') || [])]
         const actions = actionRows[actionRows.length - 1]
         out.scanAligned = actions ? getComputedStyle(actions).justifyContent : ''

         press(open)
         await sleep(350)
         const eqPanel = document.querySelector('.eq-panel')
         out.panelOpen = Boolean(eqPanel)
         out.panelTitle = text(eqPanel?.querySelector('h2'))
         out.bands = eqPanel?.querySelectorAll('.eq-band').length || 0
         out.preamp = Boolean(eqPanel?.querySelector('input[aria-label="Preamp"]'))
         out.focusedPanel = document.activeElement === eqPanel
         const panelBox = eqPanel?.getBoundingClientRect()
         const barBox = document.querySelector('.player-bar')?.getBoundingClientRect()
         out.panelBottom = panelBox?.bottom || 0
         out.barTop = barBox?.top || 0
         out.barHeight = barBox?.height || 0
         out.panelWidth = panelBox?.width || 0
         out.panelHeight = panelBox?.height || 0

         const band = [...(eqPanel?.querySelectorAll('.eq-band input') || [])].find(
           (input) => input.getAttribute('aria-label') === '1 kHz gain'
         )
         const bandBox = band?.getBoundingClientRect()
         out.bandWidth = bandBox?.width || 0
         out.bandHeight = bandBox?.height || 0
         if (band) {
           setValue.call(band, '3')
           band.dispatchEvent(new Event('input', { bubbles: true }))
           await sleep(600)
         }

         document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
         await sleep(350)
         out.panelClosedByEscape = !document.querySelector('.eq-panel')
         out.focusReturned = document.activeElement === open

         const rightButtons = [...document.querySelectorAll('.player-volume > button')]
         out.barOrder = rightButtons.map((button) => button.getAttribute('aria-label')).join('|')
         const eqButton = rightButtons.find((button) => button.getAttribute('aria-label') === 'Equalizer')
         out.barEqButton = Boolean(eqButton)
         const eqIcon = eqButton?.querySelector('svg')?.innerHTML || ''
         const settingsIcon = nav('Settings')?.querySelector('svg')?.innerHTML || ''
         const queueIcon = document.querySelector('.queue-button svg')?.innerHTML || ''
         out.eqIconDistinct =
           Boolean(eqIcon) && eqIcon !== settingsIcon && eqIcon !== queueIcon
         press(eqButton)
         await sleep(300)
         out.panelOpen = out.panelOpen && Boolean(document.querySelector('.eq-panel'))
         document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
         await sleep(250)
         return out
       })()`
    )
    record(
      audioUi.openButton && audioUi.slidersInSettings === 0 && audioUi.eqCardHint.length > 0,
      'equalizer: Settings keeps a short shortcut, not the whole curve',
      audioUi
    )
    record(
      audioUi.mergedAudio,
      'equalizer: the equalizer and loudness controls share one Audio card',
      audioUi
    )
    record(
      audioUi.panelOpen &&
        audioUi.panelTitle === 'Equalizer' &&
        audioUi.bands === 10 &&
        audioUi.preamp &&
        audioUi.focusedPanel,
      'equalizer: the panel opens from its shortcut with every band and the preamp',
      audioUi
    )
    record(
      audioUi.panelBottom <= audioUi.barTop - 1 &&
        audioUi.barHeight < 120 &&
        audioUi.panelWidth >= 400 &&
        audioUi.panelWidth <= 620 &&
        audioUi.panelHeight <= 420 &&
        audioUi.bandHeight > audioUi.bandWidth * 2,
      'equalizer: a compact fader strip stays above the player bar',
      {
        panelBottom: audioUi.panelBottom,
        barTop: audioUi.barTop,
        barHeight: audioUi.barHeight,
        width: audioUi.panelWidth,
        height: audioUi.panelHeight,
        band: `${audioUi.bandWidth}x${audioUi.bandHeight}`
      }
    )
    record(
      audioUi.panelClosedByEscape && audioUi.focusReturned,
      'equalizer: Escape closes the panel and returns focus to the opener',
      audioUi
    )
    record(
      audioUi.barOrder.startsWith('Open the mini player|Equalizer|Open queue') && audioUi.barEqButton,
      'equalizer: the player bar button sits between Mini player and Queue',
      audioUi
    )
    record(
      audioUi.eqIconDistinct,
      'equalizer: the trigger has its own icon, not the Settings or Queue one',
      audioUi
    )
    record(
      container.settings.get().audio.equalizer.bands[5] === 3,
      'equalizer: moving a band is written to the audio settings'
    )
    await evaluate<void>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const button = [...document.querySelectorAll('.player-volume > button')].find(
           (candidate) => candidate.getAttribute('aria-label') === 'Equalizer'
         )
         if (button) button.click()
         await sleep(300)
         const band = [...document.querySelectorAll('.eq-panel .eq-band input')].find(
           (input) => input.getAttribute('aria-label') === '1 kHz gain'
         )
         if (band) {
           const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
           setValue.call(band, '0')
           band.dispatchEvent(new Event('input', { bubbles: true }))
         }
         await sleep(500)
         document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
         await sleep(250)
       })()`
    )
    record(
      container.settings.get().audio.equalizer.bands[5] === 0,
      'equalizer: the test band can be reset'
    )
    record(
      !audioUi.normalizationHint.includes('Analysis decodes') && audioUi.scanAligned === 'flex-start',
      'normalization: the long analysis paragraph is gone and Analyse missing tracks is left-aligned',
      audioUi
    )

    container.downloadHistory.record(
      {
        videoId: 'selftestvid',
        status: 'failed',
        percent: null,
        error: 'Selftest save failure',
        trackId: null
      },
      { videoId: 'selftestvid', title: 'Selftest failed save', artist: null, album: null }
    )
    const cacheApi = await evaluate<{
      budgetBytes: number
      entries: number
      listed: number
      historyFound: boolean
      historyTitle: string
    }>(
      window,
      `(async () => {
         const stats = await window.player.getCacheStats()
         const entries = await window.player.listCacheEntries()
         const history = await window.player.listDownloadHistory()
         const row = history.find((item) => item.videoId === 'selftestvid')
         return {
           budgetBytes: stats.budgetBytes,
           entries: stats.entries,
           listed: entries.length,
           historyFound: Boolean(row),
           historyTitle: row ? row.title : ''
         }
       })()`
    )
    const expectedBudget = container.settings.get().retention.cacheBudgetMb * 1024 * 1024
    record(
      cacheApi.budgetBytes === expectedBudget && cacheApi.entries === 0 && cacheApi.listed === 0,
      'cache: the IPC reports the configured budget and an empty cache',
      cacheApi
    )
    record(
      cacheApi.historyFound && cacheApi.historyTitle === 'Selftest failed save',
      'downloads: a failed save is listed by the history API',
      cacheApi
    )

    // YouTube owns the two ledgers now. A direct history write in this test does
    // not produce a download event, so announce the same failure the service
    // would. This checks the real route: sidebar -> YouTube -> Saved -> failed
    // row -> Cache tab, not just the IPC contract.
    broadcast(IPC_EVENTS.downloadChanged, {
      videoId: 'selftestvid',
      status: 'failed',
      percent: null,
      error: 'Selftest save failure',
      trackId: null,
      speedBytesPerSecond: null,
      etaSeconds: null
    })
    const downloadsUi = await evaluate<{
      opened: boolean
      activeNav: string
      downloadsNav: boolean
      tabs: string
      rows: number
      failedTitle: string
      failedStatus: string
      retry: boolean
      cacheTabActive: boolean
      cacheEmpty: string
    }>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const text = (element) => ((element && element.textContent) || '').trim()
         const nav = (label) =>
           [...document.querySelectorAll('.nav-item')].find((el) => text(el).startsWith(label))
         const downloadsNav = Boolean(nav('Downloads'))
         nav('YouTube')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(600)
         const savedTab = [...document.querySelectorAll('.downloads-tab')].find((el) =>
           text(el).includes('Saved')
         )
         savedTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(500)
         const view = document.querySelector('.online-view')
         const rows = [...document.querySelectorAll('.download-item')]
         const failed = rows.find((row) =>
           (row.textContent || '').includes('Selftest failed save')
         )
         const out = {
           opened: Boolean(view) && Boolean(savedTab),
           activeNav: text(document.querySelector('.nav-item.active')),
           downloadsNav,
           tabs: [...document.querySelectorAll('.downloads-tab')]
             .map((el) => text(el))
             .join('|'),
           rows: rows.length,
           failedTitle: text(failed?.querySelector('.download-title')),
           failedStatus: text(failed?.querySelector('.download-status')),
           retry: Boolean(
             failed &&
               [...failed.querySelectorAll('button')].some(
                 (button) => button.getAttribute('title') === 'Try this save again'
               )
           ),
           cacheTabActive: false,
           cacheEmpty: ''
         }
         const cacheTab = [...document.querySelectorAll('.downloads-tab')].find((el) =>
           text(el).includes('Cache')
         )
         cacheTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(500)
         out.cacheTabActive = cacheTab?.getAttribute('aria-selected') === 'true'
         out.cacheEmpty =
           (document.querySelector('.cache-panel .downloads-empty')?.textContent || '').trim()
         return out
       })()`
    )
    record(
      downloadsUi.opened && downloadsUi.activeNav.startsWith('YouTube'),
      'downloads: YouTube in the sidebar opens the Saved downloads tab',
      downloadsUi
    )
    record(
      !downloadsUi.downloadsNav,
      'downloads: the sidebar no longer has its own Downloads item',
      downloadsUi
    )
    record(
      downloadsUi.tabs === 'Links|Saved|Cache',
      'downloads: the YouTube header offers Links, Saved and Cache toggles',
      downloadsUi
    )
    record(
      downloadsUi.rows === 1 &&
        downloadsUi.failedTitle === 'Selftest failed save' &&
        downloadsUi.failedStatus === 'Selftest save failure' &&
        downloadsUi.retry,
      'downloads: a failed save appears with its error and retry action',
      downloadsUi
    )
    record(
      downloadsUi.cacheTabActive && downloadsUi.cacheEmpty.includes('The cache is empty'),
      'downloads: the cache tab reports an empty cache',
      downloadsUi
    )

    // The dock is the way a failed save stays findable after leaving the tab.
    // Its Manage link must land on the ledgers, not merely open YouTube.
    const manageLink = await evaluate<{ found: boolean; opened: boolean; tab: string }>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const text = (element) => ((element && element.textContent) || '').trim()
         const manage = [...document.querySelectorAll('.saves-panel button')].find(
           (button) => text(button) === 'Manage'
         )
         manage?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(600)
         const activeTab = [...document.querySelectorAll('.downloads-tab')].find(
           (el) => el.getAttribute('aria-selected') === 'true'
         )
         return {
           found: Boolean(manage),
           opened: Boolean(document.querySelector('.online-view')),
           tab: text(activeTab)
         }
       })()`
    )
    record(
      manageLink.found && manageLink.opened && manageLink.tab === 'Saved',
      'downloads: the Saves dock opens YouTube on the Saved tab',
      manageLink
    )

    // Re-entering the view must read persisted history, not the slice that
    // happened to be loaded when the app started. This is the relaunch symptom
    // reduced to a remount, plus the layout regression: YouTube's Saved tab
    // scrolls like every other main view and keeps its top padding.
    container.downloadHistory.record(
      {
        videoId: 'selftest002',
        status: 'saved',
        percent: 100,
        error: null,
        trackId: null
      },
      { videoId: 'selftest002', title: 'Selftest saved track', artist: 'Night', album: 'Offline' }
    )
    broadcast(IPC_EVENTS.downloadChanged, {
      videoId: 'selftest002',
      status: 'saved',
      percent: 100,
      error: null,
      trackId: null,
      speedBytesPerSecond: null,
      etaSeconds: null
    })
    const persistedLayout = await evaluate<{
      savedFound: boolean
      mainView: boolean
      topPadding: number
    }>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const nav = (label) =>
           [...document.querySelectorAll('.nav-item')].find((el) =>
             (el.textContent || '').trim().startsWith(label)
           )
         nav('Home')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(250)
         nav('YouTube')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(300)
         const savedTab = [...document.querySelectorAll('.downloads-tab')].find((el) =>
           (el.textContent || '').trim().includes('Saved')
         )
         savedTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(500)
         const view = document.querySelector('.online-view')
         const saved = [...document.querySelectorAll('.download-item')].find((row) =>
           (row.textContent || '').includes('Selftest saved track')
         )
         return {
           savedFound: Boolean(saved),
           mainView: Boolean(view && view.classList.contains('main-view')),
           topPadding: view ? parseFloat(getComputedStyle(view).paddingTop) : -1
         }
       })()`
    )
    record(
      persistedLayout.savedFound,
      'downloads: a saved row is still listed after leaving and reopening the view',
      persistedLayout
    )
    record(
      persistedLayout.mainView && persistedLayout.topPadding >= 16,
      'downloads: the Saved tab uses the shared main-view scroll container and top padding',
      persistedLayout
    )

    await evaluate<void>(window, `window.player.dismissDownload('selftestvid')`)
    await evaluate<void>(window, `window.player.dismissDownload('selftest002')`)
    record(
      container.downloadHistory.get('selftestvid') === null &&
        container.downloadHistory.get('selftest002') === null,
      'downloads: dismissing history rows removes them from disk'
    )

    // Saved rows and cache rows are different kinds of thing, and the screen now
    // makes their actions different too: Remove from list forgets a row, Delete
    // files removes the file, Clean now applies the visible cache limits, and a
    // cached track can be saved without downloading it again. These checks drive
    // the real screen; the destructive delete uses a disposable copy so the
    // fixture library the rest of the suite relies on is untouched.
    const playTrack = container.library.list().tracks.find((track) => track.title === 'Selftest Tone')
    if (!playTrack || !playTrack.filePath) throw new Error('selftest: the playable fixture is missing')
    const deleteDir = join(container.paths.userData, 'selftest-download-delete')
    await mkdir(deleteDir, { recursive: true })
    const deletePath = join(deleteDir, 'Selftest Delete.flac')
    await copyFile(playTrack.filePath, deletePath)
    await container.library.scan(deleteDir)
    const deleteTrack = container.library
      .list()
      .tracks.find(
        (track) => track.filePath !== null && track.filePath.includes('selftest-download-delete')
      )
    if (!deleteTrack) throw new Error('selftest: the disposable download was not indexed')
    // A saved download is a local row that remembers its video; without this
    // origin the removal code cannot know which file belongs to the history row.
    container.repo.setOrigin(deleteTrack.id, 'youtube', 'selftestdl2')

    container.downloadHistory.record(
      { videoId: 'selftestdl1', status: 'saved', percent: 100, error: null, trackId: playTrack.id },
      { videoId: 'selftestdl1', title: 'Selftest Saved Song', artist: 'Night', album: 'Offline' }
    )
    container.downloadHistory.record(
      { videoId: 'selftestdl2', status: 'saved', percent: 100, error: null, trackId: deleteTrack.id },
      { videoId: 'selftestdl2', title: 'Selftest Delete Me', artist: 'Night', album: 'Offline' }
    )
    broadcast(IPC_EVENTS.downloadChanged, {
      videoId: 'selftestdl2',
      status: 'saved',
      percent: 100,
      error: null,
      trackId: deleteTrack.id,
      speedBytesPerSecond: null,
      etaSeconds: null
    })

    const savedActions = await evaluate<{
      savedRow: boolean
      meta: string
      status: string
      playEnabled: boolean
      queueEnabled: boolean
      removeEnabled: boolean
      deleteEnabled: boolean
      playedTitle: string
      queueText: string
      forgotten: boolean
      deleteControl: boolean
      deleteStillListed: boolean
      deleteStatus: string
    }>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const press = (element) => { if (element) element.click() }
         const text = (element) => ((element && element.textContent) || '').trim()
         const nav = (label) =>
           [...document.querySelectorAll('.nav-item')].find((el) => text(el).startsWith(label))
         const rowBy = (label) =>
           [...document.querySelectorAll('.download-item')].find((row) => text(row).includes(label))
         const toolbarButton = (label) =>
           [...document.querySelectorAll('.downloads-toolbar button')].find((button) =>
             text(button).includes(label)
           )
         const out = {
           savedRow: false, meta: '', status: '', playEnabled: false, queueEnabled: false,
           removeEnabled: false, deleteEnabled: false, playedTitle: '', queueText: '',
           forgotten: false, deleteControl: false, deleteStillListed: false, deleteStatus: ''
         }
         nav('Home')?.click()
         await sleep(200)
         nav('YouTube')?.click()
         await sleep(300)
         const savedTab = [...document.querySelectorAll('.downloads-tab')].find((el) =>
           text(el).includes('Saved')
         )
         press(savedTab)
         await sleep(700)

         const row = rowBy('Selftest Saved Song')
         out.savedRow = Boolean(row)
         out.meta = text(row?.querySelector('.download-meta'))
         out.status = text(row?.querySelector('.download-status'))
         const box = row?.querySelector('.download-select input')
         press(box)
         await sleep(250)
         out.playEnabled = !(toolbarButton('Play selected')?.disabled ?? true)
         out.queueEnabled = !(toolbarButton('Queue selected')?.disabled ?? true)
         out.removeEnabled = !(toolbarButton('Remove from list')?.disabled ?? true)
         out.deleteEnabled = !(toolbarButton('Delete files')?.disabled ?? true)

         press(toolbarButton('Play selected'))
         await sleep(900)
         out.playedTitle = text(document.querySelector('.player-title'))
         press(toolbarButton('Queue selected'))
         await sleep(600)
         out.queueText = text(document.querySelector('.player-subtitle'))

         press(toolbarButton('Remove from list'))
         await sleep(700)
         out.forgotten = !rowBy('Selftest Saved Song')

         window.confirm = () => true
         const deleteRow = rowBy('Selftest Delete Me')
         const trash = deleteRow
           ? [...deleteRow.querySelectorAll('.download-actions button')].find(
               (button) => button.getAttribute('title') === 'Delete the saved file and stream from YouTube'
             )
           : null
         out.deleteControl = Boolean(trash)
         press(trash)
         await sleep(1200)
         const after = rowBy('Selftest Delete Me')
         out.deleteStillListed = Boolean(after)
         out.deleteStatus = text(after?.querySelector('.download-status'))
         return out
       })()`
    )
    record(
      savedActions.savedRow &&
        savedActions.meta.includes('Night') &&
        savedActions.status === 'Saved to your library',
      'downloads: a saved row shows its title, artist and saved state',
      savedActions
    )
    record(
      savedActions.playEnabled &&
        savedActions.queueEnabled &&
        savedActions.removeEnabled &&
        savedActions.deleteEnabled,
      'downloads: selecting a saved row enables play, queue, forget and delete',
      savedActions
    )
    record(
      savedActions.playedTitle === 'Selftest Tone' && savedActions.queueText.includes('(1/2)'),
      'downloads: Play selected loads the row and Queue selected appends it',
      savedActions
    )
    record(
      savedActions.forgotten && existsSync(playTrack.filePath),
      'downloads: Remove from list forgets the history row but keeps the file',
      savedActions
    )
    record(
      savedActions.deleteControl &&
        savedActions.deleteStillListed &&
        savedActions.deleteStatus.includes('File removed') &&
        !existsSync(deletePath),
      'downloads: Delete file removes the saved file after confirmation',
      savedActions
    )
    record(
      container.downloadHistory.get('selftestdl1') === null &&
        container.downloadHistory.get('selftestdl2')?.status === 'removed' &&
        container.repo.getById(deleteTrack.id)?.sourceKind === 'youtube',
      'downloads: a deleted file leaves a streamable row behind'
    )
    container.library.removeFolder(deleteDir)
    await rm(deleteDir, { recursive: true, force: true }).catch(() => undefined)
    container.downloadHistory.remove('selftestdl1')
    container.downloadHistory.remove('selftestdl2')

    // The cache tab lists cached bytes with the identity the user saw, not a
    // video id. Clean now must follow the same age and size limits as the
    // janitor, and Save to library must be offered without a re-download.
    const cacheDir = join(container.paths.cache, 'stream')
    await mkdir(cacheDir, { recursive: true })
    const freshCachePath = join(cacheDir, 'selftestaa1.flac')
    const staleCachePath = join(cacheDir, 'selftestbb2.flac')
    await copyFile(playTrack.filePath, freshCachePath)
    await copyFile(playTrack.filePath, staleCachePath)
    const cacheNow = Date.now()
    const cacheInsert = container.database.db.prepare(
      `INSERT OR REPLACE INTO cache_entries
         (video_id, path, size_bytes, complete, pinned, mime_type, created_at, last_used_at)
       VALUES (?, ?, ?, 1, 0, 'audio/flac', ?, ?)`
    )
    cacheInsert.run(
      'selftestaa1',
      freshCachePath,
      (await stat(freshCachePath)).size,
      cacheNow,
      cacheNow
    )
    cacheInsert.run(
      'selftestbb2',
      staleCachePath,
      (await stat(staleCachePath)).size,
      cacheNow - 45 * 24 * 60 * 60_000,
      cacheNow - 45 * 24 * 60 * 60_000
    )

    const cacheUi = await evaluate<{
      rowsBefore: number
      meta: string
      policy: string
      retention: string
      cleanButton: boolean
      saveControl: boolean
      bulkSaveEnabled: boolean
      rowsAfter: number
      freshSurvived: boolean
      staleGone: boolean
      notice: string
    }>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const press = (element) => { if (element) element.click() }
         const text = (element) => ((element && element.textContent) || '').trim()
         const nav = (label) =>
           [...document.querySelectorAll('.nav-item')].find((el) => text(el).startsWith(label))
         const rows = () => [...document.querySelectorAll('.cache-panel .download-item')]
         const rowBy = (label) => rows().find((row) => text(row).includes(label))
         const summaryButton = (label) =>
           [...document.querySelectorAll('.cache-summary-actions button')].find((button) =>
             text(button).includes(label)
           )
         const out = {
           rowsBefore: 0, meta: '', policy: '', retention: '', cleanButton: false,
           saveControl: false, bulkSaveEnabled: false, rowsAfter: 0,
           freshSurvived: false, staleGone: false, notice: ''
         }
         nav('Home')?.click()
         await sleep(200)
         nav('YouTube')?.click()
         await sleep(300)
         const cacheTab = [...document.querySelectorAll('.downloads-tab')].find((el) =>
           text(el).includes('Cache')
         )
         press(cacheTab)
         await sleep(1000)

         out.rowsBefore = rows().length
         const fresh = rowBy('Online Tone One')
         out.meta = text(fresh?.querySelector('.download-meta'))
         out.policy = text(document.querySelector('.cache-policy'))
         out.retention = text(document.querySelector('.cache-retention'))
         out.cleanButton = Boolean(summaryButton('Clean now'))
         out.saveControl = Boolean(
           fresh && [...fresh.querySelectorAll('button')].some((button) => text(button) === 'Save to library')
         )
         press(fresh?.querySelector('.download-select input'))
         await sleep(250)
         const bulk = [...document.querySelectorAll('.cache-panel .downloads-toolbar button')].find(
           (button) => text(button).includes('Save selected')
         )
         out.bulkSaveEnabled = Boolean(bulk && !bulk.disabled)

         press(summaryButton('Clean now'))
         await sleep(1400)
         out.rowsAfter = rows().length
         out.freshSurvived = Boolean(rowBy('Online Tone One'))
         out.staleGone = !rowBy('Online Tone Two')
         out.notice = text(document.querySelector('.cache-notice'))
         return out
       })()`
    )
    record(
      cacheUi.rowsBefore === 2 && cacheUi.meta.includes('Selftest Streamer'),
      'cache: cached rows show the title and artist from YouTube history',
      cacheUi
    )
    record(
      cacheUi.policy.includes('30 days') && cacheUi.retention.includes('size limit'),
      'cache: the screen explains the age and size policy it enforces',
      cacheUi
    )
    record(
      cacheUi.cleanButton && cacheUi.saveControl && cacheUi.bulkSaveEnabled,
      'cache: Clean now and Save to library are offered for cached tracks',
      cacheUi
    )
    record(
      cacheUi.rowsAfter === 1 &&
        cacheUi.freshSurvived &&
        cacheUi.staleGone &&
        cacheUi.notice.includes('Cleaned'),
      'cache: Clean now removes only entries past the visible limits',
      cacheUi
    )
    container.streamCache.remove('selftestaa1')
    container.streamCache.remove('selftestbb2')
    record(
      container.streamCache.get('selftestaa1') === null && !existsSync(freshCachePath),
      'cache: removing a seeded test entry cleans up its file'
    )

    // ---- 12. artwork preferences, bar ambience, volume -----------------
    // The Visuals setting is published as data attributes on `.app`, so the whole
    // UI follows from one place. This drives it through the actual <select>
    // elements rather than the IPC channel, because `useSettings` only learns
    // about changes it made itself — going through the UI is both the honest test
    // and the only one that would catch a control that is not wired up.
    //
    // Both services are replaced for the same reason: the ranking rules are
    // pinned down in `npm run smoke`, so what the renderer half has to prove is
    // the seam — a match is proposed, choosing it relabels the panel, and going
    // back to the file restores the file's own lyrics. The stub answers with
    // one match from each service so the label and the attribution link are
    // both exercised.
    const finderCandidates = [
      {
        provider: 'lrclib' as const,
        providerId: 'selftest-lyrics',
        title: 'Selftest Tone',
        artist: 'Selftest',
        album: 'Selftest Album',
        durationMs: 3000,
        synced: true,
        text: '[00:00.40]found first\n[00:01.40]found second',
        instrumental: false,
        url: null,
        score: 0.93,
        confidence: 'strong' as const
      },
      {
        provider: 'genius' as const,
        providerId: 'selftest-genius',
        title: 'Selftest Tone',
        artist: 'The Real Selftest',
        album: null,
        durationMs: null,
        synced: false,
        text: 'first line of the plain words\nsecond line of the plain words',
        instrumental: false,
        url: 'https://genius.com/Selftest-tone-selftest-lyrics',
        score: 0.91,
        confidence: 'strong' as const
      }
    ]
    const originalLyricsFind = container.lyrics.find
    container.lyrics.find = async (target) => {
      // The finder is asked about a library row in this probe; a stream would
      // carry the same four values instead of a row.
      const track =
        typeof target === 'number'
          ? container.repo.getById(target)
          : {
              title: target.title ?? '',
              artist: target.artist,
              album: target.album,
              durationMs: target.durationMs
            }
      return {
        query: {
          title: track?.title ?? '',
          artist: track?.artist ?? null,
          album: track?.album ?? null,
          durationMs: track?.durationMs ?? null
        },
        candidates: finderCandidates,
        providers: [
          { provider: 'lrclib', ok: true, message: null, count: 1 },
          { provider: 'genius', ok: true, message: null, count: 1 }
        ],
        message: null
      }
    }
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
      lightGlowOpacity: number
      lightScrimAlpha: number
      lightCoverStrength: number
      volumeBefore: number
      volumeMuted: number
      mutePressed: string
      volumeRestored: number
      volumeBeforeWheel: number
      volumeAfterWheel: number
      volumeWheelTop: number
      volumeWheelBottom: number
      wheelCancelled: boolean
      barVolumeBefore: number
      barVolumeMuted: number
      barMutePressed: string
      barVolumeRestored: number
      barPopHidden: boolean
      barPopVertical: boolean
      barPopWithin: boolean
      barPopShownByFocus: boolean
      barKeyBefore: number
      barKeyAfter: number
      barKeyProgress: string
      barKeyRestored: number
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
      lyricsOpened: boolean
      queueClosedByLyrics: boolean
      lyricRows: number
      lyricMeta: string
      lyricCurrent: number
      lyricSeeked: boolean
      lyricFill: boolean
      lyricFillTransitionMs: number
      lyricFillFrames: number
      lyricPaused: boolean
      lyricResumed: boolean
      finderOpened: boolean
      finderMatches: number
      finderMatchText: string
      finderGeniusLabel: boolean
      fetchedMeta: string
      fetchedLines: number
      fetchedActions: boolean
      fetchedActionText: string
      fetchedFooterText: string
      fetchedLink: boolean
      fetchedLinkHref: string
      fetchedUseFileLabel: string
      fetchedUseFileEnabled: boolean
      fileMeta: string
      fileLines: number
      fileActions: boolean
      forgetLabel: string
      forgotMeta: string
      offsetPlainAtZero: boolean
      offsetAdjusted: string
      offsetResetByPress: boolean
      offsetResetGone: boolean
      offsetLive: boolean
      stageOpened: boolean
      stageLines: number
      stageCurrent: number
      stageClosed: boolean
      escapeHidLyrics: boolean
      escapeKeptWindowAfterLyrics: boolean
    }>(
      window,
      `(async () => {
         const out = { shapeReachesThumbnails: false, fitIsProportional: false, fitRatio: -1, fitIsLive: false, fitIsPlayerOnly: false, fitIsDisabledWhenRound: false, circleCropsTheBox: false, settingsRestored: false, barGlowOnBar: false, tileGlowGone: false, glowMasked: false, lightGlowOpacity: -1, lightScrimAlpha: -1, lightCoverStrength: -1, volumeBefore: -1, volumeMuted: -1, mutePressed: '', volumeRestored: -1, volumeBeforeWheel: -1, volumeAfterWheel: -1, volumeWheelTop: -1, volumeWheelBottom: -1, wheelCancelled: false, barVolumeBefore: -1, barVolumeMuted: -1, barMutePressed: '', barVolumeRestored: -1, barPopHidden: false, barPopVertical: false, barPopWithin: false, barPopShownByFocus: false, barKeyBefore: -1, barKeyAfter: -1, barKeyProgress: '', barKeyRestored: -1, panelClosedByOutsidePress: false, panelStayedOpenOnInsidePress: false, popoverHidden: false, panelAtRest: false, queueRows: 0, queueLabels: '', queueCurrent: 0, truncates: false, panelOpened: false, panelRowsFit: false, shadowFades: false, shadowStyle: '', jumped: false, panelStayedOpen: false, escapeHidPanel: false, escapeKeptWindow: false, escapeClosedWindow: false, panelCloseState: '', lyricsOpened: false, queueClosedByLyrics: false, lyricRows: 0, lyricMeta: '', lyricCurrent: 0, lyricSeeked: false, lyricFill: false, lyricFillTransitionMs: -1, lyricFillFrames: 0, lyricPaused: false, lyricResumed: false, finderOpened: false, finderMatches: 0, finderMatchText: '', finderGeniusLabel: false, fetchedMeta: '', fetchedLines: 0, fetchedActions: false, fetchedActionText: '', fetchedFooterText: '', fetchedLink: false, fetchedLinkHref: '', fetchedUseFileLabel: '', fetchedUseFileEnabled: false, fileMeta: '', fileLines: 0, fileActions: false, forgetLabel: '', forgotMeta: '', offsetPlainAtZero: false, offsetAdjusted: '', offsetResetByPress: false, offsetResetGone: false, offsetLive: false, stageOpened: false, stageLines: 0, stageCurrent: 0, stageClosed: false, escapeHidLyrics: false, escapeKeptWindowAfterLyrics: false }
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
         // The panels hide with a 360ms transition before 'visibility' flips,
         // and a slow frame can push that past any fixed wait. Poll for the
         // settled state instead: what matters is that it ends up shut.
         const lyricsHidden = async (timeoutMs) => {
           const deadline = Date.now() + timeoutMs
           for (;;) {
             const node = pick('.np-lyrics-panel')
             if (node && getComputedStyle(node).visibility === 'hidden') return true
             if (Date.now() > deadline) return false
             await new Promise((resolve) => setTimeout(resolve, 50))
           }
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

         // Always start the covered fixture from the beginning. If it happens
         // to be current but paused near its end, merely checking the title
         // would let the three-second tone roll over to the uncovered track
         // while the player window opens. Restarting it is deterministic.
         const pauseBar = () => {
           const play = pick('.player-controls .icon-button.primary')
           if (play && play.getAttribute('title') === 'Pause') press(play)
         }
         nav('Library')
         await sleep(300)
         // Stop whatever is playing before searching, so a tone that is already
         // near its end cannot advance while the row is being found.
         pauseBar()
         let toneRow = null
         for (let attempt = 0; attempt < 20 && !toneRow; attempt += 1) {
           toneRow =
             [...document.querySelectorAll('.track-row')].find((row) => {
               const text = row.querySelector('.row-title-text')
               return text && text.textContent === 'Selftest Tone'
             }) || null
           if (!toneRow) await sleep(100)
         }
         if (toneRow) {
           toneRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
           await sleep(500)
         }
         // Stop the restarted tone before opening the window as well: it is only
         // three seconds long, and a slow window animation must not turn this
         // artwork check into a check of the next track.
         pauseBar()
         await sleep(100)
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

         // Cream used the same 22% scrim as Midnight but drew a 75% cream one over
         // it, so the cover was reduced to a trace and the bar looked flat (4.png).
         // The two themes have to put comparable cover colour into the bar.
         const themeRoot = document.documentElement
         const previousTheme = themeRoot.dataset.theme || 'dark'
         themeRoot.dataset.theme = 'light'
         await sleep(220)
         out.lightGlowOpacity = glow ? Number(getComputedStyle(glow).opacity) : -1
         const scrimStyle = bar
           ? getComputedStyle(bar.querySelector('.player-bar-bg'), '::after').backgroundColor
           : ''
         const scrimChannels = (scrimStyle.match(/[\d.]+/g) || []).map(Number)
         out.lightScrimAlpha = scrimChannels.length >= 4 ? scrimChannels[3] : -1
         out.lightCoverStrength = out.lightGlowOpacity * (1 - out.lightScrimAlpha)
         themeRoot.dataset.theme = previousTheme
         await sleep(150)

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

         // The panel is a floating card: a full border, rounded corners and a
         // real shadow, rather than the hard edge-to-edge strip it used to be.
         const panelStyle = panel() ? getComputedStyle(panel()) : null
         const radius = panelStyle ? parseFloat(panelStyle.borderTopLeftRadius) : 0
         const borders = panelStyle
           ? [panelStyle.borderTopWidth, panelStyle.borderRightWidth, panelStyle.borderBottomWidth, panelStyle.borderLeftWidth].map(parseFloat)
           : []
         out.shadowFades =
           Boolean(panelStyle) &&
           radius > 0 &&
           panelStyle.boxShadow !== 'none' &&
           borders.length === 4 &&
           borders.every((width) => width > 0)
         out.shadowStyle = panelStyle
           ? radius + 'px radius | ' + panelStyle.boxShadow + ' | ' + panelStyle.borderTopWidth + ' border'
           : 'no panel'

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

        // ---- the lyrics panel ------------------------------------------------
        // The tone fixture carries two timed lines, so this is the read path end
        // to end: the main process parses the tag, the renderer draws the lines,
        // and the panel follows the song. The queue is open at this point, which
        // is also the chance to prove the two share one corner.
        const lyricsPanel = () => pick('.np-lyrics-panel')
        const lyricLines = () => [...document.querySelectorAll('.np-lyric-line')]
        const toneQueueRow = rows().find((row) => {
          const title = row.querySelector('.np-queue-title')
          return title && title.textContent === 'Selftest Tone'
        })
        if (toneQueueRow) toneQueueRow.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await sleep(300)
        // The fixture is three seconds long; pause it so the checks below are
        // about the lyrics and not about which track is playing by then.
        pause()
        press(pick('.np-lyrics-button'))
        await sleep(400)
        out.lyricsOpened = lyricsPanel() ? getComputedStyle(lyricsPanel()).visibility === 'visible' : false
        out.queueClosedByLyrics = await panelHidden(2000)
        for (let attempt = 0; attempt < 40 && lyricLines().length === 0; attempt += 1) await sleep(100)
        out.lyricRows = lyricLines().length
        out.lyricMeta = (pick('.np-lyrics-meta') || {}).textContent || ''
        // A line is a seek target, so pressing one moves the song and the
        // highlight follows without the panel being reopened. The first press
        // also proves a line lights up at all: the fixture starts before its
        // first timestamp, where nothing is being sung yet.
        if (lyricLines()[0]) press(lyricLines()[0])
        await sleep(400)
        out.lyricCurrent =
          lyricLines().filter((line) => line.classList.contains('current')).length === 1 &&
          lyricLines()[0].classList.contains('current')
            ? 1
            : 0
        if (lyricLines()[1]) press(lyricLines()[1])
        await sleep(500)
        out.lyricSeeked = lyricLines().findIndex((line) => line.classList.contains('current')) === 1
        // The highlight is a fill that grows with the line, and a manual scroll
        // stops the panel from pulling itself back while the verse is read.
        const currentLine = pick('.np-lyric-line.current')
        const currentFill = currentLine ? currentLine.querySelector('.np-lyric-fill') : null
        out.lyricFill = Boolean(currentFill) && (currentFill.style.transform || '').includes('scaleX')
        // The fill is written once a frame straight from the media element, so
        // nothing smooths it after the fact: a transition chasing every one of
        // those writes is what used to make a line stall at its start and the
        // one before it stop short of its end. Sampling it for a fifth of a
        // second proves the first half — many distinct positions are only
        // possible at frame rate — and the transition duration proves the
        // second, that each of those positions is where it is left.
        //
        // The tone fixture is three seconds long and has usually reached its end
        // by here, which freezes the position and would make any fill look
        // still. Playback is started again and the line re-picked so the samples
        // are taken against a song that is actually moving.
        const playToggle = pick('.player-controls .icon-button.primary')
        if (playToggle && playToggle.getAttribute('title') === 'Play') press(playToggle)
        await sleep(300)
        if (lyricLines()[1]) press(lyricLines()[1])
        await sleep(300)
        const fillStyle = pick('.np-lyric-line.current .np-lyric-fill')
        const fillComputed = fillStyle ? getComputedStyle(fillStyle) : null
        out.lyricFillTransitionMs = fillComputed
          ? fillComputed.transitionDuration
              .split(',')
              .reduce((worst, value) => Math.max(worst, parseFloat(value) * 1000), 0)
          : -1
        const fillSamples = new Set()
        for (let step = 0; step < 10; step += 1) {
          const line = pick('.np-lyric-line.current')
          const fill = line ? line.querySelector('.np-lyric-fill') : null
          fillSamples.add(fill ? fill.style.transform : '')
          await sleep(20)
        }
        out.lyricFillFrames = fillSamples.size
        // Put the fixture back where it was found: everything after this point
        // reads the panel, and a tone rolling on to the next track would take
        // the lyrics with it.
        pauseBar()
        const lyricList = pick('.np-lyrics-list')
        if (lyricList) lyricList.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 120 }))
        await sleep(250)
        out.lyricPaused = Boolean(pick('.np-lyrics-resume'))
        press(pick('.np-lyrics-resume'))
        await sleep(250)
        out.lyricResumed = !pick('.np-lyrics-resume')

        // The finder proposes, the panel decides. Opening it asks the services
        // (stubbed in the main process), and the list names both of them. The
        // plain-text match is the second one, so choosing it proves a fetched
        // lyric carries its source label and its page, and that "Use file
        // lyrics" puts the file's own copy back.
        press(pick('.np-lyrics-find'))
        for (let attempt = 0; attempt < 40 && !pick('.lyrics-finder'); attempt += 1) await sleep(100)
        out.finderOpened = Boolean(pick('.lyrics-finder'))
        for (let attempt = 0; attempt < 40 && !pick('.lyrics-match'); attempt += 1) await sleep(100)
        const finderMatches = [...document.querySelectorAll('.lyrics-match')]
        out.finderMatches = finderMatches.length
        out.finderMatchText = (finderMatches[0] || {}).textContent || ''
        out.finderGeniusLabel = finderMatches.some((match) => (match.textContent || '').includes('Genius'))
        const geniusMatch = finderMatches.find((match) => (match.textContent || '').includes('Genius'))
        if (geniusMatch) press(geniusMatch)
        await sleep(150)
        const useLyrics = pick('.lyrics-finder-foot .primary')
        if (useLyrics) press(useLyrics)
        for (let attempt = 0; attempt < 40 && pick('.lyrics-finder'); attempt += 1) await sleep(100)
        for (let attempt = 0; attempt < 40 && !pick('.np-lyrics-use-file'); attempt += 1) await sleep(100)
        out.fetchedMeta = (pick('.np-lyrics-meta') || {}).textContent || ''
        out.fetchedLines = lyricLines().length
        // The two file actions are icons in the footer now: what used to be a
        // labelled row above the timing controls is gone, and the provider is
        // named once, in the header pill.
        out.fetchedActions = Boolean(pick('.np-lyrics-use-file'))
        out.fetchedActionText = ((pick('.np-lyrics-use-file') || {}).textContent || '').trim()
        out.fetchedFooterText = ((pick('.np-lyrics-foot') || {}).textContent || '').trim()
        // Attribution survives the tidy-up by becoming the pill itself rather
        // than a second copy of the provider's name further down.
        const sourceLink = pick('a.np-lyrics-meta')
        out.fetchedLink = Boolean(sourceLink)
        out.fetchedLinkHref = sourceLink ? sourceLink.getAttribute('href') || '' : ''
        // The file does have lyrics, so the icon under the fetch is a way back
        // and is allowed to promise exactly that. The tooltip is the same before
        // and after the file answers, so this waits for the button to become
        // enabled — that is what proves the file was actually asked and answered
        // non-empty, rather than the check passing on the pending state.
        for (
          let attempt = 0;
          attempt < 40 &&
          (!pick('.np-lyrics-use-file') || pick('.np-lyrics-use-file').disabled);
          attempt += 1
        ) {
          await sleep(100)
        }
        out.fetchedUseFileLabel = (pick('.np-lyrics-use-file') || {}).title || ''
        out.fetchedUseFileEnabled = pick('.np-lyrics-use-file')
          ? !pick('.np-lyrics-use-file').disabled
          : false
        press(pick('.np-lyrics-use-file'))
        for (let attempt = 0; attempt < 40 && pick('.np-lyrics-use-file'); attempt += 1) await sleep(100)
        out.fileMeta = (pick('.np-lyrics-meta') || {}).textContent || ''
        out.fileLines = lyricLines().length
        out.fileActions = Boolean(pick('.np-lyrics-use-file'))

        // The timing readout is the way back to zero, which is what retired the
        // separate Reset button. At zero it is a plain number with nothing to
        // press and no pill around it; nudging the timing turns it into a
        // control, and pressing it puts the correction back to 0.0 s. The block
        // ends where it started, at 0.0 s, because the seek checks further down
        // count on the lines landing where the file put them.
        const offsetReadout = () => pick('.np-lyrics-offset')
        const offsetSteps = () => [...document.querySelectorAll('.np-lyrics-foot .np-lyrics-step')]
        out.offsetResetGone = !pick('.np-lyrics-reset')
        out.offsetPlainAtZero = Boolean(offsetReadout()) &&
          offsetReadout().tagName === 'BUTTON' &&
          offsetReadout().textContent.trim() === '0.0 s' &&
          offsetReadout().disabled
        const laterStep = offsetSteps()[1]
        press(laterStep)
        // The optimistic update shows the new number while the write is still
        // in flight, and the button is disabled for as long as saving lasts —
        // so settling means the number and a button you can press.
        for (
          let attempt = 0;
          attempt < 40 &&
          (!offsetReadout() ||
            offsetReadout().textContent.trim() !== '+0.5 s' ||
            offsetReadout().disabled);
          attempt += 1
        ) {
          await sleep(100)
        }
        out.offsetAdjusted = offsetReadout() ? offsetReadout().textContent.trim() : ''
        out.offsetLive = Boolean(offsetReadout()) && !offsetReadout().disabled
        press(offsetReadout())
        for (
          let attempt = 0;
          attempt < 40 &&
          (!offsetReadout() || offsetReadout().textContent.trim() !== '0.0 s');
          attempt += 1
        ) {
          await sleep(100)
        }
        out.offsetResetByPress = Boolean(offsetReadout()) &&
          offsetReadout().disabled &&
          offsetReadout().textContent.trim() === '0.0 s'

        // The stage is a portal out of the panel: expanding hands the same lines
        // to a full-window view, and Escape comes back to the panel rather than
        // closing the player behind it.
        const expand = pick('.np-lyrics-expand')
        if (expand) press(expand)
        await sleep(600)
        const stage = pick('.np-lyrics-stage')
        out.stageOpened = Boolean(stage) && !pick('.np-lyrics-panel')
        const stageLines = stage ? [...stage.querySelectorAll('.np-lyric-line')] : []
        out.stageLines = stageLines.length
        out.stageCurrent = stageLines.filter((line) => line.classList.contains('current')).length
        if (stage) {
          stage.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
          )
        }
        await sleep(600)
        out.stageClosed = !pick('.np-lyrics-stage') && Boolean(pick('.np-lyrics-panel'))

        // The other half of that promise, on the fixture with no lyrics of its
        // own: there is nothing to switch back to, so the same click can only
        // be a discard and must not call itself a switch. The queue and the
        // lyrics panel share one corner and are mutually exclusive, so the
        // track is changed first and the panel is then reopened — everything
        // below has to run against an open panel, which is the only place the
        // read effect and the button's label come from.
        press(pick('.np-queue'))
        await sleep(400)
        const silentRow = rows().find((row) => !row.classList.contains('current'))
        if (silentRow) silentRow.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await sleep(400)
        // The silent fixture is two seconds long; it has to stay on this track
        // while the finder is used, rather than advancing back to the tone.
        pause()
        pressAt(pick('.np-stage'))
        await sleep(400)
        press(pick('.np-lyrics-button'))
        for (let attempt = 0; attempt < 40 && !pick('.np-lyrics-panel.open'); attempt += 1) {
          await sleep(100)
        }
        // A file with nothing in it reads as no lyrics at all.
        for (
          let attempt = 0;
          attempt < 40 && (pick('.np-lyrics-meta') || {}).textContent !== 'None found';
          attempt += 1
        ) {
          await sleep(100)
        }
        press(pick('.np-lyrics-find'))
        for (let attempt = 0; attempt < 40 && !pick('.lyrics-finder'); attempt += 1) await sleep(100)
        for (let attempt = 0; attempt < 40 && !pick('.lyrics-match'); attempt += 1) await sleep(100)
        const silentMatches = [...document.querySelectorAll('.lyrics-match')]
        const silentMatch = silentMatches.find((match) => (match.textContent || '').includes('Genius'))
        if (silentMatch) press(silentMatch)
        await sleep(150)
        const silentUse = pick('.lyrics-finder-foot .primary')
        if (silentUse) press(silentUse)
        for (let attempt = 0; attempt < 40 && pick('.lyrics-finder'); attempt += 1) await sleep(100)
        for (let attempt = 0; attempt < 40 && !pick('.np-lyrics-use-file'); attempt += 1) await sleep(100)
        // The answer about the file arrives over IPC, so the tooltip settles a
        // moment after the icon appears.
        for (
          let attempt = 0;
          attempt < 40 &&
          (pick('.np-lyrics-use-file') || {}).title !==
            'This file has no lyrics of its own, so this only drops the fetched copy';
          attempt += 1
        ) {
          await sleep(100)
        }
        out.forgetLabel = (pick('.np-lyrics-use-file') || {}).title || ''
        press(pick('.np-lyrics-use-file'))
        for (let attempt = 0; attempt < 40 && pick('.np-lyrics-use-file'); attempt += 1) await sleep(100)
        out.forgotMeta = ((pick('.np-lyrics-meta') || {}).textContent || '').trim()

        pressEscape()
        await sleep(400)
        out.escapeHidLyrics = await lyricsHidden(2000)
        out.escapeKeptWindowAfterLyrics = Boolean(dialog())

        // Put the queue back: the checks below are about Escape unwinding the
        // queue panel and then the window, and this is the state they expect.
        press(pick('.np-queue'))
        await sleep(400)

         // Escape unwinds one layer at a time, and both layers are checked: the
         // panel first, then the window.
         pressEscape()
         await sleep(400)
         out.escapeHidPanel = await panelHidden(2000)
         out.escapeKeptWindow = Boolean(dialog())
         pressEscape()
         await sleep(500)
         out.escapeClosedWindow = !dialog()

         // The bar's own speaker icon is a toggle too. It used to be decoration:
         // clicking it did nothing while the full-window player's icon did the
         // same job, which is the sort of inconsistency a user reads as a bug.
         const barSlider = () => document.querySelector('.player-volume input[type="range"]')
         const barToggle = () => document.querySelector('.player-volume .volume-toggle')
         out.barVolumeBefore = barSlider() ? Number(barSlider().value) : -1
         press(barToggle())
         await sleep(300)
         out.barVolumeMuted = barSlider() ? Number(barSlider().value) : -1
         out.barMutePressed = barToggle() ? String(barToggle().getAttribute('aria-pressed')) : ''
         press(barToggle())
         await sleep(300)
         out.barVolumeRestored = barSlider() ? Number(barSlider().value) : -1

         // The bar's volume folds away like the full-window one, but it opens
         // from the speaker itself. Focus is the keyboard equivalent of hover:
         // it must reveal the vertical slider, and the arrows must move it.
         const barPop = () => pick('.player-volume-pop')
         out.barPopHidden = barPop() ? getComputedStyle(barPop()).visibility === 'hidden' : false
         const barPopBox = barPop() ? barPop().getBoundingClientRect() : null
         out.barPopVertical = Boolean(barPopBox && barPopBox.height > barPopBox.width * 2)
         out.barPopWithin = Boolean(
           barPopBox &&
             barPopBox.top >= 0 &&
             barPopBox.left >= 0 &&
             barPopBox.right <= window.innerWidth + 0.5
         )
         if (barToggle()) barToggle().focus()
         await sleep(240)
         const barPopStyle = barPop() ? getComputedStyle(barPop()) : null
         out.barPopShownByFocus = Boolean(
           barPopStyle && barPopStyle.visibility === 'visible' && barPopStyle.opacity === '1'
         )
         out.barKeyBefore = barSlider() ? Number(barSlider().value) : -1
         if (barToggle()) {
           barToggle().dispatchEvent(
             new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
           )
         }
         await sleep(240)
         out.barKeyAfter = barSlider() ? Number(barSlider().value) : -1
         out.barKeyProgress = barSlider() ? barSlider().style.getPropertyValue('--volume-progress') : ''
         if (barToggle()) {
           barToggle().dispatchEvent(
             new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })
           )
         }
         await sleep(240)
         out.barKeyRestored = barSlider() ? Number(barSlider().value) : -1
         if (barToggle()) barToggle().blur()
         await sleep(180)
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
      visuals.lightCoverStrength >= 0.3,
      'the Cream player bar shows the cover art, not only a flat tint',
      `glow ${visuals.lightGlowOpacity} x (1 - scrim ${visuals.lightScrimAlpha}) = ${visuals.lightCoverStrength.toFixed(3)}`
    )
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
      'the queue panel is a rounded, bordered card with a shadow',
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
      visuals.lyricsOpened && visuals.queueClosedByLyrics,
      'the lyrics button opens the lyrics panel and closes the queue that shares its corner'
    )
    record(
      visuals.lyricRows === 2 && visuals.lyricMeta.includes('Synced'),
      'the panel shows the timed lines from the file, labelled as synced',
      `${visuals.lyricRows} lines, "${visuals.lyricMeta}"`
    )
    record(
      visuals.lyricCurrent === 1,
      'exactly one lyric line is marked as the one being sung',
      `${visuals.lyricCurrent} marked`
    )
    record(visuals.lyricSeeked, 'clicking a lyric line seeks to it and moves the highlight')
    record(
      visuals.lyricFill,
      'the line being sung fills as it plays, so a long line reads as long'
    )
    record(
      // Chromium may serialise a zero duration as a tiny scientific-notation
      // value (`1e-06s`), which rounds to 0.001 ms here. Anything under a
      // millisecond is the no-transition case the CSS asks for.
      visuals.lyricFillTransitionMs >= 0 && visuals.lyricFillTransitionMs < 1 && visuals.lyricFillFrames > 2,
      'the fill follows the song at frame rate, with no transition smoothing it afterwards',
      `${visuals.lyricFillFrames} distinct positions in 200 ms, ${visuals.lyricFillTransitionMs} ms transition`
    )
    record(
      visuals.lyricPaused && visuals.lyricResumed,
      'scrolling the lyrics pauses the follow until you jump back to the current line',
      `paused ${visuals.lyricPaused} / resumed ${visuals.lyricResumed}`
    )
    record(
      visuals.finderOpened && visuals.finderMatches === 2 && visuals.finderGeniusLabel,
      'the lyrics header opens a finder that names every service that answered',
      `${visuals.finderMatches} matches, "${visuals.finderMatchText}"`
    )
    record(
      visuals.fetchedActions &&
        visuals.fetchedActionText === '' &&
        !visuals.fetchedFooterText.includes('From ') &&
        visuals.fetchedLink &&
        visuals.fetchedLinkHref.startsWith('https://genius.com/') &&
        visuals.fetchedLines === 0 &&
        visuals.fetchedMeta.includes('Genius'),
      'choosing a Genius match names it once in the header, keeps its page and offers the file actions as icons',
      `${visuals.fetchedLines} lines, "${visuals.fetchedMeta}", page ${visuals.fetchedLinkHref}, action text "${visuals.fetchedActionText}"`
    )
    record(
      !visuals.fileActions && visuals.fileLines === 2 && visuals.fileMeta.includes('File tags'),
      'going back to the file restores its own lyrics and drops the fetched actions',
      `${visuals.fileLines} lines, "${visuals.fileMeta}", actions ${visuals.fileActions}`
    )
    record(
      visuals.fetchedUseFileEnabled &&
        visuals.fetchedUseFileLabel === 'Forget the fetched lyrics and show what the file has',
      'over a file that has lyrics, the switch-back icon may promise exactly that',
      `"${visuals.fetchedUseFileLabel}", enabled ${visuals.fetchedUseFileEnabled}`
    )
    container.lyrics.find = originalLyricsFind
    record(
      visuals.forgetLabel ===
        'This file has no lyrics of its own, so this only drops the fetched copy' &&
        visuals.forgotMeta === 'None found',
      'over a file with no lyrics the same icon is a discard and says so',
      `"${visuals.forgetLabel}", "${visuals.forgotMeta}"`
    )
    record(
      visuals.offsetResetGone &&
        visuals.offsetPlainAtZero &&
        visuals.offsetAdjusted === '+0.5 s' &&
        visuals.offsetLive &&
        visuals.offsetResetByPress,
      'the timing readout is its own reset: a plain number at zero, a button once nudged, back to 0.0 s when pressed',
      `reset gone ${visuals.offsetResetGone}, nudged to "${visuals.offsetAdjusted}" (live ${visuals.offsetLive})`
    )
    record(
      visuals.stageOpened && visuals.stageLines === visuals.lyricRows && visuals.stageCurrent === 1,
      'expanding the lyrics hands the same lines to a full-window stage',
      `${visuals.stageLines} lines (panel had ${visuals.lyricRows}), ${visuals.stageCurrent} current`
    )
    record(visuals.stageClosed, 'Escape leaves the lyrics stage and returns to the panel')
    record(
      visuals.escapeHidLyrics && visuals.escapeKeptWindowAfterLyrics,
      'Escape shuts the lyrics panel without shutting the player window'
    )
    record(
      visuals.escapeHidPanel && visuals.escapeKeptWindow,
      'Escape shuts the panel without shutting the player window'
    )
    record(visuals.escapeClosedWindow, 'Escape shuts the player window once the panel is shut')
    record(
      visuals.barVolumeBefore > 0 &&
        visuals.barVolumeMuted === 0 &&
        visuals.barMutePressed === 'true' &&
        visuals.barVolumeRestored === visuals.barVolumeBefore,
      'the player bar speaker icon mutes and restores like the full-window player',
      `${visuals.barVolumeBefore} -> ${visuals.barVolumeMuted} -> ${visuals.barVolumeRestored} (pressed=${visuals.barMutePressed})`
    )
    record(
      visuals.barPopHidden &&
        visuals.barPopVertical &&
        visuals.barPopWithin &&
        visuals.barPopShownByFocus &&
        Math.abs(visuals.barKeyBefore - visuals.barKeyAfter - 0.05) < 0.011 &&
        Math.abs(visuals.barKeyRestored - visuals.barKeyBefore) < 0.011 &&
        visuals.barKeyProgress === `${Math.round(visuals.barKeyAfter * 100)}%`,
      'the player bar volume is a vertical popover that opens and moves from the keyboard',
      {
        hidden: visuals.barPopHidden,
        vertical: visuals.barPopVertical,
        within: visuals.barPopWithin,
        shown: visuals.barPopShownByFocus,
        before: visuals.barKeyBefore,
        after: visuals.barKeyAfter,
        progress: visuals.barKeyProgress,
        restored: visuals.barKeyRestored
      }
    )

    // ---- 12b. writes deferred while the file is playing ------------------
    // Fetching lyrics only happens while listening, and Windows will not replace
    // a file that is open for playback. Rather than ask the user to stop the
    // song they are reading, the write is queued and the panel says when it will
    // land. The renderer tells main which file is open through the same taskbar
    // call playback already makes, so this drives that call directly and then
    // takes the track off playback to drain the queue.
    const deferredTrack = container.library
      .list()
      .tracks.find((track) => track.title === 'Selftest Silent')
    if (!deferredTrack) throw new Error('the deferred-write fixture is missing')
    await container.lyrics.use(deferredTrack.id, {
      provider: 'lrclib',
      providerId: 'selftest-deferred',
      title: 'Selftest Silent',
      artist: 'Zzz Uncovered',
      album: 'Selftest Album',
      durationMs: 2000,
      synced: false,
      text: 'deferred line one\ndeferred line two',
      instrumental: false,
      url: null,
      score: 0.9,
      confidence: 'strong'
    })
    const deferred = await evaluate<{
      currentTitle: string
      seeded: boolean
      hasWriteButton: boolean
      panelMeta: string
      lyricsNotice: string
      lyricsDeferred: boolean
      tagNotice: string
      tagDeferred: boolean
      lyricsLanded: boolean
      tagLanded: string
      yearLanded: number | null
    }>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const text = (el) => ((el || {}).textContent || '').trim()
         const pick = (s) => document.querySelector(s)
         const pickAll = (s) => [...document.querySelectorAll(s)]
         const press = (el) => {
           if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         }
         const until = async (check, ms = 8000) => {
           const deadline = Date.now() + ms
           while (Date.now() < deadline) {
             if (await check()) return true
             await sleep(100)
           }
           return false
         }
         const out = {
           currentTitle: '', seeded: false, hasWriteButton: false, panelMeta: '',
           lyricsNotice: '', lyricsDeferred: false, tagNotice: '',
           tagDeferred: false, lyricsLanded: false, tagLanded: '', yearLanded: null
         }
         const id = ${deferredTrack.id}
         const nav = (label) =>
           [...document.querySelectorAll('.nav-item')].find((el) => text(el).startsWith(label))
         const barTitle = () => text(pick('.player-title'))
         const barToggle = () => pick('.player-bar .icon-button.primary')
         const pauseBar = () => {
           if (barToggle() && barToggle().getAttribute('title') === 'Pause') press(barToggle())
         }

         // Make the fixture the current track even if the earlier probe left the
         // other one playing: the panel reads whatever is current.
         press(nav('Library'))
         await sleep(300)
         if (barTitle() !== 'Selftest Silent') {
           const silentRow = pickAll('.track-row').find(
             (el) => text(el.querySelector('.row-title-text')) === 'Selftest Silent'
           )
           if (silentRow) silentRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
           await until(() => barTitle() === 'Selftest Silent')
         }
         pauseBar()
         await sleep(200)
         out.currentTitle = barTitle()
         out.seeded = Boolean(await window.player.getTrackLyrics(id))

         // Tell main this file is open for playback, exactly as the renderer's
         // effect does when the media element starts.
         await window.player.setTaskbarState({ hasTrack: true, isPlaying: true, trackId: id })

         // The lyrics panel lives in the full player window, so that has to be
         // open before its toggle exists.
         press(pick('.player-track'))
         await until(() => Boolean(pick('.np-lyrics-panel')))
         // The fetched copy seeded above is what the panel shows.
         if (!pick('.np-lyrics-panel.open')) press(pick('.np-lyrics-button'))
         out.hasWriteButton = await until(() => Boolean(pick('.np-lyrics-write-file')))
         out.panelMeta = text(pick('.np-lyrics-meta'))
         press(pick('.np-lyrics-write-file'))
         await until(() => Boolean(pick('.np-lyrics-action-notice')))
         out.lyricsNotice = text(pick('.np-lyrics-action-notice'))
         out.lyricsDeferred = out.lyricsNotice.includes('after this track finishes playing')
         // Nothing was written yet: the file still has no lyrics of its own.
         const fileBefore = await window.player.getFileLyrics(id)
         out.lyricsDeferred = out.lyricsDeferred && fileBefore === null
         press(pick('.np-lyrics-button'))
         await sleep(300)
         press(pick('.np-close'))
         await until(() => !pick('.np-stage'))
         await sleep(300)

         // The tag editor goes through the same queue. Change one field and save
         // while main still believes the file is open.
         press(nav('Library'))
         await sleep(400)
         const row = pickAll('.track-row').find(
           (el) => text(el.querySelector('.row-title-text')) === 'Selftest Silent'
         )
         if (row) {
           row.dispatchEvent(
             new MouseEvent('contextmenu', { bubbles: true, clientX: 260, clientY: 260 })
           )
         }
         await until(() => Boolean(pick('.context-menu')))
         press(
           pickAll('.context-menu .context-item').find((el) => text(el) === 'Edit tags…')
         )
         await until(() => Boolean(pick('.tag-dialog')))
         const genreField = pickAll('.tag-dialog .tag-grid .field').find(
           (field) => text(field.querySelector('span')) === 'Genre'
         )
         const genreInput = genreField ? genreField.querySelector('input') : null
         if (genreInput) {
           const setValue = Object.getOwnPropertyDescriptor(
             HTMLInputElement.prototype,
             'value'
           ).set
           setValue.call(genreInput, 'Deferred Genre')
           genreInput.dispatchEvent(new Event('input', { bubbles: true }))
         }
         await sleep(200)
         press(pick('.tag-foot button.primary'))
         await until(() => Boolean(pick('.tag-deferred')))
         out.tagNotice = text(pick('.tag-deferred'))
         out.tagDeferred = out.tagNotice.includes('after this track finishes playing')
         const rowBefore = (await window.player.getTracks([id]))[0]
         out.tagDeferred = out.tagDeferred && rowBefore.genre !== 'Deferred Genre'
         const dialog = pick('.tag-dialog')
         if (dialog) {
           dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
         }
         await sleep(300)

         // A second save while the first is still queued: it names only the
         // year, so the queued genre has to survive the merge rather than be
         // replaced by this smaller patch.
         await window.player.updateTrackTags(id, { year: 2000 })

         // Playback moves off the track, so its file is no longer open. The
         // queue drains on that state change.
         await window.player.setTaskbarState({ hasTrack: false, isPlaying: false, trackId: null })
         out.lyricsLanded = await until(async () => {
           const lyrics = await window.player.getFileLyrics(id)
           return Boolean(lyrics && lyrics.text.includes('deferred line one'))
         })
         await until(async () => {
           const rows = await window.player.getTracks([id])
           return Boolean(
             rows[0] && rows[0].genre === 'Deferred Genre' && rows[0].year === 2000
           )
         })
         const rowsAfter = await window.player.getTracks([id])
         out.tagLanded = rowsAfter[0] ? rowsAfter[0].genre || '' : ''
         out.yearLanded = rowsAfter[0] ? rowsAfter[0].year : null
         return out
       })()`
    )
    record(
      deferred.lyricsDeferred &&
        deferred.lyricsNotice.includes('after this track finishes playing'),
      'lyrics fetched while a track plays are queued, not refused, and the panel says when',
      `current "${deferred.currentTitle}", seeded ${deferred.seeded}, button ${deferred.hasWriteButton}, meta "${deferred.panelMeta}", notice "${deferred.lyricsNotice}"`
    )
    record(
      deferred.tagDeferred &&
        deferred.tagNotice.includes('after this track finishes playing'),
      'a tag edit on the playing file is queued too, and the editor says when',
      `"${deferred.tagNotice}"`
    )
    record(
      deferred.lyricsLanded &&
        deferred.tagLanded === 'Deferred Genre' &&
        deferred.yearLanded === 2000,
      'once playback moves off the track, both queued writes land and a later save keeps the earlier field',
      `lyrics ${deferred.lyricsLanded}, genre "${deferred.tagLanded}", year ${String(deferred.yearLanded)}`
    )
    const deferredFile = await extractMetadata(plainPath)
    const deferredFileLyrics = await container.lyrics.readFile(deferredTrack.id)
    record(
      deferredFile.genre === 'Deferred Genre' &&
        deferredFile.year === 2000 &&
        (deferredFileLyrics?.text ?? '').includes('deferred line one'),
      'the queued writes reached the bytes on disk, not only the library row',
      `genre "${deferredFile.genre}", year ${String(deferredFile.year)}, lyrics ${deferredFileLyrics ? 'present' : 'missing'}`
    )
    // This fixture is shared with the batch sections below, which expect a file
    // with no lyrics, genre or year. Put it back now that the write has landed.
    await container.library.updateTags(deferredTrack.id, { genre: null, year: null, lyrics: null })

    // ---- 13. artwork size and click behaviour ---------------------------
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
      legacyFooters: number
      seekBarFollows: boolean
      seekBarDetail: string
      seekBarFollowsPlaying: boolean
      seekBarPlayingDetail: string
    }>(
      window,
      `(async () => {
         const out = { sizeReachesDom: false, smallBox: -1, xlargeBox: -1, artFitsBand: false, singleClickPlays: false, singleClickSelectsOnly: false, legacyFooters: -1, seekBarFollows: false, seekBarDetail: '', seekBarFollowsPlaying: false, seekBarPlayingDetail: '' }
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
         out.legacyFooters = document.querySelectorAll('.table-footnote').length

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
      prefs.singleClickSelectsOnly && prefs.legacyFooters === 0,
      'a single click selects without playing on the default setting, with no list footer',
      `${prefs.legacyFooters} legacy footers`
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

    // ---- 13b. checkbox selection and field menus ------------------------
    // Once one row is selected, the index column becomes the selection control;
    // a click anywhere else on the row plays instead of replacing the selection.
    // The same pass checks that the library/search fields share the link field's
    // Paste/Copy/Clear menu and that the queue's save action honours a selection.
    const selection = await evaluate<{
      rows: number
      checkboxes: number
      checked: number
      playWhileSelected: boolean
      selectionKept: boolean
      checkboxSelects: boolean
      playbackKept: boolean
      rightClickDeselects: boolean
      contextSelectedActions: string
      headSelect: boolean
      headIndeterminate: boolean
      headSelectsAll: boolean
      headClears: boolean
      shiftRange: boolean
      searchMenuItems: string
      searchPasted: boolean
      searchCleared: boolean
      queueCheckboxes: boolean
      queueChecked: number
      queueHeaderIndeterminate: boolean
      queueShiftRange: boolean
      queueHeaderClears: boolean
      queueBarButtons: string
      queueBarClearNormal: boolean
      queueRowActions: string
      queueMenuSelected: boolean
      queueMenuPlaySelected: boolean
      queueBarClears: boolean
      selectedHeading: string
      discoverPasted: boolean
      discoverCleared: boolean
    }>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const pick = (selector) => document.querySelector(selector)
         const pickAll = (selector) => [...document.querySelectorAll(selector)]
         const text = (element) => (element ? (element.textContent || '').trim() : '')
         const press = (element) => {
           if (element) element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         }
         const nav = (label) => {
           const button = pickAll('.nav-item').find((el) => text(el).startsWith(label))
           press(button)
         }
         // Clipboard reads and the resulting React render are a round-trip
         // through the main process; a fixed wait races that. Poll for the
         // field to settle instead.
         const until = async (predicate, timeoutMs) => {
           const deadline = Date.now() + timeoutMs
           for (;;) {
             if (predicate()) return true
             if (Date.now() > deadline) return false
             await sleep(50)
           }
         }
         const rowTitle = (row) => text(row ? row.querySelector('.row-title-text') : null)
         const rowFor = (title) => pickAll('.track-row').find((row) => rowTitle(row) === title)
         const barTitle = () => text(pick('.player-title'))
         const out = {
           rows: 0, checkboxes: 0, checked: 0, playWhileSelected: false, selectionKept: false,
           checkboxSelects: false, playbackKept: false, rightClickDeselects: false,
           contextSelectedActions: '', headSelect: false, headIndeterminate: false,
           headSelectsAll: false, headClears: false, shiftRange: false,
           searchMenuItems: '', searchPasted: false, searchCleared: false,
           queueCheckboxes: false, queueChecked: 0, queueHeaderIndeterminate: false,
           queueShiftRange: false, queueHeaderClears: false, queueBarButtons: '',
           queueBarClearNormal: false, queueRowActions: '', queueMenuSelected: false,
           queueMenuPlaySelected: false, queueBarClears: false,
           selectedHeading: '', discoverPasted: false, discoverCleared: false
         }

         // The previous step leaves Tone selected on the default select click.
         if (!pick('.track-row.selected')) {
           const tone = rowFor('Selftest Tone')
           if (tone) tone.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
           await sleep(300)
         }
         out.rows = pickAll('.track-row').length
         out.checkboxes = pickAll('.track-row .row-select input').length
         out.checked = pickAll('.track-row .row-select input').filter((input) => input.checked).length

         // A plain click on an unselected row must play it and keep Tone selected.
         const silent = rowFor('Selftest Silent')
         if (silent) silent.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         await sleep(450)
         out.playWhileSelected = barTitle() === 'Selftest Silent'
         out.selectionKept =
           pickAll('.track-row.selected').length === 1 &&
           Boolean(rowFor('Selftest Tone')) &&
           rowFor('Selftest Tone').classList.contains('selected')

         // The checkbox is the one click that changes the selection.
         const silentBox = rowFor('Selftest Silent') ? rowFor('Selftest Silent').querySelector('.row-select input') : null
         if (silentBox) silentBox.click()
         await sleep(300)
         out.checkboxSelects =
           pickAll('.track-row.selected').length === 2 &&
           Boolean(rowFor('Selftest Silent')) &&
           rowFor('Selftest Silent').classList.contains('selected')
         out.playbackKept = barTitle() === 'Selftest Silent'

         // Right-clicking a selected row offers Deselect.
         const tone = rowFor('Selftest Tone')
         if (tone) {
           tone.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 220, clientY: 220 }))
         }
         await sleep(300)
         out.contextSelectedActions = pickAll('.context-menu .context-item').map(text).join(' | ')
         const deselect = pickAll('.context-menu .context-item').find((el) => text(el) === 'Deselect')
         if (deselect) press(deselect)
         await sleep(300)
         out.rightClickDeselects =
           pickAll('.track-row.selected').length === 1 &&
           Boolean(rowFor('Selftest Silent')) &&
           rowFor('Selftest Silent').classList.contains('selected')

         // The # header is the select-all control. With one of two rows selected
         // it is indeterminate; clicking it selects every loaded row, clicking
         // again clears the selection.
         const headBox = pick('.track-head .head-select input')
         out.headSelect = Boolean(headBox)
         out.headIndeterminate = Boolean(headBox && headBox.indeterminate)
         if (headBox) headBox.click()
         await sleep(350)
         const loadedBoxes = pickAll('.track-row .row-select input')
         const allHead = pick('.track-head .head-select input')
         out.headSelectsAll =
           loadedBoxes.length > 0 &&
           loadedBoxes.every((input) => input.checked) &&
           Boolean(allHead && allHead.checked)
         const checkedHead = pick('.track-head .head-select input')
         if (checkedHead) checkedHead.click()
         await sleep(350)
         out.headClears =
           pickAll('.track-row .row-select input').every((input) => !input.checked) &&
           !pick('.selection-bar')

         // Shift+click extends from the last anchor rather than behaving like a
         // second Ctrl+click.
         const toneRow = rowFor('Selftest Tone')
         if (toneRow) toneRow.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
         await sleep(250)
         const silentRow = rowFor('Selftest Silent')
         if (silentRow) silentRow.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
         await sleep(300)
         out.shiftRange =
           pickAll('.track-row.selected').length >= 2 &&
           Boolean(rowFor('Selftest Tone')) &&
           rowFor('Selftest Tone').classList.contains('selected') &&
           Boolean(rowFor('Selftest Silent')) &&
           rowFor('Selftest Silent').classList.contains('selected')

         // Library search: right-click Paste, then right-click Clear.
         await window.player.writeClipboardText('Selftest Tone')
         const search = pick('.search-field input')
         if (search) {
           search.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 140, clientY: 140 }))
         }
         await sleep(250)
         out.searchMenuItems = pickAll('.field-menu .context-item').map(text).join(' | ')
         const searchPaste = pickAll('.field-menu .context-item').find((el) => text(el) === 'Paste')
         if (searchPaste) press(searchPaste)
         out.searchPasted =
           Boolean(search) && (await until(() => search.value === 'Selftest Tone', 3000))
         if (search) {
           search.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 140, clientY: 140 }))
         }
         await sleep(200)
         const searchClear = pickAll('.field-menu .context-item').find((el) => text(el) === 'Clear')
         if (searchClear) press(searchClear)
         out.searchCleared = Boolean(search) && (await until(() => search.value === '', 3000))

         // The full Queue view: Ctrl+click chooses the first row, then Shift+click
         // the last extends the range. The # header is select-all/clear.
         nav('Queue')
         await sleep(500)
         const queueJumps = pickAll('.queue-jump')
         if (queueJumps[0]) {
           queueJumps[0].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
         }
         await sleep(300)
         out.queueCheckboxes =
           pickAll('.queue-item').length > 0 &&
           pickAll('.queue-item .queue-select input').length === pickAll('.queue-item').length
         out.queueChecked = pickAll('.queue-item .queue-select input').filter((input) => input.checked).length
         const queueHeadBox = pick('.queue-head .head-select input')
         out.queueHeaderIndeterminate = Boolean(queueHeadBox && queueHeadBox.indeterminate)
         out.queueBarButtons = pickAll('.selection-bar button').map(text).join(' | ')
         out.queueBarClearNormal =
           Boolean(pick('.selection-bar button.selection-clear')) &&
           !pick('.selection-bar .link-button')
         if (queueJumps.length > 1) {
           queueJumps[queueJumps.length - 1].dispatchEvent(
             new MouseEvent('click', { bubbles: true, shiftKey: true })
           )
           await sleep(300)
         }
         out.queueShiftRange =
           queueJumps.length > 1 &&
           pickAll('.queue-item .queue-select input').filter((input) => input.checked).length ===
             queueJumps.length
         const allQueueHead = pick('.queue-head .head-select input')
         if (allQueueHead && allQueueHead.checked) allQueueHead.click()
         await sleep(300)
         out.queueHeaderClears =
           pickAll('.queue-item .queue-select input').every((input) => !input.checked) &&
           !pick('.queue-head .head-select')

         // Re-select one row and check the selected-row menu and the overflow
         // menu's Play selected action.
         const firstQueueRow = pick('.queue-jump')
         if (firstQueueRow) {
           firstQueueRow.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
           await sleep(250)
           firstQueueRow.dispatchEvent(
             new MouseEvent('contextmenu', { bubbles: true, clientX: 260, clientY: 260 })
           )
           await sleep(250)
           out.queueRowActions = pickAll('.context-menu .context-item').map(text).join(' | ')
           document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
           await sleep(200)
         }
         press(pick('.queue-actions-trigger'))
         await sleep(250)
         const queueItems = pickAll('.queue-actions-menu .queue-actions-item').map(text)
         out.queueMenuSelected = queueItems.indexOf('Save selected as playlist…') >= 0
         out.queueMenuPlaySelected = queueItems.indexOf('Play selected') >= 0
         const saveSelected = pickAll('.queue-actions-menu .queue-actions-item').find(
           (el) => text(el) === 'Save selected as playlist…'
         )
         if (saveSelected) press(saveSelected)
         await sleep(300)
         out.selectedHeading = text(pick('.atp-head'))
         document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
         await sleep(200)
         press(pick('.selection-bar .selection-clear'))
         await sleep(300)
         out.queueBarClears = !pick('.queue-head .head-select')

         // Search view has the same field menu as the link field.
         nav('Search')
         await sleep(450)
         await window.player.writeClipboardText('Selftest')
         const discover = pick('.discover-input input')
         if (discover) {
           discover.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 160, clientY: 160 }))
         }
         await sleep(250)
         const discoverPaste = pickAll('.field-menu .context-item').find((el) => text(el) === 'Paste')
         if (discoverPaste) press(discoverPaste)
         out.discoverPasted =
           Boolean(discover) && (await until(() => discover.value === 'Selftest', 3000))
         if (discover) {
           discover.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 160, clientY: 160 }))
         }
         await sleep(200)
         const discoverClear = pickAll('.field-menu .context-item').find((el) => text(el) === 'Clear')
         if (discoverClear) press(discoverClear)
         out.discoverCleared =
           Boolean(discover) && (await until(() => discover.value === '', 3000))

         nav('Library')
         await sleep(350)
         return out
       })()`
    )
    record(
      selection.rows > 0 && selection.checkboxes === selection.rows && selection.checked === 1,
      'with a selection every row exposes a checkbox in the index column',
      `${selection.checkboxes} checkboxes for ${selection.rows} rows, ${selection.checked} checked`
    )
    record(
      selection.playWhileSelected && selection.selectionKept,
      'clicking a row while selected plays it without changing the selection'
    )
    record(
      selection.checkboxSelects && selection.playbackKept,
      'the checkbox adds a row to the selection without starting playback'
    )
    record(
      selection.rightClickDeselects &&
        selection.contextSelectedActions.includes('Play selected') &&
        selection.contextSelectedActions.includes('Queue selected'),
      'right-clicking a selected row offers Deselect, Play selected and Queue selected',
      selection.contextSelectedActions
    )
    record(
      selection.headSelect &&
        selection.headIndeterminate &&
        selection.headSelectsAll &&
        selection.headClears,
      'the # header is a select-all checkbox with an indeterminate state'
    )
    record(selection.shiftRange, 'Shift-click selects a range instead of toggling one row')
    record(
      selection.searchMenuItems === 'Paste | Copy | Clear' &&
        selection.searchPasted &&
        selection.searchCleared,
      'the library search field offers Paste, Copy and Clear',
      selection.searchMenuItems
    )
    record(
      selection.queueCheckboxes && selection.queueChecked === 1 && selection.queueMenuSelected,
      'the queue turns its index column into checkboxes and scopes Save to the selection'
    )
    record(
      selection.queueBarButtons === 'Play selected | Save as playlist | Clear' &&
        selection.queueBarClearNormal &&
        selection.queueBarClears,
      'the queue selection bar offers Play selected, Save as playlist and a normal Clear',
      selection.queueBarButtons
    )
    record(
      selection.queueHeaderIndeterminate &&
        selection.queueShiftRange &&
        selection.queueHeaderClears,
      'the queue header selects all and Shift-click extends a range'
    )
    record(
      selection.queueRowActions.includes('Play selected') &&
        selection.queueRowActions.includes('Queue selected') &&
        selection.queueMenuPlaySelected,
      'queue rows and the overflow menu offer Play selected and Queue selected',
      selection.queueRowActions
    )
    record(
      selection.selectedHeading === 'Selected · 1 tracks',
      'the queue save menu names the selected scope',
      selection.selectedHeading
    )
    record(
      selection.discoverPasted && selection.discoverCleared,
      'the Search field offers Paste and Clear from its context menu'
    )

    // ---- 13c. batch lyrics from the library selection ----------------------
    // The scan, the ranking and the undo rules are pinned down in
    // `npm run smoke`. What only the real window can prove is the seam: the
    // selection bar offers the batch, the dialog shows what came back with the
    // safe default, and pressing Store and then Undo actually moves the row.
    // The finder is stubbed for the same reason the panel's was: no request
    // leaves the app, and the text is known in advance.
    const batchSilent = container.library
      .list()
      .tracks.find((track) => track.title === 'Selftest Silent')
    const batchTone = container.library.list().tracks.find((track) => track.title === 'Selftest Tone')
    if (!batchSilent || !batchTone) throw new Error('selftest: the batch fixtures are missing')
    // A lyric left behind by an earlier section would make the scan skip this
    // row, and the probe would then be testing the skip path instead.
    await container.lyrics.useFile(batchSilent.id)
    const batchText = '[00:00.40]batch first\n[00:01.40]batch second'
    const originalBatchFind = container.lyrics.find
    container.lyrics.find = async (target) => {
      const track =
        typeof target === 'number'
          ? container.repo.getById(target)
          : {
              title: target.title ?? '',
              artist: target.artist,
              album: target.album,
              durationMs: target.durationMs
            }
      return {
        query: {
          title: track?.title ?? '',
          artist: track?.artist ?? null,
          album: track?.album ?? null,
          durationMs: track?.durationMs ?? null
        },
        candidates: [
          {
            provider: 'lrclib',
            providerId: `selftest-batch-${batchSilent.id}`,
            title: track?.title ?? '',
            artist: track?.artist ?? 'Selftest',
            album: track?.album ?? null,
            durationMs: track?.durationMs ?? null,
            synced: true,
            text: batchText,
            instrumental: false,
            url: null,
            score: 0.94,
            confidence: 'strong'
          }
        ],
        providers: [{ provider: 'lrclib', ok: true, message: null, count: 1 }],
        message: null
      }
    }
    const batchProbe = await evaluate<{
      buttonLabel: string
      opened: boolean
      title: string
      matchTitle: string
      matches: number
      ticked: number
      writeChecked: boolean
      applyLabel: string
      skipped: string
      stored: string
      storedText: string
      undone: string
      afterUndo: boolean
      closed: boolean
    }>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const pick = (selector) => document.querySelector(selector)
         const pickAll = (selector) => [...document.querySelectorAll(selector)]
         const text = (element) => (element ? (element.textContent || '').trim() : '')
         const press = (element) => {
           if (element) element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         }
         const until = async (predicate, timeoutMs) => {
           const deadline = Date.now() + timeoutMs
           for (;;) {
             if (predicate()) return true
             if (Date.now() > deadline) return false
             await sleep(50)
           }
         }
         const rowFor = (title) =>
           pickAll('.track-row').find((row) => text(row.querySelector('.row-title-text')) === title)
         const out = {
           buttonLabel: '', opened: false, title: '', matchTitle: '', matches: 0,
           ticked: 0, writeChecked: true, applyLabel: '', skipped: '', stored: '',
           storedText: '', undone: '', afterUndo: false, closed: false
         }

         // Two rows: one with lyrics (skipped by the scan) and one without.
         const silent = rowFor('Selftest Silent')
         if (silent) silent.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
         await sleep(250)
         const tone = rowFor('Selftest Tone')
         if (tone) tone.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
         await sleep(300)

         const fetchButton = pickAll('.selection-bar button').find(
           (el) => text(el) === 'Fetch missing lyrics'
         )
         out.buttonLabel = text(fetchButton)
         press(fetchButton)
         await sleep(300)
         out.opened = Boolean(pick('.lyrics-batch-dialog'))
         out.title = text(pick('#lyrics-batch-title'))
         await until(() => pick('.batch-match') || pick('.batch-result'), 20000)

         out.matches = pickAll('.batch-match').length
         out.matchTitle = text(pick('.batch-match .auto-tag-match-text strong'))
         out.ticked = pickAll('.batch-match input[type="checkbox"]').filter(
           (input) => input.checked
         ).length
         const writeBox = pick('.lyrics-batch-write input')
         out.writeChecked = writeBox ? writeBox.checked : true
         out.applyLabel = text(pick('.details-foot button.primary'))
         out.skipped = text(pick('.batch-skipped summary'))

         press(pick('.details-foot button.primary'))
         await until(() => pick('.batch-result'), 20000)
         out.stored = text(pick('.batch-result p'))
         out.storedText = ((await window.player.getTrackLyrics(${batchSilent.id})) || {}).text || ''

         press(pickAll('.details-foot button').find((el) => text(el) === 'Undo'))
         await until(() => pickAll('.batch-result').length > 1, 20000)
         out.undone = text(pickAll('.batch-result p')[1])
         out.afterUndo = (await window.player.getTrackLyrics(${batchSilent.id})) === null

         press(pickAll('.details-foot button').find((el) => text(el) === 'Done'))
         await sleep(350)
         out.closed = !pick('.lyrics-batch-dialog')
         // Later sections assume a library with nothing selected: the '#' column
         // and the playlist actions both key off the selection.
         press(pick('.selection-bar .selection-clear'))
         await sleep(300)
         return out
       })()`
    )
    container.lyrics.find = originalBatchFind
    record(
      batchProbe.buttonLabel === 'Fetch missing lyrics' &&
        batchProbe.opened &&
        batchProbe.title === 'Fetch missing lyrics',
      'the library selection bar opens the batch lyrics dialog',
      `"${batchProbe.buttonLabel}" -> "${batchProbe.title}"`
    )
    record(
      batchProbe.matches === 1 &&
        batchProbe.matchTitle === 'Selftest Silent' &&
        batchProbe.ticked === 1 &&
        batchProbe.applyLabel === 'Store 1',
      'the review shows the match for the row without lyrics and ticks it by default',
      `${batchProbe.matches} matches, "${batchProbe.matchTitle}", ${batchProbe.ticked} ticked, "${batchProbe.applyLabel}"`
    )
    record(
      batchProbe.writeChecked === false,
      'writing into files is off by default, so the batch stores a reversible copy first'
    )
    record(
      batchProbe.skipped.startsWith('Not fetching 1'),
      'a selected row that already has lyrics is listed as not fetched',
      `"${batchProbe.skipped}"`
    )
    record(
      batchProbe.stored.startsWith('1 stored') && batchProbe.storedText === batchText,
      'Store keeps the accepted lyrics for the library row',
      `"${batchProbe.stored}", ${batchProbe.storedText.length} characters`
    )
    record(
      batchProbe.undone.startsWith('Undone: 1 removed') && batchProbe.afterUndo,
      'Undo removes the stored copy again, leaving the row without lyrics',
      `"${batchProbe.undone}"`
    )
    record(batchProbe.closed, 'Done closes the batch dialog and leaves the library selection bar')

    // ---- 13d. the tag editor's text fields have a working right-click -----
    // Electron draws no menu for an input on its own, and the tag editor is
    // exactly where a mangled artist name gets fixed by hand, so cut, copy and
    // paste have to work there. The menu is drawn once for the whole app, so
    // the check also proves it lands above the dialog it was opened in.
    const fieldMenu = await evaluate<{
      opened: boolean
      items: string
      aboveDialog: boolean
      zIndex: string
      copied: string
      pasted: string
      cutValue: string
      cutClipboard: string
      editorClosed: boolean
      sheetClosed: boolean
    }>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const pick = (selector) => document.querySelector(selector)
         const pickAll = (selector) => [...document.querySelectorAll(selector)]
         const text = (element) => (element ? (element.textContent || '').trim() : '')
         const press = (element) => {
           if (element) element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         }
         const out = {
           opened: false, items: '', aboveDialog: false, zIndex: '',
           copied: '', pasted: '', cutValue: '', cutClipboard: '',
           editorClosed: false, sheetClosed: false
         }
         const openMenu = async (field) => {
           const rect = field.getBoundingClientRect()
           field.dispatchEvent(
             new MouseEvent('contextmenu', {
               bubbles: true,
               clientX: rect.left + 20,
               clientY: rect.top + rect.height / 2
             })
           )
           await sleep(250)
           return pick('.text-menu')
         }
         const item = (label) =>
           pickAll('.text-menu .context-item').find((el) => text(el) === label)

         const row = pickAll('.track-row').find(
           (el) => text(el.querySelector('.row-title-text')) === 'Selftest Tone'
         )
         if (row) {
           row.dispatchEvent(
             new MouseEvent('contextmenu', { bubbles: true, clientX: 240, clientY: 240 })
           )
         }
         await sleep(300)
         press(
           pickAll('.context-menu .context-item').find((el) => text(el) === 'Edit tags…')
         )
         await sleep(600)

         const title = pick('.tag-dialog .tag-grid input')
         if (title) {
           title.focus()
           title.setSelectionRange(0, 8)
           const menu = await openMenu(title)
           out.opened = Boolean(menu) && Boolean(pick('.tag-dialog'))
           out.items = pickAll('.text-menu .context-item').map(text).join(' | ')
           if (menu) {
             const rect = menu.getBoundingClientRect()
             const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + 12)
             out.aboveDialog = Boolean(hit && hit.closest('.text-menu'))
             out.zIndex = getComputedStyle(menu).zIndex
           }

           press(item('Copy'))
           await sleep(350)
           out.copied = await window.player.readClipboardText()

           await window.player.writeClipboardText('Pasted')
           await openMenu(title)
           press(item('Paste'))
           await sleep(350)
           out.pasted = title.value

           // A marker on the clipboard, then Cut: only a real copy-then-remove
           // leaves the field's old text behind on the clipboard.
           await window.player.writeClipboardText('marker')
           await openMenu(title)
           press(item('Select all'))
           await sleep(200)
           await openMenu(title)
           press(item('Cut'))
           await sleep(350)
           out.cutValue = title.value
           out.cutClipboard = await window.player.readClipboardText()
         }

         const dialog = pick('.tag-dialog')
         if (dialog) {
           dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
         }
         await sleep(400)
         out.editorClosed = !pick('.tag-dialog')
         press(pick('.details-close'))
         await sleep(400)
         out.sheetClosed = !pick('.details-backdrop')
         return out
       })()`
    )
    record(
      fieldMenu.opened && fieldMenu.items === 'Cut | Copy | Paste | Select all | Clear',
      'right-clicking a tag field offers Cut, Copy, Paste, Select all and Clear',
      fieldMenu.items
    )
    record(
      fieldMenu.aboveDialog && fieldMenu.zIndex === '120',
      'the field menu sits above the tag editor that owns the field',
      `above ${fieldMenu.aboveDialog}, z-index ${fieldMenu.zIndex}`
    )
    record(
      fieldMenu.copied === 'Selftest' && fieldMenu.pasted === 'Pasted Tone',
      'Copy and Paste edit a tag field without losing the rest of its text',
      `copied ${fieldMenu.copied}, pasted ${fieldMenu.pasted}`
    )
    record(
      fieldMenu.cutValue === '' && fieldMenu.cutClipboard === 'Pasted Tone',
      'Cut copies the selection before removing it',
      `value ${fieldMenu.cutValue}, clipboard ${fieldMenu.cutClipboard}`
    )
    record(
      fieldMenu.editorClosed && fieldMenu.sheetClosed,
      'the tag editor and its details sheet close cleanly after the field menu was used',
      `editor ${fieldMenu.editorClosed}, sheet ${fieldMenu.sheetClosed}`
    )

    // ---- 13e. the tag finder proposes, the editor still decides ----------
    // The network is replaced here, not exercised: what this checks is the seam
    // the user sees. A match fills the form and never the file, a filled field
    // starts unticked, and Escape closes the finder before the editor.
    let autoTagQuery: TagLookupQuery | null = null
    const originalLookup = container.tagLookup.lookup
    container.tagLookup.lookup = async (query) => {
      autoTagQuery = query
      return {
        query,
        candidates: [
          {
            provider: 'itunes',
            providerId: 'selftest-1',
            title: 'Selftest Tone (Remastered)',
            artist: 'The Real Selftest',
            albumArtist: 'The Real Selftest',
            album: 'Correct Album',
            year: 1999,
            genre: 'Test',
            trackNo: 4,
            trackTotal: 9,
            discNo: 1,
            discTotal: 1,
            durationMs: 3000,
            artworkUrl: null,
            score: 0.88,
            confidence: 'strong'
          }
        ],
        providers: [
          { provider: 'itunes', ok: true, message: null, count: 1 },
          { provider: 'musicbrainz', ok: true, message: null, count: 0 }
        ]
      }
    }
    const autoTag = await evaluate<{
      opened: boolean
      matches: number
      matchText: string
      artistUnticked: boolean
      albumUnticked: boolean
      genreTicked: boolean
      panelAfterApply: boolean
      artistAfter: string
      albumAfter: string
      albumArtistAfter: string
      genreAfter: string
      yearAfter: string
      trackAfter: string
      escapeClosedPanel: boolean
      escapeKeptEditor: boolean
      editorClosed: boolean
      sheetClosed: boolean
      singleBackdrop: boolean
    }>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const pick = (selector) => document.querySelector(selector)
         const pickAll = (selector) => [...document.querySelectorAll(selector)]
         const text = (element) => (element ? (element.textContent || '').trim() : '')
         const press = (element) => {
           if (element) element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         }
         const out = {
           opened: false, matches: 0, matchText: '',
           artistUnticked: false, albumUnticked: false, genreTicked: false,
           panelAfterApply: false, artistAfter: '', albumAfter: '',
           albumArtistAfter: '', genreAfter: '', yearAfter: '', trackAfter: '',
           escapeClosedPanel: false, escapeKeptEditor: false,
           editorClosed: false, sheetClosed: false, singleBackdrop: false
         }
         const fieldInput = (label) => {
           const field = pickAll('.tag-grid .field').find(
             (el) => text(el.querySelector('span')) === label
           )
           return field ? field.querySelector('input') : null
         }
         const autoRow = (name) =>
           pickAll('.auto-tag-field').find(
             (el) => text(el.querySelector('.auto-tag-field-name')) === name
           )
         const ticked = (name) => {
           const row = autoRow(name)
           const box = row ? row.querySelector('input[type=checkbox]') : null
           return Boolean(box && box.checked)
         }

         const row = pickAll('.track-row').find(
           (el) => text(el.querySelector('.row-title-text')) === 'Selftest Tone'
         )
         if (row) {
           row.dispatchEvent(
             new MouseEvent('contextmenu', { bubbles: true, clientX: 240, clientY: 240 })
           )
         }
         await sleep(300)
         press(
           pickAll('.context-menu .context-item').find((el) => text(el) === 'Edit tags…')
         )
         await sleep(600)
         // One overlay, not two: the details sheet steps aside while the
         // editor is open, so the window is dimmed once like the sheet itself.
         out.singleBackdrop = Boolean(pick('.tag-backdrop')) && !pick('.details-backdrop')

         const findTagsButton = () =>
           pickAll('.tag-head-actions .tag-find').find((el) => text(el) === 'Find tags')
         press(findTagsButton())
         await sleep(500)
         out.opened = Boolean(pick('.auto-tag'))
         out.matches = pickAll('.auto-tag-match').length
         out.matchText = pickAll('.auto-tag-match strong').map(text).join(' | ')
         out.artistUnticked = !ticked('Artist')
         out.albumUnticked = !ticked('Album')
         out.genreTicked = ticked('Genre')

         // Replacing a filled field is the decision the default withholds, so
         // it has to be made on purpose before Apply does anything.
         const artistRow = autoRow('Artist')
         const artistBox = artistRow ? artistRow.querySelector('input[type=checkbox]') : null
         if (artistBox) artistBox.click()
         await sleep(200)
         press(pick('.auto-tag-foot .primary'))
         await sleep(500)
         out.panelAfterApply = !pick('.auto-tag')
         out.artistAfter = fieldInput('Artist') ? fieldInput('Artist').value : ''
         out.albumAfter = fieldInput('Album') ? fieldInput('Album').value : ''
         out.albumArtistAfter = fieldInput('Album artist') ? fieldInput('Album artist').value : ''
         out.genreAfter = fieldInput('Genre') ? fieldInput('Genre').value : ''
         out.yearAfter = fieldInput('Year') ? fieldInput('Year').value : ''
         const trackNo = pick('input[aria-label="Track number"]')
         out.trackAfter = trackNo ? trackNo.value : ''

         // The finder is a layer inside the editor, so Escape unwinds one layer
         // at a time rather than closing the whole dialog.
         press(findTagsButton())
         await sleep(400)
         const dialog = pick('.tag-dialog')
         if (dialog) {
           dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
         }
         await sleep(400)
         out.escapeClosedPanel = !pick('.auto-tag')
         out.escapeKeptEditor = Boolean(pick('.tag-dialog'))
         const stillDialog = pick('.tag-dialog')
         if (stillDialog) {
           stillDialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
         }
         await sleep(400)
         out.editorClosed = !pick('.tag-dialog')
         press(pick('.details-close'))
         await sleep(400)
         out.sheetClosed = !pick('.details-backdrop')
         return out
       })()`
    )
    // The stub runs inside the renderer's IPC round trip, so the assignment is
    // invisible to the compiler's flow analysis; the cast is only for that.
    const capturedQuery = autoTagQuery as TagLookupQuery | null
    record(
      autoTag.opened && autoTag.matches === 1 && autoTag.matchText.includes('Selftest Tone'),
      'Find tags lists the matches the provider returned',
      `${autoTag.matches}: ${autoTag.matchText}`
    )
    record(
      autoTag.singleBackdrop,
      'the tag editor dims the window once, not twice, when opened from details',
      `single backdrop ${autoTag.singleBackdrop}`
    )
    record(
      autoTag.artistUnticked && autoTag.albumUnticked && autoTag.genreTicked,
      'a field the file already fills starts unticked, a blank one starts ticked',
      `artist ${autoTag.artistUnticked}, album ${autoTag.albumUnticked}, genre ${autoTag.genreTicked}`
    )
    record(
      autoTag.panelAfterApply &&
        autoTag.artistAfter === 'The Real Selftest' &&
        autoTag.albumArtistAfter === 'Selftest' &&
        autoTag.albumAfter === 'Selftest Album' &&
        autoTag.genreAfter === 'Test' &&
        autoTag.yearAfter === '1999' &&
        autoTag.trackAfter === '4',
      'applying a match fills the blank fields and leaves a filled album alone',
      `artist ${autoTag.artistAfter}, album ${autoTag.albumAfter}, albumArtist ${autoTag.albumArtistAfter}, genre ${autoTag.genreAfter}, year ${autoTag.yearAfter}, track ${autoTag.trackAfter}, panel ${autoTag.panelAfterApply}`
    )
    record(
      autoTag.escapeClosedPanel && autoTag.escapeKeptEditor && autoTag.editorClosed && autoTag.sheetClosed,
      'Escape closes the tag finder before the editor, then the editor and its sheet',
      `panel ${autoTag.escapeClosedPanel}, editor ${autoTag.escapeKeptEditor}/${autoTag.editorClosed}, sheet ${autoTag.sheetClosed}`
    )
    record(
      capturedQuery !== null &&
        capturedQuery.title === 'Selftest Tone' &&
        capturedQuery.artist === 'Selftest' &&
        capturedQuery.durationMs === 3000,
      'the finder searches with the row title, artist and length',
      JSON.stringify(capturedQuery)
    )

    // ---- 13e-2. the fingerprint fallback is an explicit second attempt -----
    // The network is replaced again. What matters is that it is a separate
    // button rather than an automatic retry: the review list only changes when
    // the user asks for the audio to be read.
    const originalFingerprintLookup = container.tagLookup.lookupFingerprint
    container.tagLookup.lookupFingerprint = async (query) => ({
      query,
      candidates: [
        {
          provider: 'acoustid',
          providerId: 'rec-selftest',
          title: 'Fingerprint Tone',
          artist: 'Audio Only',
          albumArtist: 'Audio Only',
          album: 'Audio Album',
          year: 2001,
          genre: null,
          trackNo: 2,
          trackTotal: 8,
          discNo: 1,
          discTotal: 1,
          durationMs: 3000,
          artworkUrl: null,
          score: 0.92,
          confidence: 'strong'
        }
      ],
      providers: [{ provider: 'acoustid', ok: true, message: null, count: 1 }]
    })
    const fingerprintTags = await evaluate<{
      button: boolean
      match: string
      score: string
      editorClosed: boolean
      sheetClosed: boolean
    }>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const pick = (selector) => document.querySelector(selector)
         const pickAll = (selector) => [...document.querySelectorAll(selector)]
         const text = (element) => (element ? (element.textContent || '').trim() : '')
         const press = (element) => {
           if (element) element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         }
         const out = { button: false, match: '', score: '', editorClosed: false, sheetClosed: false }
         const row = pickAll('.track-row').find(
           (el) => text(el.querySelector('.row-title-text')) === 'Selftest Tone'
         )
         if (row) {
           row.dispatchEvent(
             new MouseEvent('contextmenu', { bubbles: true, clientX: 240, clientY: 240 })
           )
         }
         await sleep(300)
         press(pickAll('.context-menu .context-item').find((el) => text(el) === 'Edit tags…'))
         await sleep(600)
         const findTagsButton = () =>
           pickAll('.tag-head-actions .tag-find').find((el) => text(el) === 'Find tags')
         press(findTagsButton())
         await sleep(500)
         out.button = Boolean(pick('.auto-tag-fingerprint'))
         press(pick('.auto-tag-fingerprint'))
         await sleep(500)
         out.match = pick('.auto-tag-match strong') ? text(pick('.auto-tag-match strong')) : ''
         out.score = pick('.auto-tag-score .subtitle') ? text(pick('.auto-tag-score .subtitle')) : ''
         const dialog = pick('.tag-dialog')
         if (dialog) {
           dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
         }
         await sleep(300)
         const stillDialog = pick('.tag-dialog')
         if (stillDialog) {
           stillDialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
         }
         await sleep(300)
         out.editorClosed = !pick('.tag-dialog')
         press(pick('.details-close'))
         await sleep(300)
         out.sheetClosed = !pick('.details-backdrop')
         return out
       })()`
    )
    container.tagLookup.lookupFingerprint = originalFingerprintLookup
    container.tagLookup.lookup = originalLookup
    record(
      fingerprintTags.button &&
        fingerprintTags.match === 'Fingerprint Tone' &&
        fingerprintTags.score.includes('AcoustID') &&
        fingerprintTags.score.includes('92%'),
      'Match by fingerprint replaces the text answer with the AcoustID one',
      `${fingerprintTags.button} | ${fingerprintTags.match} | ${fingerprintTags.score}`
    )
    record(
      fingerprintTags.editorClosed && fingerprintTags.sheetClosed,
      'the fingerprint lookup leaves the editor and its sheet closed cleanly',
      `editor ${fingerprintTags.editorClosed}, sheet ${fingerprintTags.sheetClosed}`
    )

    // ---- 13f. the cover picker offers pictures, the editor still writes --
    // The providers and the cache are replaced here, so this is about the seam
    // the user sees: local covers first, provider covers on request, a chosen
    // cover previewed in the editor, and Escape unwinding one layer at a time.
    const coverFor = async (name: string, color: string): Promise<string> => {
      const target = join(fixtureDir, name)
      await execFileAsync(
        ffmpegExe,
        ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=96x64`, '-frames:v', '1', target],
        { timeout: 60_000 }
      )
      return (await container.artwork.cacheRemote(await readFile(target), 'image/png')) ?? ''
    }
    const localCoverKey = (await container.artwork.cacheRemote(await readFile(coverPath), 'image/png')) ?? ''
    const folderCoverKey = await coverFor('selftest-cover-b.png', '#22aa55')
    const providerCoverKey = await coverFor('selftest-cover-c.png', '#ff8800')
    record(
      Boolean(localCoverKey && folderCoverKey && providerCoverKey),
      'cover picker: the selftest covers were cached',
      `${localCoverKey} | ${folderCoverKey} | ${providerCoverKey}`
    )

    const localChoices: ArtworkChoice[] = [
      { key: localCoverKey, kind: 'embedded', label: 'In the file', current: true },
      { key: folderCoverKey, kind: 'folder', label: 'cover.png', current: false }
    ]
    const onlineChoices: ArtworkChoice[] = [
      { key: providerCoverKey, kind: 'provider', label: 'iTunes', current: false }
    ]
    const originalChoicesLocal = container.artworkChoices.local
    const originalChoicesOnline = container.artworkChoices.online
    container.artworkChoices.local = async () => localChoices
    container.artworkChoices.online = async () => onlineChoices

    let coverPicker: {
      pickerOpen: boolean
      localCount: number
      currentMarked: boolean
      applyDisabledAtStart: boolean
      onlineCount: number
      applyEnabledAfterPick: boolean
      pickerClosedAfterUse: boolean
      headerShowsChosen: boolean
      escapeClosedPicker: boolean
      escapeKeptEditor: boolean
      editorClosed: boolean
      sheetClosed: boolean
    }
    try {
      coverPicker = await evaluate(
        window,
        `(async () => {
           const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
           const pick = (selector) => document.querySelector(selector)
           const pickAll = (selector) => [...document.querySelectorAll(selector)]
           const text = (element) => (element ? (element.textContent || '').trim() : '')
           const press = (element) => {
             if (element) element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
           }
           const out = {
             pickerOpen: false, localCount: 0, currentMarked: false,
             applyDisabledAtStart: false, onlineCount: 0,
             applyEnabledAfterPick: false, pickerClosedAfterUse: false,
             headerShowsChosen: false, escapeClosedPicker: false,
             escapeKeptEditor: false, editorClosed: false, sheetClosed: false
           }
           const coverButton = () =>
             pickAll('.tag-head-actions .tag-find').find((el) => text(el) === 'Cover')

           const row = pickAll('.track-row').find(
             (el) => text(el.querySelector('.row-title-text')) === 'Selftest Tone'
           )
           if (row) {
             row.dispatchEvent(
               new MouseEvent('contextmenu', { bubbles: true, clientX: 240, clientY: 240 })
             )
           }
           await sleep(300)
           press(
             pickAll('.context-menu .context-item').find((el) => text(el) === 'Edit tags…')
           )
           await sleep(600)

           press(coverButton())
           await sleep(500)
           out.pickerOpen = Boolean(pick('.artwork-picker'))
           out.localCount = pickAll('.artwork-choice').length
           out.currentMarked = pickAll('.artwork-choice .subtitle').some(
             (el) => text(el) === 'In use'
           )
           const apply = () => pick('.artwork-picker .auto-tag-foot .primary')
           out.applyDisabledAtStart = Boolean(apply() && apply().disabled)

           press(pick('.artwork-picker .tag-find'))
           await sleep(500)
           out.onlineCount = pickAll('.artwork-choice').length

           const second = pickAll('.artwork-choice')[1]
           press(second)
           await sleep(200)
           out.applyEnabledAfterPick = Boolean(apply() && !apply().disabled)
           press(apply())
           await sleep(400)
           out.pickerClosedAfterUse = !pick('.artwork-picker')
           const headerArt = pick('.tag-art')
           out.headerShowsChosen = Boolean(
             headerArt && (headerArt.getAttribute('src') || '').includes(${JSON.stringify(folderCoverKey)})
           )

           // Reopen and unwind with Escape: the picker goes first, the editor stays.
           press(coverButton())
           await sleep(400)
           const dialog = pick('.tag-dialog')
           if (dialog) {
             dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
           }
           await sleep(300)
           out.escapeClosedPicker = !pick('.artwork-picker')
           out.escapeKeptEditor = Boolean(pick('.tag-dialog'))
           const stillDialog = pick('.tag-dialog')
           if (stillDialog) {
             stillDialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
           }
           await sleep(300)
           out.editorClosed = !pick('.tag-dialog')
           press(pick('.details-close'))
           await sleep(300)
           out.sheetClosed = !pick('.details-backdrop')
           return out
         })()`
      )
    } finally {
      container.artworkChoices.local = originalChoicesLocal
      container.artworkChoices.online = originalChoicesOnline
    }

    record(
      coverPicker.pickerOpen && coverPicker.localCount === 2 && coverPicker.onlineCount === 3,
      'the cover picker lists local covers, then provider covers when asked',
      `open ${coverPicker.pickerOpen}, local ${coverPicker.localCount}, online ${coverPicker.onlineCount}`
    )
    record(
      coverPicker.currentMarked &&
        coverPicker.applyDisabledAtStart &&
        coverPicker.applyEnabledAfterPick &&
        coverPicker.pickerClosedAfterUse &&
        coverPicker.headerShowsChosen,
      'choosing a cover previews it in the editor without writing the file',
      `current ${coverPicker.currentMarked}, disabled ${coverPicker.applyDisabledAtStart}, enabled ${coverPicker.applyEnabledAfterPick}, closed ${coverPicker.pickerClosedAfterUse}, header ${coverPicker.headerShowsChosen}`
    )
    record(
      coverPicker.escapeClosedPicker &&
        coverPicker.escapeKeptEditor &&
        coverPicker.editorClosed &&
        coverPicker.sheetClosed,
      'Escape closes the cover picker before the editor, then the editor and its sheet',
      `picker ${coverPicker.escapeClosedPicker}, editor ${coverPicker.escapeKeptEditor}/${coverPicker.editorClosed}, sheet ${coverPicker.sheetClosed}`
    )

    // ---- 13g. batch tags from the library selection -----------------------
    // The fill/replace rule and the service's write-and-undo path are pinned
    // down in `npm run smoke`. What only the real window can prove is the seam:
    // the selection bar offers the batch, the review starts in the safe mode,
    // the replace checkbox widens what is shown, and Apply then Undo moves the
    // row and the file back.
    const batchTagTone = container.library
      .list()
      .tracks.find((track) => track.title === 'Selftest Tone')
    if (!batchTagTone) throw new Error('selftest: the batch tag fixture is missing')
    const originalBatchTagLookup = container.tagLookup.lookup
    container.tagLookup.lookup = async (query) => ({
      query,
      candidates: [
        {
          provider: 'itunes',
          providerId: 'selftest-batch-tag',
          title: 'Selftest Tone',
          artist: 'Selftest',
          albumArtist: 'Selftest',
          // A value the file already has: fill must leave it, replace must show
          // it, and undo must be able to put it back either way.
          album: 'Correct Album',
          year: 1998,
          genre: 'Test Genre',
          trackNo: 2,
          trackTotal: 10,
          discNo: 1,
          discTotal: 1,
          durationMs: 2000,
          artworkUrl: null,
          score: 0.93,
          confidence: 'strong'
        }
      ],
      providers: [{ provider: 'itunes', ok: true, message: null, count: 1 }]
    })
    const batchTagProbe = await evaluate<{
      buttonLabel: string
      opened: boolean
      title: string
      matchTitle: string
      matches: number
      ticked: number
      replaceChecked: boolean
      fillChanges: string
      replaceChanges: string
      applyLabel: string
      written: string
      genreAfterWrite: string | null
      undone: string
      genreAfterUndo: string | null
      closed: boolean
    }>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const pick = (selector) => document.querySelector(selector)
         const pickAll = (selector) => [...document.querySelectorAll(selector)]
         const text = (element) => (element ? (element.textContent || '').trim() : '')
         const press = (element) => {
           if (element) element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         }
         const until = async (predicate, timeoutMs) => {
           const deadline = Date.now() + timeoutMs
           for (;;) {
             if (predicate()) return true
             if (Date.now() > deadline) return false
             await sleep(50)
           }
         }
         const rowFor = (title) =>
           pickAll('.track-row').find((row) => text(row.querySelector('.row-title-text')) === title)
         const out = {
           buttonLabel: '', opened: false, title: '', matchTitle: '', matches: 0,
           ticked: 0, replaceChecked: true, fillChanges: '', replaceChanges: '',
           applyLabel: '', written: '', genreAfterWrite: null, undone: '',
           genreAfterUndo: null, closed: false
         }

         const silent = rowFor('Selftest Tone')
         if (silent) silent.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
         await sleep(300)

         const fixButton = pickAll('.selection-bar button').find(
           (el) => text(el) === 'Fix tags'
         )
         out.buttonLabel = text(fixButton)
         press(fixButton)
         await sleep(300)
         out.opened = Boolean(pick('.tag-batch-dialog'))
         out.title = text(pick('#tag-batch-title'))
         await until(() => pick('.batch-match') || pick('.batch-result'), 20000)

         out.matches = pickAll('.batch-match').length
         out.matchTitle = text(pick('.batch-match .auto-tag-match-text strong'))
         out.ticked = pickAll('.batch-match input[type="checkbox"]').filter(
           (input) => input.checked
         ).length
         const modeBox = pick('.tag-batch-mode input')
         out.replaceChecked = modeBox ? modeBox.checked : true
         out.fillChanges = text(pick('.tag-batch-changes'))

         // Replace is the one destructive choice: it must be unticked at first,
         // and ticking it must widen what the row says it will write.
         if (modeBox) modeBox.click()
         await sleep(300)
         out.replaceChanges = text(pick('.tag-batch-changes'))
         const modeAgain = pick('.tag-batch-mode input')
         if (modeAgain) modeAgain.click()
         await sleep(300)

         out.applyLabel = text(pick('.details-foot button.primary'))
         press(pick('.details-foot button.primary'))
         await until(() => pick('.batch-result'), 20000)
         out.written = text(pick('.batch-result p'))
         out.genreAfterWrite = (await window.player.getTracks([${batchTagTone.id}]))[0].genre

         press(pickAll('.details-foot button').find((el) => text(el) === 'Undo'))
         await until(() => pickAll('.batch-result').length > 1, 20000)
         out.undone = text(pickAll('.batch-result p')[1])
         out.genreAfterUndo = (await window.player.getTracks([${batchTagTone.id}]))[0].genre

         press(pickAll('.details-foot button').find((el) => text(el) === 'Done'))
         await sleep(350)
         out.closed = !pick('.tag-batch-dialog')
         press(pick('.selection-bar .selection-clear'))
         await sleep(300)
         return out
       })()`
    )
    container.tagLookup.lookup = originalBatchTagLookup
    record(
      batchTagProbe.buttonLabel === 'Fix tags' &&
        batchTagProbe.opened &&
        batchTagProbe.title === 'Fix tags',
      'the library selection bar opens the batch tag dialog',
      `"${batchTagProbe.buttonLabel}" -> "${batchTagProbe.title}"`
    )
    record(
      batchTagProbe.matches === 1 &&
        batchTagProbe.matchTitle === 'Selftest Tone' &&
        batchTagProbe.ticked === 1 &&
        batchTagProbe.applyLabel === 'Write 1 file',
      'the review shows the match and ticks it by default',
      `${batchTagProbe.matches} matches, "${batchTagProbe.matchTitle}", ${batchTagProbe.ticked} ticked, "${batchTagProbe.applyLabel}"`
    )
    record(
      batchTagProbe.replaceChecked === false &&
        batchTagProbe.fillChanges.includes('Genre: Test Genre') &&
        !batchTagProbe.fillChanges.includes('Album:') &&
        batchTagProbe.replaceChanges.includes('Album: Selftest Album → Correct Album'),
      'fill is the default and only replace shows the field the file already has',
      `fill "${batchTagProbe.fillChanges}" | replace "${batchTagProbe.replaceChanges}"`
    )
    record(
      batchTagProbe.written.startsWith('1 file rewritten') &&
        batchTagProbe.genreAfterWrite === 'Test Genre',
      'writing the batch fills the blank fields in the file',
      `"${batchTagProbe.written}", genre ${batchTagProbe.genreAfterWrite}`
    )
    record(
      batchTagProbe.undone.startsWith('Undone: 1 file restored') &&
        batchTagProbe.genreAfterUndo === null,
      'undo puts the file back from the backup the batch took',
      `"${batchTagProbe.undone}", genre ${batchTagProbe.genreAfterUndo}`
    )
    record(batchTagProbe.closed, 'Done closes the batch tag dialog and leaves the library selection bar')

    // ---- 14. the library keeps up with the disk by itself ----------------
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

    // ---- 15. playlists ----------------------------------------------------
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
    // A display that cannot give us 1040 CSS pixels (1024 DIP at 150% here) clamps
    // the window, and the layout then stacks by design; the splitter checks below
    // assert that collapse instead of a drag that cannot happen.
    window.setSize(1200, 780)
    await delay(400)
    const widthBeforeSplitter = container.settings.get().playlists.indexWidth
    const lists = await evaluate<{
      emptyState: boolean
      created: boolean
      hasImport: boolean
      hasExport: boolean
      sidebarCount: string
      menuOpened: boolean
      addedViaBar: boolean
      hasRemoveFromLibrary: boolean
      barStatus: string
      contextMenuOpened: boolean
      addedViaContext: boolean
      contextStatus: string
      countAfterAdds: number
      rowsAfterAdds: number
      legacyFooters: number
      keyboardOrder: string
      dropLine: boolean
      dragOrder: string
      libraryColumns: string
      libraryHeaderOverflow: boolean
      libraryHasFormat: boolean
      listWidth: number
      titleWidth: number
      artistWidth: number
      headerOverflow: boolean
      formatVisible: boolean
      indexBefore: number
      indexDragged: number
      indexKeyboardDelta: number
      layoutWidth: number
      viewportWidth: number
      twoPanes: boolean
      splitterHidden: boolean
      indexFullWidth: boolean
      viewOverflow: number
      listOverflow: number
      actionsInside: boolean
      rowsAfterRemove: number
      playedTitle: string
      renamed: string
      detailsMenu: boolean
      detailsOpen: boolean
      detailsHasFormat: boolean
      detailsTitle: string
      detailsClosed: boolean
      queueMenuOpened: boolean
      queueStatus: string
      countAfterQueueSave: number
      deleted: boolean
      emptyAfterDelete: boolean
    }>(
      window,
      `(async () => {
         const out = {
           emptyState: false, created: false, hasImport: false, hasExport: false, sidebarCount: '', menuOpened: false,
           addedViaBar: false, hasRemoveFromLibrary: false, barStatus: '', contextMenuOpened: false,
           addedViaContext: false, contextStatus: '', countAfterAdds: -1,
           rowsAfterAdds: -1, legacyFooters: -1, keyboardOrder: '', dropLine: false, dragOrder: '',
           libraryColumns: '', libraryHeaderOverflow: true, libraryHasFormat: true,
           viewOverflow: -1, listOverflow: -1, actionsInside: false,
           rowsAfterRemove: -1, playedTitle: '', renamed: '', detailsMenu: false,
           detailsOpen: false, detailsHasFormat: false, detailsTitle: '',
           detailsClosed: false, queueMenuOpened: false,
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
         out.hasImport = Boolean(buttonWith('.view-header', 'Import'))
         out.hasExport = Boolean(buttonWith('.playlist-pane .header-actions', 'Export'))
         out.sidebarCount = text(pickAll('.nav-item').find((el) => text(el).trim().indexOf('Playlists') === 0).querySelector('.nav-count')).trim()

         // --- add a track from the library's selection bar
         nav('Library')
         await sleep(450)
         const libraryHeads = pickAll('.main-view .track-head .head-cell')
         out.libraryColumns = libraryHeads.map((el) => text(el).trim()).filter(Boolean).join(' | ')
         out.libraryHeaderOverflow = libraryHeads.some((el) => el.offsetWidth > 0 && el.scrollWidth > el.clientWidth + 1)
         out.libraryHasFormat = Boolean(pick('.main-view .track-head .col-format'))
         press(rowFor('Selftest Tone'))
         await sleep(300)
         const addButton = buttonWith('.selection-bar', 'Add to playlist')
         out.menuOpened = Boolean(addButton)
         out.hasRemoveFromLibrary = Boolean(buttonWith('.selection-bar', 'Remove from library'))
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
         out.legacyFooters = pickAll('.table-footnote').length

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

         // --- the index is resizable: a pointer drag, then two arrow keys.
         // Below 1040 CSS pixels the layout stacks and the splitter is display:none
         // (styles.css), so there is no two-column width to drag. Assert the
         // collapse instead: a drag that cannot happen is not a failure.
         const splitter = pick('.playlist-splitter')
         const layoutPane = pick('.playlists-layout')
         const indexPane = pick('.playlist-index')
         out.layoutWidth = layoutPane ? Math.round(layoutPane.getBoundingClientRect().width) : -1
         out.viewportWidth = window.innerWidth
         out.twoPanes = out.viewportWidth >= 1040
         out.splitterHidden = Boolean(splitter) && getComputedStyle(splitter).display === 'none'
         out.indexFullWidth =
           Boolean(indexPane) &&
           Boolean(layoutPane) &&
           Math.abs(indexPane.getBoundingClientRect().width - layoutPane.getBoundingClientRect().width) < 2

         const indexBox = () => (indexPane ? Math.round(indexPane.getBoundingClientRect().width) : -1)
         const beforeDrag = indexBox()
         if (splitter && out.twoPanes) {
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
         if (splitter && out.twoPanes) {
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

         // --- remove one row through its row menu
         const secondRow = pickAll('.track-row')[1]
         press(secondRow ? secondRow.querySelector('button[title="More actions"]') : null)
         await sleep(250)
         press(pickAll('.row-menu .context-item').find((el) => text(el).trim() === 'Remove from playlist'))
         await sleep(600)
         out.rowsAfterRemove = titles().length

         // --- play the playlist
         press(buttonWith('.playlist-pane-head', 'Play'))
         await sleep(800)
         out.playedTitle = barTitle()

         // --- rename it from the index row's menu
         press(pick('.playlist-row .playlist-row-menu'))
         await sleep(250)
         press(pickAll('.row-menu .context-item').find((el) => text(el).trim() === 'Rename'))
         await sleep(300)
         setInput(pick('.playlist-rename .playlist-input'), 'Selftest Renamed')
         await sleep(150)
         press(pick('.playlist-rename button[type="submit"]'))
         await sleep(500)
         out.renamed = text(pick('.playlist-name'))

         // --- save the queue as a playlist from the player window
         nav('Library')
         await sleep(400)
         const menuRow = rowFor('Selftest Tone')
         press(menuRow ? menuRow.querySelector('button[title="More actions"]') : null)
         await sleep(350)
         const rowMenu = pick('.context-menu')
         const detailsItem = rowMenu
           ? [...rowMenu.querySelectorAll('.context-item')].find((el) => text(el).indexOf('Details') >= 0)
           : null
         out.detailsMenu = Boolean(detailsItem)
         press(detailsItem)
         await sleep(300)
         const dialog = pick('.details-dialog')
         out.detailsOpen = Boolean(dialog)
         out.detailsTitle = dialog ? text(pick('.details-titles h2')).trim() : ''
         out.detailsHasFormat = dialog
           ? [...dialog.querySelectorAll('dt')].some((el) => text(el).trim() === 'Format')
           : false
         press(dialog ? dialog.querySelector('.details-close') : null)
         await sleep(250)
         out.detailsClosed = !pick('.details-dialog')
         const toneRow = rowFor('Selftest Tone')
         if (toneRow) toneRow.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
         await sleep(700)
         press(pick('.player-track'))
         await sleep(700)
         press(pick('.np-queue'))
         await sleep(500)
         press(pick('.np-queue-panel .queue-actions-trigger'))
         await sleep(300)
         const actionsMenu = pick('.queue-actions-menu')
         out.queueMenuOpened = Boolean(actionsMenu)
         press(
           pickAll('.queue-actions-menu button').find(
             (el) => text(el).trim().indexOf('Save as playlist') === 0
           )
         )
         await sleep(350)
         const queueMenu = pick('.add-to-playlist')
         out.queueMenuOpened = out.queueMenuOpened && Boolean(queueMenu)
         press(menuItem('.add-to-playlist', 'Selftest Renamed'))
         await sleep(500)
         out.queueStatus = text(pick('.add-to-playlist .atp-status')).trim()
         press(pick('.np-close'))
         await sleep(600)
         nav('Playlists')
         await sleep(500)
         out.countAfterQueueSave = countInIndex()

         // --- delete it (the menu asks once, then confirms in place)
         press(pick('.playlist-row .playlist-row-menu'))
         await sleep(250)
         press(pickAll('.row-menu .context-item').find((el) => text(el).trim() === 'Delete playlist'))
         await sleep(250)
         press(
           pickAll('.row-menu .context-item').find((el) => text(el).trim().indexOf('Delete playlist?') === 0)
         )
         await sleep(700)
         out.deleted = !pick('.playlist-row')
         out.emptyAfterDelete = text(pick('.empty-state h2')) === 'No playlists yet'
         return out
       })()`
    )

    record(lists.emptyState, 'the Playlists view starts with an empty state')
    record(lists.created, 'a playlist can be created from the form', lists.created)
    record(lists.hasImport, 'the Playlists view offers file import')
    record(lists.hasExport, 'a selected playlist offers file export')
    record(lists.sidebarCount === '1', 'the sidebar counts the playlists', lists.sidebarCount)
    record(lists.menuOpened && lists.addedViaBar, 'the selection bar adds the selected tracks to a playlist', lists.barStatus)
    record(
      lists.hasRemoveFromLibrary,
      'the selection bar can remove tracks from the library without deleting files'
    )
    record(lists.contextMenuOpened && lists.addedViaContext, 'a row’s context menu adds that track to a playlist', lists.contextStatus)
    record(
      lists.countAfterAdds === 2 && lists.rowsAfterAdds === 2,
      'the playlist lists what was added, in the order it was added',
      `${lists.countAfterAdds} in the index, ${lists.rowsAfterAdds} rows`
    )
    record(
      lists.legacyFooters === 0,
      'the playlist list has no persistent footer below its rows',
      `${lists.legacyFooters} footers`
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
      lists.libraryColumns === '# | Title | Artist | Album | Duration | Actions' &&
        !lists.libraryHasFormat &&
        !lists.libraryHeaderOverflow,
      'the library columns are #, Title, Artist, Album and Duration, with an action button',
      `${lists.libraryColumns || 'none'}${lists.libraryHasFormat ? ' (format still shown)' : ''}`
    )
    record(
      !lists.formatVisible && lists.artistWidth > 100,
      'a playlist keeps the artist and drops the format column too',
      `format ${lists.formatVisible}, artist ${lists.artistWidth}px`
    )
    record(
      lists.twoPanes ? lists.indexDragged >= 50 : lists.splitterHidden,
      'the splitter resizes the index when two panes fit, and is hidden when they do not',
      lists.twoPanes
        ? `moved ${lists.indexDragged}px (before ${lists.indexBefore}, layout ${lists.layoutWidth}, viewport ${lists.viewportWidth})`
        : `${lists.splitterHidden ? 'hidden' : 'visible'} at a ${lists.viewportWidth}px viewport`
    )
    record(
      lists.twoPanes ? lists.indexKeyboardDelta === -32 : lists.indexFullWidth,
      'arrow keys step the index by 16px each, or a narrow window stacks it above the list',
      lists.twoPanes
        ? `moved ${lists.indexKeyboardDelta}px`
        : `index ${lists.indexBefore}px of ${lists.layoutWidth}px`
    )
    record(
      lists.twoPanes
        ? container.settings.get().playlists.indexWidth ===
          lists.indexBefore + lists.indexDragged + lists.indexKeyboardDelta
        : container.settings.get().playlists.indexWidth === widthBeforeSplitter,
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
    record(lists.detailsMenu, 'the row menu offers Details')
    record(
      lists.detailsOpen &&
        lists.detailsTitle === 'Selftest Tone' &&
        lists.detailsHasFormat &&
        lists.detailsClosed,
      'Details shows the format and the technical sheet, then closes',
      `${lists.detailsTitle || 'no title'} · format ${lists.detailsHasFormat} · closed ${lists.detailsClosed}`
    )
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
      'online lists: an imported album is seeded as an imported playlist',
      container.onlinePlaylists.count()
    )

    // ---- 14b. the YouTube view ------------------------------------------
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
      artistScrolls: boolean
      firstChannel: string
      firstDuration: string
      sidebarCount: string
      rowCovers: number
      rowCoverLoaded: boolean
      rowPlaceholders: number
      pasteFilled: string
      pasteMenuVisible: boolean
      pasteMenuItems: string
      pasteMenuFilled: string
      pasteMenuClosed: boolean
      historyScrolls: boolean
      playDisabled: boolean
      invalidError: string
      refusedError: string
      refusedPending: number
      pendingRows: number
      menuItems: string
      selectionActions: string
      selectionCount: string
      selectedRows: number
      ctrlSelectedRows: number
      rowCheckboxes: number
      selectAllChecked: boolean
      selectedMenuItems: string
      selectionCleared: boolean
      saveEnabled: boolean
      rowSaveButtons: number
      copiedLink: string
      removedRows: number
      clearedRows: number
      emptyAfterClear: boolean
    }>(
      window,
      `(async () => {
         const out = { rows: 0, firstTitle: '', firstArtist: '', artistScrolls: false, firstChannel: '', firstDuration: '', sidebarCount: '', rowCovers: 0, rowCoverLoaded: false, rowPlaceholders: 0, pasteFilled: '', pasteMenuVisible: false, pasteMenuItems: '', pasteMenuFilled: '', pasteMenuClosed: false, historyScrolls: false, playDisabled: false, invalidError: '', refusedError: '', refusedPending: 0, pendingRows: 0, menuItems: '', selectionActions: '', selectionCount: '', selectedRows: 0, ctrlSelectedRows: 0, rowCheckboxes: 0, selectAllChecked: false, selectedMenuItems: '', selectionCleared: false, saveEnabled: false, rowSaveButtons: 0, copiedLink: '', removedRows: -1, clearedRows: -1, emptyAfterClear: false }
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
         nav('YouTube')
         await sleep(600)

         out.rows = pickAll('.online-item').length
         out.firstTitle = text(pick('.online-title')).trim()
         out.firstArtist = text(pick('.online-artist')).trim()
         out.artistScrolls = Boolean(pick('.online-artist')?.classList.contains('is-overflowing'))
         out.firstChannel = text(pick('.online-channel')).trim()
         out.firstDuration = text(pick('.online-time')).trim()
         const onlineNav = pickAll('.nav-item').find((el) => (el.textContent || '').trim().startsWith('YouTube'))
         out.sidebarCount = text(onlineNav ? onlineNav.querySelector('.nav-count') : null).trim()

         // A row draws the cover already on its entry; one with no cover resolves
         // it through the negative-id artwork lookup. The image only counts once
         // the browser has actually decoded it.
         const covers = () => pickAll('.online-art[data-artwork="ready"]')
         for (let i = 0; i < 20 && covers().length === 0; i += 1) await sleep(150)
         out.rowCovers = covers().length
         out.rowCoverLoaded = covers().length > 0 && covers()[0].naturalWidth > 0
         out.rowPlaceholders = pickAll('.online-art[data-artwork="none"]').length

         // The history is a window, not the whole log: seven rows stay in view
         // and the wheel reaches the rest. The imported box does the same with
         // three; that check lives in the imported-list section.
         const historyList = pick('.online-list')
         const historyStyle = historyList ? getComputedStyle(historyList) : null
         out.historyScrolls = Boolean(
           historyStyle && historyStyle.overflowY === 'auto' && parseFloat(historyStyle.maxHeight) >= 300
         )

         const play = buttonWith('Play now')
         out.playDisabled = Boolean(play && play.disabled)

         // The Paste button reads the real system clipboard through the bridge.
         press(pick('.online-paste'))
         await sleep(500)
         out.pasteFilled = (pick('.online-input input') || {}).value || ''

         // Right-clicking the field offers the same clipboard read. The menu is
         // the app's own, so the native menu cannot be the only way to paste.
         setInput(pick('.online-input input'), '')
         await sleep(150)
         const field = pick('.online-input input')
         if (field) field.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 180, clientY: 180 }))
         await sleep(300)
         const fieldMenu = pick('.field-menu')
         out.pasteMenuVisible = Boolean(fieldMenu)
         out.pasteMenuItems = fieldMenu
           ? pickAll('.field-menu .context-item').map((el) => text(el).trim()).join(' | ')
           : ''
         press(
           fieldMenu
             ? pickAll('.field-menu .context-item').find((el) => text(el).trim() === 'Paste')
             : null
         )
         await sleep(600)
         out.pasteMenuFilled = (pick('.online-input input') || {}).value || ''
         out.pasteMenuClosed = !pick('.field-menu')

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

         // Right-click a row: Select, Copy and Save live in the menu. Every row
         // also carries its own save button, so a row can be kept without a menu.
         out.rowSaveButtons = pickAll('.online-actions button[aria-label^="Save"]').length
         const jump = pick('.online-jump')
         if (jump) jump.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 260, clientY: 260 }))
         await sleep(250)
         const items = pickAll('.context-menu .context-item')
         out.menuItems = items.map((el) => text(el).trim()).join(' | ')

         // A menu entry enters selection mode; Shift-click then extends the
         // range to the third link. The section head's # checkbox turns into a
         // select-all checkbox and shows the all-selected state.
         press(items.find((el) => text(el).trim() === 'Select'))
         await sleep(300)
         const selectionBar = pick('.online-selection-bar')
         out.selectionActions = selectionBar
           ? pickAll('.online-selection-bar button').map((el) => text(el).trim()).join(' | ')
           : ''
         out.selectionCount = text(selectionBar ? selectionBar.querySelector('span') : null).trim()
         out.selectedRows = pickAll('.online-item.selected').length
         out.rowCheckboxes = pickAll('.online-select input').length
         const jumps = pickAll('.online-jump')
         if (jumps[1]) jumps[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
         await sleep(250)
         out.ctrlSelectedRows = pickAll('.online-item.selected').length

         // Restart from one row so Shift-click can extend to the whole list.
         press(pick('.online-selection-bar .selection-clear'))
         await sleep(250)
         if (jump) jump.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 260, clientY: 260 }))
         await sleep(200)
         press(pickAll('.context-menu .context-item').find((el) => text(el).trim() === 'Select'))
         await sleep(250)
         if (jumps[2]) jumps[2].dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }))
         await sleep(300)
         out.selectedRows = pickAll('.online-item.selected').length
         out.selectionCount = text(pick('.online-selection-bar > span')).trim()
         const selectAllBox = pick('.online-head-select input')
         out.selectAllChecked = Boolean(selectAllBox && selectAllBox.checked)

         // With rows selected the row menu offers the selection actions too.
         if (jump) jump.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 260, clientY: 260 }))
         await sleep(250)
         const selectedItems = pickAll('.context-menu .context-item')
         out.selectedMenuItems = selectedItems.map((el) => text(el).trim()).join(' | ')
         const save = selectedItems.find((el) => text(el).indexOf('Save to library') === 0)
         out.saveEnabled = Boolean(save && !save.disabled)
         press(selectedItems.find((el) => text(el).trim() === 'Copy link'))
         await sleep(300)
         // Read it back now. The system clipboard is global, and later steps or
         // another program could overwrite it before the assertion at the end.
         out.copiedLink = await window.player.readClipboardText()

         // The now-checked # checkbox is the way out of selection mode.
         const clearAll = pick('.online-head-select input')
         if (clearAll) clearAll.click()
         await sleep(300)
         out.selectionCleared =
           !pick('.online-selection-bar') &&
           pickAll('.online-item.selected').length === 0 &&
           pickAll('.online-select input').length === 0

         // Remove lives in the row menu now: the row keeps only Save, Queue and
         // the menu button. Remove one row, then clear the rest.
         press(pickAll('.online-item button[aria-label^="More actions"]')[0])
         await sleep(250)
         const removeItem = pickAll('.context-menu .context-item').find(
           (el) => text(el).trim() === 'Remove from history'
         )
         press(removeItem)
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
    record(onlineView.rows === 3, 'the YouTube view lists the remembered links', onlineView.rows)
    record(onlineView.firstTitle.indexOf('Online Tone Two') === 0, 'the newest link is listed first', onlineView.firstTitle)
    record(
      onlineView.firstChannel === 'Selftest Streamer',
      'the YouTube view labels the uploader as a channel',
      onlineView.firstChannel
    )
    record(
      onlineView.firstArtist === 'Selftest Artist With A Deliberately Long Name' && onlineView.artistScrolls,
      'the YouTube view shows a separate artist and marks a long name for hover scrolling',
      `${onlineView.firstArtist} / scrolls ${onlineView.artistScrolls}`
    )
    record(onlineView.firstDuration === '1:30', 'the YouTube view shows the duration', onlineView.firstDuration)
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
      onlineView.historyScrolls,
      'the link history keeps seven rows in view and scrolls for the rest',
      `scrolls ${onlineView.historyScrolls}`
    )
    record(
      onlineView.pasteMenuVisible &&
        onlineView.pasteMenuItems.indexOf('Paste') >= 0 &&
        onlineView.pasteMenuFilled === 'https://www.youtube.com/watch?v=selftestaa1' &&
        onlineView.pasteMenuClosed,
      'right-clicking the link field offers Paste and fills it',
      `${onlineView.pasteMenuVisible ? 'menu' : 'no menu'} (${onlineView.pasteMenuItems || 'empty'}): ${onlineView.pasteMenuFilled || 'not filled'}`
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
      onlineView.menuItems.indexOf('Select') === 0 &&
        onlineView.menuItems.includes('Play') &&
        onlineView.menuItems.includes('Add to queue') &&
        onlineView.menuItems.includes('Save to library') &&
        onlineView.menuItems.includes('Copy link') &&
        onlineView.menuItems.includes('Remove from history'),
      'a right-click menu offers Select and the row actions',
      onlineView.menuItems
    )
    record(
      onlineView.selectionActions === 'Play selected | Add to queue | Clear' &&
        onlineView.ctrlSelectedRows === 2 &&
        onlineView.selectionCount.startsWith('3 selected') &&
        onlineView.selectedRows === 3 &&
        onlineView.rowCheckboxes === 3 &&
        onlineView.selectAllChecked,
      'YouTube links select with a menu entry, Ctrl/Shift-click and a select-all checkbox',
      `Ctrl ${onlineView.ctrlSelectedRows}, Shift ${onlineView.selectedRows}; ${onlineView.selectionActions}; ${onlineView.selectionCount}`
    )
    record(
      onlineView.selectedMenuItems.indexOf('Deselect') === 0 &&
        onlineView.selectedMenuItems.includes('Play selected') &&
        onlineView.selectedMenuItems.includes('Queue selected'),
      'a selected YouTube link menu offers the selection actions',
      onlineView.selectedMenuItems
    )
    record(
      onlineView.selectionCleared,
      'the select-all checkbox clears the YouTube selection',
      `cleared ${onlineView.selectionCleared}`
    )
    record(
      onlineView.saveEnabled && onlineView.rowSaveButtons === 3,
      'every history row offers a working save action',
      `menu enabled ${onlineView.saveEnabled}, ${onlineView.rowSaveButtons} row buttons`
    )
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
      hasSaveAll: boolean
      rowSaveButtons: number
      rowRevealButtons: number
      indexCount: string
      rowsAfterRemove: number
      playedTitle: string
      hasCover: boolean
      playingCard: boolean
      separateStrip: boolean
      playingCardAfterTrip: boolean
      onlineCardCover: boolean
      importedScrolls: boolean
      cardsAfterDelete: number
      groupEmpty: boolean
      emptyAfterDelete: boolean
      hasListId: boolean
      reimportCount: string
      renamedTitle: string
      renamedIndex: string
      onlineCards: number
      onlineCardTitle: string
      onlineCardMeta: string
      historyRows: number
      channelColumnHidden: boolean
      channelTimeAligned: boolean
      channelActionsAligned: boolean
      channelTimeFits: boolean
      channelTimeOffset: number
      channelScrollbarWidth: number
    }>(
      window,
      `(async () => {
         const out = { groupTitles: '', onlineRows: -1, kind: '', paneTitle: '', titles: '', note: '', hasReimport: false, hasClear: false, hasSaveAll: false, rowSaveButtons: 0, rowRevealButtons: 0, indexCount: '', rowsAfterRemove: -1, playedTitle: '', hasCover: false, playingCard: false, separateStrip: false, playingCardAfterTrip: false, onlineCardCover: false, importedScrolls: false, cardsAfterDelete: -1, groupEmpty: false, emptyAfterDelete: false, hasListId: false, reimportCount: '', renamedTitle: '', renamedIndex: '', onlineCards: -1, onlineCardTitle: '', onlineCardMeta: '', historyRows: -1, channelColumnHidden: false, channelTimeAligned: false, channelActionsAligned: false, channelTimeFits: false, channelTimeOffset: -99, channelScrollbarWidth: -1 }
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
         const pick = (s) => document.querySelector(s)
         const pickAll = (s) => [...document.querySelectorAll(s)]
         const press = (el) => { if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
         const text = (el) => ((el || {}).textContent || '')
         const setInput = (el, value) => {
           if (!el) return false
           const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')
           desc.set.call(el, value)
           el.dispatchEvent(new Event('input', { bubbles: true }))
           return true
         }
         const nav = (label) => {
           const b = pickAll('.nav-item').find((el) => (el.textContent || '').trim().startsWith(label))
           if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
           return Boolean(b)
         }
         const onlineGroup = () => pickAll('.playlist-group').find((el) => el.getAttribute('aria-label') === 'Imported playlists')

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
         out.hasCover = Boolean(pick('.playlist-pane-head .playlist-cover'))
         const buttons = pickAll('.playlist-pane-head button')
         out.hasReimport = buttons.some((el) => text(el).trim().indexOf('Re-import') === 0)
         out.hasClear = buttons.some((el) => text(el).trim().indexOf('Clear') === 0)
         out.hasSaveAll = buttons.some((el) => text(el).trim().indexOf('Save all') === 0)
         out.rowSaveButtons = pickAll('.track-row button[aria-label^="Save"]').length
         out.rowRevealButtons = pickAll('.track-row button[title="Show in folder"]').length
         out.hasListId = text(pick('.playlist-source-id')).trim().length > 0
         out.reimportCount = pick('.reimport-count input') ? pick('.reimport-count input').value : ''

         // Rename the snapshot from the index. The name is stored apart from the
         // YouTube title, so a later Re-import cannot silently undo it.
         press(pick('.playlist-row.online .playlist-row-menu'))
         await sleep(250)
         press(pickAll('.row-menu .context-item').find((el) => text(el).trim() === 'Rename'))
         await sleep(300)
         setInput(pick('.playlist-row.online .playlist-rename input'), 'Selftest Album Renamed')
         await sleep(150)
         press(pick('.playlist-row.online .playlist-rename button[type="submit"]'))
         await sleep(600)
         out.renamedTitle = text(pick('.playlist-pane-head h2')).trim()
         out.renamedIndex = text(pick('.playlist-row.online .playlist-title')).trim()

         press(pick('.track-row button[title="More actions"]'))
         await sleep(250)
         press(
           pickAll('.row-menu .context-item').find(
             (el) => text(el).trim() === 'Remove from this playlist'
           )
         )
         await sleep(700)
         out.rowsAfterRemove = pickAll('.track-row').length
         const groupAfter = onlineGroup()
         out.indexCount = text(groupAfter ? groupAfter.querySelector('.playlist-count') : null).trim()

         // The imported-playlist half of the hidden-column regression: turning
         // Channel off must leave Duration on the header's track and Actions on
         // the row's right edge, not slide them into one another.
         const rect = (el) => (el ? el.getBoundingClientRect() : null)
         const toggleChannel = async (on) => {
           nav('Settings')
           await sleep(300)
           const appearanceTab = pickAll('.settings-tab').find((el) => text(el).trim() === 'Appearance')
           press(appearanceTab)
           await sleep(200)
           const toggle = pick('[data-channel-column-toggle]')
           if (toggle && toggle.checked !== on) {
             press(toggle)
             await sleep(450)
           }
         }
         await toggleChannel(false)
         nav('Playlists')
         await sleep(700)
         const hiddenChannel = pick('.track-row .col-artist')
         const channelTime = pick('.track-row .col-time')
         const channelHeadTime = pick('.track-head .col-time')
         const channelActions = pick('.track-row .col-actions')
         const channelRow = pick('.track-row')
         const channelTimeRect = rect(channelTime)
         const channelHeadTimeRect = rect(channelHeadTime)
         const channelActionsRect = rect(channelActions)
         const channelRowRect = rect(channelRow)
         const channelScroller = channelRow ? channelRow.closest('.list-scroll') : null
         out.channelTimeOffset =
           channelTimeRect && channelHeadTimeRect
             ? Math.round((channelTimeRect.left - channelHeadTimeRect.left) * 10) / 10
             : -99
         out.channelScrollbarWidth = channelScroller
           ? channelScroller.offsetWidth - channelScroller.clientWidth
           : -1
         out.channelColumnHidden = Boolean(hiddenChannel && getComputedStyle(hiddenChannel).display === 'none')
         out.channelTimeAligned = Boolean(
           channelTimeRect && channelHeadTimeRect && Math.abs(channelTimeRect.left - channelHeadTimeRect.left) <= 1
         )
         out.channelActionsAligned = Boolean(
           channelActionsRect && channelRowRect && Math.abs(channelActionsRect.right - channelRowRect.right) <= 1
         )
         out.channelTimeFits = Boolean(channelTime && channelTime.scrollWidth <= channelTime.clientWidth + 1)
         await toggleChannel(true)
         nav('Playlists')
         await sleep(700)

         press(pickAll('.playlist-pane-head button').find((el) => text(el).trim().indexOf('Play') === 0))
         await sleep(900)
         out.playedTitle = text(pick('.player-title'))

         // The YouTube view gets one card for the imported list, not a row per
         // track: the history is for links the user chose to play on their own.
         nav('YouTube')
         await sleep(800)
         out.onlineCards = pickAll('.online-imported-row').length
         out.onlineCardTitle = text(pick('.online-imported-title')).trim()
         out.onlineCardMeta = text(pick('.online-imported-meta')).trim()
         out.historyRows = pickAll('.online-item').length
         out.playingCard = Boolean(pick('.online-imported-row.current'))
         out.separateStrip = Boolean(pick('.playing-banner'))
         out.onlineCardCover = Boolean(
           pick('.online-imported-row.current .online-imported-art[data-artwork="ready"]')
         )
         const importedList = pick('.online-imported-list')
         const importedStyle = importedList ? getComputedStyle(importedList) : null
         out.importedScrolls = Boolean(
           importedStyle && importedStyle.overflowY === 'auto' && parseFloat(importedStyle.maxHeight) >= 150
         )

         // The mark belongs to the app state, not to the YouTube view: a round
         // trip must leave the same card marked when the view comes back.
         nav('Playlists')
         await sleep(500)
         nav('YouTube')
         await sleep(700)
         out.playingCardAfterTrip = Boolean(pick('.online-imported-row.current'))
         nav('Playlists')
         await sleep(700)

         const arm = pickAll('.playlist-pane-head .link-button').find((el) => text(el).trim().indexOf('Remove') === 0)
         press(arm)
         await sleep(250)
         const confirm = pickAll('.playlist-pane-head .link-button').find((el) => text(el).trim().indexOf('Remove') === 0)
         press(confirm)
         await sleep(800)
         const groupGone = onlineGroup()
         out.groupEmpty = Boolean(groupGone) && groupGone.querySelectorAll('.playlist-row').length === 0
         out.emptyAfterDelete = text(pick('.empty-state h2')).trim() === 'No playlists yet'

         // The card is the only place the playing list is named, so deleting the
         // snapshot removes the card too; the player bar still knows the queue.
         nav('YouTube')
         await sleep(700)
         out.cardsAfterDelete = pickAll('.online-imported-row').length
         return out
       })()`
    )

    record(onlineLists.groupTitles === 'Custom | Imported', 'the Playlists index separates Custom from Imported', onlineLists.groupTitles)
    record(onlineLists.onlineRows === 1, 'the imported album appears in the Imported group', onlineLists.onlineRows)
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
      onlineLists.hasListId && onlineLists.reimportCount === '2',
      'the imported list shows its YouTube id and a track count beside Re-import',
      `list id ${onlineLists.hasListId}, count ${onlineLists.reimportCount || 'empty'}`
    )
    record(
      onlineLists.renamedTitle === 'Selftest Album Renamed' &&
        onlineLists.renamedIndex === 'Selftest Album Renamed',
      'an imported playlist can be renamed from its index row',
      `${onlineLists.renamedIndex} / title ${onlineLists.renamedTitle}`
    )
    record(
      onlineLists.hasSaveAll && onlineLists.rowSaveButtons === 2 && onlineLists.rowRevealButtons === 0,
      'imported entries can be saved one by one or all at once',
      `save all ${onlineLists.hasSaveAll}, ${onlineLists.rowSaveButtons} row buttons, ${onlineLists.rowRevealButtons} reveal buttons`
    )
    record(
      onlineLists.rowsAfterRemove === 1 && onlineLists.indexCount === '1',
      'removing an imported entry updates the snapshot and the index count',
      `${onlineLists.rowsAfterRemove} rows, index ${onlineLists.indexCount}`
    )
    record(
      onlineLists.channelColumnHidden &&
        onlineLists.channelTimeAligned &&
        onlineLists.channelActionsAligned &&
        onlineLists.channelTimeFits,
      'an imported playlist keeps Duration and Actions in place when Channel is hidden',
      onlineLists
    )
    record(
      onlineLists.playedTitle === 'Online Tone Two',
      'playing an imported album queues its remaining tracks, not the history',
      onlineLists.playedTitle
    )
    record(
      onlineLists.hasCover,
      'the opened list shows a cover beside its title',
      `cover ${onlineLists.hasCover}`
    )
    record(
      container.onlineRepo.count() === 0,
      'playing an imported entry does not echo it into the YouTube history',
      container.onlineRepo.count()
    )
    record(
      onlineLists.onlineCards === 1 &&
        onlineLists.onlineCardTitle === 'Selftest Album Renamed' &&
        onlineLists.historyRows === 0 &&
        onlineLists.onlineCardCover,
      'the YouTube view lists the imported playlist once, with its cover and no history tracks',
      `${onlineLists.onlineCards} card(s): ${onlineLists.onlineCardTitle || 'none'} (${onlineLists.onlineCardMeta || 'no meta'}); cover ${onlineLists.onlineCardCover}; ${onlineLists.historyRows} history rows`
    )
    record(
      onlineLists.playingCard &&
        !onlineLists.separateStrip &&
        (onlineLists.onlineCardMeta.indexOf('Playing') === 0 ||
          onlineLists.onlineCardMeta.indexOf('Paused') === 0),
      'the playing list is marked on its own card, not in a separate strip',
      `card ${onlineLists.playingCard}, strip ${onlineLists.separateStrip}, meta ${onlineLists.onlineCardMeta || 'none'}`
    )
    record(
      onlineLists.onlineCardMeta.includes('Online Tone Two') &&
        onlineLists.onlineCardMeta.includes('1 / 1'),
      'the card names the track the list is on and its position',
      onlineLists.onlineCardMeta
    )
    record(
      onlineLists.playingCardAfterTrip,
      'the playing mark survives a trip to another view',
      `marked ${onlineLists.playingCardAfterTrip}`
    )
    record(
      onlineLists.importedScrolls,
      'the imported list keeps three recent cards in view and scrolls for the rest',
      `scrolls ${onlineLists.importedScrolls}`
    )
    record(
      onlineLists.cardsAfterDelete === 0,
      'deleting the imported snapshot removes its card',
      `${onlineLists.cardsAfterDelete} card(s) after delete`
    )
    record(
      onlineLists.groupEmpty && onlineLists.emptyAfterDelete,
      'removing the imported album needs a confirmation and leaves an empty index',
      `group empty ${onlineLists.groupEmpty}, empty state ${onlineLists.emptyAfterDelete}`
    )
    const copiedLink = onlineView.copiedLink
    record(
      copiedLink === 'https://www.youtube.com/watch?v=selftestbb2',
      'Copy link puts the canonical URL on the clipboard',
      copiedLink
    )

    // ---- 15b. the Home shelves after imports and streams ----------------
    // Three things the shelves used to omit: an imported list (the Playlists
    // shelf only knew custom ones), a YouTube listen (no `tracks` row exists),
    // and a newly added file with no album tag (Recently added was album-only).
    // This seeds each in the way the app writes it, visits Home once, and then
    // puts the fixtures back so the restart section starts where it expects.
    const shelfSeed = Date.now()
    const shelfPlaylist = container.onlinePlaylists.upsert(
      {
        listId: 'OLAK5uy_shelftest',
        kind: 'album',
        title: 'Shelf Test Album',
        owner: 'Shelf Streamer',
        sourceUrl: 'https://www.youtube.com/playlist?list=OLAK5uy_shelftest',
        coverKey: null,
        totalCount: 2
      },
      [
        {
          videoId: 'shelftest01',
          title: 'Shelf Test Stream',
          artist: 'Shelf Streamer',
          album: 'Shelf Test Album',
          durationMs: 120_000
        },
        {
          videoId: 'shelftest02',
          title: 'Shelf Test Second',
          artist: 'Shelf Streamer',
          album: 'Shelf Test Album',
          durationMs: 90_000
        }
      ],
      shelfSeed
    )
    // Enough imported lists that the Playlists shelf has to scroll at the
    // selftest window width, so the arrows have a direction to offer.
    const shelfExtras = Array.from({ length: 7 }, (_, index) => {
      const n = index + 1
      return container.onlinePlaylists.upsert(
        {
          listId: `OLAK5uy_shelfextra${n}`,
          kind: 'playlist',
          title: `Shelf Extra ${n}`,
          owner: 'Shelf Streamer',
          sourceUrl: `https://www.youtube.com/playlist?list=OLAK5uy_shelfextra${n}`,
          coverKey: null,
          totalCount: 1
        },
        [
          {
            videoId: `shelfextra0${n}`,
            title: `Shelf Extra Track ${n}`,
            artist: 'Shelf Streamer',
            album: null,
            durationMs: 60_000
          }
        ],
        shelfSeed + n
      )
    })
    const shelfHistory = container.onlineRepo.upsert(
      {
        videoId: 'shelftest03',
        title: 'Shelf Test Stream',
        artist: 'Shelf Streamer',
        channel: 'Shelf Streamer',
        album: null,
        durationMs: 120_000,
        sourceUrl: youtubeWatchUrl('shelftest03'),
        artworkKey: null
      },
      shelfSeed
    )
    const streamPlaysBefore = container.streamPlays.count()
    // The history row is what a pasted link produces; reporting a counted listen
    // for it is the same call the player makes when the threshold is crossed.
    container.online.recordStreamPlay(-shelfHistory.id)
    const shelfSingleId = container.repo.insert(
      {
        contentKey: 'selftest-shelf-single',
        sourceKind: 'local',
        sourceId: null,
        originKind: null,
        originId: null,
        title: 'Shelf Test Single',
        artist: 'Shelf Shelf Artist',
        albumArtist: null,
        album: null,
        trackNo: null,
        discNo: null,
        trackTotal: null,
        discTotal: null,
        year: null,
        genre: null,
        durationMs: 150_000,
        codec: 'flac',
        bitrateKbps: null,
        sampleRate: null,
        channels: null,
        fileSize: null,
        fileMtimeMs: null,
        filePath: null
      },
      shelfSeed
    )
    const shelfAlbumId = container.repo.insert(
      {
        contentKey: 'selftest-shelf-album',
        sourceKind: 'local',
        sourceId: null,
        originKind: null,
        originId: null,
        title: 'Shelf Test Album Single',
        artist: 'Shelf Album Artist',
        albumArtist: null,
        album: 'Shelf Test Single Album',
        trackNo: 1,
        discNo: null,
        trackTotal: null,
        discTotal: null,
        year: null,
        genre: null,
        durationMs: 140_000,
        codec: 'flac',
        bitrateKbps: null,
        sampleRate: null,
        channels: null,
        fileSize: null,
        fileMtimeMs: null,
        filePath: null
      },
      shelfSeed + 1
    )
    // A real two-track album keeps the detail page covered: the single above
    // proves the play-on-click rule, this one proves a release still opens.
    const shelfMultiOneId = container.repo.insert(
      {
        contentKey: 'selftest-shelf-multi-one',
        sourceKind: 'local',
        sourceId: null,
        originKind: null,
        originId: null,
        title: 'Shelf Test Multi One',
        artist: 'Shelf Multi Artist',
        albumArtist: null,
        album: 'Shelf Test Multi Album',
        trackNo: 1,
        discNo: null,
        trackTotal: null,
        discTotal: null,
        year: null,
        genre: null,
        durationMs: 130_000,
        codec: 'flac',
        bitrateKbps: null,
        sampleRate: null,
        channels: null,
        fileSize: null,
        fileMtimeMs: null,
        filePath: null
      },
      shelfSeed + 2
    )
    const shelfMultiTwoId = container.repo.insert(
      {
        contentKey: 'selftest-shelf-multi-two',
        sourceKind: 'local',
        sourceId: null,
        originKind: null,
        originId: null,
        title: 'Shelf Test Multi Two',
        artist: 'Shelf Multi Artist',
        albumArtist: null,
        album: 'Shelf Test Multi Album',
        trackNo: 2,
        discNo: null,
        trackTotal: null,
        discTotal: null,
        year: null,
        genre: null,
        durationMs: 110_000,
        codec: 'flac',
        bitrateKbps: null,
        sampleRate: null,
        channels: null,
        fileSize: null,
        fileMtimeMs: null,
        filePath: null
      },
      shelfSeed + 3
    )
    broadcast(IPC_EVENTS.onlineChanged, null)
    broadcast(IPC_EVENTS.playHistoryChanged, null)

    const homeShelves = await evaluate<{
      playlistTitle: string
      playlistMeta: string
      streamTitle: string
      streamMeta: string
      addedTitle: string
      addedMeta: string
      addedInPlayed: boolean
      arrowCount: number
      arrowStartScroll: number
      shelfWidth: number
      shelfContent: number
      arrowStartsDisabled: boolean
      arrowForwardEnabled: boolean
      shelfScrolled: number
      arrowBackEnabled: boolean
      shelfNodeStable: boolean
      artistKicker: string
      artistTitle: string
      artistRows: number
      artistHasSingle: boolean
      artistAlbumColumn: string
      playStarted: boolean
      singleTrackPlayed: boolean
      singleTrackCard: boolean
      multiDetailTitle: string
      multiDetailRows: number
      multiBackWorks: boolean
      openMenuItems: string
      onPlaylists: boolean
      paneTitle: string
      paneRows: number
      allTitles: string
      allBadges: string
      allPlaylistBadge: string
      allLibraryBadge: string
      allHasStreamBadge: boolean
      sourceHeading: string
      badgesInSource: number
      badgesInTitle: number
      streamSaveTitle: string
      localSaveTitle: string
      localMenuButton: boolean
      playedHeading: string
      playedChip: string
      playedBadges: string
      playedHasPlaylistOnly: boolean
      playedCleared: boolean
      playedClearedHeading: string
    }>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const text = (el) => ((el || {}).textContent || '')
         const nav = (label) =>
           [...document.querySelectorAll('.nav-item')].find((el) =>
             text(el).trim().startsWith(label)
           )
         const shelf = (title) =>
           [...document.querySelectorAll('.home-section')].find(
             (section) =>
               text(section.querySelector('.home-section-head h2')).trim() === title
           )
         const trackCard = (title, name) =>
           [...(shelf(title)?.querySelectorAll('.track-card') || [])].find(
             (card) => text(card.querySelector('.album-card-title')).trim() === name
           )
         const onlineCard = (name) =>
           [...document.querySelectorAll('.home-shelf .online-playlist-card')].find(
             (card) => text(card.querySelector('.album-card-title')).trim() === name
           )
         const out = {
           playlistTitle: '', playlistMeta: '', streamTitle: '', streamMeta: '',
           addedTitle: '', addedMeta: '', addedInPlayed: false,
           arrowCount: 0, arrowStartScroll: 0, shelfWidth: 0, shelfContent: 0,
           arrowStartsDisabled: false, arrowForwardEnabled: false,
           shelfScrolled: 0, arrowBackEnabled: false, shelfNodeStable: false,
           artistKicker: '', artistTitle: '', artistRows: 0, artistHasSingle: false,
           artistAlbumColumn: '',
           playStarted: false, singleTrackPlayed: false, singleTrackCard: false,
           multiDetailTitle: '', multiDetailRows: 0, multiBackWorks: false,
           openMenuItems: '',
           onPlaylists: false, paneTitle: '', paneRows: 0,
           allTitles: '', allBadges: '', allPlaylistBadge: '', allLibraryBadge: '',
           allHasStreamBadge: false, sourceHeading: '', badgesInSource: -1,
           badgesInTitle: -1, streamSaveTitle: '', localSaveTitle: '', localMenuButton: false,
           playedHeading: '', playedChip: '',
           playedBadges: '', playedHasPlaylistOnly: false, playedCleared: false,
           playedClearedHeading: ''
         }

         nav('Home')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         const deadline = Date.now() + 8000
         let card = null
         while (Date.now() < deadline) {
           card = onlineCard('Shelf Test Album')
           if (card) break
           await sleep(100)
         }
         out.playlistTitle = text(card?.querySelector('.album-card-title')).trim()
         out.playlistMeta = text(card?.querySelector('.album-card-meta')).trim()

         const stream = trackCard('Recently played', 'Shelf Test Stream')
         out.streamTitle = text(stream?.querySelector('.album-card-title')).trim()
         out.streamMeta = text(stream?.querySelector('.album-card-meta')).trim()

         const added = trackCard('Recently added', 'Shelf Test Single')
         out.addedTitle = text(added?.querySelector('.album-card-title')).trim()
         out.addedMeta = text(added?.querySelector('.album-card-meta')).trim()
         // The single has never been played, so it must not leak onto the
         // played shelf just because both read the same merged shape.
         out.addedInPlayed = Boolean(trackCard('Recently played', 'Shelf Test Single'))

         // One shelf scrolls: the arrows on its heading have to agree with what
         // it can actually do. At the start back is disabled; forward steps the
         // shelf and wakes back in the same gesture.
         // The step is smooth when motion is allowed, and the compositor can
         // pause a smooth scroll while the window is occluded. That would leave
         // correct arrows looking broken, so this one interaction asks for the
         // instant step that reduced motion uses, then puts the setting back:
         // what is under test is the edges and the distance moved, not the
         // easing. Nodes are re-read from the live tree on every check, because
         // a shelf that receives data mid-test is legitimately re-rendered.
         const motionBefore = document.documentElement.dataset.motion
         document.documentElement.dataset.motion = 'reduced'
         try {
           const liveShelf = () => shelf('Playlists')
           const liveScroller = () => liveShelf()?.querySelector('.home-shelf')
           const liveArrows = () => [
             ...(liveShelf()?.querySelectorAll('.home-section-tools .shelf-arrow') || [])
           ]
           out.arrowCount = liveArrows().length
           const startNode = liveScroller()
           out.arrowStartScroll = startNode ? Math.round(startNode.scrollLeft) : -1
           out.shelfWidth = startNode ? Math.round(startNode.clientWidth) : -1
           out.shelfContent = startNode ? Math.round(startNode.scrollWidth) : -1
           const arrowDeadline = Date.now() + 3000
           while (Date.now() < arrowDeadline && liveArrows()[1]?.disabled !== false) await sleep(50)
           out.arrowStartsDisabled = liveArrows()[0]?.disabled === true
           out.arrowForwardEnabled = liveArrows()[1]?.disabled === false
           const scroller = liveScroller()
           const beforeScroll = scroller ? scroller.scrollLeft : 0
           liveArrows()[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
           const scrollDeadline = Date.now() + 2000
           while (Date.now() < scrollDeadline) {
             const node = liveScroller()
             if (!node || Math.abs(node.scrollLeft - beforeScroll) >= 1) break
             await sleep(40)
           }
           // The back arrow re-enables when the shelf's own scroll listener has
           // measured the new position. A window that is occluded can have that
           // event held back, so deliver it explicitly: the listener under test
           // still does the measuring and the state change.
           liveScroller()?.dispatchEvent(new Event('scroll'))
           const backDeadline = Date.now() + 2000
           while (Date.now() < backDeadline && liveArrows()[0]?.disabled !== false) await sleep(40)
           const after = liveScroller()
           out.shelfScrolled = after ? Math.round(after.scrollLeft) : -1
           out.arrowBackEnabled = liveArrows()[0]?.disabled === false
           out.shelfNodeStable = Boolean(scroller && scroller === after)
         } finally {
           if (motionBefore === undefined) delete document.documentElement.dataset.motion
           else document.documentElement.dataset.motion = motionBefore
         }

         // The list below the shelves is one merged feed: seeded playlist entries,
         // the counted stream listen and the new file all have to show up with
         // the badge that says where each row came from. More on Recently played
         // narrows that same list to tracks with a listen and a chip brings back
         // the full feed.
         const rowEls = () => [...document.querySelectorAll('.all-tracks-list .track-row')]
         const titleOf = (row) => text(row.querySelector('.row-title-text')).trim()
         const badgeOf = (row) => text(row.querySelector('.row-badge')).trim()
         const rowFor = (title) => rowEls().find((row) => titleOf(row) === title)
         const feedDeadline = Date.now() + 8000
         while (Date.now() < feedDeadline && !rowFor('Shelf Test Second')) await sleep(100)
         out.allTitles = rowEls().map(titleOf).join('|')
         out.allBadges = rowEls().map(badgeOf).join('|')
         out.allPlaylistBadge = badgeOf(rowFor('Shelf Test Second') || document.createElement('div'))
         out.allLibraryBadge = badgeOf(rowFor('Shelf Test Single') || document.createElement('div'))
         out.sourceHeading = text(
           document.querySelector('.all-tracks-list .track-head .col-source')
         ).trim()
         out.badgesInSource = document.querySelectorAll(
           '.all-tracks-list .track-row .col-source .row-badge'
         ).length
         out.badgesInTitle = document.querySelectorAll(
           '.all-tracks-list .track-row .col-title .row-badge'
         ).length
         const streamRow = rowFor('Shelf Test Stream')
         out.streamSaveTitle =
           streamRow?.querySelector('.col-actions button')?.getAttribute('title') || ''
         const localActionTitles = [
            ...(rowFor('Shelf Test Single')?.querySelectorAll('.col-actions button') || [])
          ].map((button) => button.getAttribute('title') || '')
          out.localSaveTitle = localActionTitles.find((title) => title.startsWith('Save ')) || ''
          out.localMenuButton = localActionTitles.includes('More actions')
         out.allHasStreamBadge = rowEls().some(
           (row) => titleOf(row) === 'Shelf Test Stream' && badgeOf(row) === 'YouTube'
         )

         const morePlayed = [...document.querySelectorAll('.home-more')].find(
           (el) => el.getAttribute('aria-label') === 'More recently played tracks'
         )
         morePlayed?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         const playedDeadline = Date.now() + 8000
         while (Date.now() < playedDeadline) {
           const heading = text(document.querySelector('.all-tracks-head h2')).trim()
           const chip = text(document.querySelector('.all-tracks-chip')).trim()
           if (heading === 'Recently played' && chip.includes('Recently played')) break
           await sleep(100)
         }
         const playedLoadedDeadline = Date.now() + 8000
         while (Date.now() < playedLoadedDeadline && rowFor('Shelf Test Second')) {
           await sleep(100)
         }
         out.playedHeading = text(document.querySelector('.all-tracks-head h2')).trim()
         out.playedChip = text(document.querySelector('.all-tracks-chip')).trim()
         out.playedBadges = rowEls().map(badgeOf).join('|')
         out.playedHasPlaylistOnly = Boolean(rowFor('Shelf Test Second'))
         document
           .querySelector('.all-tracks-chip')
           ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         const feedBackDeadline = Date.now() + 8000
         while (Date.now() < feedBackDeadline) {
           const heading = text(document.querySelector('.all-tracks-head h2')).trim()
           if (heading === 'All tracks' && rowFor('Shelf Test Second')) {
             out.playedCleared = true
             break
           }
           await sleep(100)
         }
         out.playedClearedHeading = text(document.querySelector('.all-tracks-head h2')).trim()

         let artistCard = null
         const artistDeadline = Date.now() + 6000
         while (Date.now() < artistDeadline) {
           artistCard = [...document.querySelectorAll('.artist-card')].find(
             (entry) => text(entry.querySelector('.artist-card-name')).trim() === 'Shelf Shelf Artist'
           )
           if (artistCard) break
           await sleep(100)
         }
         artistCard
           ?.querySelector('.artist-card-main')
           ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         const detailDeadline = Date.now() + 6000
         let detail = null
         while (Date.now() < detailDeadline) {
           detail = document.querySelector('.album-detail')
           if (detail && detail.querySelector('.track-row')) break
           await sleep(100)
         }
         out.artistKicker = text(detail?.querySelector('.home-kicker')).trim()
         out.artistTitle = text(detail?.querySelector('.album-detail-copy h2')).trim()
         out.artistRows = detail?.querySelectorAll('.track-row').length || 0
         out.artistHasSingle = [...(detail?.querySelectorAll('.row-title-text') || [])].some(
           (el) => text(el).trim() === 'Shelf Test Single'
         )
         out.artistAlbumColumn =
           detail?.querySelector('[data-album-column]')?.getAttribute('data-album-column') || ''

         detail?.querySelector('.home-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         const backDeadline = Date.now() + 6000
         while (Date.now() < backDeadline && !document.querySelector('.home-shelf')) await sleep(100)

         // A release with one file is a track, not an album: it appears as a
         // track card and plays on a click, with the track actions in its menu.
         const singleTrack = [...document.querySelectorAll('.home-shelf .track-card')].find(
           (card) => text(card.querySelector('.album-card-title')).trim() === 'Shelf Test Album Single'
         )
         out.singleTrackCard = Boolean(singleTrack)
         singleTrack
           ?.querySelector('.album-card-main')
           ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         const singleDeadline = Date.now() + 6000
         while (Date.now() < singleDeadline) {
           if (text(document.querySelector('.player-title')).trim() === 'Shelf Test Album Single') break
           await sleep(100)
         }
         out.singleTrackPlayed =
           text(document.querySelector('.player-title')).trim() === 'Shelf Test Album Single'
         out.singleTrackCard =
           out.singleTrackCard &&
           ![...document.querySelectorAll('.home-shelf .album-card')].some(
             (card) => text(card.querySelector('.album-card-title')).trim() === 'Shelf Test Single Album'
           )

         // A real album keeps its detail page: two rows, Play and Queue, and a
         // back button that returns to the shelves.
         const multiAlbum = [...document.querySelectorAll('.home-shelf .album-card')].find(
           (card) => text(card.querySelector('.album-card-title')).trim() === 'Shelf Test Multi Album'
         )
         multiAlbum
           ?.querySelector('.album-card-main')
           ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         const multiDeadline = Date.now() + 6000
         let multiDetail = null
         while (Date.now() < multiDeadline) {
           multiDetail = document.querySelector('.album-detail')
           if (multiDetail && multiDetail.querySelectorAll('.track-row').length === 2) break
           await sleep(100)
         }
         out.multiDetailTitle = text(multiDetail?.querySelector('.album-detail-copy h2')).trim()
         out.multiDetailRows = multiDetail?.querySelectorAll('.track-row').length || 0
         multiDetail?.querySelector('.home-back')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         const multiBackDeadline = Date.now() + 6000
         while (Date.now() < multiBackDeadline && !document.querySelector('.home-shelf')) await sleep(100)
         out.multiBackWorks = Boolean(document.querySelector('.home-shelf')) && !multiDetail?.isConnected

         // A card is a play control now: one click queues the list's tracks.
         // The queue length is set synchronously, before any stream resolves,
         // so this does not depend on the engine answering.
         const online = onlineCard('Shelf Test Album')
         online
           ?.querySelector('.album-card-main')
           ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         const queueDeadline = Date.now() + 6000
         while (Date.now() < queueDeadline) {
           const title = document.querySelector('.queue-button')?.getAttribute('title') || ''
           if (title === 'Queue (2)') {
             out.playStarted = true
             break
           }
           await sleep(100)
         }

         // Opening the list for editing is the overflow menu's first item.
         online
           ?.querySelector('.card-overflow')
           ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         const menuDeadline = Date.now() + 3000
         let openItem = null
         while (Date.now() < menuDeadline) {
           openItem = [...document.querySelectorAll('.context-item')].find((el) =>
             text(el).includes('Open in Playlists')
           )
           if (openItem) break
           await sleep(50)
         }
         out.openMenuItems = [...document.querySelectorAll('.context-item')]
           .map((el) => text(el).trim())
           .join('|')
         openItem?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         // The pane is filled by an IPC round trip, so wait for the title rather
         // than assuming one paint.
         const paneDeadline = Date.now() + 6000
         let pane = ''
         while (Date.now() < paneDeadline) {
           pane = text(document.querySelector('.playlist-pane-head h2')).trim()
           if (pane.length > 0) break
           await sleep(100)
         }
         out.onPlaylists = Boolean(document.querySelector('.playlists-view'))
         out.paneTitle = pane
         out.paneRows = document.querySelectorAll('.playlist-pane .track-row').length
         return out
       })()`
    )

    record(
      homeShelves.playlistTitle === 'Shelf Test Album' &&
        homeShelves.playlistMeta.includes('YouTube album') &&
        homeShelves.playlistMeta.includes('2 tracks'),
      'home: an imported playlist appears in the Playlists shelf with its kind and count',
      `${homeShelves.playlistTitle || 'none'} · ${homeShelves.playlistMeta || 'no meta'}`
    )
    record(
      homeShelves.streamTitle === 'Shelf Test Stream' &&
        homeShelves.streamMeta.includes('Shelf Streamer') &&
        homeShelves.streamMeta.includes('YouTube'),
      'home: a YouTube listen appears on Recently played as its own track card',
      `${homeShelves.streamTitle || 'none'} · ${homeShelves.streamMeta || 'no meta'}`
    )
    record(
      homeShelves.addedTitle === 'Shelf Test Single' &&
        homeShelves.addedMeta.includes('Shelf Shelf Artist') &&
        !homeShelves.addedInPlayed,
      'home: a newly added file with no album tag appears on Recently added only',
      `${homeShelves.addedTitle || 'none'} · ${homeShelves.addedMeta || 'no meta'} · leaked ${homeShelves.addedInPlayed}`
    )
    record(
      homeShelves.singleTrackCard && homeShelves.singleTrackPlayed,
      'home: a one-file release appears as a track card and plays on a click',
      { card: homeShelves.singleTrackCard, played: homeShelves.singleTrackPlayed }
    )
    record(
      homeShelves.multiDetailTitle === 'Shelf Test Multi Album' &&
        homeShelves.multiDetailRows === 2 &&
        homeShelves.multiBackWorks,
      'home: a real album card still opens its detail and returns to Home',
      {
        title: homeShelves.multiDetailTitle,
        rows: homeShelves.multiDetailRows,
        back: homeShelves.multiBackWorks
      }
    )
    record(
      homeShelves.playStarted,
      'home: clicking a playlist card plays the list instead of navigating',
      `queue after click ${homeShelves.playStarted ? 'held the two tracks' : 'did not change'}`
    )
    record(
      homeShelves.onPlaylists &&
        homeShelves.paneTitle === 'Shelf Test Album' &&
        homeShelves.paneRows === 2 &&
        homeShelves.openMenuItems.includes('Open in Playlists'),
      'home: the playlist card menu opens the list in Playlists',
      `menu ${homeShelves.openMenuItems || 'none'}, view ${homeShelves.onPlaylists ? 'Playlists' : 'other'}, pane ${homeShelves.paneTitle || 'none'}, ${homeShelves.paneRows} rows`
    )
    record(
      streamPlaysBefore === 0 && container.streamPlays.getByVideoId('shelftest03') !== null,
      'the stream play log records a counted YouTube listen under its video id',
      `${streamPlaysBefore} before, ${container.streamPlays.count()} after`
    )
    record(
      homeShelves.arrowCount === 2 &&
        homeShelves.arrowStartsDisabled &&
        homeShelves.arrowForwardEnabled &&
        homeShelves.shelfScrolled > 20 &&
        homeShelves.arrowBackEnabled &&
        homeShelves.shelfNodeStable,
      'home: a shelf has prev/next arrows that agree with its edges and scroll it',
      `arrows ${homeShelves.arrowCount}, at ${homeShelves.arrowStartScroll}px of ${homeShelves.shelfWidth}/${homeShelves.shelfContent}, back at start ${homeShelves.arrowStartsDisabled}, forward ${homeShelves.arrowForwardEnabled}, scrolled ${homeShelves.shelfScrolled}px, back after ${homeShelves.arrowBackEnabled}, same node ${homeShelves.shelfNodeStable}`
    )
    record(
      homeShelves.allTitles.includes('Shelf Test Single') &&
        homeShelves.allTitles.includes('Shelf Test Second') &&
        homeShelves.allTitles.includes('Shelf Test Stream') &&
        homeShelves.allPlaylistBadge === 'Playlist' &&
        homeShelves.allLibraryBadge === 'Library' &&
        homeShelves.allHasStreamBadge,
      'home: All tracks merges files, listens and playlist entries behind a source badge',
      {
        titles: homeShelves.allTitles,
        badges: homeShelves.allBadges,
        playlist: homeShelves.allPlaylistBadge,
        library: homeShelves.allLibraryBadge,
        stream: homeShelves.allHasStreamBadge
      }
    )
    record(
      homeShelves.sourceHeading === 'Source' &&
        homeShelves.badgesInSource === homeShelves.allBadges.split('|').length &&
        homeShelves.badgesInTitle === 0 &&
        homeShelves.streamSaveTitle === 'Save to your library' &&
        homeShelves.localSaveTitle === '' &&
        homeShelves.localMenuButton,
      'home: All tracks badges sit under Source, only stream rows offer a save, and every row has its menu',
      {
        heading: homeShelves.sourceHeading,
        inSource: homeShelves.badgesInSource,
        inTitle: homeShelves.badgesInTitle,
        rows: homeShelves.allBadges.split('|').length,
        save: homeShelves.streamSaveTitle,
        localSave: homeShelves.localSaveTitle,
        localMenu: homeShelves.localMenuButton
      }
    )
    record(
      homeShelves.playedHeading === 'Recently played' &&
        homeShelves.playedChip.includes('Recently played') &&
        !homeShelves.playedHasPlaylistOnly &&
        homeShelves.playedCleared &&
        homeShelves.playedClearedHeading === 'All tracks',
      'home: More on Recently played filters the merged list and the chip restores it',
      {
        heading: homeShelves.playedHeading,
        chip: homeShelves.playedChip,
        badges: homeShelves.playedBadges,
        playlistOnly: homeShelves.playedHasPlaylistOnly,
        cleared: homeShelves.playedCleared,
        clearedHeading: homeShelves.playedClearedHeading
      }
    )
    record(
      homeShelves.artistKicker === 'Artist' &&
        homeShelves.artistTitle === 'Shelf Shelf Artist' &&
        homeShelves.artistRows === 1 &&
        homeShelves.artistHasSingle &&
        homeShelves.artistAlbumColumn === 'show',
      'home: an artist with no albums opens their tracks instead of an empty grid',
      `${homeShelves.artistKicker || '?'} ${homeShelves.artistTitle || 'none'} · ${homeShelves.artistRows} rows · album column ${homeShelves.artistAlbumColumn || 'none'}`
    )

    // ---- 15c. right-click on Home ---------------------------------------
    // The shelves and All tracks are a launch surface with no selection, so
    // their menu is the row's own actions: Play, Add to playlist, Details and
    // — for a file — Edit tags and Show in folder. A stream has no file and
    // gets the smaller Play/Details menu. A shelf groups files into album
    // cards, so those get the album's own Play/Open/Queue menu instead of
    // ignoring the right-click. Select must never appear, because there is no
    // selection for it to change.
    const homeMenus = await evaluate<{
      localCardItems: string
      localCardHasSelect: boolean
      streamCardItems: string
      albumCardItems: string
      albumCardHasButton: boolean
      localRowItems: string
      localRowHasSelect: boolean
      streamRowItems: string
      trackCardHasButton: boolean
      menusClosed: boolean
    }>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const text = (el) => ((el || {}).textContent || '')
         const nav = (label) =>
           [...document.querySelectorAll('.nav-item')].find((el) =>
             text(el).trim().startsWith(label)
           )
         const shelf = (title) =>
           [...document.querySelectorAll('.home-section')].find(
             (section) =>
               text(section.querySelector('.home-section-head h2')).trim() === title
           )
         const trackCard = (title, name) =>
           [...(shelf(title)?.querySelectorAll('.track-card') || [])].find(
             (card) => text(card.querySelector('.album-card-title')).trim() === name
           )
         const albumCard = (title, name) =>
           [...(shelf(title)?.querySelectorAll('.album-card') || [])].find(
             (card) =>
               !card.classList.contains('track-card') &&
               text(card.querySelector('.album-card-title')).trim() === name
           )
         const rowFor = (title) =>
           [...document.querySelectorAll('.all-tracks-list .track-row')].find(
             (row) => text(row.querySelector('.row-title-text')).trim() === title
           )
         const items = (selector) =>
           [...document.querySelectorAll(selector + ' .context-item')]
             .map((el) => text(el).trim())
             .join('|')
         const rightClick = (el, x, y) =>
           el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y }))
         const close = async () => {
           document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
           const deadline = Date.now() + 2000
           while (Date.now() < deadline && document.querySelector('.context-menu')) await sleep(40)
         }
         const out = {
           localCardItems: '', localCardHasSelect: false, streamCardItems: '',
           albumCardItems: '', albumCardHasButton: false,
           localRowItems: '', localRowHasSelect: false, streamRowItems: '',
           trackCardHasButton: false, menusClosed: false
         }

         nav('Home')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
         const ready = Date.now() + 8000
         while (Date.now() < ready && !rowFor('Shelf Test Single')) await sleep(100)

         const localCard = trackCard('Recently added', 'Shelf Test Single')
         rightClick(localCard, 200, 220)
         const cardDeadline = Date.now() + 3000
         while (Date.now() < cardDeadline && !document.querySelector('.context-menu')) await sleep(40)
         out.localCardItems = items('.context-menu')
         out.localCardHasSelect = out.localCardItems.split('|').includes('Select')
         await close()

         const streamCard = trackCard('Recently played', 'Shelf Test Stream')
         rightClick(streamCard, 240, 240)
         const streamDeadline = Date.now() + 3000
         while (Date.now() < streamDeadline && !document.querySelector('.row-menu')) await sleep(40)
         out.streamCardItems = items('.row-menu')
         await close()

         // The shelves group files into album cards, and those are the cards
         // most shelves actually show. Right-clicking one must open the
         // album's own menu rather than doing nothing.
         rightClick(albumCard('Recently added', 'Shelf Test Multi Album'), 250, 280)
         const albumDeadline = Date.now() + 3000
         while (Date.now() < albumDeadline && !document.querySelector('.row-menu')) await sleep(40)
         out.albumCardItems = items('.row-menu')
         out.albumCardHasButton = Boolean(
           albumCard('Recently added', 'Shelf Test Multi Album')?.querySelector('.card-overflow')
         )
         await close()

         rightClick(rowFor('Shelf Test Single'), 260, 300)
         const rowDeadline = Date.now() + 3000
         while (Date.now() < rowDeadline && !document.querySelector('.context-menu')) await sleep(40)
         out.localRowItems = items('.context-menu')
         out.localRowHasSelect = out.localRowItems.split('|').includes('Select')
         await close()

         rightClick(rowFor('Shelf Test Stream'), 280, 320)
         const streamRowDeadline = Date.now() + 3000
         while (Date.now() < streamRowDeadline && !document.querySelector('.row-menu')) await sleep(40)
         out.streamRowItems = items('.row-menu')
         await close()

         // The sheet covers the card's artwork, which the user does not want,
         // so there is no overlay button: right-click is the only entry point.
         out.trackCardHasButton = Boolean(
           trackCard('Recently added', 'Shelf Test Single')?.querySelector('.card-overflow')
         )
         out.menusClosed = !document.querySelector('.context-menu') && !document.querySelector('.row-menu')
         return out
       })()`
    )

    record(
      homeMenus.localCardItems.includes('Play') &&
        homeMenus.localCardItems.includes('Add to playlist') &&
        homeMenus.localCardItems.includes('Details') &&
        !homeMenus.localCardHasSelect,
      'home: right-clicking a local shelf card opens the row menu without Select',
      homeMenus.localCardItems || 'no menu'
    )
    record(
      homeMenus.streamCardItems === 'Play|Details',
      'home: right-clicking a stream shelf card opens Play and Details only',
      homeMenus.streamCardItems || 'no menu'
    )
    record(
      homeMenus.albumCardItems === 'Play|Open album|Add to queue',
      'home: right-clicking an album shelf card opens its album menu',
      homeMenus.albumCardItems || 'no menu'
    )
    record(
      !homeMenus.albumCardHasButton && !homeMenus.trackCardHasButton && homeMenus.menusClosed,
      'home: a shelf card has no overlay button, and right-click alone opens and closes the menu',
      `album button ${homeMenus.albumCardHasButton}, track button ${homeMenus.trackCardHasButton}, closed ${homeMenus.menusClosed}`
    )
    record(
      homeMenus.localRowItems.includes('Play') &&
        homeMenus.localRowItems.includes('Add to playlist') &&
        homeMenus.localRowItems.includes('Details') &&
        !homeMenus.localRowHasSelect,
      'home: right-clicking an All tracks row opens the row menu without Select',
      homeMenus.localRowItems || 'no menu'
    )
    record(
      homeMenus.streamRowItems === 'Play|Details',
      'home: right-clicking an All tracks stream row opens Play and Details only',
      homeMenus.streamRowItems || 'no menu'
    )

    container.library.removeTracks([shelfSingleId, shelfAlbumId, shelfMultiOneId, shelfMultiTwoId])
    container.onlineRepo.remove(shelfHistory.id)
    container.onlinePlaylists.delete(shelfPlaylist.id)
    for (const extra of shelfExtras) container.onlinePlaylists.delete(extra.id)
    container.streamPlays.clear()
    broadcast(IPC_EVENTS.onlineChanged, null)
    broadcast(IPC_EVENTS.playHistoryChanged, null)

    // ---- 16. resuming ----------------------------------------------------
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

    // The default is quiet, but the resume opt-in must actually start the
    // restored queue. Turn it on through the UI, reload, and watch the primary
    // button become Pause while the saved track is still there.
    const autoplayArmed = await evaluate<boolean>(
      window,
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
         const press = (el) => { if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
         const resume = () => {
           const label = [...document.querySelectorAll('.field.checkbox')].find((el) =>
             (el.textContent || '').includes('Resume playback')
           )
           return label ? label.querySelector('input') : null
         }
         const settingsNav = [...document.querySelectorAll('.nav-item')].find(
           (el) => ((el.textContent || '').trim().indexOf('Settings') === 0)
         )
         press(settingsNav)
         // Settings loads its snapshot asynchronously. Wait for the control to
         // exist instead of assuming one paint, then wait for React to commit
         // the checked state. A fixed 400 ms wait made this check flaky on a
         // cold packaged launch.
         const appearDeadline = Date.now() + 10000
         while (Date.now() < appearDeadline && !resume()) await sleep(100)
         if (!resume()) return false
         if (!resume().checked) resume().click()
         const checkedDeadline = Date.now() + 5000
         while (Date.now() < checkedDeadline && resume()?.checked !== true) await sleep(100)
         return resume()?.checked === true
       })()`
    )

    let autoplayRestored: { title: string; paused: boolean } | null = null
    if (autoplayArmed) {
      window.webContents.reload()
      const autoplayDeadline = Date.now() + 15_000
      while (Date.now() < autoplayDeadline) {
        try {
          autoplayRestored = await evaluate<{ title: string; paused: boolean }>(
            window,
            `(() => {
               const pick = (s) => document.querySelector(s)
               const text = (el) => ((el || {}).textContent || '')
               const play = pick('.player-bar .icon-button.primary')
               return {
                 title: text(pick('.player-title')).trim(),
                 paused: (play ? play.getAttribute('title') : '') !== 'Pause'
               }
             })()`
          )
        } catch {
          autoplayRestored = null
        }
        if (autoplayRestored && autoplayRestored.title.length > 0 && !autoplayRestored.paused) break
        await delay(200)
      }
    }

    record(
      autoplayArmed && autoplayRestored?.paused === false,
      'automatic resume plays the restored queue when the resume option is on',
      autoplayArmed
        ? `${autoplayRestored?.title || 'nothing'} / ${autoplayRestored?.paused ? 'paused' : 'playing'}`
        : 'resume switch did not turn on'
    )

    // ---- 16. Search rows, selection and menus ---------------------------
    // Search normally asks YouTube over the network. The layout, selection and
    // row-menu behaviour are local, so stub only the discovery provider: the
    // renderer still runs its whole search path, including the live IPC round
    // trip, without making a real request or depending on what YouTube returns
    // today. Imported fixtures are seeded directly and removed afterwards.
    window.setSize(1200, 780)
    await delay(300)
    const realSearch = container.online.search
    const realChannel = container.online.channel
    const searchResults = Array.from({ length: 10 }, (_, index) => ({
      videoId: `selftestsearch${index + 1}`,
      title: `Search Tone ${index + 1}`,
      artist: index === 0 ? 'Search Artist' : null,
      durationMs: 125_000 - index * 1_000,
      channelId: 'UCselftest',
      channelName: 'Search Channel'
    }))
    container.online.search = async (_query, limit = 10, offset = 0) =>
      searchResults.slice(offset, offset + limit)
    container.online.channel = async () => ({
      channelId: 'UCselftest',
      name: 'Search Channel',
      url: 'https://www.youtube.com/channel/UCselftest',
      entries: searchResults.slice(0, 1)
    })
    const importedSeed = Date.now()
    const importedHistory = [
      {
        videoId: 'selftestimport1',
        title: 'Selftest Imported One',
        artist: 'Selftest Imported Artist',
        channel: 'Selftest Imported Channel',
        album: null,
        durationMs: 180_000,
        sourceUrl: youtubeWatchUrl('selftestimport1'),
        artworkKey: null
      },
      {
        videoId: 'selftestimport2',
        title: 'Selftest Imported Two',
        artist: 'Selftest Imported Artist',
        channel: 'Selftest Imported Channel',
        album: null,
        durationMs: 200_000,
        sourceUrl: youtubeWatchUrl('selftestimport2'),
        artworkKey: null
      }
    ]
    // Enough history to overflow the Imported shelf's eight-card cap, so Show
    // all is exercised against a real shelf rather than a stubbed count.
    for (let extra = 0; extra < 7; extra += 1) {
      importedHistory.push({
        videoId: `selftestimportx${extra}`,
        title: `Selftest Imported Extra ${extra + 1}`,
        artist: 'Selftest Imported Artist',
        channel: 'Selftest Imported Channel',
        album: null,
        durationMs: 120_000,
        sourceUrl: youtubeWatchUrl(`selftestimportx${extra}`),
        artworkKey: null
      })
    }
    importedHistory.forEach((entry, at) => {
      container.onlineRepo.upsert(entry, importedSeed - at * 1000)
    })
    // The first entry repeats a history video on purpose: the shelf must show
    // that video once, as history, rather than once per place it is remembered.
    const importedList = container.onlinePlaylists.upsert(
      {
        listId: 'PLselftestsearch',
        kind: 'playlist',
        title: 'Selftest Imported List',
        owner: 'Selftest Owner',
        sourceUrl: 'https://www.youtube.com/playlist?list=PLselftestsearch',
        coverKey: null,
        totalCount: 2
      },
      [
        {
          videoId: 'selftestimport2',
          title: 'Selftest Imported Two',
          artist: 'Selftest Imported Artist',
          album: null,
          durationMs: 200_000
        },
        {
          videoId: 'selftestimport3',
          title: 'Selftest Imported Three',
          artist: null,
          album: null,
          durationMs: 150_000
        }
      ],
      importedSeed
    )
    // A Search prefetch is a real resolve in the app. The provider above is
    // stubbed, so the resolver must be too: the spy records the guess and
    // returns at once, and a play of an actual row still takes the real path.
    const realResolve = container.resolvers.resolve
    const prefetchRequests: string[] = []
    container.resolvers.resolve = async (track) => {
      if (track.sourceKind === 'youtube' && track.id === 0) {
        prefetchRequests.push(track.sourceId ?? '')
        return {
          url: 'https://selftest.invalid/prefetch',
          expiresAt: null,
          mimeType: null,
          resolverId: 'selftest'
        }
      }
      return realResolve.call(container.resolvers, track)
    }
    try {
      // A downloaded copy is the same track as the remembered video, and a
      // video that sits in history and in a list is still one row. Both are
      // decisions of the merge, so they are checked without driving the UI.
      const localForMerge = container.library.list({ search: 'Selftest', limit: 1 }).tracks[0]
      const merged = mergeLibrarySearch(
        localForMerge
          ? [{ ...localForMerge, originKind: 'youtube' as const, originId: 'selftestimport1' }]
          : [],
        container.onlineRepo.search('Selftest', 30),
        container.onlinePlaylists.search('Selftest', 30),
        30
      )
      const mergedIds = merged.imported.map((entry) => entry.track.sourceId)
      const mergedSources = merged.imported.map((entry) => entry.source)
      record(
        mergedIds.length === 9 &&
          !mergedIds.includes('selftestimport1') &&
          mergedIds.filter((id) => id === 'selftestimport2').length === 1,
        'Search Imported drops a downloaded copy and shows a repeated video once',
        mergedIds
      )
      record(
        mergedSources.includes('History') && mergedSources.includes('Selftest Imported List'),
        'Search labels an imported row with the history or playlist that remembers it',
        mergedSources
      )

      const searchUi = await evaluate<{
        liveLocal: number
        liveImported: number
        liveYoutubeCards: number
        ctaBeforeSubmit: boolean
        ctaText: string
        submitLabel: string
        importSources: string[]
        shelves: number
        grids: number
        shelfBadges: number
        importedShownBefore: number
        showAllLabelBefore: string
        importedShownAfter: number
        showAllLabelAfter: string
        rowsAfterSubmit: number
        localRows: number
        importedRows: number
        youtubeRows: number
        ctaAfterSubmit: boolean
        pager: number
        bestCards: number
        bestPillText: string
        bestIsFirst: boolean
        artSquare: boolean
        rowMenuButton: boolean
        channelLinks: number
        channelLinkText: string
        channelLinkUnderline: string
        youtubeBeforeMore: number
        moreLabel: string
        youtubeAfterMore: number
        moreGone: boolean
        bestAfterMore: boolean
        rowsAfterMore: number
        resetYoutube: number
        resetCta: boolean
        selectedOne: boolean
        checkboxes: number
        selectedTwo: boolean
        menuOpen: boolean
        menuLabels: string[]
        playlistMenu: boolean
        menusClosed: boolean
        importedMenu: string[]
        channelTitle: string
        channelRows: number
        channelHasBack: boolean
        backToSearch: boolean
      }>(
        window,
        `(async () => {
           const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
           const pick = (selector) => document.querySelector(selector)
           const pickAll = (selector) => [...document.querySelectorAll(selector)]
           const text = (element) => ((element || {}).textContent || '')
           const shelf = (badge) =>
             pickAll('.discover-shelf').find(
               (section) => text(section.querySelector('.source-badge')).trim() === badge
             )
           const count = (badge) => {
             const section = shelf(badge)
             return Number(text(section ? section.querySelector('.discover-count') : null))
           }
           const cards = (badge) => {
             const section = shelf(badge)
             return [...(section ? section.querySelectorAll('.discover-item') : [])]
           }
           const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
           const setInput = (value) => {
             const input = pick('.discover-input input')
             if (!input) return
             setValue.call(input, value)
             input.dispatchEvent(new Event('input', { bubbles: true }))
           }
           const submitNow = () => {
             const button = pick('.discover-bar button[type="submit"]')
             if (button) button.click()
           }
           const waitFor = async (check, ms) => {
             const until = Date.now() + ms
             while (Date.now() < until) {
               if (check()) return true
               await sleep(100)
             }
             return check()
           }
           const out = {
             liveLocal: 0, liveImported: 0, liveYoutubeCards: 0, ctaBeforeSubmit: false,
             ctaText: '', submitLabel: '', importSources: [], shelves: 0, grids: 0,
             shelfBadges: 0, importedShownBefore: 0, showAllLabelBefore: '',
             importedShownAfter: 0, showAllLabelAfter: '', rowsAfterSubmit: 0,
             localRows: 0, importedRows: 0, youtubeRows: 0, ctaAfterSubmit: false,
             pager: 0, bestCards: 0, bestPillText: '', bestIsFirst: false,
             artSquare: false, rowMenuButton: false, channelLinks: 0, channelLinkText: '',
             channelLinkUnderline: '', youtubeBeforeMore: 0, moreLabel: '',
             youtubeAfterMore: 0, moreGone: false, bestAfterMore: false, rowsAfterMore: 0,
             resetYoutube: 0, resetCta: false, selectedOne: false,
             checkboxes: 0, selectedTwo: false, menuOpen: false, menuLabels: [],
             playlistMenu: false, menusClosed: false, importedMenu: [], channelTitle: '',
             channelRows: 0, channelHasBack: false, backToSearch: false
           }

           const searchNav = pickAll('.nav-item').find((el) => text(el).trim().startsWith('Search'))
           if (searchNav) searchNav.dispatchEvent(new MouseEvent('click', { bubbles: true }))
           await sleep(350)

           // Typing fills the two database shelves; YouTube is only an offer.
           setInput('Selftest')
           await waitFor(() => count('On this device') === 2 && count('Imported') === 10, 6000)
           out.liveLocal = count('On this device')
           out.liveImported = count('Imported')
           out.liveYoutubeCards = cards('YouTube').length
           out.ctaBeforeSubmit = Boolean(pick('.search-youtube-cta'))
           out.ctaText = text(pick('.search-youtube-cta')).trim()
           out.submitLabel = text(pick('.discover-bar button[type="submit"]')).trim()
           out.shelves = pickAll('.discover-shelf').length
           out.grids = pickAll('.discover-grid').length
           out.shelfBadges = pickAll('.discover-shelf .source-badge').length

           // Eight cards, then Show all; the shelf's own count never lies.
           out.importedShownBefore = cards('Imported').length
           const showAll = shelf('Imported') ? shelf('Imported').querySelector('.discover-show-all') : null
           out.showAllLabelBefore = text(showAll).trim()
           if (showAll) showAll.click()
           await waitFor(() => cards('Imported').length === 10, 3000)
           out.importedShownAfter = cards('Imported').length
           out.showAllLabelAfter = text(shelf('Imported').querySelector('.discover-show-all')).trim()
           out.importSources = pickAll('.discover-import-source').map((el) => text(el).trim())

           submitNow()
           await waitFor(() => count('YouTube') === 5, 8000)
           out.rowsAfterSubmit = pickAll('.discover-item').length
           out.localRows = count('On this device')
           out.importedRows = count('Imported')
           out.youtubeRows = count('YouTube')
           out.ctaAfterSubmit = Boolean(pick('.search-youtube-cta'))
           out.pager = pickAll('.discover-pager').length

           // The first YouTube card is the best match, and only one is marked.
           const youtubeCards = cards('YouTube')
           out.bestCards = pickAll('.discover-item.best-match').length
           out.bestPillText = text(pick('.discover-best-pill')).trim()
           out.bestIsFirst = Boolean(youtubeCards[0] && youtubeCards[0].classList.contains('best-match'))
           out.rowMenuButton = Boolean(youtubeCards[0] && youtubeCards[0].querySelector('.discover-menu'))
           const art = youtubeCards[0] ? youtubeCards[0].querySelector('.album-card-art') : null
           const artBox = art ? art.getBoundingClientRect() : null
           out.artSquare = Boolean(artBox && Math.abs(artBox.width - artBox.height) < 2)

           out.channelLinks = pickAll('.discover-channel-link').length
           const channelLink = pick('.discover-channel-link')
           out.channelLinkText = text(channelLink).trim()
           out.channelLinkUnderline = channelLink ? getComputedStyle(channelLink).textDecorationLine : 'missing'

           // Five is the first answer; one +5 request may extend it to ten,
           // and then the shelf stops offering more.
           out.youtubeBeforeMore = cards('YouTube').length
           const more = pick('.discover-more')
           out.moreLabel = text(more).trim()
           if (more) more.click()
           await waitFor(() => count('YouTube') === 10, 8000)
           out.youtubeAfterMore = cards('YouTube').length
           out.moreGone = !pick('.discover-more')
           out.bestAfterMore = Boolean(
             pickAll('.discover-item.best-match').length === 1 &&
               cards('YouTube')[0] &&
               cards('YouTube')[0].classList.contains('best-match')
           )
           out.rowsAfterMore = pickAll('.discover-item').length

           // Editing the query must take the YouTube answer away with it.
           setInput('Selftest T')
           await waitFor(() => Boolean(pick('.search-youtube-cta')), 4000)
           out.resetYoutube = count('YouTube')
           out.resetCta = Boolean(pick('.search-youtube-cta'))

           // Ask again, then drive selection and the row menus on the full page.
           setInput('Selftest')
           await waitFor(() => pickAll('.discover-item').length >= 5, 5000)
           submitNow()
           await waitFor(() => count('YouTube') === 5, 8000)

           const rows = pickAll('.discover-item')
           if (rows[0]) rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
           await sleep(150)
           out.selectedOne = Boolean(rows[0] && rows[0].classList.contains('selected') && pick('.discover-selection-bar'))
           out.checkboxes = pickAll('.discover-select input').length
           if (rows[1]) rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
           await sleep(150)
           out.selectedTwo = pickAll('.discover-item.selected').length === 2

           if (rows[0]) {
             rows[0].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 220, clientY: 220 }))
           }
           await sleep(150)
           const menu = pick('.row-menu')
           out.menuOpen = Boolean(menu)
           out.menuLabels = menu ? pickAll('.row-menu .context-item').map((item) => text(item).trim()) : []
           const playlistItem = menu
             ? pickAll('.row-menu .context-item').find((item) => text(item).trim().startsWith('Add to playlist'))
             : null
           if (playlistItem) playlistItem.click()
           await sleep(180)
           out.playlistMenu = Boolean(pick('.add-to-playlist'))
           document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
           await sleep(120)
           out.menusClosed = !pick('.row-menu') && !pick('.add-to-playlist')

           // An imported card is streamable but not a file: it offers Play,
           // queue and Details, and no save or playlist action.
           const importedRow = pickAll('.discover-item')[out.localRows]
           if (importedRow) {
             importedRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 260, clientY: 300 }))
           }
           await sleep(150)
           out.importedMenu = pickAll('.row-menu .context-item').map((item) => text(item).trim())
           document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
           await sleep(120)

           const link = pick('.discover-channel-link')
           if (link) link.click()
           let deadline = Date.now() + 3000
           while (Date.now() < deadline && text(pick('.view-header h1')).trim() !== 'Search Channel') await sleep(100)
           out.channelTitle = text(pick('.view-header h1')).trim()
           out.channelRows = pickAll('.discover-item').length
           out.channelHasBack = pickAll('.view-header button').some((button) => text(button).includes('Back to results'))

           const back = pickAll('.view-header button').find((button) => text(button).includes('Back to results'))
           if (back) back.click()
           await sleep(400)
           out.backToSearch = text(pick('.view-header h1')).trim() === 'Search' && pickAll('.discover-item').length >= 7
           return out
         })()`
      )
      record(
        searchUi.liveLocal === 2 &&
          searchUi.liveImported === 10 &&
          searchUi.liveYoutubeCards === 0 &&
          searchUi.ctaBeforeSubmit &&
          searchUi.shelves === 3 &&
          searchUi.grids === 2,
        'Search fills On this device and Imported as you type in three shelves, and offers YouTube instead of guessing',
        {
          local: searchUi.liveLocal,
          imported: searchUi.liveImported,
          youtube: searchUi.liveYoutubeCards,
          cta: searchUi.ctaBeforeSubmit,
          shelves: searchUi.shelves,
          grids: searchUi.grids
        }
      )
      record(
        searchUi.importedShownBefore === 8 &&
          searchUi.showAllLabelBefore === 'Show all 10' &&
          searchUi.importedShownAfter === 10 &&
          searchUi.showAllLabelAfter === 'Show fewer',
        'Search shows eight cards per shelf and reveals the rest on demand',
        {
          before: [searchUi.importedShownBefore, searchUi.showAllLabelBefore],
          after: [searchUi.importedShownAfter, searchUi.showAllLabelAfter]
        }
      )
      record(
        searchUi.submitLabel === 'Search YouTube' && searchUi.ctaText.includes('Search YouTube for'),
        'Search names the network request on the button and in the empty YouTube shelf',
        { button: searchUi.submitLabel, cta: searchUi.ctaText }
      )
      record(
        searchUi.importSources.length === 10 &&
          searchUi.importSources.slice(0, 9).every((source) => source === 'History') &&
          searchUi.importSources[9] === 'Selftest Imported List',
        'Search names the history or playlist that remembers each imported card',
        searchUi.importSources
      )
      record(
        searchUi.rowsAfterSubmit === 17 &&
          searchUi.localRows === 2 &&
          searchUi.importedRows === 10 &&
          searchUi.youtubeRows === 5 &&
          !searchUi.ctaAfterSubmit &&
          searchUi.pager === 0 &&
          searchUi.shelfBadges === 3,
        'Search YouTube fills the third shelf beside the two local shelves with five cards, without a pager',
        {
          cards: searchUi.rowsAfterSubmit,
          local: searchUi.localRows,
          imported: searchUi.importedRows,
          youtube: searchUi.youtubeRows,
          pager: searchUi.pager,
          badges: searchUi.shelfBadges
        }
      )
      record(
        searchUi.bestCards === 1 && searchUi.bestPillText === 'Best match' && searchUi.bestIsFirst,
        'Search marks the first YouTube card as the best match and leaves the rest unmarked',
        {
          marked: searchUi.bestCards,
          pill: searchUi.bestPillText,
          first: searchUi.bestIsFirst
        }
      )
      record(
        searchUi.artSquare && searchUi.rowMenuButton,
        'Search results are square art cards with a row menu button',
        { square: searchUi.artSquare, menu: searchUi.rowMenuButton }
      )
      record(
        searchUi.youtubeBeforeMore === 5 &&
          searchUi.moreLabel === '+5 more' &&
          searchUi.youtubeAfterMore === 10 &&
          searchUi.moreGone &&
          searchUi.bestAfterMore,
        'Search offers one +5 page on the YouTube shelf and stops at ten',
        {
          label: searchUi.moreLabel,
          before: searchUi.youtubeBeforeMore,
          after: searchUi.youtubeAfterMore,
          gone: searchUi.moreGone,
          best: searchUi.bestAfterMore
        }
      )
      record(
        searchUi.channelLinks === 5 &&
          searchUi.channelLinkText === 'Search Channel' &&
          searchUi.channelLinkUnderline === 'none',
        'Search puts the channel link on the channel name, with no underline',
        { links: searchUi.channelLinks, text: searchUi.channelLinkText, decoration: searchUi.channelLinkUnderline }
      )
      record(
        searchUi.resetYoutube === 0 && searchUi.resetCta,
        'Search clears the YouTube answer, and offers the search again, when the query changes',
        { youtube: searchUi.resetYoutube, cta: searchUi.resetCta }
      )
      record(
        searchUi.selectedOne && searchUi.checkboxes === 15 && searchUi.selectedTwo,
        'Search cards select with Ctrl-click and reveal a checkbox per card',
        { first: searchUi.selectedOne, boxes: searchUi.checkboxes, two: searchUi.selectedTwo }
      )
      record(
        searchUi.menuOpen &&
          searchUi.menuLabels.includes('Deselect') &&
          searchUi.menuLabels.includes('Add to queue') &&
          searchUi.menuLabels.some((label) => label.startsWith('Play selected')) &&
          searchUi.menuLabels.includes('Add to playlist…') &&
          searchUi.menuLabels.includes('Select all results'),
        'Search right-click offers row actions, selection actions and the playlist submenu',
        searchUi.menuLabels
      )
      record(
        searchUi.playlistMenu && searchUi.menusClosed,
        'Search Add to playlist opens the existing playlist menu and closes cleanly',
        { opened: searchUi.playlistMenu, closed: searchUi.menusClosed }
      )
      record(
        searchUi.importedMenu.includes('Play') &&
          searchUi.importedMenu.includes('Add to queue') &&
          searchUi.importedMenu.includes('Details') &&
          !searchUi.importedMenu.includes('Save to library') &&
          !searchUi.importedMenu.includes('Add to playlist…') &&
          !searchUi.importedMenu.includes('Go to channel'),
        'an imported card offers Play and Details, without save or playlist actions',
        searchUi.importedMenu
      )
      record(
        searchUi.channelTitle === 'Search Channel' && searchUi.channelRows === 1 && searchUi.channelHasBack,
        'Search opens a channel from the card link',
        { title: searchUi.channelTitle, rows: searchUi.channelRows, back: searchUi.channelHasBack }
      )
      record(
        searchUi.backToSearch,
        'Search returns from a channel to the results that were there',
        searchUi.backToSearch
      )

      // A warm-up is a real resolve, so the spy above records every attempt.
      // Three moments matter: a timer cancelled by the next keystroke, a query
      // the local shelves can answer, and one that only YouTube can, followed
      // by a second query inside the cooldown.
      await evaluate<void>(
        window,
        `(async () => {
           const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
           const pick = (selector) => document.querySelector(selector)
           const pickAll = (selector) => [...document.querySelectorAll(selector)]
           const text = (element) => ((element || {}).textContent || '')
           const shelf = (badge) =>
             pickAll('.discover-shelf').find(
               (section) => text(section.querySelector('.source-badge')).trim() === badge
             )
           const count = (badge) => {
             const section = shelf(badge)
             return Number(text(section ? section.querySelector('.discover-count') : null))
           }
           const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
           const setInput = (value) => {
             const input = pick('.discover-input input')
             if (!input) return
             setValue.call(input, value)
             input.dispatchEvent(new Event('input', { bubbles: true }))
           }
           const submitNow = () => {
             const button = pick('.discover-bar button[type="submit"]')
             if (button) button.click()
           }
           const type = async (value) => {
             setInput(value)
             await sleep(260)
           }
           const waitFor = async (check, ms) => {
             const until = Date.now() + ms
             while (Date.now() < until) {
               if (check()) return true
               await sleep(100)
             }
             return check()
           }

           // A pending warm-up is cancelled by the next query, and a query the
           // device can answer is never warmed at all.
           await type('No Selftest Tune')
           submitNow()
           await sleep(500)
           await type('Selftest')
           await waitFor(() => count('On this device') === 2, 5000)
           submitNow()
           await waitFor(() => count('YouTube') === 5, 8000)
           await sleep(2600)

           // Nothing on the device or in the lists: warm the one best match.
           await type('No Selftest Tune')
           submitNow()
           await waitFor(() => count('YouTube') === 5, 8000)
           await sleep(2800)

           // A second query inside the cooldown must not spend another resolve.
           await type('No Selftest Tune Two')
           submitNow()
           await waitFor(() => count('YouTube') === 5, 8000)
           await sleep(2800)
         })()`
      )
      record(
        prefetchRequests.length === 1 && prefetchRequests[0] === 'selftestsearch1',
        'Search warms the best match once, only when both local shelves are empty',
        prefetchRequests
      )
    } finally {
      container.online.search = realSearch
      container.online.channel = realChannel
      container.resolvers.resolve = realResolve
      container.onlineRepo.removeByVideoIds(importedHistory.map((entry) => entry.videoId))
      container.onlinePlaylists.delete(importedList.id)
      broadcast(IPC_EVENTS.onlineChanged, null)
    }

    // ---- gapless handoff, SMTC and taskbar ------------------------------
    // The deck prepares the next local track on its idle element. A transition
    // mark is written only when that prepared element is promoted, so its
    // presence is the difference between a real handoff and a reload that
    // happens to start soon after. The same run checks that the Media Session
    // surface and the taskbar accept the player state.
    const gapless = await evaluate<{
      rows: number
      reason: string | null
      transitioned: boolean
      marks: number
      title: string
      firstTitle: string
      metadataTitle: string
      metadataArtist: string
      playbackState: string
      hasActions: boolean
      firstArtwork: string
      artwork: string
      taskbar: boolean
      actualPlaying: boolean
      buffering: boolean
    }>(
      window,
      `(async () => {
         const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const session = navigator.mediaSession
         const artworkOf = () => session && session.metadata && session.metadata.artwork && session.metadata.artwork[0]
           ? session.metadata.artwork[0].src
           : ''
         const out = {
           rows: 0, reason: null, transitioned: false, marks: 0, title: '',
           firstTitle: '', metadataTitle: '', metadataArtist: '', playbackState: '', hasActions: false,
           firstArtwork: '', artwork: '', taskbar: false, actualPlaying: false, buffering: false
         }
         try {
           performance.clearMarks('player:gapless')
           const before = performance.getEntriesByName('player:gapless').length
           const nav = [...document.querySelectorAll('.nav-item')].find((el) => (el.textContent || '').trim().startsWith('Library'))
           if (nav) nav.dispatchEvent(new MouseEvent('click', { bubbles: true }))
           await wait(400)
           const rows = [...document.querySelectorAll('.track-row')]
           out.rows = rows.length
           if (rows.length < 2) { out.reason = 'fewer than two library rows'; return out }
           rows[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
           const title = () => ((document.querySelector('.player-title') || {}).textContent || '').trim()
           let deadline = Date.now() + 6000
           while (Date.now() < deadline && !title()) await wait(100)
           // The first track may or may not have a cover. Record the metadata
           // artwork for both tracks so the cover in the pair is checked whichever
           // row the fixture sort puts first.
           deadline = Date.now() + 1500
           while (Date.now() < deadline && ((session && session.metadata && session.metadata.title) || '') !== title()) await wait(100)
           out.firstTitle = title()
           await wait(250)
           out.firstArtwork = artworkOf()
           deadline = Date.now() + 12000
           while (Date.now() < deadline && performance.getEntriesByName('player:gapless').length === before) await wait(150)
           await wait(400)
           out.marks = performance.getEntriesByName('player:gapless').length
           out.transitioned = out.marks > before
           out.title = title()
           deadline = Date.now() + 1500
           while (Date.now() < deadline && ((session && session.metadata && session.metadata.title) || '') !== title()) await wait(100)
           await wait(250)
           out.metadataTitle = session && session.metadata ? (session.metadata.title || '') : ''
           out.metadataArtist = session && session.metadata ? (session.metadata.artist || '') : ''
           out.playbackState = session ? session.playbackState : ''
           out.hasActions = Boolean(session && typeof session.setActionHandler === 'function')
           out.artwork = artworkOf()
           out.taskbar = await window.player.setTaskbarState({ hasTrack: true, isPlaying: true })
           const playButton = document.querySelector('.player-bar .icon-button.primary')
           out.actualPlaying = Boolean(playButton) && playButton.getAttribute('title') === 'Pause'
           out.buffering = Boolean(document.querySelector('.player-error.buffering'))
           await window.player.setTaskbarState({ hasTrack: Boolean(title()), isPlaying: out.actualPlaying })
         } catch (error) {
           out.reason = String(error)
         }
         return out
       })()`
    )
    record(gapless.rows >= 2, 'two local tracks are available for a gapless transition', gapless.rows)
    record(
      gapless.transitioned && gapless.marks > 0,
      'the next track is handed over on the prepared element without a reload',
      { reason: gapless.reason, marks: gapless.marks, title: gapless.title }
    )
    record(
      gapless.metadataTitle === gapless.title && gapless.playbackState === 'playing',
      'Media Session publishes the current track for Windows SMTC',
      {
        title: gapless.metadataTitle,
        player: gapless.title,
        state: gapless.playbackState,
        artist: gapless.metadataArtist
      }
    )
    record(
      gapless.hasActions &&
        (gapless.firstArtwork.startsWith('player-art://') ||
          gapless.artwork.startsWith('player-art://')),
      'Media Session exposes transport handlers and the artwork scheme',
      {
        actions: gapless.hasActions,
        first: gapless.firstArtwork,
        second: gapless.artwork,
        tracks: [gapless.firstTitle, gapless.title]
      }
    )

    record(
      process.platform === 'win32' ? gapless.taskbar : !gapless.taskbar,
      'the taskbar thumbnail toolbar accepts playback state',
      gapless.taskbar
    )
    record(
      !gapless.buffering,
      'healthy playback does not leave the buffering status on screen',
      gapless.buffering
    )

    // ---- mini player ----------------------------------------------------
    // One window, two layouts. The renderer swaps the UI and asks main for the
    // native bounds; this check exercises that whole round trip, including the
    // smaller minimum size that has to be applied before the window can shrink.
    const mini = await evaluate<{
      button: boolean
      entered: boolean
      width: number
      title: string
      controls: number
      barHidden: boolean
      expanded: boolean
      fullWidth: number
      barVisible: boolean
    }>(
      window,
      `(async () => {
         const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
         const button = document.querySelector('.mini-player-button')
         if (!button) return { button: false, entered: false, width: 0, title: '', controls: 0, barHidden: false, expanded: false, fullWidth: 0, barVisible: false }
         button.click()
         await wait(600)
         const app = document.querySelector('.app')
         const miniPanel = document.querySelector('.mini-player')
         const bar = document.querySelector('.player-bar')
         const entered = Boolean(app && app.classList.contains('mini-player-mode') && miniPanel)
         const title = miniPanel ? (miniPanel.querySelector('.mini-player-title')?.textContent || '').trim() : ''
         const controls = miniPanel ? miniPanel.querySelectorAll('.icon-button').length : 0
         const barHidden = Boolean(bar && getComputedStyle(bar).display === 'none')
         const width = window.innerWidth
         const expand = document.querySelector('.mini-player-expand')
         if (expand) expand.click()
         await wait(600)
         const appAfter = document.querySelector('.app')
         const barAfter = document.querySelector('.player-bar')
         return {
           button: true,
           entered,
           width,
           title,
           controls,
           barHidden,
           expanded: Boolean(appAfter && !appAfter.classList.contains('mini-player-mode') && !document.querySelector('.mini-player')),
           fullWidth: window.innerWidth,
           barVisible: Boolean(barAfter && getComputedStyle(barAfter).display !== 'none')
         }
       })()`
    )
    record(mini.button, 'the player bar offers a mini-player button')
    record(
      mini.entered && mini.width <= 470 && mini.title.length > 0 && mini.controls >= 4,
      'mini player shrinks the window and renders its own controls',
      { entered: mini.entered, width: mini.width, title: mini.title, controls: mini.controls }
    )
    record(
      mini.barHidden && mini.expanded && mini.fullWidth >= 900 && mini.barVisible,
      'leaving mini player restores the full window and player bar',
      { hidden: mini.barHidden, expanded: mini.expanded, width: mini.fullWidth, bar: mini.barVisible }
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
  home: number
  hasCards: boolean
  hasTable: boolean
  hasQueue: boolean
  online: number
  hasOnline: boolean
  discover: number
  hasDiscover: boolean
  discoverShrink: string | null
  hasHome: boolean
  homeStatsInside: boolean
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
    home: overflow('.home-view'),
    hasCards: Boolean(document.querySelector('.cards')),
    hasTable: Boolean(document.querySelector('.list-scroll') && document.querySelector('.track-head')),
    hasQueue: Boolean(document.querySelector('.queue-list')),
    online: overflow('.online-list'),
    hasOnline: Boolean(document.querySelector('.online-list')),
    discover: overflow('.discover-list') + overflow('.discover-bar'),
    hasDiscover: Boolean(document.querySelector('.discover-bar') || document.querySelector('.discover-list')),
    hasHome: Boolean(document.querySelector('.home-view .home-hero')),
    homeStatsInside: (() => {
      const hero = document.querySelector('.home-hero')
      const stats = document.querySelector('.home-stats')
      if (!hero || !stats) return false
      const outside = hero.getBoundingClientRect()
      const inside = stats.getBoundingClientRect()
      return inside.top >= outside.top && inside.bottom <= outside.bottom + 1
    })(),
    // A flex child that is allowed to shrink clips its own rows instead of
    // making the view scroll. Every direct child must keep its natural height.
    discoverShrink: (() => {
      const el = document.querySelector('.discover-view > *')
      return el ? getComputedStyle(el).flexShrink : null
    })(),
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
