# Suura

A desktop music player for Windows. It plays the music you already own and the YouTube links you paste in — one
library, one queue, one search box.

- **Your files stay yours.** Suura indexes folders you choose. It never moves, renames or uploads anything.
- **YouTube when you want it.** Paste a link, a playlist, an album or a mix and play it through `yt-dlp`. Streaming is
  the default; saving a track into your library is a click you make, not something that happens behind your back.
- **A real library.** Tags and embedded cover art, sortable and searchable lists, smart views, playlists, a queue that
  survives a restart, and a mini player for when the window is in the way.

Suura **0.1.0** is an early pre-release. There is no public download yet, so "installing it" today means building the
installer from source — about five minutes, and no compiler is needed.

---

## What you need

| | |
|---|---|
| **Windows** | Windows 10 or 11, 64-bit |
| **Node.js** | 22.12 or newer (24 recommended) — only to build; the installed app carries its own runtime |
| **npm** | comes with Node.js |
| **yt-dlp** | for YouTube: streaming, search, imports and saving |
| **ffmpeg** | for saving tracks, and for the test suite |

Only the first three are needed to play your own files. Without `yt-dlp` the YouTube side of the app reports that the
engine is missing instead of failing silently.

### Install yt-dlp and ffmpeg

From PowerShell:

```powershell
winget install --id yt-dlp.yt-dlp -e
winget install --id Gyan.FFmpeg -e
```

Open a new terminal afterwards so the updated `PATH` is picked up. If you already have them somewhere else, Suura also
looks in `%USERPROFILE%\yt-dlp`, `%USERPROFILE%\bin`, `%LOCALAPPDATA%\Programs\yt-dlp`, the WinGet links folder and the
Python `Scripts` folders. Failing that, point it at the folder that holds both binaries under
**Settings → Streaming → Engine folder (optional)**.

**Settings → Streaming → YouTube engine** shows whether each one was found, where it was found and what version it is.
Use **Check** after installing or updating.

`yt-dlp` changes often because YouTube changes often. Suura asks it to update itself at most once a day; you can turn
that off, or update it yourself with `yt-dlp -U`.

---

## Install

There is no public download yet and the source is not published. From a copy of this folder, run:

```powershell
npm install
npm run package:win
```

That type-checks the project, builds it and writes the installer to:

```
release\Suura-0.1.0-Setup.exe
```

Run it. The installer is **per-user**: it installs to `%LOCALAPPDATA%\Programs\Suura`, needs no administrator password
and creates a desktop and Start-menu shortcut.

### The SmartScreen warning

The build is **not code-signed**, so Windows may show *"Windows protected your PC"* the first time. Choose **More info →
Run anyway**. Signing is a release-engineering task that has not been done yet; it does not mean anything is wrong with
the file you just built yourself.

### Run it without installing

Useful while trying it out:

```powershell
npm install
npm run dev
```

This starts Suura with hot reload. It uses the same data folder as the installed app.

### Uninstall

Use *Apps & features* or the Start-menu entry. The uninstaller asks once whether to delete Suura's library database,
settings, caches and logs — the default is **No**, so a reinstall finds everything as you left it. Music you saved into
`Music\Suura` is never deleted.

---

## First run

Suura opens on **Home** with an empty library.

1. Click **Add music folder** (or drag a folder onto the window) and pick a folder.
2. Suura scans it recursively, reads tags with `music-metadata`, extracts embedded cover art and shows the result. A
   large library is indexed in the background, with progress on the Home hero.
3. Press play. Double-click a row, or use the play button that appears on hover.

Supported files: `.mp3`, `.m4a`, `.m4b`, `.aac`, `.flac`, `.ogg`, `.oga`, `.opus`, `.wav`, `.wave`, `.wma`, `.aiff`,
`.aif`, `.aifc`, `.ape`, `.wv`, `.mpc`, `.spx`. Anything else in the folder is ignored.

Folders are watched, so an album copied in later appears by itself and a deleted file is forgotten. Turn off **Watch
folders for changes** under **Settings → General** for a library on a slow or network drive; **Rescan** in the Library
toolbar is always available.

---

## Using Suura

### The views

| View | What it is |
|---|---|
| **Home** | A dashboard: recently played and recently added shelves, artist and playlist cards, library totals, and one searchable **All tracks** list that merges local files, streamed listens, imported playlist entries and remembered links. |
| **Library** | The full list, virtualized and sortable by any column. Chips switch between **All**, **Recently added** (last 30 days), **Most played**, **Never played** and **YouTube**. Search applies inside the chosen view. |
| **YouTube** | Paste a link here. The top box holds imported playlists, albums and mixes; the bottom box is the history of links you added. |
| **Search** | Asks your library and YouTube at the same time and puts both answers in one list, marked **Local** or **YouTube**. |
| **Playlists** | Lists you made, plus lists imported from YouTube, side by side. |
| **Downloads** | Every save — queued, running, paused, failed, finished — and the offline cache with its size and budget. |
| **Queue** | What plays next, in order. Jump, remove or clear. |
| **Settings** | General, Appearance, Streaming, Misc, About. |

### Playing

The bar at the bottom has play/pause, previous/next, a scrubber, volume, repeat (off / all / one), shuffle and the
queue. Click the now-playing area to open the **full-window player** with a large cover, a full-width scrubber and the
queue sliding in over the artwork. **Escape** closes it and playback never stops.

**Mini player** and the **tray icon** are there when the window is in the way. The tray menu shows and hides the
window, toggles the mini player, and carries play/pause, previous, next and quit. Closing the window quits unless you
turn on **Close to tray** in Settings.

The Windows media overlay and the taskbar thumbnail controls drive the same transport, and the **media keys** work
anywhere.

Suura remembers the queue, the track and the position, and restores them paused on the next start — unless you turn on
**Resume playback automatically** in Settings. Tracks that have since been deleted are left out.

### Editing tags

Right-click a local track and choose **Edit tags…**, or open **Details** and press **Edit tags**. Title, artist, album
artist, album, year, genre, track and disc numbers (with their totals) and lyrics can be changed; blanking a field
removes that tag.

The file itself is rewritten, not just the library row. The new version is written to a temporary file in the same
folder, read back to check it, and only then swapped in; the previous version is kept in `backups/tags` under the app
data folder. MP3, FLAC, M4A/M4B, Ogg and Opus are writable today, and WAV, AIFF, AAC, WMA, APE, WavPack and Musepack are
refused rather than half-written. A file that is open for playback, read-only, or locked by another program is reported
instead of being changed.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `←` / `→` | Seek back / forward 5 seconds |
| `Shift` + `←` / `→` | Seek 30 seconds |
| `↑` / `↓` | Volume up / down 5 % |
| `N` / `P` | Next / previous track |
| `M` | Mute / unmute |
| `/` or `Ctrl` + `F` | Jump to search |
| `Esc` | Close the player window, a menu or a dialog; leave a text field |
| `Shift` + `F10` or the Menu key | Row context menu |
| `Alt` + `↑` / `↓` | Reorder the selected row inside a playlist |

Shortcuts stay out of the way while you are typing in a field. Inside a track list the up/down arrows move the
selection (`Home`, `End` and `Page Up`/`Page Down` too) and `Enter` plays; the transport shortcuts above keep working.

### Mouse

Clicking a row is a setting: **Settings → General** chooses what a single click and a double click each do — select,
play, select-and-play, or nothing — because both "select first, play on double click" and "click to play" are habits
people keep. The row tooltips and the footnote under the list always state what is in effect. The mouse wheel over the
volume control steps it by 5 % by default (1–15 % configurable, `Shift` for 1 %).

Right-click a row (or use the `…` button) for **Details**, **Add to playlist**, **Add to queue** and the rest; YouTube
rows also offer **Save**. Drag a folder onto the window to add it to the library; drag an audio file to add its folder,
since the library is indexed by folder.

### YouTube

Paste a link into the YouTube view and choose **Play now** or **Add to queue**. A cold link takes roughly 7–10 seconds
to resolve, so the row appears immediately as *Resolving…* and fills in when it is ready — or offers **Retry** if it
cannot be played.

- **Playlists, albums and mixes** are recognised from the link. The button becomes **Import & play** and adds **Add all
  to queue**. The list is fetched once, stored as a snapshot, and appears under **Imported** in Playlists. **Re-import**
  refreshes it without losing a name you gave it.
- **Limits** keep a never-ending mix sane: 200 entries for a playlist or album, 50 for a mix, both adjustable under
  **Settings → Streaming**. A **Tracks** box next to **Re-import** overrides the count for one snapshot (1–1000).
- **Account lists and channels** (`LL…`, `WL…`, `FL…`) are refused with an explanation: Suura never signs in to your
  account.
- **Search** returns ten results at a time with a pager, and a result's channel opens that channel's recent videos in
  place. There is no recommendation feed and nothing is browsed unless you ask.
- **Prefetch** (on by default) resolves the next queue entry about four seconds into the current track, so pressing
  Next only waits for the audio to arrive. Turning it off sends one fewer request per track.
- The **Saves** dock above the player bar follows every save with speed, time remaining, **Pause**, **Resume**,
  **Cancel**, **Retry** and **Reveal**. The Downloads view is the durable version of the same ledger.

Cleanup happens on the way in: `Artist - Title (Official Music Video)` becomes artist *Artist* and title *Title*, and
decoration such as *Official Audio*, *Lyrics*, *4K* or *Remastered* is removed. `(Live)` is kept, because it names a
different recording.

### Saving tracks, and the offline cache

Streaming writes nothing by default. **Settings → Streaming** chooses what happens after a YouTube track plays:

| Mode | What it does |
|---|---|
| **Stream only** *(default)* | Nothing is kept. |
| **Cache played tracks** | Keeps a bounded cache so played tracks replay offline. |
| **Save every played track** | Saves each played track into your library automatically. |

The cache has a size budget (5 GB) and a maximum age (30 days) by default; least-recently-used entries are evicted, and
pinned entries never are. Playback uses a cached copy first, so a cached track needs no network at all. If the disk is
short, Suura skips the cache copy rather than filling it.

**Save to library** (or the button on a YouTube row) downloads the track with its tags and cover and adds it as an
ordinary file, in **Opus** by default — what YouTube delivers, so it is a remux rather than a re-encode. MP3 320 and M4A
are one setting away for other players. The folder defaults to `Music\Suura\<Artist>\<Album>\<Title>.<ext>` and can be
changed. The folder is added to the library automatically the first time, so the file simply appears.

A saved file is yours: deleting it from the Downloads view removes the file and marks the library row missing, and that
row then plays from its YouTube origin instead of complaining about a missing file.

### Playlists

Create, rename and delete lists from the **`…`** menu in the Playlists index. Add tracks from the library's selection
bar, from a row's context menu, or save the whole queue as a playlist from the player window. Drag rows to reorder, or
select one and press `Alt` + `↑` / `↓`; the order is kept exactly as you set it. Imported YouTube lists live in the same
pane under **Imported** and can be played, added to the queue, saved in bulk or removed entry by entry.

### Settings

| Tab | What lives there |
|---|---|
| **General** | Launch view, scan on launch, folder watching, click behaviour, volume-wheel step, resume playback, close to tray. |
| **Appearance** | Theme (Midnight, Cream, Follow Windows), five accents, three densities, four text sizes, cover-art shape, motion, sidebar glyphs and panel style. |
| **Streaming** | Engine folder and status, quality tier, retention mode and cache limits, save format and folder, prefetch, `yt-dlp` self-update, PO Token provider, cookie fallback, import limits. |
| **Misc** | Backups and restore, library health, find moved files, reset preferences. |
| **About** | Versions of Suura, Electron, Chromium and Node, the `yt-dlp`/`ffmpeg` probe, **Copy diagnostics** and **Save diagnostics**. |

**Settings → Misc** resets one section at a time — General, Playback, Streaming or Appearance — or all preferences at
once, without touching your library, engine folder or download folder. Appearance also has its own **Reset
appearance** on its tab.

### Backups and library health

**Settings → Misc → Backup & restore** writes a consistent copy of the database, the settings and a manifest to a folder
you choose, and restores one from a folder picker. A restore is validated and finishes on the next start; a broken one
leaves the old library untouched and says why.

Suura also makes its own copy when the newest one is more than a day old and before any database upgrade. Ten are kept
by default (3–50 configurable). A backup written by a newer version is refused rather than opened by an older one.

**Library health** finds byte-identical duplicates and keeps one copy, carrying playlist entries and play counts across.
**Find moved files** relinks a file you moved, by its stored fingerprint first and then by size and modification time.

---

## Where your data lives

`<userData>` is `%APPDATA%\Suura` on Windows.

| What | Where |
|---|---|
| Library database | `%APPDATA%\Suura\library.db` |
| Settings | `%APPDATA%\Suura\config.json` |
| Logs | `%APPDATA%\Suura\logs\suura.log` (rotated at 5 MB) |
| Cover-art cache | `%APPDATA%\Suura\cache\artwork\` |
| Offline stream cache | `%APPDATA%\Suura\cache\stream\` |
| Temporary downloads | `%APPDATA%\Suura\downloads\` |
| Backups | `%APPDATA%\Suura\backups\` |
| Saved tracks | `Music\Suura\` by default |

The exact paths are listed in **Settings → Misc**. Deleting the cache folders is safe; it costs you offline copies and
covers, not library rows. Deleting `library.db` loses the library, playlists, play counts and history — take a backup
first if you care about them.

---

## Troubleshooting

**Windows says "Windows protected your PC".** The installer is unsigned. *More info → Run anyway*. See above.

**YouTube says the engine is missing, or a link fails.** Open **Settings → Streaming → YouTube engine** and press
**Check**. Update `yt-dlp` (`yt-dlp -U` or reinstall it) — most playback failures are an out-of-date `yt-dlp`. If the
engine is found but YouTube asks for a bot check, the **cookie fallback** can read cookies from a browser you choose;
it is off by default and never runs quietly.

**A track I moved shows as missing.** **Settings → Misc → Find moved files.** Suura matches it by fingerprint, then by
size and modification time, and keeps its id, so playlists and play counts survive.

**The library is slow to open on a network drive.** Turn off **Watch folders for changes** under **Settings → General**.
Watching is what makes new albums appear by themselves, and it is the first thing to give up on a slow share.

**Something is broken and I want to report it.** **Settings → About → Save diagnostics** writes versions, app paths,
library-folder count, the user agent and the tail of the log to a file you choose. Nothing is sent anywhere.

**I want a clean start.** **Settings → Misc → Reset preferences** restores the settings but keeps the library. A full
reset means uninstalling with *delete app data*, or removing `%APPDATA%\Suura` yourself.

---

## Privacy

Suura has no account, no telemetry and no analytics. It does not upload your library, your listening history or your
files.

It talks to the network only when you ask it to: playing or searching YouTube goes through `yt-dlp` to YouTube,
cover art for streamed tracks is fetched like any other thumbnail, and `yt-dlp` may check for its own updates. Local
playback needs no network at all. Diagnostics are written to a file you pick; nothing is sent.

---

## Legal

Suura is a music player, not a downloader. Streaming is the default and no audio is written unless you save a track,
switch on the cache, or ask Suura to keep what you play.

`yt-dlp` is a separate tool with its own licence and version. It is not bundled, and Suura does not fetch anything that
circumvents DRM or paywalls. Downloading media can breach YouTube's Terms of Service and copyright law where you live;
that responsibility is yours. Suura ships no media.

Playing files you already own is unaffected by any of this.

---

## Licence

MIT. The full text is in [`LICENSE`](./LICENSE). Suura is an early pre-release — unsigned, with no public download and
no support promised — but the source is yours to use, change and redistribute under those terms.

---

## Development

Architecture, the test suite, project layout, known gaps and the release checklist live in
[`docs/development.md`](./docs/development.md). The plan and milestone state are in [`ROADMAP.md`](./ROADMAP.md), and
Windows packaging details are in [`docs/release/windows.md`](./docs/release/windows.md).

Quick reference:

```powershell
npm run dev          # run from source with hot reload
npm run build        # type-check and bundle into out/
npm run package:win  # build the installer into release/
npm run smoke        # core checks against real files
npm run selftest     # end-to-end run of the real app
```
