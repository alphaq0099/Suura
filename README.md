# Suura

A desktop music player for Windows. It plays the music you already own and the YouTube links you paste in — one
library, one queue, one search box.

- **Your files stay yours.** Suura indexes folders you choose. It never moves, renames or uploads anything.
- **YouTube when you want it.** Paste a link, a playlist, an album or a mix and play it through `yt-dlp`. Streaming is
  the default; saving a track into your library is a click you make, not something that happens behind your back.
- **A real library.** Tags, lyrics and embedded cover art, sortable and searchable lists, smart views, playlists, a queue
  that survives a restart, and a mini player for when the window is in the way.

Suura is an early pre-release for Windows 10 and 11 (64-bit). The source is public, the installer is **not code-signed
yet**, and there is no telemetry of any kind. An Android version is planned; it is not started.

---

## Download

Installers are published on the [Releases page](https://github.com/alphaq0099/Suura/releases/latest) as
`Suura-<version>-Setup.exe`, next to a `SHA256SUMS.txt` you can use to verify the download.

The installer is **per-user**: it installs to `%LOCALAPPDATA%\Programs\Suura`, needs no administrator password, and
creates a desktop and Start-menu shortcut.

### The SmartScreen warning

The build is not code-signed, so Windows may show *"Windows protected your PC"* the first time you run it. Choose
**More info → Run anyway**. This is expected for an unsigned build and does not mean the file is unsafe — but it does
mean Windows cannot prove who built it. See [Code signing](#code-signing).

To check the file you downloaded:

```powershell
Get-FileHash .\Suura-0.1.0-Setup.exe -Algorithm SHA256
```

Compare the result with the matching line in `SHA256SUMS.txt`.

### Build it yourself

From a checkout, with Node.js 22.12 or newer:

```powershell
npm install
npm run package:win
```

That type-checks the project, builds it and writes `release\Suura-<version>-Setup.exe`. Run it, or use `npm run dev`
for a hot-reloading build that shares the installed app's data folder.

### Uninstall

Use *Apps & features* or the Start-menu entry. The uninstaller asks once whether to delete Suura's library database,
settings, caches and logs — the default is **No**, so a reinstall finds everything as you left it. Music you saved into
`Music\Suura` is never deleted.

---

## What you need

| | |
|---|---|
| **Windows** | Windows 10 or 11, 64-bit |
| **YouTube features** | `yt-dlp` and `ffmpeg`, either downloaded in the app or already on `PATH` |

Local playback needs nothing else. The installed app carries its own runtime; Node.js is only needed to build from
source.

### The YouTube engine

Suura does not bundle `yt-dlp` or `ffmpeg`. The **YouTube** view notices when they are missing and offers a
**Download engine** button with the download size and progress; **Settings → Streaming → YouTube engine** has the same
button, plus the probe and the engine folder. Suura fetches pinned versions into `%APPDATA%\Suura\engine`, checks each
file's SHA-256 before installing it, and shows progress with a Cancel button. A copy you already have is used instead
and reported as *available*, with where it came from.

If you prefer to manage them yourself:

```powershell
winget install --id yt-dlp.yt-dlp -e
winget install --id Gyan.FFmpeg -e
```

Open a new terminal afterwards so the updated `PATH` is picked up. Suura also looks in `%USERPROFILE%\yt-dlp`,
`%USERPROFILE%\bin`, `%LOCALAPPDATA%\Programs\yt-dlp`, the WinGet links folder and the Python `Scripts` folders. If
that fails, point **Settings → Streaming → Engine folder** at the folder holding both binaries.

`yt-dlp` changes often because YouTube changes often. Suura asks it to update itself at most once a day; you can turn
that off, or update it yourself with `yt-dlp -U`.

---

## First run

Suura opens on **Home** with an empty library.

1. Click **Add music folder** (or drag a folder onto the window) and pick a folder.
2. Suura scans it recursively, reads tags, extracts embedded cover art and shows the result. A large library is
   indexed in the background, with progress on the Home hero.
3. Press play. Double-click a row, or use the play button that appears on hover.

Supported files: `.mp3`, `.m4a`, `.m4b`, `.aac`, `.flac`, `.ogg`, `.oga`, `.opus`, `.wav`, `.wave`, `.wma`, `.aiff`,
`.aif`, `.aifc`, `.ape`, `.wv`, `.mpc`, `.spx`. Anything else in the folder is ignored.

Folders are watched, so an album copied in later appears by itself and a deleted file is forgotten. Turn off **Watch
folders for changes** under **Settings → General** for a library on a slow or network drive; **Rescan** in the Library
toolbar is always available.

For YouTube, do the one-time engine download above. Without it, the YouTube side reports that the engine is missing
instead of failing silently.

---

## Using Suura

### The views

| View | What it is |
|---|---|
| **Home** | A dashboard: recently played and recently added shelves, artist and playlist cards, library totals, and one searchable **All tracks** list that merges local files, streamed listens, imported playlist entries and remembered links. |
| **Library** | The full list, virtualized and sortable by any column. Chips switch between **All**, **Recently added** (last 30 days), **Most played**, **Never played** and **YouTube**. Search applies inside the chosen view. |
| **YouTube** | One surface with three tabs: **Links** (the history of links you pasted), **Saved** (every save — queued, running, paused, failed, finished) and **Cache** (the offline cache with its size and budget). Each tab keeps its own state. |
| **Search** | Asks your library and YouTube at the same time and puts both answers in one list, marked **Local** or **YouTube**. |
| **Playlists** | Lists you made, plus lists imported from YouTube, side by side. |
| **Queue** | What plays next, in order. Jump, remove or clear. |
| **Settings** | General, Appearance, Streaming, Metadata, Misc, About. |

The Downloads view of earlier builds is gone: its two halves are now **YouTube → Saved** and **YouTube → Cache**, and
they share the YouTube header instead of owning a sidebar entry.

### Playing

The bar at the bottom has play/pause, previous/next, a scrubber, volume, repeat (off / all / one), shuffle, the queue
and the equalizer. Click the now-playing area to open the **full-window player** with a large cover, a full-width
scrubber and the queue sliding in over the artwork. **Escape** closes it and playback never stops.

**Mini player** and the **tray icon** are there when the window is in the way. The tray menu shows and hides the
window, toggles the mini player, and carries play/pause, previous, next and quit. Closing the window quits unless you
turn on **Close to tray** in Settings.

The Windows media overlay and the taskbar thumbnail controls drive the same transport, and the **media keys** work
anywhere.

Suura remembers the queue, the track and the position, and restores them paused on the next start — unless you turn on
**Resume playback automatically** in Settings. Tracks that have since been deleted are left out.

### YouTube

Paste a link into **YouTube → Links** and choose **Play now** or **Add to queue**. A cold link takes roughly 7–10
seconds to resolve, so the row appears immediately as *Resolving…* and fills in when it is ready — or offers **Retry**
if it cannot be played.

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
- **Clear history** sits above the **Links / Saved / Cache** tabs and removes the link history only; saved files and
  cached audio are untouched.

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
short, Suura skips the cache copy rather than filling it. **YouTube → Cache** shows what is cached, how much space it
uses, and lets you pin, reveal, remove or clear without touching saved tracks.

**Save to library** (or the button on a YouTube row) downloads the track with its tags and cover and adds it as an
ordinary file, in **Opus** by default — what YouTube delivers, so it is a remux rather than a re-encode. MP3 320 and M4A
are one setting away for other players. The folder defaults to `Music\Suura\<Artist>\<Album>\<Title>.<ext>` and can be
changed. The folder is added to the library automatically the first time, so the file simply appears.

A saved file is yours: removing it from **YouTube → Saved** deletes the file and marks the library row missing, and that
row then plays from its YouTube origin instead of complaining about a missing file.

### Editing tags and lyrics

Right-click a local track and choose **Edit tags…**, or open **Details** and press **Edit tags**. Title, artist, album
artist, album, year, genre, track and disc numbers (with their totals) and lyrics can be changed; blanking a field
removes that tag. Every text field also has a right-click menu — Cut, Copy, Paste, Select all and Clear — so a mangled
artist name can be replaced from the clipboard without touching the keyboard.

**Find tags** asks iTunes and MusicBrainz what the file is. Both are keyless, and each is asked independently, so one
being unavailable still leaves the other's matches. Results are scored against the file's own title, artist and length,
and the best few appear with a strong, likely or possible badge. A field the file already fills in starts unticked;
ticking it replaces what is there on purpose. Nothing is written when you apply a match: it fills the form, and **Save**
is still the one moment the file changes.

**Cover** opens a picker for the artwork: the picture already in the file, a `cover.jpg` (or `folder`/`front`/`album`/
`albumart`) beside it, and the still from the video the track was downloaded from — all square-cropped. **Search
online** adds covers from the same two providers. Choosing one only changes the preview; **Save tags** embeds it, and
**Remove the cover** takes it out. MP3, FLAC and M4A/M4B can hold a cover today; Ogg and Opus cannot, so the picker
refuses a cover there while the text tags still save.

The file itself is rewritten, not just the library row. The new version is written to a temporary file in the same
folder, read back to check it, and only then swapped in; the previous version is kept in `backups/tags` under the app
data folder. MP3, FLAC, M4A/M4B, Ogg and Opus are writable today, and WAV, AIFF, AAC, WMA, APE, WavPack and Musepack are
refused rather than half-written. A file that is open for playback, read-only, or locked by another program is reported
instead of being changed. Edits made while a track is playing are queued and reported when the file is free.

The lyrics box opens with the lyrics the file already has. Leaving it alone keeps them, editing it replaces them, and
**Remove the lyrics already in this file** clears them on purpose — an empty box never wipes a lyric you did not touch.
If the lyrics come from a `.lrc` file beside the track, the box shows them read-only: that file is what the player
shows, so edit or remove it instead.

### Lyrics

The player window has a **Lyrics** button beside the queue. It shows lyrics that are already on your disk: a tag inside
the file (`USLT`/`SYLT` on MP3, `LYRICS` on FLAC/Ogg/Opus, `©lyr` on M4A) or a `.lrc` file with the same name next to
the track. When both exist the `.lrc` wins, because it is the copy you can edit without rewriting the audio. UTF-8 and
UTF-16 sidecars are both read, with or without a byte-order mark.

Timed lyrics follow the song: the current line is highlighted and scrolled into view, and clicking a line seeks there.
The highlight fills across the line as it is sung. Scrolling the panel by hand pauses the follow for a few seconds;
**Jump to the current line** brings it straight back. **−0.5 s** and **+0.5 s** correct a lyric that runs early or late,
and **Reset** removes the correction. The offset is saved per track and source in the library database, never written
into the file. A `[offset:]` tag inside the `.lrc` is honoured on top of it.

**Find lyrics** asks LRCLIB for a match and shows the source before you accept it; accepting can write it into the file
or keep it in the library only. This is the one lyrics action that touches the network.

The **expand** button turns the whole player into a lyrics stage: the cover sits blurred behind a scrim and the lines
are large enough to read from across the room. It is the same list, the same timing correction and the same fetch as
the panel, so nothing reloads when it opens. Clicking a line still seeks, **Esc** or the close button returns to the
player, and focus goes back to the button that opened it.

### Naming a file from its fingerprint

**Settings → Metadata** takes an AcoustID API key (free from [acoustid.org](https://acoustid.org/new-application)).
With a key and `fpcalc` installed, **Match by fingerprint** in the tag finder reads up to two minutes of audio and asks
AcoustID what the recording is. It is its own button — never part of a lookup, a batch or a scan — because it spends
your key and reads the file. This is how a `track01` row with unusable tags can still be named correctly. `fpcalc` is
installed by **Settings → Streaming → Download engine** alongside the other binaries.

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
| **Metadata** | The AcoustID key and the metadata providers used by **Find tags**, **Find lyrics** and **Match by fingerprint**. |
| **Misc** | Backups and restore, library health, find moved files, crash reports, reset preferences. |
| **About** | Versions of Suura, Electron, Chromium and Node, the `yt-dlp`/`ffmpeg` probe, the update feed and channel, **Copy diagnostics** and **Save diagnostics**. |

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

## Updates

Suura updates from a **static HTTPS folder** (a "feed") that serves a small channel file beside the installer. It never
downloads or installs anything behind your back:

1. **Settings → About** shows the configured feed. A build with no feed says *Not configured* and never checks.
2. **Check now** asks the feed whether a newer version exists.
3. **Download update** fetches it, with progress.
4. **Restart and install** is the only action that quits and replaces the app.

With **Check once a day in the background** on, an installed build checks once per 24 hours after a short settle. The
check is package-only; the download still waits for you.

Public builds may ship with a feed already configured. You can point the field at another folder, or clear it to
disable checks.

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
| Engine binaries | `%APPDATA%\Suura\engine\` |
| Backups | `%APPDATA%\Suura\backups\` |
| Crash reports (opt-in) | `%APPDATA%\Suura\crashes\` |
| Saved tracks | `Music\Suura\` by default |

The exact paths are listed in **Settings → Misc**. Deleting the cache folders is safe; it costs you offline copies and
covers, not library rows. Deleting `library.db` loses the library, playlists, play counts and history — take a backup
first if you care about them.

---

## Troubleshooting

**Windows says "Windows protected your PC".** The installer is unsigned. *More info → Run anyway*. See
[Code signing](#code-signing).

**YouTube says the engine is missing, or a link fails.** The **YouTube** view offers **Download engine** at the top
when `yt-dlp` or `ffmpeg` is missing. **Settings → Streaming → YouTube engine** has the same button plus **Check**. Most
playback failures are an out-of-date `yt-dlp`; it updates itself daily unless you turned that off. If the engine is
found but YouTube asks for a bot check, the **cookie fallback** can read cookies from a browser you choose; it is off
by default and never runs quietly.

**A track I moved shows as missing.** **Settings → Misc → Find moved files.** Suura matches it by fingerprint, then by
size and modification time, and keeps its id, so playlists and play counts survive.

**The library is slow to open on a network drive.** Turn off **Watch folders for changes** under **Settings → General**.
Watching is what makes new albums appear by themselves, and it is the first thing to give up on a slow share.

**A tag edit was refused.** A file that is playing, read-only, or locked by another program is reported rather than
half-written. Stop playback or close the other program and try again; an edit made during playback is queued.

**Something is broken and I want to report it.** **Settings → About → Save diagnostics** writes versions, app paths,
library-folder count, the user agent and the tail of the log to a file you choose. Nothing is sent anywhere. If it
crashed, turn on **Crash reports** under **Settings → Misc** first, then export them.

**I want a clean start.** **Settings → Misc → Reset preferences** restores the settings but keeps the library. A full
reset means uninstalling with *delete app data*, or removing `%APPDATA%\Suura` yourself.

---

## Privacy

Suura has no account, no telemetry and no analytics. It does not upload your library, your listening history or your
files.

It talks to the network only when you ask it to: playing or searching YouTube goes through `yt-dlp` to YouTube, cover
art for streamed tracks is fetched like any other thumbnail, metadata and lyrics lookups reach iTunes, MusicBrainz,
LRCLIB and AcoustID only when you press their button, and `yt-dlp` may check for its own updates. Local playback needs
no network at all.

Diagnostics are written to a file you pick; nothing is sent. **Crash reports are off by default**, stored only under
`%APPDATA%\Suura\crashes`, capped at 20, and leave the machine only if you export and share them.

---

## Legal

Suura is a music player, not a downloader. Streaming is the default and no audio is written unless you save a track,
switch on the cache, or ask Suura to keep what you play.

`yt-dlp` is a separate tool with its own licence and version. It is not bundled, and Suura does not fetch anything that
circumvents DRM or paywalls. Downloading media can breach YouTube's Terms of Service and copyright law where you live;
that responsibility is yours. Suura ships no media.

Playing files you already own is unaffected by any of this.

---

## Code signing

Public installers are **unsigned** for now. There is no certificate, so Windows shows *Unknown publisher* and
SmartScreen warns on each new file. `SHA256SUMS.txt` next to the installer lets you verify that a download arrived
intact, but it cannot prove who built it.

Suura intends to apply to the [SignPath Foundation](https://signpath.org), which provides free code signing for
open-source projects. If approved, releases will be built and signed in CI by SignPath and Windows will show *SignPath
Foundation* as the publisher. Nothing is signed locally, and no build produced outside this repository will ever carry
that signature. The full policy is in [`CODE_SIGNING.md`](./CODE_SIGNING.md).

---

## Contributing

Bug reports, fixes and features are welcome. Start with [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the build, the test
gates and the house rules. Security issues should go through [`SECURITY.md`](./SECURITY.md), not a public issue.

Suura is MIT-licensed; by contributing you agree to publish your work under the same licence.

---

## Development

Architecture, the test suite, project layout, known gaps and the release checklist live in
[`docs/development.md`](./docs/development.md). The plan and milestone state are in [`ROADMAP.md`](./ROADMAP.md),
Windows packaging details are in [`docs/release/windows.md`](./docs/release/windows.md), and the stack decision is in
[`docs/adr/0001-stack-and-storage.md`](./docs/adr/0001-stack-and-storage.md).

Quick reference:

```powershell
npm run dev          # run from source with hot reload
npm run build        # type-check and bundle into out/
npm run package:win  # build the installer into release/
npm run smoke        # core checks against real files
npm run selftest     # end-to-end run of the real app
npm run perf         # performance budgets on a 10,000-track library
```

---

## Licence

MIT. The full text is in [`LICENSE`](./LICENSE). Suura is an early pre-release: unsigned, no support promised, but the
source is yours to use, change and redistribute under those terms.
