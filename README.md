# Player

A desktop music player for Windows. It plays from your **local library**, and the first slice of M3 can stream a YouTube
link you paste in through a yt-dlp sidecar. Caching and optional downloads come next.

The full plan lives in [`ROADMAP.md`](./ROADMAP.md). This README covers what is **actually built right now**.

---

## Status: M1 complete, M3 streaming in progress

Working today:

- Add music folders through the native folder picker; they are scanned recursively.
- Tags are read with `music-metadata` (title, artist, album artist, album, track/disc, year, genre, duration, codec,
  bitrate, sample rate, channels).
- Tracks are listed in a **virtualized, sortable** library list with search (SQLite **FTS5**). Click selects, double
  click (or Enter, or the hover play button) plays. Sort by any column from the header. The list fits the window at any
  size instead of scrolling sideways: the Album and Artist columns drop out as it narrows.
- **Cover art** is extracted from embedded tags, resized, and cached content-addressed; rows and the player bar show it,
  with a placeholder when a file has none. **Settings → Visuals** chooses whether artwork is drawn square or circular,
  whether the player window's large cover is cropped to a square or given the cover's own shape, and how much of the
  window's artwork band it may fill (four presets, from small to extra large).
- A player bar with play/pause, previous/next, seek, volume, and a **queue** you can open, jump around, remove from and
  clear.
- **The library click behaviour is a setting.** Single click and double click each choose between selecting, playing,
  selecting-and-playing or doing nothing, because "select first, play on a double click" and "click to play" are both
  conventions people are attached to. Whatever is chosen is written into the row tooltips and the footnote under the list.
- A **full-window player**: click the now-playing area of the bar and the album art fades up over an ambient backdrop
  built from itself — the cover blurred, brightened and bled to every corner — with the transport, queue, volume and a
  full-width scrubber. Escape or the chevron fades it back out; whatever is behind it keeps its scroll position and
  playback is never interrupted. The queue slides in over the artwork from the same button that opened the window, so
  picking what plays next does not mean leaving the track you are looking at.
- **The library follows playback**: a track that has scrolled out of the list is brought back into view when it starts,
  but only if it is not already on screen.
- **Repeat** (off / all / one) and **shuffle** (which keeps the real order aside so turning it off restores it).
- **Keyboard shortcuts** (space, arrows, N/P, M, Ctrl+F, Escape) and the Windows **media keys**.
- Rescans are incremental: a file whose size and mtime are unchanged is never opened again.
- Deleting or moving files is reflected on the next full scan.
- **The folders are watched**: an album copied in appears by itself, and a file that disappears is forgotten, without
  pressing Rescan. Watching can be switched off in Settings for a library on a slow or network drive.
- **Playlists**: create, rename and delete them; add tracks from the library's selection bar, from a row's right-click
  (or Shift+F10) menu, or save the whole queue as a playlist from the player window. Rows are reordered by dragging or
  with Alt+↑/↓, and a playlist's order is kept exactly as the user set it. The list of playlists has a draggable
  splitter (arrow keys resize it too) and its width is remembered. A playlist shows title, artist, album and time —
  no format column — and drops the album or the artist as its pane gets narrower rather than squeezing the title.
- **It picks up where it left off**: the queue, the track and the position are written down as they play and put back
  on the next start — paused, at the same spot, with tracks that have since been deleted left out.
- **Play a YouTube link** (first M3 slice): *Play link* in the library header opens a small dialog. A pasted
  `youtube.com` / `youtu.be` link is resolved by the `yt-dlp` sidecar, and playback goes through an internal
  `player-stream://` proxy that forwards `Range` and the signed URL's headers. The first play costs 7–10 s because the
  sidecar starts for each resolve; the second play of the same link in a session is instant, and a URL that expires is
  re-resolved once if the CDN answers 403. Stream links are session-only — nothing is added to the library — and their
  queue is not restored after a restart yet.
- Settings persist to `config.json`. The engine settings now drive the resolver (binary folder, quality tier); the
  retention settings are stored and validated, and the cache/download path they describe arrives in M4.
- The engine layer reports whether `yt-dlp` and `ffmpeg` are present and runnable, and the resolver uses them.

Not built yet (deliberately): gapless playback, SMTC / tray icon, YouTube search or catalogue browsing, caching,
downloads (M4), packaging, playlist import/export and smart playlists.

---

## Scope and legal

This is a music player, not a media downloader. The streaming phase is shaped to keep that true:

- **Streaming is the default; downloading is opt-in.** The retention setting defaults to stream-only, and no audio is
  kept on disk unless the user chooses it. (A stream's thumbnail is cached as artwork, like any cover.) Today a link can
  only be streamed; the download path arrives in M4.
- **There is no catalogue browser**, and no search against YouTube. A track is something the user brings: a local file,
  or a link they paste.
- **`yt-dlp` is a sidecar, not the product.** It is named where it is configured, keeps its own licence and version, and
  the app does not bundle or fetch anything that circumvents DRM or paywalls.
- **The user carries the responsibility.** Downloading with `yt-dlp` can violate YouTube's Terms of Service and
  copyright law where the user lives. The app ships no media, and the download path is off by default.

Playing local files the user already owns is unaffected by any of this.

---

## Requirements

- **Node.js 22.12+** (Node 24 recommended) — the app uses `node:sqlite` and `require(esm)`.
- **No native build tools needed.** There are zero native npm dependencies, by design (see
  [`docs/adr/0001-stack-and-storage.md`](./docs/adr/0001-stack-and-storage.md)).
- Optional, needed for streaming and the tests: **ffmpeg** and **yt-dlp**.

## Quick start

```bash
npm install
npm run dev          # launches Electron with the Vite dev server and HMR
```

To verify a production build locally:

```bash
npm run build        # typecheck + bundle main, preload and renderer into out/
npm start            # preview the built app
```

---

## Verifying it works

Five independent checks, from cheapest to most convincing:

| Command | What it proves |
|---|---|
| `npm run typecheck` | Both TypeScript projects (`node` and `web`) compile under `strict` + `noUncheckedIndexedAccess`. |
| `npm run smoke` | **209 checks** against the real core: builds a throwaway library with ffmpeg, indexes it, rescans it, searches it, sorts and pages it, extracts cover art from a real file, resolves a playable URL, exercises range parsing, queue rules and display formatting, deletes a file to prove pruning, and watches a real folder to prove that a file appearing or disappearing triggers an incremental scan by itself. It also validates YouTube link parsing and the sidecar argument policy, exercises the stream proxy against a local HTTP server (full and ranged requests, forwarded headers, a 403 retry, a second 403 and unknown tokens), and proves the resolver cache answers a second play without a second sidecar. No Electron involved. |
| `npm run runtime:check` | The three runtime bets still hold **inside Electron**: `node:sqlite` exists, FTS5 works, and `music-metadata` (ESM-only) loads from CommonJS. Run this after every Electron upgrade. |
| `npm run selftest` | **127 end-to-end checks**: launches the real app against a throwaway data directory, confirms React mounted, indexes two generated audio files (one with an embedded cover) *through the IPC bridge*, then **actually decodes, plays and seeks one** through the `player-media://` protocol. It drives the real UI — a click selects, a double click plays, the queue view lists the queue, the repeat/shuffle buttons cycle, clicking the now-playing area opens the full-window player (and asserts its backdrop really is the blurred, brightened cover with no hard separator over the controls), and Escape closes it **through its exit animation**. Clicking the queue button slides the panel in, and the panel's own rows, scroll fit and gradient shadow are checked before a press on the black space or the artwork shuts it again (a press inside it does not), and Escape unwinds one layer at a time. It then changes the artwork and click-behaviour settings through the actual `<select>` elements in Settings and measures what the DOM did with them — the box takes a 3:2 cover's proportions, the size presets resize it, and a single click plays or selects depending on what the setting says. It seeks the player bar's scrubber twice in a row, paused and playing, and asserts the bar shows the position just chosen rather than the one before it. It also checks that the player bar's ambience spans the whole bar rather than the now-playing tile, and clicks the volume button to prove it mutes and restores, then rolls the wheel over the control to check that one notch moves the level five percent, that it stops at the ends of the scale, and that the scroll is swallowed rather than passed on. Then it copies a real file into the watched folder and deletes it again, asserting that the library indexed and then forgot it with no user action at all, and that switching watching off really does stop it. Then it creates a playlist through the form, adds tracks from the library's selection bar and from a row's context menu, reorders it with Alt+Down and a synthesized drag (with its drop line), removes a row, plays it, renames it, saves the queue as a playlist from the player window, and deletes it. At 1200x780 — narrow enough that the playlist's own pane has only ~670px once the sidebar and the index have taken their share — it measures the title column and every visible header label, proving that no label paints over its neighbour, that the artist is still shown and Format is gone, then drags the splitter 64px, presses ArrowLeft twice, and asserts the width that lands in `config.json` is exactly the one on screen. It also resizes the window to 1200x780 and 940x580 and asserts that **no view, including the player window, overflows sideways**, and that the playlist's row buttons stay inside its card - the only thing that catches a layout that slides out of the window. Finally it reloads the whole renderer, which throws away every queue held in memory, and asserts that the track, the queue and the position come back from disk, paused. It also opens the play-a-link dialog, proves the Play button stays disabled until something is typed, submits an invalid link and asserts the inline error keeps the dialog open, then closes it with Escape. Last, it registers a token in the real stream proxy against a local HTTP server and plays, seeks and pauses that URL through `player-stream://` in the production build — the check that the scheme, the proxy, the CSP and the `<audio>` element all agree. Exits non-zero on failure. |


The self-test is the one that matters most. A renderer that fails to mount, or a protocol handler that refuses every
request, otherwise just shows a blank window with a clean log.

At 10,000 tracks, on the machine this was developed on: a cold scan takes about 11 s (an incremental rescan about 2–3 s,
because it only stats files), the first page of 400 loads in about 12 ms, a search returns in about 2 ms, the database is
5.9 MB, the window shows the library in about 0.5 s, and a double click starts audio in about 50 ms (median of three
runs). The fixtures are 5 KB WAVs, so the scan number is a floor rather than a promise for real albums: tag parsing, not
SQLite, is what grows with real files.

Streaming was measured separately: a 20-link sample resolved **20/20** through yt-dlp with a median of **8.8 s** and a
maximum of 10.2 s; every one was a 108–143 kbps webm/opus stream, and all 20 answered a byte-range request with `206`.
A cached resolve inside the app takes about **1 ms**, which is why the design warms the cache when the link is pasted.
The table and the reasons the M3 exit target of “< 3 s to first audio” needs a resident sidecar are in
[`docs/notes/yt-dlp-sample.md`](./docs/notes/yt-dlp-sample.md).

---

## Architecture

Four layers, with one rule that keeps the code honest:

```
src/main/      Electron: window, IPC, the player-media/player-stream protocols, service wiring
src/preload/   the only bridge; exposes window.player via contextBridge
src/renderer/  React UI (never touches the filesystem)
src/core/      library, database, settings, logging   ─┐ neither of these may
src/engine/    IMediaResolver + resolver implementations ─┘ import electron
```

**Rule: `src/core/**` and `src/engine/**` must never import `electron`.** They are plain Node. That is what lets
`tools/smoke.ts` test scanning, database migrations, FTS search, file identity and range parsing in a plain Node
process, and it is what would survive a change of desktop framework.

### How audio reaches the speakers

The renderer never sees a file path. It asks the main process to resolve a track and gets back a URL for the custom
`player-media://` scheme:

```
renderer  ──resolveSource(track)──▶  main
          ◀── player-media://media/?path=…  ── LocalFileResolver
<audio src="player-media://…">  ──▶  protocol.handle → 200 / 206 with byte ranges
```

Three reasons this indirection exists rather than using `file://`:

1. **It is an allowlist.** Only paths inside a configured library folder are served; anything else gets `403`. A
   `file://` URL from the renderer would make every file on disk readable.
2. **Seeking needs byte ranges.** The handler implements `Range` requests itself (see `src/shared/range.ts`), which is
   what makes the seek bar work on a large FLAC.
3. **It was the template for streaming.** `player-stream://` repeats the pattern for remote audio: the renderer holds
   only an opaque token, while the main process forwards ranges and headers to the signed CDN URL.

### How a YouTube link reaches the speaker

A pasted link goes to `YouTubeResolver` (`src/engine/youtube-resolver.ts`), which runs
`yt-dlp --ignore-config --no-playlist -f "bestaudio[abr>=128]/bestaudio/best" -J` (the default *high* tier) and caches
the answer for the session. The signed CDN URL and
the headers it needs never cross the bridge: `RemoteStreamProxy` keeps them, registers the video under a `randomUUID`
token, and returns `player-stream://stream/<token>`. The proxy forwards `Range` and the headers yt-dlp reported, and on a
401/403/410 it re-resolves the video once and retries the same request, so a URL expiring mid-album does not stop
playback; the token stays the same, which is what makes that retry invisible to the `<audio>` element. A 25 s timeout and
`taskkill /T` stop a hung sidecar. `--ignore-config` is not optional: a user's `~/.yt-dlp.conf` can add cookies, archive
files and output templates, any of which changes what the app does.

`webPreferences` sets `contextIsolation: true`, `nodeIntegration: false`, and the built HTML ships a strict CSP
(injected at build time only, because Vite's dev server needs inline scripts). **Every custom scheme the UI loads a
resource from must be listed in that CSP** — a missing entry blocks the request before it ever reaches the protocol
handler, which then looks like a broken handler rather than a policy problem.

### How artwork reaches the screen

Cover art takes the same route, with one difference: it is *derived* data, so it is produced on demand and cached.

```
row renders ──artworkKey? no──▶ getArtwork(trackId) ──▶ main
                                                        │ music-metadata reads the picture
                                                        │ nativeImage resizes to ≤512px
                                                        │ sha1(content) + ext = cache key
                                                        ▼
                                    cache/artwork/<sha1>.jpg  (content-addressed, shared per album)
renderer  ◀── player-art://art/<key>  ──▶ protocol.handle → the bytes, cached immutable
```

The database column behind it has three states, and all three are load-bearing: `NULL` (never looked at, so the renderer
knows to ask), `''` (looked at, no cover — a negative cache, so an album without art is not re-parsed forever), and a
filename (the answer). An album's cover is extracted once and reused by every track on it.

### Storage

| What | Where |
|---|---|
| SQLite database | `<userData>/library.db` (WAL mode) |
| Settings | `<userData>/config.json` (written atomically) |
| Logs | `<userData>/logs/player.log` (rotated at 5 MB) |
| Artwork cache | `<userData>/cache/artwork/<sha1>.<ext>` |
| Downloads | `<userData>/downloads` (reserved for M4) |

`<userData>` is `%APPDATA%\Player` on Windows. All of these paths are shown in **Settings → Storage & diagnostics**.

The schema is versioned with SQLite's `user_version` and migrated in `src/core/db/schema.ts`. Migrations are
append-only: add a new entry, never edit a shipped one.

---

## Project layout

```
src/
  main/
    index.ts            app lifecycle, single-instance lock, --selftest mode
    window.ts           BrowserWindow + renderer failure logging
    ipc.ts              every IPC handler, plus input validation
    schemes.ts          privileged-scheme registration (must run before ready)
    media-protocol.ts   player-media:// handler (range requests, allowlist)
    artwork-protocol.ts player-art:// handler (content-addressed cache)
    artwork-service.ts  extract → resize → cache covers, deduped per album
    media-keys.ts       global media-key shortcuts → playerCommand events
    selftest.ts         the end-to-end harness behind `npm run selftest`
    broadcast.ts        main → renderer event fan-out
    services/container.ts   the whole dependency graph in one place
  preload/index.ts      contextBridge surface (the only way to reach main)
  core/
    db/                 driver (the only node:sqlite import), schema, migrations
    library/            scanner, tag reading, artwork extraction, repository, library service
    settings/           defaults, deep merge, atomic writes
    logging/            file logger with rotation
    paths.ts            all app-owned locations, derived from one root
  engine/
    resolver.ts         MediaResolver interface + registry
    local-file-resolver.ts
    sidecar/            locating and version-probing yt-dlp / ffmpeg
  renderer/src/
    App.tsx             composition root
    components/         Sidebar, LibraryView, TrackList, QueueView, SettingsView, PlayerBar, NowPlayingView, SeekBar, ArtworkImage, Icons
    hooks/              useSettings, useLibrary, usePlayer, useArtwork, useKeyboardShortcuts
  shared/               types, the IPC contract and pure helpers (queue rules, URLs, ranges, formatting)
tools/
  smoke.ts              core smoke test (real files, no Electron)
  runtime-check.cjs     Electron runtime assumptions
docs/adr/               architecture decision records
```

### Notable details

- **The IPC contract is one file.** `src/shared/ipc.ts` defines channels, the `PlayerApi` interface, event payloads and
  the token-based subscription scheme. Adding a channel without wiring both ends is a compile error.
- **Subscriptions return tokens, not closures**, because returning a function across `contextBridge` is not part of the
  documented serialisation contract.
- **All settings patches are validated in main** (`sanitizeSettingsPatch`). This is not ceremony: `libraryFolders` *is*
  the media allowlist, so anything that can widen it is checked at the boundary.
- **Scan writes are batched in transactions** (250 tag reads in parallel, then one commit), so a 10 000-file scan pays a
  few hundred fsyncs instead of 10 000.
- **Pruning only happens on a full library scan.** A single-folder scan can never delete rows belonging to another
  folder; removing a folder explicitly forgets its tracks.
- **Player state lives on the `<audio>` element**, and React state is only a mirror for rendering — the element is the
  source of truth for position and pause.
- **The queue is one ordered array.** Shuffle reorders it and keeps the original order aside, so turning shuffle off
  restores what the user actually queued. The rules live in `src/shared/queue.ts` as pure functions (`nextDecision`,
  `shuffleFrom`) precisely so `npm run smoke` can pin down the off-by-one cases without a browser.
- **The library list is virtualized.** Only the visible rows plus an overscan are in the DOM, the grid container is a
  single tab stop owning `aria-activedescendant`, and sorting is applied in SQL over the whole library (not the loaded
  page) with `id` always appended so paging is a total order.
- **The player window covers the app rather than replacing it.** The views behind it stay mounted, so opening and closing
  it does not reset the list's scroll position and cannot remount the `<audio>` element mid-track. Closing is a two-step
  state (`nowPlaying` + `nowPlayingClosing`) rather than a plain toggle, because the element has to survive the length of
  the exit animation.
- **The player bar's ambience spans the whole bar.** It used to be a tint confined to the now-playing tile, which read as
  a lit rectangle with a border sitting inside a flat bar — visibly a *box*, which is the opposite of ambient. It is now
  one cover stretched across the bar and masked to nothing on all four sides. Two nested layers carry the mask, one axis
  each: a single ellipse wide enough to cover the bar is still near its centre at the far edge, and a `mask-composite` of
  two gradients makes the result depend on which end of the list the browser treats as the base. Nesting has no such
  ambiguity. The horizontal inset is exactly zero, too — a negative one makes the element's border box stick out of the
  bar and shows up as horizontal overflow in `npm run selftest` even though nobody can see it.
- **Artwork shape is one preference, published as a data attribute on `.app`.** The rule is "all cover art", so it is
  decided in one place and every surface follows — a 24px row thumbnail goes round at the same time as the player
  window's cover, without either knowing about the other.
- **Artwork fit is the opposite: it is the player window's large artwork only.** A wide cover fitted into a 24px tile is
  a two-pixel stripe, so thumbnails always crop. And fitting does not letterbox: the box itself takes the cover's
  proportions, because a letterbox in a frame with a border and a shadow still reads as a square box with dead bands in
  it, which was the whole complaint. `ArtworkImage` reports the decoded cover's ratio as `--art-scale`, and
  `min(size, size * ratio)` fills the box on the constraining axis so the other one follows. The ratio is unknown until
  the image decodes, so the fallback of `1` reserves a full-size square and the artwork settles into its own shape rather
  than collapsing to nothing and jumping back.
- **A circle only exists on a square, so round artwork is always cropped.** Fitting a 3:2 cover into a round frame
  produced an oval that cut the corners off the cover the setting had just promised to show whole. The shape wins, the
  Settings view disables the fit control while round is selected so it is not silently ignored, and a CSS rule holds the
  line for anyone whose stored settings say otherwise.
- **The artwork's shadow is two shadows, neither of them a slab.** A single 26px-offset, 60px-blur shadow spreads 60px in
  every direction, which parks a dark rectangle under the cover — the one hard edge in a window that is otherwise all
  gradient. A tight contact shadow keeps the cover from looking pasted on, a wider one with a *negative* spread keeps the
  depth under the artwork instead of beside it, and both offset in proportion to `--np-art-size` so a large cover does not
  get a small shadow.
- **The artwork size presets are a multiplier, not a pixel value.** The band the cover sits in is whatever the window
  leaves over, so a fixed size is too small on a large screen and too tall on a short one. Each preset scales the
  viewport-relative size instead, including in the short-window media query, which is where a wholesale override would
  quietly make the setting do nothing on exactly the windows where it matters most.
- **The cover's proportions come from whichever of two signals notices first.** An image that is already decoded fires no
  load event, so switching fitting on while the player window is open — with the cover cached and the element reused —
  left the box square with no error anywhere. `ArtworkImage` reads `complete` in an effect as well as `onLoad`, and the
  self-test toggles the setting with the window open to keep it that way.
- **Click behaviour is two independent dropdowns rather than one mode.** "Select on click, play on double click" and
  "play on click" are both conventions in wide use, and any single-mode control would have had to guess at the other
  gesture. One consequence is worth knowing: a double click *is* two single clicks followed by the double-click handler,
  so setting both to "play" would restart the track the first click just started. The row handler skips the repeat when
  the track it would start is already the one playing, which is the only case where the second click could be heard.
- **The volume slider is not a second progress bar.** The accent colour now means playback position and nothing else —
  which is why both volume sliders are neutral, including the one in the bar that sits directly under the seek bar. In the
  player window the volume button is a mute toggle and the slider is folded away until the pointer or the keyboard is on
  it. The slider is *rotated* rather than written vertically (the track and thumb pseudo-elements stay in the horizontal
  coordinate space they are documented in) and is centred by `position: absolute` rather than by the parent's alignment,
  because an item wider than its grid track is aligned to the track's *start*, not centred on it.
- **Its background is ambient colour, not a picture.** The cover is brightened and saturated *before* it is dropped to
  opacity; a dark cover blurred to 46px at 60% over an already-black window is invisible everywhere except where it
  happens to be brightest, which is exactly how this first shipped as a smudge in one corner. A wash layer reaches every
  corner so no frame goes dead, and the scrim is a vignette — brightest behind the artwork, landing the bottom on the app
  colour — rather than a curtain.
- **The wash is deliberately colourless**, because it cannot know what it is looking at. Tinted with the accent it reads
  well over a blue sleeve and turns an orange one to mud; as a neutral lift it holds the floor without ever fighting the
  cover's own colour. That split — the filter supplies brightness, the wash supplies the floor — is also why the
  saturation can stay modest instead of being cranked up to compensate.
- **Its blurred backdrop gets its own clipping layer.** The backdrop is deliberately wider than the window (a blurred
  image otherwise samples transparent pixels outside the element and shows a halo), and `overflow: hidden` on the parent
  is *not* enough: a transformed descendant still counts as scrollable overflow, which is exactly the kind of thing the
  layout checks in `npm run selftest` catch.
- **A seek publishes its own position.** `timeupdate` fires a few times a second, so moving `currentTime` and letting the
  element report back left the scrubber holding the position from *before* the seek. The next drag was then measured
  against that stale number, which put the bar one seek behind the audio for the rest of the track — pull to 1:30 and it
  snapped to where it had been, pull to 2:00 and it went to 1:30. `seek()` now publishes the position it just committed to
  in the same event as the assignment, so the bar and the element agree immediately and the element's later reports only
  confirm it. The self-test seeks twice in a row — paused, where no `timeupdate` can paper over it, and again while playing
  — and asserts the bar shows the position just chosen each time.
- **The library follows playback.** A playing track that has scrolled out of the viewport is brought back into view — but
  only then. Re-centring on every auto-advance would yank the list out from under someone reading further down, and a
  current track that has not been paged in yet is deliberately left alone rather than pulling the rest of the library in.
- **Global shortcuts yield to a focused button.** Space on a focused button used to both click it and run the global
  play/pause, cancelling out; the handler now recognises an activatable target and stands aside.
- **The queue is a panel inside the player window, not a trip back to the Queue view.** Leaving the window to see what
  plays next loses the track that is playing, which is the one thing the window exists to show. It shares the artwork's
  grid band, so the header line, the close button, the transport and the button that opened it all stay exactly where they
  were — the same button slides it back out. The host clips it, because a sliding transform is scrollable overflow and an
  unclipped one makes the whole window scroll sideways. Escape unwinds one layer at a time, panel first, and is handled on
  the dialog rather than by the global shortcut so the two cannot both fire. It fades as it slides, on a curve that eases
  out of the start: sliding a fully opaque slab across a busy cover reads as abrupt however long it takes.
- **The panel's depth is a masked gradient, not a `box-shadow`.** A box-shadow along the left edge sits at full strength
  from the panel's first pixel to its last, and the host clips it at the top — so it *began* at a hard corner, a dark line
  that started and stopped, which over a light cover was the most conspicuous thing on screen. A `::before` carrying a
  horizontal gradient, masked away at both ends, fades in and out instead; dropping it to zero at the top is safe because
  the panel's own background and left border are what define the edge. The self-test asserts the mask is transparent at
  both ends, because this is exactly the sort of thing that quietly reverts.
- **A press outside the panel closes it.** The black space beside the artwork, the artwork itself, the transport row and
  the scrubber all count as outside, so the panel behaves the way it looks: an overlay you can dismiss by clicking away
  from it. It listens for `pointerdown` rather than `click`, so the panel is gone the moment the press lands rather than
  after the target has handled it, and it ignores presses inside the panel — a row is how a track is picked, and that
  already leaves the panel open. The queue button is excluded because its own handler toggles the panel; letting both
  fire would open and close it in one press.
- **The wheel over the volume control is a native listener.** React's `onWheel` is registered as passive, so it is not
  allowed to cancel the scroll it rode in on; the hook attaches a `{ passive: false }` listener instead and calls
  `preventDefault`. Level and setter go through refs so the listener is attached once and still sees the current volume —
  a listener closed over the value from its first render would only ever move the level one notch and then stop. One
  notch is five percent, Shift makes it one, and the value is rounded to the slider's own step so repeated notches cannot
  drift. The self-test checks the step, both ends of the scale and that the event really is cancelled.
- **Watching reacts to a change by scanning, rather than tracking files.** The OS watcher only says "something under this
  folder moved"; the scan then decides what it means, because it already skips every file whose size and mtime are
  unchanged and can therefore be run for free. Keeping a map of files in the watcher instead would mean duplicating the
  scanner's rules — the hidden-directory and extension filters, the tag reader's idea of what a track is — and the two
  would drift. It is also why a deleted folder or a moved file needs no special case: the scan prunes what is gone. The
  quiet period is 800 ms, so a copy or a tag editor's burst of writes lands as one scan, with a five-second ceiling so a
  long copy still gets picked up while it is running. A change that arrives mid-scan is queued rather than dropped, and
  the queue is drained by whichever scan finishes last — including a manual one — so nothing is missed; cancelling a scan
  clears it, because otherwise the scan the user just stopped would start again. `fs.watch` has no name for a folder that
  has been deleted, so the filter only applies to a file being *written*: a rename is always interesting, since a folder
  called `Album.2024` reads as a file.

- **A playlist's order is a number, and the number has room in it.** Entries are stored 1024 apart rather than as 0, 1, 2,
  3, so dropping a row between two others is one `UPDATE` at the midpoint instead of renumbering everything below the drop.
  Ten successive drops into the same gap still fit; when a gap finally closes, the playlist is renumbered in one
  transaction and the drop lands by index. The service, not the view, decides where a drop lands, and every mutation
  answers with the playlist as it now stands — a hand-ordered list has no client-side rule that could predict the result.
  The one exception is a drag, which is applied optimistically and then replaced by the answer, so the row lands under the
  pointer instead of snapping back for a round trip.

- **Rows are dragged with the platform's own drag events**, not a pointer-tracking reimplementation: the row stays a plain
  div, and the browser draws the drag image and handles the thresholds. `dragover` has to call `preventDefault()` or no
  drop is ever delivered, the drop line is an inset shadow (rows live in a translated window inside a scroller), and a
  `dragend` listener on the window cleans up a drag whose source row scrolled out of view. Alt+↑/↓ is the keyboard
  equivalent, not a fallback: it moves the row the keyboard cursor is on.

- **Playlists cascade.** An entry is a reference to a track row, and local tracks have no "temporarily unavailable" state
  yet, so `ON DELETE CASCADE` means a pruned track leaves every playlist with it rather than leaving a row that points at
  nothing. The scan already refuses to prune folders it could not enumerate, so an unmounted drive does not quietly trim
  playlists.

- **The play state is a snapshot, not a queue table.** One row holds a JSON array of ids, the cursor and the position.
  Nothing ever queries *into* it — it is read once at start-up and rewritten as a whole — so a table of rows would buy
  nothing and cost a join on every save. It is written on a one-way channel, because the moment the position matters
  most is the moment the window is closing, where awaiting a reply is not an option. On load, ids that no longer exist
  are dropped and the cursor moves to a track that survived, so a queue can never come back pointing at nothing.

---

## Known gaps

- No playlist import/export (M3U/JSON, M6), no smart playlists (M5), and no per-playlist retention override.
- Stream links are session-only: playing one leaves the last local queue in the resume slot rather than a queue that
  cannot be rebuilt. YouTube tracks join the library in M5; caching and downloading are M4.
- Resolving has no Cancel button. Closing the dialog discards the result, but the sidecar finishes in the background and
  warms the cache, so retrying the same link is instant.
- The first play of a link takes 7–10 s because yt-dlp is started per resolve. A resident sidecar (or resolving on
  selection) is the next step if that is too slow; the numbers are in the sample note.
- No YouTube search or catalogue browsing, by design (M5 is a link/playlist import, not a browser).
- No "select all N matching" (selection covers the loaded rows).
- A restored queue remembers what was playing, not where it came from: if shuffle was on, the saved order is the
  shuffled one, so turning shuffle off after a restart cannot bring back the pre-shuffle order for that session.
- The saved position is at most a few seconds old while playing, because it is written at most every five seconds; a
  pause writes it immediately.
- A playlist is loaded whole rather than paged: fine for thousands of rows because the list is virtualized, but a
  100 000-track playlist would still cross the IPC bridge in one message.
- Watching only covers the session it runs in: files added or removed while the app was closed are picked up by the next
  scan (adding a folder, or Rescan). A folder that is missing when watching starts — an unmounted drive — is watched only
  after the folder list changes or the app is restarted; `fs.watch` needs the directory to exist.
- Search is prefix-AND only; no fuzzy matching or field-scoped queries.
- `sandbox: false` on the renderer, because the preload bundle is CommonJS. Hardening item for M7.
- No packaging/installer yet (electron-builder arrives in M7).

## Next steps

1. M4 (retention: cache / keep) is the next milestone. The stream path is in place, so caching has somewhere to hook in.
2. M3's exit criteria still need a 50-link run and a latency decision: 20/20 resolved, but at a median of 8.8 s. See
   [`docs/notes/yt-dlp-sample.md`](./docs/notes/yt-dlp-sample.md) and the first spike in
   [`docs/notes/yt-dlp-spike.md`](./docs/notes/yt-dlp-spike.md).
3. M0 leftovers: the Downloads wireframe (it arrives with M4) and the remaining 30 links of the 50-link exit check.
