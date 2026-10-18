# Player

A desktop music player for Windows. It plays from your **local library** today; streaming and optional downloading from
YouTube via a yt-dlp sidecar is the next phase.

The full plan lives in [`ROADMAP.md`](./ROADMAP.md). This README covers what is **actually built right now**.

---

## Status: M1 in progress — a usable local music player

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
- Settings persist to `config.json`; retention and engine settings are stored and validated but not yet acted on.
- The engine layer reports whether `yt-dlp` and `ffmpeg` are present and runnable (used from M3).

Not built yet (deliberately): playlists, file watching, gapless playback, SMTC / tray icon, the yt-dlp resolver,
caching, downloads, packaging.

---

## Requirements

- **Node.js 22.12+** (Node 24 recommended) — the app uses `node:sqlite` and `require(esm)`.
- **No native build tools needed.** There are zero native npm dependencies, by design (see
  [`docs/adr/0001-stack-and-storage.md`](./docs/adr/0001-stack-and-storage.md)).
- Optional, only needed for the tests and for M3+: **ffmpeg** and **yt-dlp**.

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

Four independent checks, from cheapest to most convincing:

| Command | What it proves |
|---|---|
| `npm run typecheck` | Both TypeScript projects (`node` and `web`) compile under `strict` + `noUncheckedIndexedAccess`. |
| `npm run smoke` | **111 checks** against the real core: builds a throwaway library with ffmpeg, indexes it, rescans it, searches it, sorts and pages it, extracts cover art from a real file, resolves a playable URL, exercises range parsing, queue rules and display formatting, and deletes a file to prove pruning. No Electron involved. |
| `npm run runtime:check` | The three runtime bets still hold **inside Electron**: `node:sqlite` exists, FTS5 works, and `music-metadata` (ESM-only) loads from CommonJS. Run this after every Electron upgrade. |
| `npm run selftest` | **88 end-to-end checks**: launches the real app against a throwaway data directory, confirms React mounted, indexes two generated audio files (one with an embedded cover) *through the IPC bridge*, then **actually decodes, plays and seeks one** through the `player-media://` protocol. It drives the real UI — a click selects, a double click plays, the queue view lists the queue, the repeat/shuffle buttons cycle, clicking the now-playing area opens the full-window player (and asserts its backdrop really is the blurred, brightened cover with no hard separator over the controls), and Escape closes it **through its exit animation**. Clicking the queue button slides the panel in, and the panel's own rows, scroll fit and gradient shadow are checked before Escape unwinds one layer at a time. It then changes the artwork and click-behaviour settings through the actual `<select>` elements in Settings and measures what the DOM did with them — the box takes a 3:2 cover's proportions, the size presets resize it, and a single click plays or selects depending on what the setting says. It seeks the player bar's scrubber twice in a row, paused and playing, and asserts the bar shows the position just chosen rather than the one before it. It also checks that the player bar's ambience spans the whole bar rather than the now-playing tile, and clicks the volume button to prove it mutes and restores. Finally it resizes the window to 1200x780 and 940x580 and asserts that **no view, including the player window, overflows sideways** — the only thing that catches a layout that slides out of the window. Exits non-zero on failure. |


The self-test is the one that matters most. A renderer that fails to mount, or a protocol handler that refuses every
request, otherwise just shows a blank window with a clean log.

---

## Architecture

Four layers, with one rule that keeps the code honest:

```
src/main/      Electron: window, IPC, the player-media protocol, service wiring
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
renderer  ──resolveSource(trackId)──▶  main
          ◀── player-media://media/?path=…  ── LocalFileResolver
<audio src="player-media://…">  ──▶  protocol.handle → 200 / 206 with byte ranges
```

Three reasons this indirection exists rather than using `file://`:

1. **It is an allowlist.** Only paths inside a configured library folder are served; anything else gets `403`. A
   `file://` URL from the renderer would make every file on disk readable.
2. **Seeking needs byte ranges.** The handler implements `Range` requests itself (see `src/shared/range.ts`), which is
   what makes the seek bar work on a large FLAC.
3. **It is the seam for streaming.** In M3 the local branch is joined by a branch that proxies a yt-dlp stream, and the
   renderer keeps handing the same kind of URL to the same `<audio>` element.

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

---

## Known gaps

- No file watching: the library changes only when a scan runs.
- No playlists yet, and no "select all N matching" (selection covers the loaded rows).
- Search is prefix-AND only; no fuzzy matching or field-scoped queries.
- `sandbox: false` on the renderer, because the preload bundle is CommonJS. Hardening item for M7.
- No packaging/installer yet (electron-builder arrives in M7).

## Next steps

1. Finish M1: file watching, playlists, and gapless playback.
2. The yt-dlp engine spike from ROADMAP.md §13, which is unblocked: `npm run smoke` already shows both binaries found.
3. Then M3 (streaming resolver), M4 (retention: cache / keep).
