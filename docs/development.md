# Suura — development notes

Suura is a desktop music player for Windows. It plays from a **local library** and streams YouTube links you paste in
through a yt-dlp sidecar — and, when you ask it to, saves a track into the library as an ordinary tagged file.

This document is the engineering record: what is built, how it works, how it is verified and what is still missing. For
installing and using the app, read the [README](../README.md) instead. The full plan lives in
[`ROADMAP.md`](../ROADMAP.md); the code below is what is **actually built right now**.

---

## Status: M1–M7 and M12 complete, including the visual revamp (Home dashboard, merged **All tracks**, album/artist detail, playlist hero). M8 Windows release engineering is in progress: the per-user installer, local diagnostics export, renderer sandbox and the headless performance gate are done; signing, auto-update, opt-in crash reporting, bundled sidecars, the compatibility/accessibility pass and a CI runner for that gate remain.

Working today:

- Add music folders through the native folder picker; they are scanned recursively.
- Tags are read with `music-metadata` (title, artist, album artist, album, track/disc, year, genre, duration, codec,
  bitrate, sample rate, channels).
- Tracks are listed in a **virtualized, sortable** library list with search (SQLite **FTS5**). Click selects, double
  click (or Enter, or the hover play button) plays. Sort by any column from the header. The columns are
  **#, Title, Artist, Album, Duration, Action**; the last one opens the row menu (or right-click), where **Details** shows
  the technical sheet — format, codec, bitrate, sample rate, channels, file size, path, added and last played, plus the
  YouTube video a saved track came from. The list fits the window at any size instead of scrolling sideways: the Album
  and Artist columns drop out as it narrows, and the Album column can be turned off outright in Settings for local lists.
- **Smart Library views** (M5): a chip row above the list switches between **All**, **Recently added**, **Most played**,
  **Never played** and **YouTube**, each showing its count. The first four are answered in SQLite, so they cover the whole
  library rather than the loaded pages: *Recently added* is the last **30 days** and opens newest first, *Most played*
  opens in play-count order, and *Never played* is the complement. Search applies inside the chosen view, and clicking a
  column header still overrides the view's natural order. **YouTube** folds the played-link history into the same table
  instead of sending the user to a separate screen: those rows support Play, multi-select, Add to queue, Save to
  library, and a row menu with Details and Remove from history. They stay marked as the current row and remain links
  until saved — they are not counted as local tracks or included in the local filters.
- **Home** (visual revamp): a dashboard over the same library, with a cover-led hero and track/album/artist/disk totals,
  **Recently played** and **Recently added** shelves, artist cards that open that artist's tracks, and playlist cards
  that play the list (the card's `…` opens it in Playlists for editing). Below it, one searchable **All tracks** list
  merges local files, counted stream listens, imported playlist entries and remembered links, newest activity first,
  with a **Source** column and the same save action YouTube rows get elsewhere; the filter chip and search sit in a
  toolbar under the heading. A one-track album is a single, so its card plays the song; a real album opens in place with
  its tracks, selection bar, context menu, Play/Queue and a Back button. Covers are requested only as cards approach the
  viewport. A fresh install starts on Home; Settings → General can choose it explicitly or pick another launch view.
- **Cover art** is extracted from embedded tags, resized, and cached content-addressed; rows and the player bar show it,
  with a placeholder when a file has none. **Settings → Appearance** chooses the theme (Midnight, Cream or Follow Windows),
  one of five contrast-checked accents, Compact/Comfortable/Spacious density, four text sizes for the whole interface,
  Modern or Classic sidebar glyphs, solid or accented panels, and the motion preference. Explanations sit behind small
  info icons. It also chooses whether artwork is drawn square or circular, whether the
  player window's large cover is cropped to a square or given the cover's own shape, how much of the window's artwork
  band it may fill, and how large playlist covers are (four presets each, from small to extra large). The column controls
  are grouped by list family: **Local lists** can hide Album, and **YouTube lists** can hide Channel in imported playlists.
  YouTube Links always show Channel (plus Artist when YouTube reports a separate one), and imported playlists always keep
  Album. Extra Large text stays usable because the fixed columns scale with the text preset instead of pinning to a pixel
  width.
- A player bar with play/pause, previous/next, seek, volume, and a **queue** you can open, jump around, remove from and
  clear. The Queue view carries the same **#, Title, Artist, Album / playlist, Duration, Action** header as the library,
  aligned with its rows.
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
- **Consecutive tracks are prepared on an idle second element.** Local files are always preloaded; YouTube follows when
  prefetch is on. The next track starts as the current one ends, without the reload that would otherwise leave a gap.
  The **Windows media overlay (SMTC)** and **taskbar thumbnail controls** mirror the same track and drive the same
  transport.
- **A mini player and a tray icon** for when the full window is in the way. The mini player is the same renderer and the
  same playback deck resized into a compact panel — cover, title, scrubber, transport and volume — so expanding it is
  instant and never restarts a track. It stays above other windows until it is expanded or closed. The tray menu shows
  and hides the window, toggles the mini player, and carries play/pause, previous, next and quit. **Close to tray** is an
  opt-in setting; without it, closing the last window quits as usual.
- **Files and folders can be dropped on the window.** A folder becomes a library folder; an audio file is added through
  its folder, because the library is indexed by folder and the overlay says so. Non-audio files are refused, and a folder
  already covered by a library root is scanned once rather than added twice.
- **Keyboard shortcuts** (space, arrows, N/P, M, Ctrl+F, Escape) and the Windows **media keys**.
- Rescans are incremental: a file whose size and mtime are unchanged is never opened again.
- Deleting or moving files is reflected on the next full scan.
- **The folders are watched**: an album copied in appears by itself, and a file that disappears is forgotten, without
  pressing Rescan. Watching can be switched off in Settings for a library on a slow or network drive.
- **Playlists**: create, rename and delete them from the playlist index's `…` menu; add tracks from the library's
  selection bar, from a row's right-click (or Shift+F10) menu, or save the whole queue as a playlist from the player
  window. Rows are reordered by dragging or with Alt+↑/↓, and a playlist's order is kept exactly as the user set it.
  Each index row puts the name first, then the track count, a compact **List** or **Mix** badge and the menu, so a badge
  cannot shorten the name. **Play** is the accent action; **Add all**, **Save all** and **Re-import** stay neutral;
  **Remove** is red and asks for a second click. The list of playlists has a draggable splitter (arrow keys resize it
  too) and its width is remembered. The opened list uses the album page's hero: a large sleeve, the list's kind as a
  kicker, the name, track count and duration, then **Play**, **Add all** and the list's own actions above the rows. Track
  rows keep **Save** visible and move **Details** and **Remove** into the `…` menu. Every track list — the library, a
  playlist and the queue — shows title, the second column, album and duration; the title is the only flexible track,
  the second column and album are equal bounded widths, and Format lives in the
  row's **Details** sheet rather than in a column. The second column says **Artist** for local files and **Channel** for
  YouTube links and imported YouTube lists, because that is what the metadata actually holds. Local lists can hide Album;
  imported playlists always keep it but can hide Channel. YouTube Links drop Album entirely and show Title, optional
  Artist, Channel and Duration, so the optional Artist column appears only when yt-dlp reports an artist different from
  the uploader. Either metadata column drops out as a pane gets narrower rather than squeezing the title, and a long
  Artist or Channel name truncates then scrolls on hover. A shared footnote under both playlist panes keeps their bottoms
  aligned, while the index itself sizes to its playlists instead of stretching into an empty panel. List, Mix and Album
  badges are colour-coded but muted.
- **It picks up where it left off**: the queue, the track and the position are written down as they play and put back
  on the next start — paused, at the same spot, with tracks that have since been deleted left out.
- **The YouTube view** (M3): a sidebar entry under Library where a pasted YouTube link becomes a row that stays. Paste
  from the clipboard with the button in the field, or right-click the field and choose **Paste**, then **Add to queue**
  or **Play now**. Resolving takes 7–10 s, so a submitted link appears as a *Resolving…* row at once and fills in — or
  reports *Could not play this link* with Retry — instead of blocking on a dialog. The view is split into two boxes.
  **Imported playlists** has one row per imported list (cover, title, kind, count, owner) with **Play**, which replaces
  the queue with the whole list and starts it, and **Open in Playlists**; the list's YouTube id is in the row's tooltip
  so two lists that start with the same track can be told apart. A list without a sleeve uses its first entry's still
  as the card art. The box keeps the three most recent cards in view and scrolls for the rest. **Links** is the history:
  newest-activity first, and playing one lifts it; the box keeps seven rows in view and scrolls for the rest. Each row
  has artwork, title, channel, album and duration, keeps Download/Save and Add to queue as direct actions while
  Play, Details, Copy link and Remove live in the right-click (or ⋯) menu, and playing a row queues it together with
  the rows below it so Next walks the list. The history survives a
  restart even after the audio cache is cleared — it is a list of links, not files. It holds *only links the user
  added*: playing a track out of an imported list never echoes it back, and importing a list withdraws any row a play
  had already made for one of its entries, so a 50-track mix is one card above, not 50 rows in the history. After an
  import & play, the card being played is marked in place and follows the track it is on, with a pulsing indicator
  while it plays and *Paused* when it stops — there is no separate banner repeating it. The mark comes from app state,
  so stepping over to Playlists (or anywhere else) and back keeps it, and playing an imported list from the Playlists
  window lights up its card too. **Save to library** downloads the row (with its tags and cover), indexes it and turns
  the button into a tick; the row shows *Queued*, a percentage, then *Finishing* while it works. Saved rows are never
  downloaded twice. A compact **Saves** dock sits above the player bar from every view: it lists running, failed and
  just-finished saves, shows live speed and time remaining while a transfer runs, offers **Pause** and **Resume**
  (the paused job keeps its partial file), **Cancel** while a save is queued, downloading or paused, **Retry** after a
  failure or a cancellation, and **Reveal** once the file is in the library. The full **Downloads** screen is the
  durable view: it lists saved, failed, cancelled and removed saves from `download_history` alongside the offline cache.
  A crash or force-quit leaves no temp folder behind: the next start sweeps the downloads directory for this service's
  own UUID folders and `.part` files.
- **Search** (M5): the sidebar's **Search** view asks the local library and YouTube at the same time and puts both
  answers in one list. Every row says where it would play from: **Local** rows play a file immediately, **YouTube**
  rows run the same add-link path as a pasted URL, so they join the YouTube history and use the same resolve cache.
  YouTube results are metadata only — a search resolves nothing and writes nothing until a result is chosen. The
  YouTube half arrives **ten at a time**, in a result box with its own scrollbar, and a **pager** asks for the next ten
  without growing the first request. Rows offer **Play**, **Add to queue** and **Save to library**; a result's channel
  opens a page of that channel's recent videos in place, **ten at a time with its own pager**, and **Back to results**
  returns without losing the search. The view stays mounted for the session, so leaving Search and coming back keeps the
  query, results and open channel; restarting the app clears them. There is no recommendation feed and no automatic
  browsing: a query is a query, and the user starts it.
- **Cleaner YouTube metadata**: `Artist - Title (Official Music Video)` becomes artist **Artist** and title **Title**.
  Bracketed decoration (`Official Audio`, `Lyrics`, `4K`, `Remastered 2011`, …) is removed from pasted links, imports,
  search results and channel rows. `(Live)` is kept, because it names a different recording rather than decoration.
- **Playlist, album and mix import**: pasting a list link (a `PL…` playlist, an `OLAK5uy…` album or an `RD…`/`start_radio=1`
  mix) turns the button into **Import & play** and adds **Add all to queue**. The whole list is fetched in one flat
  `--flat-playlist` call (no per-track resolves), stored as a snapshot and shown in **Playlists** under **Imported**,
  beside the **Custom** lists the user made. An imported list can be renamed from its index row; the name is stored
  apart from YouTube's title, so **Re-import** refreshes the snapshot without undoing it, and the pane shows the list's
  YouTube id underneath. The pane lists every track individually and can play it, add it all to the queue, re-import,
  remove entries or delete the snapshot; each entry has its own **Save to library** button and the pane has **Save all**,
  which queues every entry that is not yet in the library. Above the tracks the opened list shows a square cover beside
  its title — an album's own sleeve, or the first track's still when the list has none. Two settings cap the fetch —
  *Playlist / album import limit* (200) and *Mix length* (50) — because a mix never ends, and a **Tracks** box beside
  **Re-import** overrides the count for that snapshot (1–1000), which is how a mix or radio gets exactly the length you
  want. Account lists (`LL…`, `WL…`, `FL…`) and channel pages are refused with an explanation instead of a failed sidecar
  run: the app never signs in. A watch link that belongs to a playlist plays the video and offers to import the list
  separately; a mix link imports the mix, not its seed video.
- **Streaming playback** (M3): a resolved link plays through an internal `player-stream://` proxy that forwards `Range`
  and the signed URL's headers. The first play costs about 8 s because the sidecar starts for each resolve — the
  50-link measurement put the median at **8.3 s**, with the CDN's first bytes arriving 0.46 s after that; the second play
  of the same link in a session is instant, and a URL that expires is re-resolved once if the CDN answers 403. The `< 3 s`
  target is therefore a **warm** target (cached or prefetched playback, which meets it), while a cold paste has a
  **≤ 10 s** display target and shows *Resolving…* while it waits. See
  [`docs/notes/yt-dlp-50.md`](./notes/yt-dlp-50.md). The player
  bar marks a stream with a **YouTube** badge. Four seconds into a stream the app
  resolves the *next* queue entry in the background while **Prefetch the next track** is on (the default), so the
  7-10 s sidecar run happens while the current song is still playing and pressing Next (or reaching the end) only waits
  for the CDN's first bytes. Turning prefetch off in Settings sends one fewer speculative request per track. Only the resolve is brought
  forward — the audio itself is still streamed on demand by the `<audio>` element, not downloaded ahead. Next cuts the
  outgoing track off at once — the old source is paused before the new one is resolved, so the previous song never plays
  on under the spinner. A stream that has started and then runs dry says **Buffering…**; if it stays down, the
  reconnecting state takes over. Nothing is added to the library by streaming alone, and a stream queue is not restored
  after a restart.
- **Offline cache and retention** (M12a + M12b): Settings → Streaming chooses what happens after a YouTube track plays.
  **Stream only** is the default. **Save played tracks** keeps a bounded cache for offline replay, and **Keep after
  play** auto-saves into the library through the same path as *Save to library*. The cache is separate from saved
  files: it writes `<userData>/cache/stream/<videoId>.<ext>`, downloads the full track in the background while the
  stream plays, and renames a `.part` file only when the download is complete, so a crash can never leave a row
  pointing at half a file. It is bounded by a size budget and a maximum age, evicts least-recently-used unpinned
  entries, and counts pinned entries without ever evicting them automatically. Playback resolves a cached copy first,
  so cached tracks replay with no network at all; an uncached YouTube track played offline fails with a clear "not
  available offline" message instead of an endless spinner. A free-space check skips a cache copy and refuses a save
  rather than filling the disk.
  The **Downloads** view has two ledgers. **Saved** shows every save in `download_history` — queued, downloading,
  paused, finishing, indexed, saved, failed, cancelled or removed — with live speed/ETA, Pause/Resume, Cancel, Retry and
  Reveal. It supports multi-select removal and bulk actions. **Offline cache** shows real usage against the budget, each
  entry's size and last use, per-entry **Keep** (pin), **Reveal** and **Remove**, multi-select removal and **Clear cache**.
  Pausing aborts the sidecar but keeps the UUID folder; Resume reuses that same folder with `--continue`, so the work
  already done is not thrown away. Removing a saved file deletes only a file inside a configured library folder, marks
  the library row missing, records the history row as `removed`, and keeps its playlist/queue identity. That row then
  plays from its YouTube origin instead of reporting a missing file. A cache file held open by the player cannot be
  deleted on Windows; its row stays and the UI reports that it could not be removed. Every save's progress is also
  written to `download_history`, so a failed or cancelled save survives a restart and can be retried from the Downloads
  screen or the Saves dock; a paused row is reported as failed at startup, because its abandoned temp folder is swept
  rather than trusted across restarts.
- Settings persist to `config.json`. The engine settings drive the resolver (binary folder, quality tier); the saving
  settings choose where saved files go (default `Music\Suura`) and in what container (Opus, MP3 or M4A), while the
  retention mode chooses between streaming, the bounded cache and keeping played tracks. Saving a track adds its
  folder to the library the first time, so the file appears without any further setup. Settings is now five tabs
  (**General, Appearance, Streaming, Misc, About**) with one scrollable panel at a time.
  Streaming uses one column of cards with two-column fields, so short cards and tall provider/cookie cards no longer
  leave a dead half-page; longer explanations sit behind the info tooltips instead of filling every card.
  Appearance is deliberately bounded: three themes (Midnight, the deep blue-black default; Cream, a warm off-white;
  Follow Windows tracks live OS changes), five accents, three densities, solid or accented panels, a motion preference,
  cover-art shape, and independent switches for the player's large cover and its cover-colour ambience. Accented adds an
  accent wash and a CSS blur over the app's own background rather than native acrylic/Mica, so it behaves the same on
  every Windows build; it deliberately does not claim to be an album-art frost. Reset appearance restores every choice on
  the tab. **General** chooses the launch view (last used by default, or Home, Library, YouTube, Search, Playlists,
  Downloads or Queue; a fresh install opens on Home; Settings itself is never restored), whether a full scan runs at launch, what a single or
  double click does, the volume-wheel step (5% by default, configurable 1–15, with Shift still 1%) and whether the
  restored local queue starts automatically; with that off, restored playback stays paused. Misc has a separate **Reset preferences** action: it
  restores playback, appearance, click behaviour, startup, backup retention, import limits, retention mode,
  cache budget and age, saving quality and request-budget choices, but keeps the library, the engine and download
  folders and the provider command. Each of
  General, Playback and Streaming also has its own reset button, and Appearance has its own reset, so one section can be
  restored without touching the others.
  The tab strip is keyboard-operable (arrows, Home, End) and the scrollable panels take focus, so the whole page can be
  used without a mouse. The Streaming tab also has the prefetch switch, a daily yt-dlp self-update, a PO Token provider
  section for the external bgutil HTTP server (with an optional command the app may start and stop), and a three-mode
  cookie fallback - off, once after a bot check, or always - with an optional browser profile. **About** lists the
  Suura, Electron, Chromium and Node versions and the yt-dlp/ffmpeg probe; **Copy diagnostics** writes versions, app
  paths, library-folder count and the user agent to the clipboard - no cookies, history, account data or library file
  paths. **Save diagnostics** writes that same snapshot plus the most recent log to a text file chosen with the native
  dialog. Nothing is uploaded; the saved file can contain local paths from the log.
- **Data care** (M7, complete): Settings → Misc can create a **backup folder** containing a consistent `library.db`,
  the settings and a manifest, and restore one from a folder picker. Restoring validates the database (integrity and
  schema), normalizes the settings through the same allowlist as the Settings form, copies the current library aside,
  then finishes on restart — before the database is opened. The app also writes a consistent database copy when the
  newest automatic copy is more than 24 hours old, and before any migration; the newest automatic/pre-migration copies
  rotate (10 by default, configurable 3–50 in Misc, with immediate pruning when lowered), and a backup written by a newer
  schema is refused rather than opened by an older build. A failed
  migration names the pre-upgrade copy in the error, and a failed restore leaves the old library in place with
  `restore-failed.json` beside it. **Library health** fingerprints whole files lazily, groups byte-identical copies,
  keeps the oldest row, carries playlist entries and play counts across, and deletes only the redundant file. A file
  that disappears stays as a hidden row, so its history and playlist entries survive; **Find moved files** matches it
  by stored hash first and then by size and modification time, without changing its id. The library's selection bar
  can also forget chosen rows without touching their files.
- The engine layer reports whether `yt-dlp` and `ffmpeg` are present and runnable, and the resolver uses them.

Not built yet (deliberately): optional crossfade, app auto-update, opt-in crash reporting and saved smart playlists (the
Library's fixed chips are views, not user-defined lists). Tag writing remains deferred: removing a download or clearing
the cache deletes files but never rewrites tags. Windows release engineering (M8) is in progress; the installer and
manual log export are the completed slices, and the rest is listed in [Next steps](#next-steps).

## Windows build

`npm run package:dir` produces an unpacked app under `release/win-unpacked/`; `npm run package:win` produces the NSIS
installer `release/Suura-<version>-Setup.exe`. Both run the full TypeScript check and production build first. The
installer is **per-user**: no administrator prompt, no machine-wide install. Uninstalling asks before deleting
`%APPDATA%\Suura` (default **No**) and never deletes music saved into `Music\Suura`.

The build is unsigned by default, so SmartScreen may warn. Signing and the release checklist live in
[`docs/release/windows.md`](./release/windows.md). The packaged app still expects externally installed `yt-dlp`
and `ffmpeg`; sidecar bundling is not done.

---

## Scope and legal

This is a music player, not a media downloader. The streaming phase is shaped to keep that true:

- **Streaming is the default; downloading is opt-in.** The retention setting defaults to stream-only, and no audio is
  written unless the user chooses *Save to library*, switches retention to the cache, or chooses *Keep after play*. A
  cache copy is counted against a visible budget and can be cleared at any time. (A stream's thumbnail is cached as
  artwork, like any cover.) There is no automatic download and no background mirroring of an imported list until *Save
  all* is pressed.
- **There is no catalogue browser.** Search is an explicit query the user types; it returns metadata rows and never
  walks recommendations, subscriptions or a channel's whole catalogue automatically. A track is still something the
  user brings: a local file, a link they paste, or one result they choose from a search.
- **`yt-dlp` is a sidecar, not the product.** It is named where it is configured, keeps its own licence and version, and
  the app does not bundle or fetch anything that circumvents DRM or paywalls.
- **The user carries the responsibility.** Downloading with `yt-dlp` can violate YouTube's Terms of Service and
  copyright law where the user lives. The app ships no media, and the download path is off by default.

Playing local files the user already owns is unaffected by any of this.

---

## Requirements

- **Node.js 22.12+** (Node 24 recommended) — the app uses `node:sqlite` and `require(esm)`.
- **No native build tools needed.** There are zero native npm dependencies, by design (see
  [`docs/adr/0001-stack-and-storage.md`](./adr/0001-stack-and-storage.md)).
- Optional, needed for streaming and the tests: **ffmpeg** and **yt-dlp**.

## Quick start

```bash
npm install
npm run dev          # launches Electron with the Vite dev server and HMR
```

To verify a production build locally:

```bash
npm run build        # typecheck + bundle main, preload and renderer into out/
npm run preview      # preview the built app
npm run package:dir  # build and package an unpacked app under release/win-unpacked/
npm run package:win  # build the per-user NSIS installer under release/
```

---

## Verifying it works

Seven independent checks, from cheapest to most convincing:

| Command | What it proves |
|---|---|
| `npm run typecheck` | Both TypeScript projects (`node` and `web`) compile under `strict` + `noUncheckedIndexedAccess`. |
| `npm run smoke` | **830 checks** against the real core: builds a throwaway library with ffmpeg, indexes it, rescans it, searches it, sorts and pages it, extracts cover art from a real file, resolves a playable URL, exercises range parsing, queue rules, taskbar control descriptors and display formatting, deletes a file to prove missing tracking, and watches a real folder to prove that a file appearing or disappearing triggers an incremental scan by itself. It also validates YouTube link parsing and classification (videos, a video inside a playlist, playlists, albums, mixes, and the account/channel refusals), the flat-playlist parser and its cap, the InnerTube search/channel parsers and duration parsing, the JPEG thumbnail candidates, the sidecar argument policy for both resolving and saving, the PO Token provider argument and URL/profile normalisation, the provider command splitter and a real local server start/stop through the manager (while leaving an external server alone), the legacy cookie migration, exercises the stream proxy against a local HTTP server (full and ranged requests, forwarded headers, a 403 retry, a second 403 and unknown tokens), proves the resolver cache answers a second play without a second sidecar, proves a prefetch of the next track fills the same cache so the play that follows needs no sidecar at all (and that a prefetch is a best-effort warm-up: an unclaimed track, a resolver without one and a failed warm-up are all quiet), drives the Online history repository against a real database file (dedupe, refresh, ordering by added and played activity, forgetting rows by video id, and the row-to-stream-track mapping with the two id spaces kept apart), drives the imported-playlist repository (snapshot replacement, position renumbering, a retained cover, a custom name that survives a re-import, explicit child deletion, and the first entry kept as the card's cover fallback), checks that all three retention modes survive a reload and invalid values fall back to the documented defaults, drives the stream cache against a local HTTP server (completed rename, no partial file, one shared fetch, low-disk skip, budget and age eviction, pinning, per-entry reveal and removal, stale-row cleanup and start-up leftovers), drives the download-history ledger (persisted cancel, start-up interruption and dismissal), that the startup sweep removes only this service's UUID temp folders and `.part` files, and that cancel rejects a running save, reports it as cancelled rather than failed, and removes its temp folder. It also pauses a save, presses Resume before the abort unwinds, asserts the resumed sidecar reuses the same UUID folder, removes the saved file from a playlist and asserts the row survives as a YouTube-backed track, parses live percentage/speed/ETA (including a three-part ETA), and checks that `--continue` is in the download arguments, validates the title/artist cleanup and the search/channel parsers against recorded yt-dlp JSON, checks the Library filter allowlist and the recent/most-played/never-played SQL and counts against a real database, scans a real file whose tag carries a YouTube URL to prove the saved-track origin round-trips, and exercises the data-care path against a real database: a manual backup folder with settings and manifest, SQLite `VACUUM INTO`, inspected backup integrity, one automatic backup per day, rotation of old automatic copies, refusal of a database written by a newer schema, and a staged restore that replaces the library on the next start while keeping the replaced copy aside. It also proves the data-care paths against a real database: identical files are grouped by SHA-256, a merge folds the newer row and its playlist entry into the oldest row, adds the play count and deletes only the redundant file, a moved file is hidden as missing while its playlist entry and id survive, relocation matches it by stored hash and, for a row that was never fingerprinted, by exact size and modification time, and removing a row from the library leaves its file on disk. It also proves that a dropped audio file becomes its parent folder and is scanned once, that a dropped non-audio file is refused, and that close-to-tray is off by default and restored by a preference reset. No Electron involved. |
| `npm run runtime:check` | The three runtime bets still hold **inside Electron**: `node:sqlite` exists, FTS5 works, and `music-metadata` (ESM-only) loads from CommonJS. Run this after every Electron upgrade. |
| `npm run selftest` | **about 330 end-to-end checks**: launches the real app against a throwaway data directory, confirms React mounted, that the window really has context isolation, no Node and the sandbox, and that the sandboxed preload still reaches `webUtils` for dropped files, indexes two generated audio files (one with an embedded cover) *through the IPC bridge*, then **actually decodes, plays and seeks one** through the `player-media://` protocol. It drives the real UI - a click selects, a double click plays, the queue view lists the queue under the same #/Title/Artist/Album/Duration/Action header as the library and measures that the header sits over its cells and clear of the subtitle, the repeat/shuffle buttons cycle, clicking the now-playing area opens the full-window player (and asserts its backdrop really is the blurred, brightened cover with no hard separator over the controls), and Escape closes it **through its exit animation**. Clicking the queue button slides the panel in, and the panel's own rows, scroll fit and gradient shadow are checked before a press on the black space or the artwork shuts it again (a press inside it does not), and Escape unwinds one layer at a time. It then changes the artwork and click-behaviour settings through the actual `<select>` elements in Settings and measures what the DOM did with them — the box takes a 3:2 cover's proportions, the size presets resize it, and a single click plays or selects depending on what the setting says. It seeks the player bar's scrubber twice in a row, paused and playing, and asserts the bar shows the position just chosen rather than the one before it. It also checks that the player bar's ambience spans the whole bar rather than the now-playing tile, and clicks the volume button to prove it mutes and restores (and the bar's own speaker icon after the window is shut), then rolls the wheel over the control to check that one notch moves the level five percent by default, that it stops at the ends of the scale, and that the scroll is swallowed rather than passed on. Then it copies a real file into the watched folder and deletes it again, asserting that the library indexed and then hid it with no user action at all, and that switching watching off really does stop it. Then it creates a playlist through the form, adds tracks from the library's selection bar and from a row's context menu, reorders it with Alt+Down and a synthesized drag (with its drop line), removes a row, plays it, renames it from its index menu, saves the queue as a playlist from the player window, and deletes it from that menu. At 1200x780 - narrow enough that the playlist's own pane has only ~670px once the sidebar and the index have taken their share - it measures the title column and every visible header label, proving that no label paints over its neighbour, that the artist is still shown, that Format is gone and that the library header is #/Title/Artist/Album/Duration/Action with a Details sheet behind its row menu, then drags the splitter 64px, presses ArrowLeft twice, and asserts the width that lands in `config.json` is exactly the one on screen (on a display too narrow to give the two-column layout it asserts the stacked fallback instead - splitter hidden, index full width, stored width untouched). It also resizes the window to 1200x780 and 940x580 and asserts that **no view, including the player window, overflows sideways**, and that the playlist's row buttons stay inside its card - the only thing that catches a layout that slides out of the window. Finally it reloads the whole renderer, which throws away every queue held in memory, and asserts that the track, the queue and the position come back from disk, paused. It also drives the YouTube view: seeds a history, checks the rows, channel, duration and sidebar count, reads the real clipboard through the Paste button, refuses a link that is not YouTube and an account list with no request sent, opens a row's right-click menu (Play, Add to queue, Copy link, Details, Remove, and a disabled Save to library), removes a row through its row menu, clears the history through its confirmation, seeds an imported album and drives the grouped Playlists view - Custom and Imported are separate, the album is labelled and opened, its tracks are in source order, the cap note says how many were kept, the YouTube id and the track count beside Re-import are shown, the list is renamed from its index menu and the new name reaches both the pane and the YouTube card, Re-import replaces Clear, removing an entry through its row menu renumbers the snapshot, playing it queues its remaining tracks and does **not** echo the entry into the YouTube history, the YouTube view shows the imported list as one card above the history while the history stays empty, the link history and imported box keep seven and three rows in view and scroll, right-clicking the link field offers Paste and fills it, the opened list shows a cover beside its title, playing it from the Playlists window marks its YouTube card (with the current track and 1 / 1), no separate strip appears, the mark survives a trip to another view, and removing the snapshot needs a confirmation - and asserts Copy link put the canonical `watch?v=` URL on the clipboard (read immediately, since the clipboard is global). It also drives the Library's smart chips against the seeded history: all five chips are present, **YouTube** lists the stream rows with save, queue and a row menu for Remove/Details, a local chip excludes them, and **All** returns to the local tracks. It also opens the Search view at both window sizes, measures that it has no sideways overflow, proves the result box (not the page) owns the vertical scrollbar, and checks that Settings shows five tabs, one panel at a time. It then drives the Appearance controls: Cream reaches `<html>` and paints the warm background, an accent reaches the CSS palette, Compact changes the virtualized row to 32px, Frosted adds the CSS blur, Reduced motion folds a transition, Extra Large text raises the body font, Classic swaps the sidebar glyph set, hiding Album and Channel collapses their cells, and Reset restores Dark/Blue/Comfortable/Solid/System/Medium/Modern with the Album and Channel columns and the 38px row. It also checks the tab strip's End/Home focus movement and the Misc reset: a changed click-behaviour select and the watch-folder switch go back, the confirmation and status appear, the library folder survives, and Misc exposes the backup/restore actions plus the backups folder, and that Library health offers duplicate and missing-file care. It also asserts that the library's selection bar offers Remove from library. Last, it registers a token in the real stream proxy against a local HTTP server and plays, seeks and pauses that URL through `player-stream://` in the production build - the check that the scheme, the proxy, the CSP and the `<audio>` element all agree. It also drives the new settings work: startup view and scan-on-launch, wheel step, automatic resume, backup retention, per-tab resets, runtime versions, the diagnostics clipboard and a saved diagnostics bundle with the recent log; the default restored playback is still proven paused, while the automatic-resume opt-in is then enabled and proven to play. Before the mini-player round trip it also lets a queued local track end and asserts that the next one was handed over by the prepared element (a performance mark is written only on that path), that Media Session exposes the current title, playback state, artwork and action handlers, and that the taskbar accepts the thumbnail-toolbar state while healthy playback leaves no buffering status on screen. Finally, it clicks the player bar's mini-player button, measures that the window became compact and the full layout hid, then expands it again and checks that the full window and player bar returned. It also switches Retention to Cache through the actual select, checks the budget and age controls appear and the mode is written back, opens the Downloads screen from the sidebar, asserts its Saved and Offline cache tabs, sees the seeded failed save with its error and Retry action, asserts the empty-cache state, exercises the cache and download-history IPC, and dismisses a failed save. Exits non-zero on failure. |
| `npm run perf` | Builds a real **10,000-file** library in a throwaway data directory, scans it, rescans it, pages it, searches it and then enforces the budgets: full scan, incremental rescan, first page, search, database size and main-process memory. It opens no window and needs no audio device, so it is the check that can run unattended; a miss prints the metric, the number and the budget, and the command exits non-zero. |
| `npm run scale` | The same 10,000-file library and the same core budgets, plus the two numbers a person actually feels: cold start (the window showing a full library) and first audio (a double click to sound, median of three). It needs a desktop, so it stays a manual run. |
| `npm run package:dir` + `release\win-unpacked\Suura.exe --selftest` | Packages the production bundles and runs the same end-to-end suite **from inside the packaged app**, proving the asar, preload and unpacked `music-metadata` modules all load. |


The self-test is the one that matters most. A renderer that fails to mount, or a protocol handler that refuses every
request, otherwise just shows a blank window with a clean log.

At 10,000 tracks, on the machine this was developed on: a cold scan takes about 10–14 s (an incremental rescan about
2–3 s, because it only stats files), the first page of 400 loads in about 20 ms, a search returns in about 5 ms, the
database is 5.5 MB and the main process sits at about 165 MB. The window shows the library in about 1.3 s, and the first
audio sample arrives about 100 ms after the double click (median of three runs; the player bar flips sooner than that,
because it reacts to the `play` event rather than to a decoded sample). The fixtures are 5 KB WAVs, so the scan number is
a floor rather than a promise for real albums: tag parsing, not SQLite, is what grows with real files.

`npm run perf` turns the core numbers above into budgets and fails the run when one regresses; `npm run scale` measures
cold start and first audio as well, which is why it needs a window.

Streaming was measured twice. The original 20-link sample resolved **20/20** with a median of **8.8 s**; the M3
exit sample then used **50** search-derived links and resolved **50/50** with a median of **8.3 s** (6.8–11.5 s), and
the CDN's first 2 KB arrived in a median of **0.46 s** after the resolve. Formats were webm/opus and m4a/aac, every
response was a `206` with the requested range, and no link hit a bot check or an unavailable video. A cached resolve
inside the app takes about **1 ms**, which is why the design warms the cache when the link is pasted and prefetches
the next queue entry. The `< 3 s` target is therefore met for **warm or prefetched** playback; a cold paste has a
**≤ 10 s** display target. Both samples and the reasoning are in
[`docs/notes/yt-dlp-50.md`](./notes/yt-dlp-50.md) and
[`docs/notes/yt-dlp-sample.md`](./notes/yt-dlp-sample.md).

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

The resolve cache is therefore the thing that makes a queue bearable, and the player feeds it: four seconds into a stream,
`usePlayer` asks the main process to `prefetch` the next entry (`media:prefetch` → `ResolverRegistry.prefetch` →
`YouTubeResolver.prefetch`), which runs the same sidecar and fills the same cache without registering a proxy token. It
is a guess about the queue, so it never records history and never fails the caller; a video id is only asked for once per
session, and the timer is dropped on every track change so skipping through a list does not spawn a sidecar per row. When
the next track does arrive, `resolve` finds the answer already there.

That resolve cache stores signed URLs, not audio. The optional **stream cache** is a separate layer: after a YouTube
track actually starts, `StreamCache` fetches its resolved URL into `cache/stream/<videoId>.<ext>.part`, then renames it
on completion and only then writes the `cache_entries` row. The play itself keeps streaming from the proxy, so caching
never delays the first note. One fetch is shared by concurrent plays of the same video, a low-disk check skips the copy,
and the janitor enforces the budget and age while pinning exempts a file from automatic eviction. A cache hit returns a
`player-media://` source, which is why cached tracks play with the network off; a miss with no network fails up front
with "not available offline" rather than waiting for a sidecar. `clear()` cannot unlink a file Windows still has open,
so it keeps that row instead of reporting a false zero.

### How a pasted link becomes history

The YouTube view is a list of *links*, not of files. Pasting one calls `online:add-link`, which resolves it (warming the
cache playback will read) and writes a row to the `online_tracks` table: the video id, the metadata yt-dlp reported, the
canonical `watch?v=` URL and two timestamps. Identity is the video id, so pasting the same link again refreshes one row
instead of adding another. Ordering is "most recent activity first", where activity is either being added or being played
— which is why `media:resolve` touches the row, so the row a user just played rises to the top. Because the row is only a
link, the history survives a restart (and an audio-cache wipe); nothing here is a `Track` and nothing is in the library.

A track that exists only inside an imported playlist never gets a history row. Its list is its home, so `media:resolve`
skips `rememberPlay` for those ids — `isImportedPlaylistTrackId` tells the two kinds of stream track apart — and playing
a fifty-track mix does not spray fifty copies into the link history. Importing a list also withdraws any row a play had
already made for one of its entries (`removeByVideoIds`), so the two views cannot both claim the same video. That is why
the view has two boxes: **Imported playlists** is one card per list (the whole list plays from there with one click),
and **Links** is the history of single links. The history is not a log of every track that ever sounded; it is the list
of links the user chose.
`onlineEntryToTrack` (`src/shared/online.ts`) turns a row into a session track with a *negative* id when it is played,
keeping it out of the tracks table by construction. **Save to library** is the download path (see below): it downloads
the video once, and the row then shows a tick.

Only the newest few are in view at once: three imported cards and seven links, each box scrolling for the rest, so the
page stays about the paste field instead of becoming a second library. The playing list is marked on its own card —
matched by `playlistId` and the current video id — so a renamed list shows the new name and no separate banner is
needed. A card without a sleeve (a playlist or mix) uses its first entry's still: the repository exposes `firstVideoId`
as a subquery over the snapshot, so the fallback follows a re-import or a removed first entry.

The cover is the exception to "write it all at paste time": the row is written with no artwork key, and the first time it
is drawn — in the list or the player bar — the artwork service derives the still from the video id, downloads it, caches
it and writes the key back. A paste therefore never waits on an image CDN, and a row added while thumbnails could not be
decoded repairs itself on the next draw. The lookup takes the source identity (`sourceKind` + `sourceId`) rather than a
row id, because an entry imported from a playlist has no history row at all.

### How unified search works

The Search view runs two reads in parallel: the library's existing FTS query and a YouTube search over the web
InnerTube endpoint (`src/engine/innertube.ts`). The YouTube side returns ids, titles, channels and durations only — no
formats, no signed URLs — so a search cannot start playback, write a file or fill the history by itself. Every result is
badged **Local** or **YouTube**, and both kinds share the same row layout and actions. Playback still belongs to
yt-dlp; discovery is deliberately a separate HTTP path, so a search does not spend the anonymous request budget a
resolve needs.

Choosing a YouTube result calls the same `online:add-link` path as a pasted URL. That is deliberate: the history and the
resolve cache should not care whether a video arrived by clipboard or by search. Choosing a local result plays the file
straight from disk. A result's channel id or `@handle` opens a flat recent-videos page from InnerTube; an `@handle` is
resolved to its stable `UC…` id and cached for five minutes. A display name with no id falls back to a name search,
because there is no page to point at otherwise.

YouTube requests have a budget. The first search or channel page shows **ten** entries, later pages are fetched only
when the user presses the pager, a channel is never browsed in the background, and search results stay metadata until a
row is chosen. The only speculative request is the single prefetch of the next queued track, and that switch can be
turned off. On top of the page budget there is a small request governor:

- InnerTube search and channel requests are serialized with a short jittered gap; playlist imports still use at most two
  yt-dlp metadata processes, and downloads use a separate lane so a long save never sits in front of playback;
- search and channel pages are cached for five minutes; a later page reuses the feed and asks for a continuation only
  when it needs more rows, and identical requests already in flight share one request;
- the yt-dlp playback/import path keeps its transient retry after a backoff, but a bot check is not retried blindly:
  if the cookie fallback is set to **only after a bot check**, one cookie retry happens before the breaker records the
  failure;
- a bot check that still fails trips a five-minute breaker (fifteen minutes if it repeats within half an hour), so the
  app stops adding requests instead of hammering the same wall. Resolves already cached still play during the pause;
- browser cookies are off by default. Only a browser the user explicitly chooses is read, and the fallback decides
  whether that happens never, once after a challenge, or on every request. The app itself never signs in, and account
  playlists remain unsupported;
- a PO Token provider is optional and external. The app does not bundle the bgutil plugin or its server; it points
  yt-dlp at the configured HTTP endpoint, reports whether `/ping` answers, and can start a command the user supplied
  (without a shell) if they ask it to.

This keeps ordinary use well below the burst a measurement harness produces, but it cannot make YouTube's anti-bot
check impossible on playback: that check is per-request, and can still appear on a shared address, after repeated
retries or for restricted videos. Discovery no longer contributes to it: search and channel rows keep working while
the yt-dlp playback path is inside a bot-check cooldown. The honest response for a blocked play is still to wait for the
breaker, retry, or choose another result. The 50-link measurement in
[`docs/notes/yt-dlp-50.md`](./notes/yt-dlp-50.md) predates the governor, so its timings are unchanged but its
request pattern is no longer quite what the app sends.

Metadata cleanup happens at the boundary, in `cleanYouTubeMetadata`: marketing brackets are removed and a repeated
`Artist - ` prefix moves into the artist field. It is applied when a link is remembered, when a list is imported, and
when search or channel rows are mapped, so the same video has the same name everywhere. `(Live)` is not removed, because
it names a different recording rather than decoration.

### How an imported playlist is stored

A list link is a different read from a watch link: one `--flat-playlist --playlist-end <cap> -J` call returns every id,
title, channel and duration at once, with no formats and no stream URLs. That is what makes a 12-track album import in
about three seconds instead of twelve resolves.

```
paste ──parseYouTubeLink──▶ kind: playlist | album | mix
      │                     (account lists / channels refuse here, before a process starts)
      ▼
fetchPlaylist(url, cap) ──▶ entries[] + the list's own title/owner/cover
      │
      ▼
online_playlists  (one row per list id, snapshot metadata)
online_playlist_items (position, video id, title, artist, album, duration)
      │
      ▼
queue = exactly the items, resolved lazily as each one plays
```

Two tables, no foreign key cascade: the repository deletes child entries explicitly, because a snapshot is a unit and a
half-deleted one would be a list of positions pointing at nothing. Re-importing the same list id replaces the entries in
one transaction and keeps the row (and its place in the index); a cover that could not be fetched this time does not
throw away the one cached last time. Positions are 0-based and renumbered when an entry is removed, since "play from
here" is a position, not a stable key.

The list's name has two homes. YouTube's title lives in `title` and is refreshed on every re-import; a name the user
chooses lives in `custom_title` (migration 8) and is never touched by an import. The repository's row mapping reads the
custom one first, so a mix that is auto-named after its first track can be renamed to something meaningful without
Re-import silently undoing it. The list id is shown as the stable identity, because two mixes can share a title.

The cap is a setting, not a constant: *Playlist / album import limit* (default 200) and *Mix length* (default 50). A mix
never reports a total, so its length is whatever that setting says; a finite list that YouTube reports as longer than the
snapshot shows a "first N of M" note. The **Tracks** box beside Re-import overrides the cap for one import (clamped to
1…1000), which is how a radio or a mix gets a length chosen on the spot; an empty or invalid box falls back to the
setting. Importing the same playlist again is the only thing that refreshes it — this is a snapshot, not a subscription.

`onlinePlaylistItemToTrack` (`src/shared/online.ts`) assigns those entries their own negative id space, offset a million
below history rows, so an imported track can never collide with a local id or with a history row's `-id` even though the
two tables both start counting at one. The id is derived from the entry id, not its position, so removing an earlier
entry does not change the identity of what is playing.

Only an album gets a list-level cover. A playlist's thumbnails are the first video's 16:9 stills — a 120×90 crop that
looks like a mistake blown up to a cover — and a mix has none, so those kinds use per-track stills instead. An album's
largest still is often a 404 placeholder: the importer walks the candidates and keeps the first that answers with real
image bytes (the signed `sddefault.jpg` is a genuine sleeve).

### How saving a track into the library works

*Save to library* is the one place the app writes audio instead of streaming it, and it is deliberately the ordinary
path: the result is a normal tagged file that the scanner indexes like any other.

```
save(videoId) ──▶ already saved? ──yes──▶ the existing row
                        │ no
                        ▼
             yt-dlp -x --audio-format <format> --embed-metadata --embed-thumbnail
                        │  one process, progress parsed from '[download] 42.3%'
                        ▼
             <userData>/downloads/<uuid>/<videoId>.<ext>   (temporary; kept only while paused)
                        │  moved into Music\Suura\<Artist>\<Album>\<Title>.<ext>
                        ▼
             library.addFolder(root)  +  scanWhenIdle()
                        ▼
             the row gets origin_kind/origin_id = youtube/<videoId>
```

The file is an ordinary `local` track: its `source_kind` stays `local` because that is how it plays (offline, from
disk), and the video it came from lives in the separate `origin_kind`/`origin_id` pair. That split matters in both
directions — a saved file plays through the local resolver with no special case, and the YouTube view can ask "is this
video already in my library?" (one `savedOrigins` query for a whole page) without pretending a file is a stream. A tag
check would not be enough on its own: Opus carries yt-dlp's watch URL as a comment, but MP3 puts it in an ID3
`TXXX:comment` frame that `music-metadata` only exposes natively, so `extractMetadata` reads both, and the downloader
sets the origin explicitly as a belt-and-braces guarantee.

The queue is capped by *Max concurrent downloads* and deduplicated per video, so ten clicks on one row download it
once and a *Save all* on a 50-track mix does not start fifty yt-dlp processes. Each save has its own
`AbortController`; **Cancel** removes a queued job or aborts a running sidecar, and is reported as *cancelled* rather
than *failed* so the dock offers Retry instead of an error. **Pause** is only offered for an active transfer: it aborts
the sidecar, emits *paused*, and deliberately keeps the UUID folder. **Resume** starts the same video again in that
folder with `--continue`; a Resume pressed before the aborted job has unwound is deferred rather than dropped. A
process killed before its `finally` leaves a UUID folder behind, so startup sweeps `downloads/` for this service's own
UUID folders and `.part` files — never an unrelated folder. Names are sanitised for Windows (`AC/DC` becomes `AC DC`,
`CON` becomes `_CON`) and a second file with the same name gets ` (2)`. Format and folder are settings; Opus is the
default because it is what YouTube already delivers (a remux, not a re-encode), while MP3 and M4A re-encode for players
that will not take Opus.

Before a sidecar starts, the save checks free space on both the per-save temp volume and the target volume against the
resolver's reported file size (or a conservative fallback when there is no hint) plus a reserve. Every progress change
is mirrored into `download_history`; startup marks any row still queued, downloading or paused as failed, and the
Downloads screen reads that ledger while the Saves dock hydrates only unfinished, failed or cancelled rows, so a
successful save from months ago does not come back as a card. **Remove download** deletes the file only after checking
that it is inside a configured library folder. It then marks the row missing instead of deleting it: playlist and queue
foreign keys survive, and the row's YouTube origin lets playback fall back to the stream. The history row becomes
*removed*, so the same item can be saved again. The *Keep after play* retention mode simply calls this same service
with the metadata the resolver already cached, so an automatically kept track is indistinguishable from one saved by
hand.

`webPreferences` sets `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`; the preload only pulls
`electron` and the shared channel constants, so the renderer runs without Node. The built HTML ships a strict CSP
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

A streamed link is not in the `tracks` table, so its cover cannot be derived from a file. `getArtwork` therefore takes
either a local row id or an identity (`sourceKind` + `sourceId`): a history row can still be reached by the negation of
its id, but an entry imported from a playlist has no history row, so it sends its video id and the Online service fetches
and caches that still exactly like an embedded cover. It asks for **JPEG**, not the `vi_webp` still that `yt-dlp`
reports: Electron's `nativeImage` returns an *empty* image for WebP rather than an error, which is why streamed rows
silently had no artwork at first. The largest 16:9 still is preferred, with `mqdefault.jpg` as the fallback, and a missing
`maxresdefault.jpg` is checked by status because YouTube answers it with a decodable 120×90 placeholder. Fetches are
limited to four at a time, so opening a 200-entry import does not fire 200 image requests in one tick.

### Storage

| What | Where |
|---|---|
| SQLite database | `<userData>/library.db` (WAL mode) |
| Settings | `<userData>/config.json` (written atomically) |
| Logs | `<userData>/logs/suura.log` (rotated at 5 MB) |
| Artwork cache | `<userData>/cache/artwork/<sha1>.<ext>` |
| Stream cache | `<userData>/cache/stream/<videoId>.<ext>` (budget and max age under Settings → Streaming) |
| Temp downloads | `<userData>/downloads` (per-save working folder, cleared after the move) |
| Saved tracks | `Music\Suura\<Artist>\<Album>\<Title>.<ext>` by default (set the folder under Settings → Streaming) |

`<userData>` is `%APPDATA%\Suura` on Windows. All of these paths are shown in **Settings → Misc**, and the versions
behind them are on **About**. `library.db` also holds the cache ledger (`cache_entries`) and the save ledger
(`download_history`); neither is a second copy of the library, and deleting either folder leaves the library rows
untouched.

The app was called **Player** while it was being built. Machine-readable identifiers keep that name so old files keep
working: the backup and playlist formats still say `player-backup`, `player-restore` and `player-playlist`, and the
internal `player-media://`, `player-art://` and `player-stream://` schemes are unchanged.

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
    tray.ts             tray icon and its transport menu
    window-mode.ts      native bounds and state for the mini-player layout
    taskbar.ts          Windows thumbnail-toolbar buttons
    taskbar-icons.ts    embedded white taskbar glyphs
    selftest.ts         the end-to-end harness behind `npm run selftest`
    stream-protocol.ts  the player-stream:// handler
    online-service.ts   link history, imports, YouTube search and channel listings
    download-service.ts save-to-library queue: yt-dlp → tags → move → scan, pause/resume, remove-download, startup sweep
    youtube-service.ts  resolver + stream proxy, registered with the registry
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
    youtube-resolver.ts link validation, resolve + session cache
    stream-proxy.ts     token registry, range/header forwarding, one-shot re-resolve
    innertube.ts        search/channel metadata over YouTube's web API
    sidecar/            locating and version-probing yt-dlp / ffmpeg; the yt-dlp client
  renderer/src/
    App.tsx             composition root
    components/         Sidebar, LibraryView, TrackList, SearchView, OnlineView, PlaylistsView, DownloadsView, QueueView, SettingsView, SavesPanel, PlayerBar, NowPlayingView, SeekBar, ArtworkImage, Icons
    hooks/              useSettings, useLibrary, useOnline, useDownloads (save queue, pause/resume, remove, retry, reveal), usePlayer, useMediaSession, useArtwork, useKeyboardShortcuts
    audio/              playback-chain (EQ, ReplayGain, volume), playback-deck (two-element gapless handoff)
  shared/               types, the IPC contract and pure helpers (queue rules, taskbar controls, URLs, ranges, formatting, file names)
tools/
  smoke.ts              core smoke test (real files, no Electron)
  measure-streams.mjs   the 50-link M3 timing harness (network + yt-dlp)
  runtime-check.cjs     Electron runtime assumptions
docs/adr/               architecture decision records
docs/notes/             spike and measurement records, with raw JSON
```

### Notable details

- **The IPC contract is one file.** `src/shared/ipc.ts` defines channels, the `PlayerApi` interface, event payloads and
  the token-based subscription scheme. Adding a channel without wiring both ends is a compile error.
- **Subscriptions return tokens, not closures**, because returning a function across `contextBridge` is not part of the
  documented serialisation contract.
- **All settings patches are validated in main** (`sanitizeSettingsPatch`). This is not ceremony: `libraryFolders` *is*
  the media allowlist, so anything that can widen it is checked at the boundary. Appearance values are validated against
  the same shared lists the renderer draws, so a choice cannot exist in the UI and be silently rejected by main. The
  defaults live in `src/shared/settings-defaults.ts` too, so Reset preferences cannot drift from a first launch; its
  patch deliberately omits folder locations and the engine-update timestamp.
- **Appearance is data attributes on `<html>`**, not a second theme object threaded through components. The CSS token
  blocks key off `data-theme`/`data-accent`/`data-density`/`data-surface`/`data-motion`; the virtualizer gets the same
  density row height through a prop, so the CSS height and the scroll math cannot drift. The last resolved palette is
  cached in `localStorage` only to paint the right background before the settings IPC round-trip; the config remains
  the source of truth.
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
- **Home is a lens over the library, not a second store.** Album summaries group in SQL by title and the same
  album-artist fallback the artwork cache uses. The artist filter is correlated to that grouping so two same-titled
  releases do not leak into each other, while a compilation still matches any artist on it. Cards request a
  representative track's cover through an `IntersectionObserver`, so opening Home does not trigger an extraction burst
  for every album. The hero stats, shelves and **All tracks** list share that grouping; there is no separate Home index.
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
  which is why both volume sliders are neutral, including the one in the bar that sits directly under the seek bar. The
  slider is *rotated* rather than written vertically (the track and thumb pseudo-elements stay in the horizontal
  coordinate space they are documented in) and is centred by `position: absolute` rather than by the parent's alignment,
  because an item wider than its grid track is aligned to the track's *start*, not centred on it. The speaker icon is a
  mute toggle in both places — the bar as well as the player window, where the slider is folded away until the pointer or
  the keyboard is on it. Mute is not a stored setting: it is only "the volume is zero, remember what it was", so
  unmuting restores the level the user actually chose rather than a default.
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
  notch is 5% by default (Settings → General offers 1–15%), Shift makes it 1%, and the value is rounded to the slider's
  own step so repeated notches cannot drift. The self-test checks the default step, both ends of the scale, that the
  event really is cancelled, and that the wheel-step control is wired to the hook.
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

- **A missing file is a state, not a deletion.** A track whose file vanishes keeps its row, history and playlist entries
  with `missing_at` set; normal lists and playlist details hide it, and the row returns in place when relocation finds
  the file. Explicitly removing a row (or a whole folder) still cascades through playlist entries. The scan refuses to
  mark anything missing from a folder it could not enumerate, so an unmounted drive does not quietly hide the library.

- **Playlist transfer is a match, not a trust exercise.** Export writes an extended M3U/M3U8 (UTF-8, CRLF, absolute
  paths) or the versioned `player-playlist` JSON. Import resolves relative entries against the playlist's own folder,
  matches local paths through the same normalised content key the scanner uses, and matches YouTube watch URLs through a
  saved track's origin id. It creates a playlist only when at least one entry resolves, reports added, duplicate, missing
  and invalid entries, and suffixes a colliding name with ` (2)`. Files are capped at 10 MB and 50 000 entries. CSV export
  is the whole library, not the loaded page: UTF-8 BOM, CRLF and RFC 4180 quoting so Excel opens it correctly.

- **The play state is a snapshot, not a queue table.** One row holds a JSON array of ids, the cursor and the position.
  Nothing ever queries *into* it — it is read once at start-up and rewritten as a whole — so a table of rows would buy
  nothing and cost a join on every save. It is written on a one-way channel, because the moment the position matters
  most is the moment the window is closing, where awaiting a reply is not an option. On load, ids that no longer exist
  are dropped and the cursor moves to a track that survived, so a queue can never come back pointing at nothing.

---

## Known gaps

- No per-playlist retention override. There are also no saved smart playlists: the Library's chips are fixed views, not
  user-defined lists that can be named and reused.
- Playlist transfer covers hand-made playlists only. An imported YouTube list is a snapshot of videos that may not be
  on disk, so it is exported through the original link rather than flattened into a local M3U.
- Automatic backups are single database files, made when the newest copy is more than 24 hours old and before a
  migration; settings are included only in the manual backup folders. The number kept is configurable in Settings →
  Misc (default 10, range 3–50), but there is still no scheduled interval or backup-age setting to tune.
- An imported playlist is a **snapshot, not a mirror**: it is refreshed only by Re-import, so a list edited on YouTube
  keeps its old entries until then. Removing the snapshot never touches the library.
- Imported playlists live outside the library. Played links appear in the Library under the **YouTube** chip rather than
  among local tracks, and **Remove from history** forgets the link without touching a saved copy.
- A stream play leaves the last local queue in the resume slot rather than a queue that cannot be rebuilt.
- The Downloads screen is not a live scheduler. It renders the `download_history` ledger plus whatever the Saves dock is
  doing; a row completed long ago stays until it is dismissed, and cache entries are keyed by video id because the
  cache itself stores no tags.
- Removing a saved file while it is open in the player can fail on Windows with a sharing violation. The row stays
  saved and the file is untouched; stop playback and remove it again.
- Bulk cache removal and bulk saved-file removal are available in Downloads, but clearing the whole cache is all-or-
  nothing: there is no per-folder or per-playlist cache budget.
- Resolving has no Cancel button. Dismissing the *Resolving…* row discards the result, but the sidecar finishes in the
  background and warms the cache, so retrying the same link is instant.
- The first play of a link takes 7–10 s because yt-dlp is started per resolve. A resident sidecar (or resolving on
  selection) is the next step if that is too slow; the numbers are in the sample note.
- No catalogue browsing or recommendations: search is explicit, and there are no subscriptions or feeds.
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
- The installer is unsigned unless the build environment sets `CSC_LINK`; SmartScreen may warn. There is no app
  auto-update yet, so every release is a fresh install over the previous one.
- The packaged app does not bundle `yt-dlp` or `ffmpeg`. A clean machine can use the local library but must install both
  before streaming or saving; the packaged selftest uses the copy already on this machine.
- **Copy diagnostics** is clipboard-only, but **Save diagnostics** writes a local text bundle with the recent log. There
  is no opt-in crash reporting and nothing is uploaded automatically.

## Next steps

Everything below is release work, not product work; M1–M7 and M12 are built.

1. **Bundle `yt-dlp` and `ffmpeg` as sidecars** so the installer is self-sufficient, then re-run the packaged
   `--selftest` on a clean Windows machine (the M0 clean-machine pass).
2. **Sign the installer** with a real certificate (`CSC_LINK` / `CSC_KEY_PASSWORD`) and document the SmartScreen
   workaround for the unsigned case; the checklist is in [`docs/release/windows.md`](./release/windows.md).
3. **Add the auto-update channel** (stable/beta) with an update endpoint, rollback and engine rollback, so a release no
   longer means a manual install over the previous one.
4. **Decide crash reporting**: keep the local, export-only diagnostics bundle, or add an opt-in remote service. Nothing
   is uploaded today.
5. **Compatibility and accessibility pass**: Windows 10/11 at 100–200% scaling, multi-monitor and HiDPI, plus
   keyboard-only navigation, screen-reader labels and contrast.
6. **Run the performance gate in CI**: `npm run perf` now enforces the 10 000-file scan, rescan, paging, search,
   database size and main-process memory budgets headlessly, and exits non-zero on a miss. What is still missing is a
   CI runner to call it, which needs the repository. Cold start, first audio and memory under playback stay manual.
7. **M2 gap**: optional crossfade.

The update endpoint, crash-reporting service and signing certificate are decisions rather than code, so they come
before the steps that depend on them.
