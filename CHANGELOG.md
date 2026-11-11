# Changelog

All notable changes to Suura are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic
Versioning](https://semver.org/spec/v2.0.0.html).

Suura is a pre-release: minor versions may change behaviour and the database schema. Migrations are append-only and a
backup is taken before any schema upgrade, so an upgrade keeps the library.

## [Unreleased]

Changes since 0.1.0. Nothing here is in a published build yet.

### Library

- A library that will not open offers the newest healthy automatic backup, a fresh library or Quit, and keeps the damaged
  file beside the database.

### Playlists

- **To phone** copies a playlist's files and an `.m3u8` into a folder of your choosing, ready for a phone player.

### Settings

- Optional **Start Suura when I sign in**: one Windows sign-in entry, off by default and removed by the uninstaller.
- Streaming leads with the outcome: one engine status line, one download or repair action, and the folder, update and
  rollback controls behind **Advanced**. The bot-check card is now **YouTube bot check**, with its setup details behind
  **Set up**, and Search offers the engine download where a result needs it.
- Updates now leads with its status, daily-check switch and **Check now**; the channel and feed folder sit under
  **Advanced**, and a build with no feed offers **Turn on updates** instead of asking for a URL.

### Playback

- A write postponed because a file was open now lands when playback stops. The queue drains until it is quiet, a locked
  write is retried within the same drain, and a lasting failure is announced only after several attempts over 15 seconds.

### Security

- `player-media://` resolves `..` before the allowlist comparison and is separator-aware, `player-art://` accepts only a
  40-hex cache key, and `player-stream://` accepts only a stream's UUID. Each refusal is exercised by the self-test.
- The window denies every device permission, sends only `http:`/`https:` links to the shell, and blocks navigation away
  from itself.

### Privacy

- A privacy statement at <https://suura-player.pages.dev/privacy> lists every host and every request, including the daily
  update check — the only request the app makes on its own.

### Changed

- Crossfade is settled as **no**. Gapless playback already removes the gap between tracks; an overlap is not planned.

## [0.1.0] - 2026-11-06

First public pre-release. Everything below is new to anyone installing Suura for the first time.

### Library

- Recursive folder scanning into SQLite with FTS5 search; tags, embedded artwork and per-file details.
- Virtualized lists sortable by title, artist, album, duration, year, added and played, plus a row details sheet.
- Smart views: All, Recently added, Most played, Never played and YouTube.
- Home dashboard with recently played/added shelves, artist and playlist cards, and a merged All tracks list.
- Folder watching with an off switch for slow or network drives; rescan on demand.

### Playback

- Play/pause, next/previous, seek, volume, shuffle and repeat, with a queue that survives a restart.
- Gapless playback, a 10-band equalizer with presets, and ReplayGain-based volume normalization.
- Full-window player with a cover backdrop, a lyrics stage, and a queue panel.
- Mini player, tray icon, close-to-tray, media keys, Windows media overlay and taskbar controls.
- Keyboard navigation throughout, including list selection and `Alt`+arrows playlist reordering.

### YouTube

- The **YouTube** view offers the engine download where it is needed, with size, progress and cancel, instead of
  only behind Settings → Streaming.
- Paste a link, playlist, album or mix; resolve through `yt-dlp` and stream immediately.
- Playlist/album/mix import as a stored snapshot, with re-import, per-entry trimming and custom names.
- Search through YouTube's InnerTube API with a pager; channel pages open in place.
- Title cleanup (`Artist - Title`, removed marketing tags) and per-row saved-state.
- Prefetch of the next queue entry, a request governor, a bot-check circuit breaker, an optional PO Token provider and
  an off-by-default three-mode cookie fallback that accepts a browser or an exported Netscape `cookies.txt`, and names a
  rate limit, a locked Chrome cookie database or an undecryptable Chrome/Edge store instead of a generic failure.

### Saving and offline

- Stream-only by default; optional bounded cache and optional auto-save after playback.
- Explicit **Save to library** as Opus (or MP3/M4A), tagged with cover art, with pausing, resuming, cancelling,
  retrying and removing.
- Offline replay from a size- and age-bounded cache with pinning, LRU eviction and a disk-space pre-flight.
- YouTube's **Links / Saved / Cache** tabs replace the old Downloads view; each keeps its own state.

### Metadata and lyrics

- Manual tag editor for title, artist, album artist, album, year, genre, track/disc and lyrics, with atomic writes and
  a backup of the previous file.
- **Find tags** through iTunes and MusicBrainz with duration-aware scoring and a review dialog.
- Artwork picker: embedded, sidecar, video still or provider cover, square-cropped.
- Lyrics reading (`USLT`/`SYLT`, `LYRICS`, `©lyr`, `.lrc`), synced follow with offset correction, and **Find lyrics**
  through LRCLIB.
- Batch tag and lyrics review with one-shot undo, and per-provider rate limits.
- Fingerprint fallback: optional `fpcalc` plus an AcoustID key, exposed as its own **Match by fingerprint** action.

### Data care

- M3U/M3U8 and JSON playlist import/export; CSV library export.
- Manual backup and staged restore, rotating automatic backups, and a pre-migration copy.
- Duplicate detection with safe merge, and relocation of moved files by fingerprint then size/mtime.
- Append-only schema migrations with a `user_version` guard that refuses a newer database.

### Settings and accessibility

- Six tabs: General, Appearance, Streaming, Metadata, Misc, About, with per-section reset.
- Themes (Midnight, Cream, Follow Windows), five accents, three densities and four text sizes.
- One `<main>` landmark per view, a keyboard-complete tab strip, a modal focus trap with restoration, and
  forced-colors fallbacks.

### Packaging and updates

- Per-user NSIS installer: no administrator prompt, clean uninstall, app data kept unless explicitly deleted.
- The note icon set: one master image generates the 512 px artwork, all nine ICO frames and the tray bitmap.
- Fetch-on-first-use engine installer with pinned versions and SHA-256 verification.
- Optional update feed over a static HTTPS folder, with explicit Download and Restart-and-install steps and a daily
  background check.
- Daily `yt-dlp` self-update with last-known-good rollback.
- CI on `windows-latest`: build, smoke, self-test and performance budgets.

### Privacy

- No account, no telemetry, no analytics, and nothing uploaded automatically.
- Opt-in local crash reports under `%APPDATA%\Suura\crashes`; manual diagnostics export.

### Known limitations

- The installer is unsigned, so SmartScreen warns (see `CODE_SIGNING.md`).
- Windows 10/11 HiDPI, multi-monitor and 4K verification is still in progress.
- The Android app is planned and not started.
- Tag writing supports MP3, FLAC, M4A/M4B, Ogg and Opus; other formats are refused rather than half-written.
