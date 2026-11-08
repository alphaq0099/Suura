# Roadmap - Music Player (working name: **Suura**)

A music player that manages a **local music library** and can also **search, stream and download songs from YouTube** through a backend engine built on **yt-dlp**.

- **Platform order:** Windows desktop now. Android is **deferred and demand-only** — it is not planned work, and starts only
  if Windows is finished and users ask for it in numbers (see §7/M9).
- **Streaming first:** play immediately, no waiting for a full download
- **User's choice:** decide per-track / per-playlist whether downloaded audio is kept on disk, cached temporarily, or never written to disk at all. **The bounded cache, offline replay and the Saved/Cache tabs inside YouTube are complete in M12a + M12b.**
- **Status of this document:** the plan. Implementation has started — see [`README.md`](./README.md) for what actually
  works today, and the milestone checkboxes below for progress.

---

## 1. Product Vision

### 1.1 What it is
A single app where a user's music lives in one place:
1. **Local library** — folders on disk are scanned, indexed, and played with a proper music-player UX (albums, artists, playlists, queue, search).
2. **YouTube as a source** — paste a URL, search, or import a playlist; the app resolves the audio and plays it *immediately* while streaming.
3. **Optional retention** — the same stream can be "kept": either as a temporary cache entry (auto-evicted) or as a permanent download in the local library, with metadata and artwork attached.

### 1.2 Core principles
| Principle | Meaning |
|---|---|
| **Instant playback** | Pressing play on a YouTube track starts audio in ~1–3 s, not after a download. |
| **Explicit retention** | The app never silently permanently fills the disk. Retention is a user setting with a visible, editable cache. |
| **One library** | Local files and YouTube tracks appear in the same library, playlists, and queue. |
| **Engine is swappable** | The "how do I get audio for this track" logic sits behind an interface, so Windows can use yt-dlp and Android can use a different resolver. |
| **Honest about the law** | Downloading from YouTube can violate YouTube's Terms of Service and local copyright law. The app must be built and shipped with that in mind — see §10. |

### 1.3 Explicit non-goals (v1)
- No user accounts, no cloud service, no server-side component
- No music *upload/sharing* features
- No DRM'd commercial streaming services (Spotify/Apple Music) integration
- No social features
- No Android or iOS app while Windows is unfinished: phones already have good local players, the YouTube core cannot ship on
  Play, and a second platform would double maintenance for a solo project (M9)
- No iOS. Revisit only if a mobile port ever happens, and only after it.

### 1.4 Success criteria for v1 (Windows)
- Library of 10,000 tracks scans, indexes and is searchable; cold start < 2 s
- Playing a local file: < 300 ms to first audio
- Playing a YouTube track already resolved this session (or prefetched): < 3 s to first audio; a cold paste has a
  ≤ 10 s median display target while it resolves
- Cache/download manager never exceeds the configured disk budget *(enforced in M12a, with the manager surface and
  per-entry controls in M12b; explicit saves are bounded by the queue and reported in the Saves dock and YouTube's Saved
  tab)*
- Crash-free sessions > 99%; no orphaned yt-dlp processes after exit

---

## 2. Architecture (target end-state)

```
┌──────────────────────────────────────────────────────────────┐
│  UI LAYER                                                    │
│  Library · Search · Now Playing · Queue · Playlists ·        │
│  YouTube (Links · Saved · Cache) · Settings                  │
└───────────────┬──────────────────────────────────────────────┘
                │  commands / state (typed IPC)
┌───────────────▼──────────────────────────────────────────────┐
│  APPLICATION CORE (state, playlists, queue, settings, DB)     │
│  - LibraryService   - PlaybackService   - PlaylistService     │
│  - SearchService    - RetentionPolicy   - SettingsService     │
└───────┬───────────────────────┬──────────────────┬───────────┘
        │                       │                  │
┌───────▼─────────┐  ┌──────────▼────────┐  ┌──────▼──────────┐
│  PLAYER ENGINE  │  │  SOURCE RESOLVER  │  │  STORAGE LAYER  │
│  - decode/demux │  │  IMediaResolver   │  │  - Library DB   │
│  - output dev.  │  │   ├ YtDlpResolver │  │  - Cache store  │
│  - seeking      │  │   ├ LocalResolver │  │  - Downloads    │
│  - gapless      │  │   └ (Android:     │  │  - Artwork      │
│  - EQ/volume    │  │      NewPipe-style│  │  - Tag writer   │
└─────────────────┘  └────────┬──────────┘  └─────────────────┘
                              │
                    ┌─────────▼──────────────────────────────┐
                    │  ENGINE SIDECAR (external processes)   │
                    │  - yt-dlp  (resolve URLs, download)    │
                    │  - ffmpeg  (transcode, mux, tag)       │
                    │  - local HTTP stream proxy (optional)  │
                    └────────────────────────────────────────┘
```

### 2.1 The one architectural decision that matters most
**How does audio get from YouTube to the speakers?** Three options, and the app should support the first two:

| Approach | How | Pros | Cons |
|---|---|---|---|
| **A. Resolve-then-stream** *(primary)* | `yt-dlp -g -f <selector>` returns a direct CDN URL; hand that URL to the player, which does HTTP range requests | Real seeking/scrubbing, efficient buffering, lowest CPU | URL expires (~6 h) → must re-resolve on failure; CDN URL rate limits |
| **B. Pipe to stdout** *(fallback)* | `yt-dlp -o - -f <selector>` pipes bytes into the decoder | Never expires mid-stream; works when direct URLs are blocked | No seeking, no range requests, fragile buffering |
| **C. Always download first** *(fast path when keeping)* | `yt-dlp -x --audio-format ...` to disk, then play the file | Simple, seekable, already cached | Not "instant"; wasted work if the user skips |

The UX rule: **start with A, fall back to B if A fails, and switch to C automatically when the user has said "keep this one"** — so a keep-requested track downloads in the background while A already plays it.

### 2.2 Retention modes (per the requirement)
Expose this as a three-way user choice, set globally with per-track / per-playlist overrides:

| Mode | Behaviour | Where the bytes live |
|---|---|---|
| **Stream only** | Nothing is written to disk. Pure streaming. | RAM buffer only |
| **Cache (smart default)** | Bytes are written to a temp cache while playing; evicted LRU when the cache budget is exceeded. Offline replay works until eviction. | `<appdata>/cache/audio`, size-capped |
| **Keep / Download** | Full download, transcoded, tagged, artwork embedded, moved into the library as a permanent track. | User's library folder |

Extra per-track actions in the UI: `Keep`, `Remove download` (falls back to streaming, and the *same* track stays in playlists), `Pin in cache` (never auto-evict).

---

## 3. Technology Stack — Decision Point

> **Status: intentionally deferred.** The stack choice is not blocking anything in this document except M0's ADR. Everything below is written to stay stack-agnostic — the data model, retention policy, engine contract, and milestone order are identical in all three options.
>
> **What deferring costs you:** nothing, as long as §3's cross-cutting choices (SQLite, the IPC schema, the `IMediaResolver` interface, the sidecar contract) stay framework-neutral. Those are the parts that would be expensive to redo.
>
> **What to avoid until you decide:** building UI before the wireframes are frozen, and writing engine code that assumes a specific process/IPC model. Prototype the *engine* first — it's the risky part and it's portable across all three stacks.

This is **Phase 0's only hard deliverable**. Options:

| | **Option A — Tauri 2 + Rust core + web UI** | **Option B — Electron + Node** | **Option C — Flutter (Win + Android)** |
|---|---|---|---|
| Windows maturity | High | Highest | Medium |
| Binary size / RAM | ~10–20 MB / low | ~150 MB / high | ~30 MB / medium |
| Dev speed (first version) | Medium | Fastest | Fast |
| Sidecar process management (yt-dlp/ffmpeg) | Excellent (Rust `Command`, bundled sidecars) | Excellent | Good (platform channels) |
| Audio playback | Web `<audio>` / Rust (rodio, cpal, symphonia) | Web `<audio>` / native addon | just_audio / media_kit |
| System media controls (SMTC, media keys) | Plugin needed (or Rust via `windows` crate / `souvlaki`) | Good community packages | Package-dependent |
| Path to Android | Tauri 2 supports Android, but less proven | Poor (needs rewrite) | **Excellent — one codebase** |
| Recommendation | **Primary recommendation** if Android reuse matters | Fastest to a Windows demo | **Recommendation if you want one UI codebase for both platforms** |

**Suggested resolution (decide in Phase 0):**
- If the goal is a polished Windows app *and* you're comfortable in Rust → **Tauri 2**.
- If the goal is to reach both Windows and Android with the least duplicated UI work → **Flutter** with a native platform-channel engine layer.
- Either way, keep the **core logic in a service layer behind interfaces** so the engine choice stays reversible.

**Cross-cutting choices to lock in Phase 0**

| Concern | Choice (proposed) |
|---|---|
| Player engine (Windows) | Web/`<audio>` for a quick start; migrate to a native path (rodio/symphonia or `media_kit`/libmpv) if gapless/format needs demand it |
| Metadata & tags | `lofty` (Rust) / `mutagen` (Python) / `taglib` — pick one and use ffmpeg only for transcoding |
| Library DB | **SQLite** (with FTS5 for search) — single file, ships everywhere, trivially portable to Android |
| Artwork cache | Content-hashed files on disk + thumbnails |
| IPC | Typed command/event protocol, one schema, validated on both sides |
| Streaming proxy | Optional localhost HTTP proxy so the player only ever talks to `http://127.0.0.1:PORT/stream/{id}` (hides expiry, gives stable seekable URLs) |
| Config | JSON/TOML in the OS config dir; secrets (cookies) in the OS keychain |

---

## 4. Data Model (draft)

```
Artist        (id, name, sort_name, image_ref)
Album         (id, title, artist_id, year, artwork_ref, album_type)
Track         (id, title, duration_ms, track_no, disc_no, album_id,
               artist_id, genre, year, path_or_url, source_kind,
               source_id, file_size, bitrate, codec, added_at,
               is_available_offline, loudness_lufs, rating, play_count,
               last_played_at, content_hash)
Playlist      (id, name, description, created_at, is_smart, smart_query,
               cover_ref, sort_order)
PlaylistItem  (playlist_id, track_id, position, added_at)
Source        (id, kind = local|youtube, external_id, web_url, channel,
               upstream_title, upstream_duration, resolved_url,
               resolved_at, expires_at)
DownloadJob   (id, track_id, state, progress, speed, eta, format,
               target_path, bytes_written, error, retries, created_at)
CacheEntry    (track_id, path, size_bytes, last_used_at, pinned, complete)
PlayHistory   (track_id, started_at, played_ms, completed)
Setting       (key, value, scope = global|track|playlist|source)
```

**Track identity & de-duplication** — the hardest correctness problem:
- Local file identity: `content_hash` of the audio stream (`path + size + mtime` as a fast pre-check).
- YouTube identity: the video ID from the URL/extractor.
- **The same song may exist twice** (once local, once YouTube). Model this with a *virtual track* concept: canonical track + N *availability* rows. The player picks the best available source (local file > pinned download > cache > stream). This is what makes "Keep/Remove download" non-destructive.
- A "match local to YouTube" feature (fuzzy title/duration matching) can be a later milestone to merge the two views.

---

## 5. Disk & Cache Layout

```
%APPDATA%/Suura/
├── config.json                 # settings
├── library.db                  # SQLite (+ FTS5)
├── cache/
│   ├── audio/<hash>.opus        # transient / smart-cache audio
│   ├── artwork/<hash>.webp
│   └── stream/                  # partial files for in-progress streaming
├── downloads/<hash>.part        # in-progress permanent downloads
├── logs/                        # rotating, includes yt-dlp stderr
├── engine/
│   ├── yt-dlp.exe
│   ├── ffmpeg.exe
│   └── version.json
└── <user library folder>/       # final "kept" files
    ├── Artist/Album/01 - Title.opus
    └── Artist/Album/folder.jpg
```

Rules:
- Cache has a **hard size budget** (default e.g. 5 GB) and a **hard age budget** (default e.g. 30 days), both user-editable; a janitor task enforces them.
- `*​.part` files are cleaned up on start and on failure.
- Kept files follow a **configurable naming template** (e.g. `{artist}/{album}/{track:02} - {title}`), with a safe-filename sanitizer.
- Every file the app writes must be traceable back to a DB row, so "remove download" is a clean delete.

---

## 6. The yt-dlp Engine Layer (the heart of the app)

### 6.1 Responsibilities
1. **Resolve** a YouTube URL/ID/search query → metadata + a playable media URL
2. **Stream-feed** the player (via resolved URL or stdout pipe)
3. **Download** when retention demands it, with progress reporting
4. **Post-process** with ffmpeg (extract audio, transcode, embed tags/artwork)
5. **Self-manage**: version check, updates, health checks, cookie handling

### 6.2 Process contract (what to specify in Phase 0)
- Run yt-dlp as a **long-lived worker** with `--newline` (parseable progress) or better `--progress-template` emitting structured lines, plus `--no-playlist` by default.
- Prefer **machine-readable output**: `--dump-single-json` for metadata, `--print` with a template for URLs/fields.
- One JSON message per line over stdout/stderr → a typed event stream in the core (`JobStarted`, `Progress`, `JobFinished`, `Error`).
- **Job queue with concurrency limits**: two metadata starts at a time with a jittered gap; downloads use a separate lane capped by the user setting, so a long save never blocks playback.
- **Timeouts and cancellation**: a cancel must kill the process tree; no zombies.
- **Retry policy**: exponential backoff; on `429`/`403`, re-resolve rather than retrying the same URL.

### 6.3 Format & quality policy
- Format selector tiers: `Best available` / `High (~256k)` / `Balanced (~128k)` / `Data saver (~64k)`.
- Prefer **Opus** in WebM/Ogg for streaming (great quality per byte); for "kept" files offer `Opus (recommended)`, `MP3 320`, `M4A/AAC`, `FLAC passthrough` where the source allows (and be clear that transcoding from a lossy source never adds quality).
- Never transcode on the streaming path (CPU cost + latency); transcode only when a keep/download is requested.
- Loudness: optional normalization via ffmpeg (`loudnorm` / ReplayGain) **only** on the download path.

### 6.4 Operational realities to design for (do not skip)
| Problem | Mitigation |
|---|---|
| Signed CDN URL expiry | Re-resolve on `403`; keep `Source.expires_at`; the local proxy hides this from the player |
| Bot checks / "Sign in to confirm you're not a bot" | Optional external PO Token provider (`youtubepot-bgutilhttp`), an off-by-default cookie fallback (`off` / once after a bot check / always), a 5/15-minute circuit breaker, and a clear in-app message. The app does not bundle the provider or the plugin |
| Rate limiting (`429`) | Two metadata starts at a time with jitter, one transient retry, a 5/15-minute breaker, and a UI-visible cooldown message |
| Extractor breakage | yt-dlp ships frequent fixes → **auto-update the sidecar**, keep the last-known-good binary, roll back on failure |
| Bundling ffmpeg | Fetch on first use (chosen in M8) with a pinned URL, byte count and SHA-256. **The current pin is a GPL-3.0 `ffmpeg-static` build**, while this table and the README imply LGPL; either move to an LGPL build or state the GPL provenance in the third-party notices (§14.3) |
| Region/age restrictions, geo-blocks | Detect the specific error and give a human-readable reason instead of "failed" |
| Non-music videos, live streams, very long videos | Reject or warn; mark as non-library content |
| yt-dlp's own ToS posture | yt-dlp is public domain (Unlicense); the *act* of downloading is the user's responsibility — the app must say so |

### 6.5 Engine abstraction for Android
Define `IMediaResolver` now, so Phase 8 is a swap, not a rewrite:

```
IMediaResolver
  ├── resolve(queryOrUrl) -> TrackMetadata + PlaybackSource
  ├── search(query)        -> [TrackMetadata]     (may be unsupported on some backends)
  ├── fetchForKeep(track, opts) -> DownloadedFile
  └── capabilities()       -> { search, streaming, download, formats }
```

Implementations: `YtDlpResolver` (Windows), `NewPipeExtractorResolution` or an embedded-Python approach (Android), `LocalFileResolver` (both). Android cannot run yt-dlp comfortably (it's Python), so plan for a **NewPipeExtractor-based resolver** and let the UI degrade gracefully when a capability is missing.

---

## 7. Milestones

Assumes roughly one developer, part-time-to-full-time. Durations are relative, not promises.

### M0 — Foundations & Decisions  *(~1 week)*
**Goal:** every irreversible choice is made and written down.
- [x] Choose the stack (§3) and record it in an ADR (Architecture Decision Record)
- [x] Decide the player engine and the primary streaming approach (A/B/C above)
- [x] Wireframe the 6 core screens: Library, Now Playing, Queue, Search, Downloads, Settings — all six are built;
      the saved-files and cache manager arrived with M12b and now live as YouTube's Saved and Cache tabs
- [x] Write the `IMediaResolver` interface and the IPC event schema (as a spec, not code) — built, not just specified:
      `src/engine/resolver.ts` and `src/shared/ipc.ts`
- [ ] Verify yt-dlp + ffmpeg work as sidecars on a clean Windows machine; measure resolve latency and success rate on 20
      representative videos — presence is checked by `npm run smoke`; the 20-video sample (**20/20**, median 8.8 s) and
      the 50-video M3 sample (**50/50**, median 8.3 s) are done, in [`docs/internal/notes/yt-dlp-sample.md`](./docs/internal/notes/yt-dlp-sample.md)
      and [`docs/internal/notes/yt-dlp-50.md`](./docs/internal/notes/yt-dlp-50.md); the clean-machine pass is still open
- [x] Legal/ToS note drafted (§10) — in the README under **Legal** and in `docs/development.md` under **Scope and legal**
**Exit:** a one-page architecture doc + stack ADR + working sidecar smoke test.

### M1 — Local Library MVP  *(~2–3 weeks)*
**Goal:** it is a genuinely usable local music player.
- [x] Folder scanning (recursive, incremental index into SQLite)
- [x] Tag reading → Artist/Album/Track ingestion; compilation & multi-artist handling
- [x] Library UI: virtualized list, sort by title/artist/album/duration/year/added/played, search via FTS5. Columns are
      **#, Title, Artist, Album, Duration, Action**; Format is not a column but a row's **Details** sheet (format, codec,
      bitrate, sample rate, channels, size, path, added/played, YouTube origin), opened from the ⋯ button or the row menu.
      The Queue view carries the same six-column header, aligned with its rows. The later consistency pass makes Title
      the only flexible track, gives Artist/Album equal bounded widths, and uses a separate **#, Title, optional Artist,
      Channel, Duration, Action** grid for YouTube Links (no Album).
- [x] Artwork: embedded covers extracted lazily, resized, cached content-addressed, served over `player-art://`
- [x] Home dashboard and album grid (visual revamp): cover-led hero with the library stats under its heading, recently
      played/added shelves, artist cards that open the artist's tracks, playlist cards, and one searchable **All tracks**
      list with a **Source** column, plus an in-place album/artist detail view. Album summaries group by title plus the
      album-artist fallback; covers load lazily as cards approach the viewport. A one-track album is a single, so its
      card plays the song; a real album still opens its detail page. Home is the fresh-install launch view.
- [x] Now Playing: full-window player with a blurred art backdrop, transport, volume, queue and a scrubber; the queue
      as a panel inside the window, slid in by the button that opened it and dismissed by a press anywhere outside it
- [x] Visuals settings: artwork square or circular, cropped to a square or given the cover's own shape, and sized from
      small to extra large; ambient player-bar background masked to no hard edge; volume as mute-on-click with the
      slider revealed on hover, and a wheel over the control nudging it by 5% by default (configurable 1–25%, with
      Shift still 1%); the player bar's own speaker icon is the same kind of toggle
- [x] Click behaviour setting: single click and double click each choose select / play / select-and-play / nothing
- [x] Playback: play/pause/next/prev/seek, volume, shuffle, repeat (off/all/one)
- [x] Queue management (add to queue, jump, remove, clear)
- [x] File watching for changes: an OS watcher per folder, debounced, turning any change into an incremental scan that
      prunes what disappeared; a setting to turn it off for slow or network drives
- [x] Basic playlists: create, rename, delete; add from the library selection bar, a row's context menu or the queue in
      the player window; remove entries; reorder by drag or Alt+↑/↓ with a gap-based position that keeps the order exact;
      a resizable (and remembered) playlist index; playlist columns that respond to the pane's own width; the opened
      list uses the album page's hero (large sleeve, name, facts and actions above the rows) for custom and imported
      playlists alike
- [x] Persist play state; resume last session on start
- [x] 10,000-track check (`npm run scale`): cold start 1.3 s, first audio 98 ms (median of three decoded samples),
      first page 15 ms, search 4 ms, database 5.5 MB, main-process RSS 174 MB; the core numbers are budgets now, not
      just a report (`npm run perf`)
**Exit:** 10,000-track library is fast, searchable and pleasant; audio starts in < 300 ms.

### M2 — Player Quality & System Integration  *(~2 weeks)*
- [x] Gapless playback between consecutive tracks (album continuity)
- [x] Media keys (global shortcuts for play/pause, next, previous, stop)
- [x] Windows SMTC (now-playing overlay), taskbar thumbnail controls
- [x] Mini player, tray icon, close-to-tray behaviour
- [x] 10-band EQ + presets, preamp
- [x] ~~Optional crossfade~~ **removed, not built** — the 1.0 decision. Gapless covers the transition need, and a
      crossfade would have to change the transport itself (the next track becomes audible before the old one is
      silent, so the progress bar, the Windows overlay and the queue would name it early) and would fight the
      ReplayGain gain. See §14.5.
- [x] Volume normalization for local files (ReplayGain scan)
- [x] Keyboard shortcuts (space, arrows, N/P, M, Ctrl+F, Escape)
- [x] Drag & drop of files/folders
**Exit:** feels like a real desktop music app, not a tech demo.

### M3 — Engine Skeleton (resolve + stream, no downloads)  *(~2–3 weeks)*
**Goal:** **the core differentiator.** Paste a YouTube link, hear audio in seconds, nothing kept.
- [x] Sidecar manager: locate/verify/launch/kill yt-dlp & ffmpeg, capture stderr into logs
- [x] Resolver: URL → metadata + playable source
- [x] Search-by-text — **landed in M5**, as an explicit search rather than a catalogue browser; paste remains the
      shortest path and nothing browses recommendations on its own
- [x] Local HTTP stream proxy with range-request support and a stable per-track URL — implemented as the
      `player-stream://` custom protocol instead of a localhost server, with header replay, stable tokens and range
      forwarding
- [x] Player integration: **Stream only** mode works end-to-end
- [x] Playback state machine for stream sources (loading → buffering → playing → failed) — loading, buffering,
      playing and failed are distinct; a started stream that runs dry says *Buffering…*, and a long stall hands over
      to the reconnect state
- [x] Error taxonomy & user-facing messages (expired URL, bot check, geo-block, unavailable, network)
- [x] Re-resolve on failure/expiry, transparent to the player
- [x] Resolve-result metadata cache (avoid re-resolving the same video within a session)
- [x] Request governor: at most two yt-dlp metadata processes (playlist imports), jittered start gap, a five-minute
      search/channel cache with single-flight, one transient-failure retry, and a bot-check breaker (5 min / 15 min on
      a repeat) that leaves already-resolved streams playing. Search/channel now use InnerTube, so they do not start a
      sidecar at all. Prefetch is a setting. Browser cookies are off by default and can be used never, once after a
      bot check, or always; a PO Token provider is an optional external HTTP server with an optional managed command,
      and a start that is slow to bind is watched instead of killed.
- [x] Next-track prefetch: four seconds into a stream the player asks the main process to resolve the entry it will
      play next (`media:prefetch` → `ResolverRegistry.prefetch` → `YouTubeResolver.prefetch`), filling the cache the
      play will read without registering a token, recording history or failing the caller. A video id is asked for once
      per session and the timer dies with the track, so skimming a queue does not spawn a sidecar per row. Only the
      resolve is brought forward; the bytes are still streamed on demand.
- [x] Paste surface: a dedicated **YouTube** view (sidebar, under Library) with a persistent link history — a pasted link
      becomes a row at once (*Resolving…*), then fills in; **Add to queue** / **Play now**, per-row album/channel/duration,
      a right-click menu (Play, Add to queue, Copy link, Remove) and a **YouTube** badge in the player bar. Rows show a
      cached thumbnail, fetched from the video id the first time the row is drawn (and repaired if an earlier pass failed).
      Saving a row into the library is M4 (done). The history is links, not files, so it survives a restart and a cache
      wipe, and it holds only links the user added — playing a track out of an imported list never echoes it there, and
      importing a list withdraws any row a play had already made for one of its entries. After an import & play, the
      card itself names the list, the current track and its position; the mark is held by the app, not by the view, so
      visiting another view and coming back keeps it, and playing an imported list from the Playlists window lights it
      up as well. Imported lists also get their own box above the history: one card per list (not one row per track),
      with **Play** for the whole list and **Open in Playlists**, so the history stays a log of links the user chose.
      The imported box keeps three recent cards and the history seven rows in view, both scrolling for the rest; a card
      without a sleeve uses its first entry's still; and the link field has a right-click **Paste** menu beside the
      paste button.
**Exit:** 50 hand-picked YouTube links play directly, ≥ 90% on first attempt, < 3 s to first audio, and seeking works.
*Status: **exit measured and met on the agreed definition.** A fresh 50-link sample resolved **50/50 (100%)**, and
playback with seeking works end-to-end through the YouTube view. The median cold resolve was **8.3 s** (6.8–11.5 s)
and the CDN's first 2 KB arrived in a median **0.46 s** (176–1263 ms), so the sidecar is the cost, not the stream. The
`< 3 s` target is therefore adopted for **warm playback**: pressing play on a track whose URL is already in the session
cache, or moving to a prefetched next track, starts audio in well under a second. A **cold paste** has a display target
of **≤ 10 s median** and shows *Resolving…* while it waits; making cold start `< 3 s` would require a resident sidecar
(and a larger install), which is deliberately not this milestone. The M3 buffering state shipped in `e4ab1ba`. Evidence:
[`docs/internal/notes/yt-dlp-50.md`](./docs/internal/notes/yt-dlp-50.md).*

### M4 — Save to Library (lite)  *(done; automatic cache split into M12)*
**Goal:** keep the "save it explicitly" half of §2.2. Saving stays a deliberate action; the automatic cache is a
separate layer with its own budget, and the two never pretend to be the same thing.
- [x] **Keep** action: download → tag → embed cover → move into the library → scanned row appears (default Opus, or
      MP3/M4A; folder, quality and format are settings). Verified live: 12 s for a 4.9 MB Opus, tags and JPEG cover intact.
- [x] **Keep an imported entry**: the same path from the imported playlist pane — a per-entry *Save to library* button and
      a *Save all* that queues every entry not already in the library. The library row keeps the video id in
      `origin_kind`/`origin_id`, so *sourceId* is preserved without pretending the file is a stream.
- [x] Download manager: per-track queue, concurrency cap, progress parsed from yt-dlp, a per-save temporary folder,
      `.part`-safe final moves, and **cancel** (queued or running). Cancelling is reported as a decision, not an error.
- [x] Startup sweep: a crash or force-quit never runs the per-save cleanup, so the next start removes its own UUID temp
      folders and orphaned `.part` files. Unrelated folders in `downloads/` are left alone.
- [x] **Saves dock**: one compact panel mounted by the app, visible from every view, with pause/resume, live speed/ETA,
      cancel while running, retry after a failure or cancel, and reveal-in-Explorer once the row is indexed. It links
      to YouTube's Saved tab, where the durable ledger lives.
- [x] Settings honest (M12a): **Stream only**, **Save played tracks** and **Keep after play** are all real modes; the
      cache budget and max-age fields appear only when the cache is selected, and disk pre-flight plus the download
      history are implemented behind them.
- [x] **Remove download**, per-item pin/retention UI, pause/resume, speed + ETA and the durable saved-files manager — the
      remaining half of the old M12 scope, delivered as **M12b** and merged into YouTube's Saved and Cache tabs.
**Exit:** saving a history row or imported entry round-trips into an ordinary tagged library track; a killed process
leaves no temp folder; pause/resume, cancel, retry and remove work from the dock and the Saved/Cache tabs. **Met.**

### M5 — Discovery & YouTube Library Surface  *(complete)*
- [x] Unified search: **On this device**, **Imported** and **YouTube** as three shelves in one view. Typing filters
      the first two from SQLite as it settles, without a network call, so files and remembered videos answer
      immediately; YouTube stays behind **Search YouTube** (button or Enter) and is never guessed. A device row plays a
      file at once. A YouTube row goes through the same add-link path as a pasted URL, so it is remembered in the
      YouTube history and uses the same resolve cache. Results are cards in Home's visual language, capped at eight
      per local shelf with **Show all**, and a YouTube answer is one **Best match** plus four alternatives with a small
      **+5 more** control that loads one extra page; ten rows is the ceiling, because past the top ten a text match is
      a guess rather than a near miss. Choosing a result still returns metadata only, so nothing is resolved or written
      until it is chosen. The
      view stays mounted for the session, so leaving Search and returning keeps the query, results and open channel; a
      restart clears them.
- [x] Search may warm the best YouTube match once, and only when the query found nothing on the device or in the
      imported lists. The guess waits 1.8 s after the answer appears, never overlaps another resolve, respects the
      existing **Prefetch the next track** setting, stays quiet for 45 s after an attempt and pauses with the engine
      after a bot check. It is cancelled by playing a card or editing the query, so a warm-up never outlives the
      result it was meant for.
- [x] Channel/artist pages (basic), **more from this channel**. A search result's channel id or handle opens a page of
      its recent videos in place, with the same row actions. Search results that carry only a display name fall back to
      a name search; the page says what it is instead of inventing a channel URL.
- [x] Discovery separated from playback. Search and channel pages now use YouTube's InnerTube web API
      (`src/engine/innertube.ts`), while yt-dlp remains the only playback, playlist-import and download path. A search
      no longer spends the anonymous request budget a resolve needs, so discovery keeps working while playback is in a
      bot-check cooldown. The provider follows continuations, resolves an `@handle` to its `UC…` id and caches it for
      five minutes, and skips live/upcoming rows that cannot be queued.
- [x] Auto-attach YouTube metadata: `Artist - Title (Official Music Video)` becomes artist **Artist** and title
      **Title**. Bracketed marketing tags (`Official Audio`, `Lyrics`, `4K`, `Remastered 2011`, …) are removed; `(Live)`
      is deliberately kept because it is a different recording. Applied to pasted links, imports, search results and
      channel rows. MusicBrainz matching is not started.
- [x] Playlist import from a YouTube playlist URL — **landed early, during M3/M4**. A `--flat-playlist` fetch (one
      process, capped by a setting, default 200) stores a snapshot in `online_playlists` + `online_playlist_items`; a
      `music.youtube.com/playlist?list=OLAK5uy…` link is an album (list title = album, common entry uploader = album
      artist); `RD…`/`start_radio=1` mixes are imported too, capped by their own setting (default 50). `v=…&list=…` plays
      the video and offers the import; account lists (`LL…`, `WL…`, `FL…`) and channel pages are refused before a sidecar
      runs. The Playlists view separates **Custom** from **Imported**, and an imported snapshot can be played, queued,
      re-imported, trimmed or deleted entry by entry. An imported list can be renamed: the user's name lives in
      `custom_title` (migration 8) apart from YouTube's title, so a re-import refreshes the snapshot without undoing it,
      and the list id is shown as the stable identity. A **Tracks** box beside Re-import overrides the cap for that one
      import (1…1000), so a mix or radio can be given a length on the spot. Metadata only for now: audio resolves lazily
      on play, and each entry (or the whole snapshot) can now be saved to the library through the M4 download path.
- [x] Show which imported entries are already in the library — a `savedOrigins` query per page turns the save button
      into a tick, and the same information prevents a second download of the same video.
- [x] Smart views in the Library: a chip row for **All**, **Recently added** (the last 30 days, newest first), **Most
      played** (play-count order), **Never played** and **YouTube**, with counts. The local views are answered in SQLite
      rather than by filtering the loaded pages; search applies inside the chosen view and a column sort overrides its
      natural order. There are no user-defined smart playlists yet: the chips are fixed views, not saved lists.
- [x] Fold "YouTube-only" tracks into the normal library views so it feels like one library — the **YouTube** chip feeds
      the played-link history through the ordinary track table, with Play, multi-select, Add to queue, Save to library,
      and a row menu holding Remove from history and Details. The rows stay links (they are not local tracks and the
      local chips do not count them), but the user no longer has to leave the Library to see them.
**Exit:** a user can go from "no music" to "a 40-track playlist playing" without touching a folder.
*Status: complete. Search splits local, imported and YouTube answers into three shelves, fills the first two while
typing, searches YouTube only on request as one best match and four alternatives with one +5 page, and warms one best
match when the local shelves are empty. Channels open in
place, smart chips cover recent, played and unplayed views, and the YouTube chip folds stream-only history into the
Library. Imported lists plus the link history cover the "start from nothing" path. The channel page is a flat
recent-videos list on purpose — no subscriptions, no channel import, no "download all".*

### M6 — Settings Revamp  *(complete)*
**Goal:** one deliberate pass over Settings after M5, instead of growing it card by card. The page currently mixes
library folders, engine paths, playback choices, artwork, saving, import caps and about text in one long scroll; it
works, but it has no hierarchy and no way to find a single option.

- [x] Structure agreed with the user: **six top tabs** — General, Appearance, Behaviour, Streaming, Misc, About — with
      one scrollable panel at a time. The heading and tab strip stay put; the panel owns the scrollbar.
- [x] Make every control state what it changes and whether it applies now or on restart; no dead or duplicate controls
- [x] Move diagnostics (engine status, paths, logs, database location) behind **Misc** rather than the main flow
- [x] Give saving one honest home: folder, quality, format and concurrency, plus the retention modes and bounded-cache
      controls in one place under **Streaming**
- [x] Streaming controls for the request budget: next-track prefetch, daily yt-dlp self-update, an optional external PO
      Token provider (URL, command, auto-start, status), and a three-mode browser-cookie fallback with its privacy caveat
- [x] Bounded Appearance: Midnight/Cream/Follow Windows, five contrast-checked accents, Compact/Comfortable/Spacious
      density, Small/Medium/Large/Extra Large text presets, Modern/Classic sidebar glyphs, Solid/Accented surfaces (accent
      wash and CSS blur, not native acrylic or album-art frost), a motion preference, info-icon
      explanations, cover-art and playlist-cover sizes, grouped **Local lists** Album / **YouTube lists** Channel
      controls, and reset. One bundled typeface (Inter) rather than a font-family picker. No arbitrary CSS, third-party
      icon packs, layout builder, custom accent or Material theme in v1
- [x] Review defaults and reset-to-default. **Misc → Reset preferences** restores playback, appearance, behaviour, import
      limits, saving quality and request-budget choices from the same defaults a first launch uses, while keeping the
      library, engine and download folders and the last engine-update timestamp. Settings export/restore is deliberately
      left to the backup work in M7
- [x] Density pass after first use: Streaming is one column with two-column fields (no dead half-page under short
      cards), PO Token and cookie fallback are separate cards, and long explanations moved from General, Appearance,
      Misc and About into info tooltips behind one-line hints
- [x] Second pass on the controls themselves: General opens the last non-settings view by default (or a fixed Library,
      YouTube, Search, Playlists or Queue), can scan on launch, sets click behaviour, the wheel step (5% default, 1–15,
      Shift 1%) and whether the restored queue plays or stays paused; Misc sets automatic-backup retention
      (10 default, 3–50) and prunes immediately; General, Playback, Streaming and Appearance each reset without
      touching folders or the other sections; About shows the app, Electron, Chromium and Node versions plus Copy
      diagnostics (versions, paths, folder count and user agent, never cookies or library files); M8 adds Save
      diagnostics, which writes the same snapshot plus the recent log to a local text file
- [x] Accessibility and keyboard pass: tablist arrow/Home/End movement with roving focus, focusable scrollable panels,
      real `<label>` elements around every field, `aria-pressed` on the choice buttons, a live error banner and a
      two-step reset confirmation with a status message
- [x] Search within Settings considered and deferred: five tabs keep every option one click away, so a second search box
      would add a mode without removing a step. Revisit if the page outgrows the tabs
**Exit:** a new user can find and change any setting without scrolling past unrelated cards, and every control has a
visible effect. **Met.**

### M7 - Playlists, Sync & Data Care  *(complete)*
- [x] M3U / M3U8 and JSON import-export of playlists; CSV export of the library. Export covers hand-made playlists
      (absolute paths, UTF-8, CRLF); import resolves relative paths, matches saved tracks by content key or YouTube
      origin, reports added/duplicate/missing/invalid entries, and refuses to create an empty playlist. CSV is the
      uncapped library with a BOM and RFC 4180 quoting.
- [x] Backup/restore of `library.db` + config; automatic rotating DB backups. Manual backups are a folder with the
      database, normalized settings and a manifest; restore validates integrity and schema before staging the swap for
      the next start. Automatic copies use `VACUUM INTO` when the newest copy is more than 24 hours old and before a
      migration, and the configured number of managed copies rotates (10 by default, 3–50 in Misc).
- [x] DB migrations framework: append-only versioned migrations, a `user_version` guard that refuses a newer schema, and
      a pre-migration backup whose path is named in a migration failure.
- [x] Duplicate detection with safe merge: present local files are fingerprinted lazily with SHA-256, grouped, and
      merged oldest row first. Playlist entries and play counts move to the keeper; the redundant file is deleted only
      after the rows merge. The scanner resets a hash when a file changes.
- [x] Missing-file handling: a vanished file keeps its row with `missing_at`, stays in its playlists and history, and
      is hidden from normal lists. Relocation scans a chosen folder and matches by stored hash first, then by exact
      size and modification time, folding any already-indexed target into the retained row.
- [x] Bulk operations: multi-select play, queue, add-to-playlist and remove-from-library. Removing rows never deletes
      files. Remove-download landed with M12b; tag writing still needs a tag writer and remains deferred.
**Exit:** data survives a crash, a reinstall and a folder move. **Met:** manual and rotating automatic backups, staged
restore, migration guard, and id-preserving relocation were exercised in the smoke test and the UI self-test.
**Status:** complete.

### M8 — Windows Release Engineering  *(~2 weeks; in progress)*
**Goal:** a stranger can install, use and uninstall it without instructions.

**Order of work.** CI first, because it is independent of the artifact and makes every later step verifiable. Then the
sidecar delivery model (settled: fetch on first use) and its implementation, then the update channel and engine
rollback, then crash reporting and the compatibility/accessibility pass. Signing and release polish stay last. The
installer is already done; what is open is what the installed app *contains* and how that is replaced, which is why the
artifact's shape is settled before the work tested against it (updates, provenance, signing checks, compatibility, CI
packaging).

- [x] CI on GitHub Actions: build (typecheck included), smoke and the self-test on `windows-latest`, plus `npm run perf`
      in its own job. The workflow at `.github/workflows/ci.yml` ran green on the first push: smoke 1257/1257, self-test
      all checks, perf budgets met.
- [x] Installer (per-user, no admin): electron-builder NSIS x64, clean uninstall and an opt-in prompt to delete
      `%APPDATA%\Suura`. Silent install, the installed build's `--selftest`, and silent uninstall were verified; app
      data survived by default.
- [x] Code signing path documented (or at least a documented SmartScreen workaround plan): certificate environment
      variables, checksum publishing and the unsigned-build warning are in `docs/release/windows.md`. No certificate is
      configured on this machine.
- [x] Daily yt-dlp self-update, throttled to once per 24 h and recorded in `engine.lastUpdateCheckAt`
- [x] Sidecar delivery model decided: **fetch on first use**, not bundling. Each asset is pinned by version, byte count
      and SHA-256 in `src/engine/sidecar/manifest.ts`, downloaded into `%APPDATA%\Suura\engine`, verified before an
      atomic rename, and recorded in `install-record.json`. The installer stays small and the app does not redistribute
      ffmpeg; an offline machine keeps its existing `PATH`/configured-folder setup.
- [x] Sidecar packaging: the engine prefers the configured folder, then the app-managed copies, then `PATH`, then the
      usual install locations. Settings → Streaming shows each file, downloads missing ones with progress and Cancel,
      and handles the optional `fpcalc` separately. A usable copy outside the engine folder is reported as *available*
      (and where it came from), never as "missing", and the install record stores the installed file's size so a zip
      member is not compared against the archive size. Unblocks M13 Phase 6.
- [x] App auto-update through a generic HTTPS feed, plus engine rollback now that there are managed bytes and a
      provenance rule. `electron-updater` reads `latest.yml` on **Stable** and `beta.yml` on **Beta** from a static feed
      folder set in Settings → About; a missing feed is a clear "not configured" state, and nothing is downloaded or
      installed without pressing Download then Restart and install. A daily package-only check runs once per 24 h after
      a 30 s settle. Before `yt-dlp -U`, the working binary is copied to `yt-dlp.previous.exe` (+ a small JSON record);
      a broken update, a failed update, or three extractor failures in ten minutes restores it (30 min cooldown), and
      Settings → Streaming can restore it by hand. A fresh pinned install clears the old fallback.
- [x] Manual log export: Settings → About → Save diagnostics writes the app/path snapshot plus the last 256 KB of the
      log to a user-chosen text file. The renderer → preload → IPC → write path is covered by the self-test; nothing is
      uploaded.
- [x] Renderer sandbox enabled. The preload imports only `electron` and shared constants; the self-test proves the
      bridge and `webUtils.getPathForFile` still work under `sandbox: true` in dev and packaged builds.
- [x] Opt-in local crash reporting: Settings → Misc has a **Crash reports** switch (off by default) that writes a small
      JSON report under `<userData>/crashes` on a main-process exception, an unhandled rejection, a renderer-process crash
      or a Chromium child-process crash. The card shows the count, newest time, folder and size, exports the reports as a
      text bundle the user chooses, and clears them after confirmation. No remote service is configured and nothing is
      uploaded; turning the switch off stops new files and leaves existing ones for inspection.
- [ ] Windows 10/11 compatibility matrix, HiDPI, multi-monitor, 4K scaling. The code side is in: covers are cached
      at up to 1280px (schema migration 18 re-extracts the old 512px ones), the self-test repeats every fit check at
      940x580 with extra-large text, closing the mini player clamps bounds from an unplugged monitor back on screen,
      and `docs/release/windows.md` carries the hardware checklist. The box stays open until that checklist has been
      run on real Windows 10 and 11 machines.
- [x] Performance budgets enforced headlessly (`npm run perf`): 10,000-file scan, incremental rescan, first page,
      search, database size and main-process memory, with a non-zero exit and the missed metric named on a regression
- [x] The same budgets on a CI runner: `npm run perf` runs in its own job and passed there, so the scan, rescan, paging,
      search, database size and main-process memory gates now guard every push. Cold start, first audio and memory under
      playback stay manual.
- [x] Accessibility and keyboard pass: one `<main>` landmark per active view, `aria-current` on the sidebar, YouTube
      tabs on arrow/Home/End keys with a roving tab index, labels for the unlabelled fields, meaningful slider value
      text, a modal Tab trap that restores focus to its opener, faint text measured above 4.5:1 on every surface it
      uses, and `forced-colors` fallbacks for current and selected states. The self-test checks the landmarks, tab
      keys, slider text and dialog focus.

**Exit:** a stranger can install, use and uninstall it without instructions.
**Status:** the installer, manual diagnostics export, opt-in local crash reports, renderer sandboxing, headless perf
budgets, daily yt-dlp update, the fetch-on-first-use sidecar installer, the CI workflow, the app update channel,
yt-dlp rollback, the R2 feed and the accessibility pass are complete. The published feed
(`https://pub-f78cb36c07324422ba352033e3d71909.r2.dev`) is now the default, so a fresh install checks without setup;
clearing it in Settings → About still disables every request. What is left is the finish line in §14 — the real
Windows 10/11 hardware pass, signing, and one proven update cycle on an installed copy.

### M9 — Android Port  *(deferred; demand-only, not scheduled)*

**Decision.** Android is not planned work. It starts only if **all** of these are true:

1. Windows is finished (§14) and has real users who keep asking for a phone app — not the maintainer wanting one.
2. Distribution is accepted as **APK sideload / F-Droid only**. Google Play prohibits apps that facilitate downloading
   from YouTube, so the core feature cannot ship there. Android 14+ also makes sideloading more friction than it was.
3. A two-week spike passes: MediaStore index → Media3 playback → foreground service → notification controls → survives a
   phone call. No milestone, no dates before that.
4. The maintenance cost is accepted: two release pipelines, a second signing key (lose it and the app can never update),
   and YouTube changes chased twice.

**Why not now.** The engine layer is the blocker, not the UI. Streaming already needs `yt-dlp` (Python), `ffmpeg` (native
build) and a Node-based PO-token provider (`src/engine/sidecar/po-token.ts`); an APK either bundles three runtimes or
reimplements the most volatile part of the stack. Meanwhile the niche is served on Android by NewPipe, Tubular, Seal,
InnerTune, Metrolist and PowerAmp, and Suura's differentiator — one curated library with tags, duplicates, ReplayGain,
lyrics *and* YouTube — is desk work.

If it is ever built, it should be a **separate Android app** sharing the `player-backup` format and the design language,
not a port with platform branches inside this tree. A phone-sync feature (export a playlist as M3U plus files for
PowerAmp) is the cheap answer to the actual need and is tracked in §14.

**If it is picked up:**
- [ ] Confirm the shared surface (backup format, playlist semantics, settings vocabulary) vs. the rewrite (engine, player,
      storage, UI)
- [ ] Resolver behind the existing `IMediaResolver`: NewPipeExtractor, or embedded Python — decided by a spike
- [ ] Media3/ExoPlayer + foreground service + MediaSession + audio focus; the Web Audio EQ is replaced, not ported
- [ ] MediaStore + SAF for storage; no `fs.watch`
- [ ] Mobile UX: bottom nav, mini-player, touch targets, no hover
- [ ] Data saver: stream-only on mobile data, Wi-Fi-only downloads
- [ ] Update path: signed APK, in-app installer or F-Droid metadata
**Exit (if ever):** library + search + stream + keep on a signed APK, installed and updated by a stranger.

### M10 — Two-Device Continuity *(deferred with M9)*
The phone half of this only exists if M9 does. Until then the portable bridge is the backup format and M3U export (§14).

- [ ] Optional **companion server mode**: one device (usually the PC) exposes its resolved stream + library over LAN so the other device can play/download from it
- [ ] Playlist/play-state sync between devices (local network, no cloud account)
- [ ] "Send to device" (Cast-like) for the same-network case
**Exit:** start a song on the PC, continue on the phone.

### M11 — Long-Term / Nice-to-Have  *(continuous)*
- [ ] Last.fm scrobbling · Discord Rich Presence
- [ ] Audio visualiser, spectrum analyser
- [ ] Podcast/soundtrack mode, chapters, playback speed & pitch
- [ ] Advanced: WASAPI exclusive output, ASIO, bit-perfect/hi-res path, device selection
- [ ] Plugin/extension API for community resolvers
- [ ] Optional CLI companion for scripting

Tag writing, auto-tagging, artwork replacement and lyrics are no longer here: they became **M13**, because they are
planned desktop work with a schema change, not continuous extras.

### M12 — Offline Cache & Downloads *(complete)*
**Goal:** the other half of the original M4: a bounded cache that writes while a stream plays, an honest retention
setting, and one place for saved files and cached streams. M12a landed the data layer and offline playback; M12b
landed the manager, which now lives as YouTube's **Saved** and **Cache** tabs.

**M12a — data layer and offline playback (done)**
- [x] Cache engine: background full fetch of the resolved URL into `cache/stream/<videoId>.<ext>.part`, rename on
      completion, one shared download per video, janitor, LRU eviction and size/age budgets. Manual `clear()` and
      per-entry reveal/removal are exposed through IPC and used by YouTube's Cache tab.
- [x] Pinning: `pinned` entries count toward the budget but are never evicted automatically; the IPC can pin/unpin, and
      the Cache tab exposes the per-entry control.
- [x] Offline detection: a cached track resolves to `player-media://` and plays with no network; an uncached YouTube
      track fails up front with "not available offline" instead of a spinner. Local files and saved library tracks are
      never blocked.
- [x] Retention modes re-enabled in Settings: **Stream only** (default), **Save played tracks** (cache) and **Keep
      after play** (auto-save through the existing download path). Budget and age are editable and validated.
- [x] Disk pre-flight: a cache copy is skipped when free space is below its size hint plus the cache reserve; a save
      checks both the temp and target volumes against the resolver's size hint (or a conservative fallback) plus the
      save reserve.
- [x] Download history: `download_history` persists status, progress, error and request metadata; startup marks
      interrupted rows failed; YouTube's Saved tab and the Saves dock read it, and either can dismiss one.
- [x] Startup integrity: `reconcile()` deletes orphan files and `.part` leftovers, and a stale row is never offered as
      a cached source. File deletion is restricted to the cache root.

**M12b — manager and merged YouTube tabs (done)**
- [x] Cache manager tab: real usage against the budget, entries with size and last use, pin/unpin, reveal, single
      removal, multi-select removal and Clear cache
- [x] Saved tab over `download_history`: active/completed/failed/paused/removed rows, live speed + ETA, pause/resume,
      cancel, retry, reveal and dismiss. It shares the YouTube header with Links and Cache instead of owning a sidebar
      entry.
- [x] Remove download: delete only a file inside a configured library folder, mark the track missing without deleting
      its row, record history as `removed`, keep playlist/queue identity, and fall back to the YouTube stream
- [x] Per-item retention and bulk actions: pinned cache entries count toward the budget and are never auto-evicted;
      bulk keep/remove and whole-cache clear are available
- [x] Pause/resume: abort yt-dlp but preserve the UUID temp folder, resume with `--continue`, defer a Resume pressed
      before the abort unwinds, cancel queued jobs on pause, and convert a paused row to failed at startup

**Exit:** disk usage never exceeds a budget; killing the app mid-cache leaves no corruption; offline replay works for
cached tracks; "keep" ↔ "remove" round-trips cleanly. **Met:** M12a's smoke checks cover the cache budget, eviction,
offline resolution and startup cleanup; M12b adds pause/resume temp reuse, remove-download with playlist fallback,
history status, single-entry cache reveal/removal, and live progress parsing. The selftest drives YouTube's Saved and
Cache tabs through the header toggles.

---

### M13 — Library Metadata & Lyrics  *(~6 weeks; Phases 1–6 complete, Phase 7 deferred)*
**Goal:** fix the tags YouTube got wrong, and show the lyrics a file already has, without leaving the player.

The number is next because the milestone was added last; Phases 1–6 are complete. Phase 7 is separate, additive work and
is not scheduled. M13 is no longer a prerequisite for anything: Android (M9) is deferred, so nothing "inherits" it.

**Phase 1 - write path (the foundation)**
- [x] One `TagWriter` with a per-format strategy: `node-id3` for MP3 `USLT`/`SYLT`, ffmpeg `-c copy` for FLAC/Ogg/Opus
      and M4A (verified: ffmpeg writes `TXXX:USLT` on MP3, not a real `USLT` frame)
- [x] Atomic write: temp file in the same folder → verify by parsing → replace; the original survives any failure
- [x] Refuse while the track is playing, handle read-only and locked files, update the row afterwards
- [x] Manual tag editor: title, artist, album artist, album, year, genre, track/disc, lyrics
- [x] Cover in the manual editor: the picker and its preview live inside the editor (the artwork work landed in
      Phase 3, not as a separate pass)

**Phase 2 — lyrics, read-only**
- [x] `track_lyrics` table (track, source, language, synced, LRC, offset, fetched at)
- [x] Embedded lyrics: `USLT`/`SYLT`, Vorbis `LYRICS`, `©lyr`, plus a `TXXX` fallback for files ffmpeg wrote
- [x] `.lrc` sidecar, synced scroll and an offset control; no network
- [x] Reading view: line-by-line fill as the line is sung, manual scroll pauses the follow, and the panel expands into a
      full-window stage (blurred cover behind, same fetch, same offset)

**Phase 3 — single-track auto-tag and artwork**
- [x] iTunes + MusicBrainz lookup, duration-aware scoring, review dialog, apply through the writer
- [x] Artwork picker: embedded / `cover.jpg` / video still / provider cover, with a square-crop preview

**Phase 4 — lyrics finder**
- [x] LRCLIB fetch, match, cache, source label, offset; optional "write into the file"

**Phase 5 — batch**
- [x] Selection queue, review, undo and "fetch missing lyrics": the scan keeps the candidates in the main process, the
      dialog returns the accepted items, and undo is one-shot (a file edited since is left alone)
- [x] Per-provider rate limits: each service gets its own scheduler (iTunes and LRCLIB two at a time, Genius one lookup
      a second, MusicBrainz 1.1 s apart), and a 429/502/503 is obeyed once — `Retry-After` when sent, a doubling
      backoff otherwise, capped so the batch stays cancellable — before the answer becomes the dialog's sentence

**Phase 6 — fingerprint fallback**
- [x] `fpcalc` sidecar: located like the other engine binaries, spawned with a timeout and killed as a tree, `-json` output
      parsed into a whole-file duration and a Chromaprint fingerprint; optional in the engine manifest, so streaming still
      works without it
- [x] AcoustID key in Settings → Misc: 8–64 letters and digits, normalised on write and on read, blank or invalid stored
      as "not configured" so nothing unconfigured reaches the service
- [x] MusicBrainz lookup: the AcoustID recording id is re-fetched with its releases, release groups, genres and media, and
      the release whose medium actually lists the recording supplies album, track/disc numbers and the release year
- [x] Cover Art Archive: a fingerprint candidate's release front image is offered through the existing artwork picker when
      the text lookup found no cover
- [x] **Match by fingerprint** is its own button in the tag finder, never part of a lookup, a batch or a scan: it reads up to
      two minutes of audio and spends the user's key. The AcoustID score is preserved rather than re-scored against the wrong text
      tags, so a `track01` / `Unknown` row can still be named.

**Phase 7 — deferred**
- [ ] AI transcription: local, opt-in, labelled "generated"; only if the rest is done and asked for

**Status:** Phases 1–6 are complete as written: a wrong tag can be fixed by hand or in a batch, a cover can be replaced,
lyrics can be read, found and written, and a file whose tags are unusable can be named from its audio fingerprint. Every
write is reversible. Phase 6 is dormant until the user supplies their own AcoustID key in Settings → Misc; it needs
`fpcalc`, which M8's engine download installs separately from the rest. Phase 7 stays deferred.

**Exit:** a wrong tag can be fixed and a lyric found from inside the app on MP3/FLAC/M4A/Ogg; every write is reversible
and survives a kill between the temp write and the replace.

---

## 8. Milestone Summary

| # | Milestone | Focus | Est. | Dependency |
|---|---|---|---|---|
| M0 | Foundations & Decisions | Stack, architecture, sidecar spike | 1 w | — |
| M1 | Local Library MVP | Scan, index, play, queue | 2–3 w | M0 |
| M2 | Player Quality & System Integration | Gapless, EQ, SMTC, tray | 2 w | M1 |
| M3 | Engine Skeleton | Resolve + **stream** | 2–3 w | M0, M1 |
| M4 | Save to Library (lite) | Explicit save / saves dock / retention modes | 1–2 w | M3 |
| M5 | Discovery & YouTube Surface | Unified search, channels, smart Library views | 2–3 w | M4 |
| M6 | Settings Revamp | Hierarchy, grouping, honest controls | 1–2 w | M5 |
| M7 | Playlists, Sync & Data Care | Import/export, migrations, dedupe | 2 w | M6 |
| M8 | Windows Release Engineering *(in progress)* | Installer, update, telemetry, a11y | 2 w | M7 |
| M9 | Android Port *(deferred, demand-only)* | Only if Windows is finished and users ask | — | M8 |
| M10 | Two-Device Continuity *(deferred with M9)* | LAN companion server | — | M9 |
| M11 | Long-term extras | Scrobbling, hi-res, plugins, visualiser | continuous | — |
| M12 | Offline Cache & Downloads *(complete)* | Cache engine, offline replay, history; manager surface inside YouTube's Saved/Cache tabs | 2–3 w | M4, M6 |
| M13 | Library Metadata & Lyrics *(Phases 1–6 complete; Phase 7 deferred)* | Tag writing, auto-tag, artwork, lyrics, fingerprint | 6 w | M1, M7 |

**Critical path:** M0 → M1 → M3 → M4 → M5 → M6 → M8 → §14 finish line → M13 Phase 7 (only if asked). M2 can be interleaved,
M7 is data-care hygiene, and M12 is complete (data layer plus the manager inside YouTube's Saved/Cache tabs). M13 is
numbered next because it was added last; Phases 1–6 are complete and Phase 7 stays deferred. **Android (M9) is not on the
critical path and is not scheduled**: it is demand-only, with the entry conditions written into its section. The visual
revamp landed as Home plus the album grid, and **Windows release engineering (M8) is nearly done**: the per-user NSIS
installer, diagnostics export, opt-in local crash reports, renderer sandbox, fetch-on-first-use sidecar installer, CI
workflow, a live update feed, yt-dlp rollback and the accessibility pass are built and verified. §14 is what remains.

---

## 9. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| yt-dlp extractor breaks after a YouTube change | Streaming stops working | **High** — recur periodically | Auto-update + last-known-good rollback; abstraction layer so a broken resolver degrades to "local library still works" |
| YouTube bot checks / `403`s | Feature unreliable for some users | High | Optional external PO Token provider, an off-by-default three-mode cookie fallback, a circuit breaker, re-resolve and clear messaging; discovery uses InnerTube separately, so search/channel stay usable during a playback cooldown |
| Signed-URL expiry mid-listening | Playback stalls | Medium | Re-resolve on 403, buffer-ahead, local proxy that hides expiry |
| Legal / ToS exposure | Distribution blocked, takedown | Medium | Personal-use framing, no bundled catalogue, no redistribution features, documented disclaimer; keep Android distribution decision (Play Store vs APK) explicit |
| Disk bloat from cache/downloads | User frustration, data loss trust | Medium | Hard budgets, visible manager, sane defaults (stream-only), pin/evict rules |
| Player engine limitations (seeking, gapless, formats) | Core UX feels amateur | Medium | Pick the engine with a known escape hatch to a native path; validate gapless in M2 |
| Sidecar packaging/licensing (ffmpeg) | Ship blocker | Low–Medium | LGPL build or fetch-on-first-use with checksum verification |
| Scope creep in the UI | Delayed delivery | High | Freeze the 6 core screens in M0; everything else goes to M11 |
| Android engine gap (no yt-dlp) | Rewrite instead of port | Not applicable while M9 is deferred | `IMediaResolver` is in place; the decision is recorded, not scheduled |

---

## 10. Legal & Ethical Note (must be handled, not ignored)

- Downloading audio from YouTube generally **violates YouTube's Terms of Service** and may infringe copyright depending on your jurisdiction and use.
- Design consequences to accept deliberately:
  - No built-in catalogue browsing that encourages redistribution (no "download all of channel X" as a headline feature — playlist import is user-initiated and rate-limited).
  - The user, not the app, chooses to keep files; ship with **stream-only as the default retention mode**.
  - Ship a plain-language disclaimer; do not brand the app as a "YouTube downloader".
- yt-dlp is public domain (Unlicense); **ffmpeg licensing depends on the build** — use an LGPL configuration if you bundle it.
- Before publishing on Google Play, assume a review risk for a downloader app; evaluate direct APK / F-Droid distribution as the primary Android channel.

---

## 11. Proposed Repository Layout (for when coding starts)

```
player/
├─ docs/                     # ADRs, this roadmap, schemas
│   ├─ adr/
│   └─ specs/                # IPC schema, IMediaResolver, DB schema
├─ core/                     # library, playlists, retention policy, DB, settings
├─ engine/                   # sidecar manager, resolvers, job queue, stream proxy
├─ player/                   # playback engine bindings, EQ, output devices
├─ ui/                       # screens, components, design tokens
├─ platform/
│   ├─ windows/              # SMTC, tray, installer, autostart
│   └─ android/              # (M9) MediaSession, SAF, foreground service
├─ engine-bin/               # yt-dlp/ffmpeg acquisition & verification scripts
├─ tests/                    # unit, integration, engine-contract tests
└─ tools/                    # dev scripts, fixtures, benchmark harness
```

---

## 12. Testing & Quality Strategy

| Layer | What to test | Approach |
|---|---|---|
| Library/DB | scan, dedupe, migrations, search | Unit tests + a fixture folder of odd tags/filenames |
| Retention policy | eviction, budgets, pin, remove-download | Unit tests with a fake clock + fake filesystem |
| Engine | resolve, download, cancel, retry | **Contract tests with recorded yt-dlp JSON fixtures** (so tests don't depend on YouTube), plus an opt-in weekly live smoke test |
| Player | seek, gapless, format matrix | Automated playback harness (opus/mp3/flac/m4a/wav, odd sample rates) |
| UI | core flows | End-to-end: scan → search → play → keep → remove |
| Performance | cold start, 10k scan, memory | CI benchmarks with thresholds that fail the build |
| Resilience | kill mid-download, kill sidecar, offline, disk full | Chaos-style manual checklist run each milestone |

---

## 13. Immediate Next Steps (do these first)

1. ~~**Run the sidecar spike**~~ Done: `docs/internal/notes/yt-dlp-spike.md`, followed by the 20-link sample and the 50-link M3
   measurement in `docs/internal/notes/yt-dlp-50.md`. yt-dlp + ffmpeg resolve, seek, download and tag on this machine.
2. ~~**Decide the stack** (§3) once the spike has told you what the engine actually needs. Write it down as an ADR.~~ Done: `docs/adr/0001-stack-and-storage.md` (Electron + TypeScript + React, `node:sqlite`, no native build tools).
3. ~~**Wireframe the 6 core screens**~~ Done, and built: Library, YouTube, Search, Playlists, Queue, Settings, Now
   Playing and the Saved/Cache manager inside YouTube all exist.
4. ~~**Write the two specs**~~ Done: `IMediaResolver` is `src/engine/resolver.ts`; the IPC event schema is `src/shared/ipc.ts`.
5. ~~**Pick the retention defaults**~~ Done: stream-only is the default; all three modes are now accepted, the cache
   defaults to 5 GB / 30 days, and saving remains explicit unless *Keep after play* is chosen.

Where things stand: the stack and storage decisions are recorded (ADR 0001). YouTube playback has a real surface — the
**YouTube** view with a persistent link history and a separate **Imported** box, one card per list — and playlist,
album and mix import stores a snapshot that the Playlists view can play, queue, re-import, rename and trim, with a
per-import track count for mixes and radios. **Saving to the library works**: a history row, a search result or an
imported entry downloads once, is tagged with embedded artwork, moves into the music folder and is indexed as an
ordinary local track that remembers its video id. A compact **Saves** dock shows running, failed and finished saves
from every view, with pause/resume, live speed/ETA, cancel, retry and reveal; YouTube's **Saved** tab adds the durable
saved-files ledger and its **Cache** tab the offline copies, both with per-entry keep/reveal/remove and bulk actions. **M3 is measured** at 50/50 links, a 8.3 s median cold resolve and a
0.46 s median to the CDN's first bytes, so `< 3 s` is adopted for warm/prefetched playback and cold paste has a 10 s
display target. **M5's core is in**: a unified **Search** view over the local library and YouTube, channel pages, and
title/artist cleanup. Every track list shares the same **#, Title, …metadata, Duration, Action** priorities, with
Format in a row's **Details** sheet, and the Queue has a header aligned with its rows. The current consistency pass
keeps Title as the only flexible track, gives Artist/Album equal bounded widths, removes Album from YouTube Links in
favour of Channel plus an optional Artist, and keeps Duration/Actions fixed when a column is hidden. **M12 is done**:
the bounded stream cache, offline replay, retention modes, download history, disk pre-flight, the cache manager and the
saved-files ledger are in place inside YouTube's Saved/Cache tabs, including pause/resume, remove-download with stream
fallback, and per-entry keep.
**The visual revamp is done**: Home opens on a cover-led dashboard with the library totals under its heading, recently
played/added shelves, artist and playlist cards, and one merged **All tracks** list below them. That list spans local
files, counted stream listens, imported playlist entries and remembered links, deduped by video id and newest activity
first; its fourth column is **Source** rather than Album, the filter chip and search sit in a toolbar under the heading,
and a YouTube row saves through the same download queue as YouTube Links. A shelf's **More** filters the same list in
place with a removable chip. The hero art is at full strength in both themes, and its crossfade pace is a Settings
slider (3–60 s) instead of a constant.
**Windows release engineering (M8) is nearly done**: the per-user NSIS installer, icon, uninstall data prompt, renderer
sandbox, headless perf budgets, fetch-on-first-use sidecar installer, CI workflow, the published update feed, yt-dlp
rollback and opt-in local crash reports are in place, and the packaged app passes its self-test. Updates read
`latest.yml`/`beta.yml` from the R2 folder that now ships as the default and never install without a press; the previous
yt-dlp is kept and restored when a new one breaks. The accessibility and keyboard pass is done. §14 is the remaining
list: the real Windows 10/11 hardware run, signing, one proven update cycle, and the packaging, licensing, hardening and
release-process items that only matter at 1.0.

**Next:** the §14 finish line — the real Windows 10/11 hardware pass, signing, and one proven update cycle on an installed
copy. Android (M9) is deferred and demand-only. M13 is complete through Phase 6, and its Phase 7 (local AI transcription)
stays deferred until asked for. M13's fingerprint fallback needs nothing more than the user's own AcoustID key: `fpcalc`
arrives with the M8 engine download, and the text search keeps working without either.

---

## 14. Windows 1.0 Finish Line

What stands between 0.1.0 and a release a stranger can trust. Ordered by what blocks the version, not by effort. *(code)*
marks work in this repository; the rest is hardware, accounts and process.

### 14.1 Release blockers

- [ ] **Real hardware pass** — install, run and uninstall on Windows 10 and Windows 11: 100/125/150/200% scaling, 4K,
      two monitors with the window dragged between them, a monitor unplugged while the mini player is open,
      sleep/resume, audio device switch (headphones → speakers → Bluetooth), a long queue, a 10k-track library.
      Checklist in `docs/release/windows.md`.
- [ ] **Signing** — SignPath approval or a certificate, `CSC_LINK`/`CSC_KEY_PASSWORD` in the release environment, and the
      signature verified on the installer and the installed exe. Unsigned stays shippable; signed is finished.
      `CODE_SIGNING.md`.
- [ ] **One complete update cycle on an installed copy** — publish 0.1.1, let 0.1.0 see it, Check now → Download update →
      Restart and install; confirm the version changes, the library and playlists survive, the old exe is replaced and no
      second copy is left behind. The parts are verified; the whole loop has never run.

### 14.2 Packaging and metadata *(code)*

- [x] `electron-builder.yml` placeholders removed: the copyright is `Copyright © 2026 alphaq0099` and the publish block
      points at the real R2 folder, so generated metadata matches where the files live.
- [ ] Confirm the exe's file properties (product, version, description, publisher, icon) and the Apps & Features entry
      after install.
- [ ] Upgrade in place 0.1.0 → next: settings, engine folder and library untouched, no duplicate Start-menu entry.
- [ ] Uninstall: app data kept by default, the opt-in prompt deletes it, no stale shortcuts or registry keys.
- [ ] Decide file associations for `.m3u`/`.m3u8`. Today double-clicking a playlist does nothing.

### 14.3 Trust, licences and legal *(code + docs)*

- [x] **Third-party notices** — `THIRD-PARTY.md` lists the bundled and downloaded components with their licences, and
      Settings → About carries a collapsed credits block that summarises it.
- [x] **ffmpeg licence mismatch resolved by disclosure** — the pinned `eugeneware/ffmpeg-static` b6.1.1 build is
      GPL-3.0-or-later. It is fetched at runtime, not bundled, and runs as a separate program, so the pin stays and the
      provenance is stated plainly in `THIRD-PARTY.md` and About instead of being described as LGPL.
- [x] First-run and About: the YouTube/ToS disclaimer and the "no telemetry" statement, in plain language. Home's welcome
      hero and Settings → About both carry it, both link the privacy statement, and neither adds a second explanation to a
      card that already has one.
- [x] Privacy statement that matches behaviour: the daily update check contacts R2/Cloudflare, crash reports never leave
      the machine, no analytics. The statement at <https://suura-player.pages.dev/privacy> lists every host and every
      request, including the ones a button starts.
- [x] Site: a known-issues page and an FAQ. The FAQ at <https://suura-player.pages.dev/faq> answers the installer
      warning, offline use, YouTube limits, saving tracks, updates, data and Android, then lists the known issues.

### 14.4 Security hardening *(code)*

- [x] `session.setPermissionRequestHandler` and `setPermissionCheckHandler` deny every device permission; clipboard
      access already goes through IPC, so nothing the app uses is lost.
- [x] `will-navigate` guard, and `setWindowOpenHandler` now passes only `http:`/`https:` to `shell.openExternal`.
- [x] CSP for the renderer — already present for production builds in `electron.vite.config.ts` (dev omits it because
      Vite injects an inline refresh preamble); no change needed, only verification.
- [x] Re-audit the custom protocols (`player-media://`, `player-art://`, `player-stream://`) for traversal and arbitrary
      path disclosure. Media is gated by the library-folder allowlist (resolved, so `..` collapses, and separator-aware,
      so a sibling with a shared name prefix is outside); artwork accepts only a 40-hex cache key; streams accept only a
      UUID that indexes the proxy's in-memory map. Self-test and smoke cover all three refusals.
- [x] **Corrupt database recovery** - a library that will not open now offers "restore the newest usable automatic
      backup", "start a new library" or "quit", keeps the damaged file beside the database, and never prompts during the
      headless runs.
- [x] Confirm the local PO-token provider binds loopback only and never triggers a Windows Firewall prompt. Suura opens
      no listening socket; the default provider URL is `http://127.0.0.1:4416`, and the provider is a separate, opt-in
      program the user runs.

### 14.5 Product finish

- [x] **Crossfade** — settled as **no**. The last open M2 checkbox is closed rather than left as a promise: gapless
      playback covers the transition, and a real crossfade would mean the transport naming the next track while the
      current one is still audible, plus a fade that has to coexist with the volume control and ReplayGain. Nothing
      ships in 1.0; the FAQ says so plainly.
- [x] **Send to phone** - **To phone** in a playlist copies its local files into a folder of the user's choosing and
      writes an `.m3u8` beside them with names relative to that folder, ready for PowerAmp or any phone player. This is
      the answer to "I want it on my phone" without M9.
- [x] **Start with Windows** - an opt-in switch in Settings → General. Off by default, because a program that starts
      itself is the user's choice to make. The config file is the source of truth: the entry is rebuilt at launch after
      a reinstall, removed when the switch is turned off, and the uninstaller deletes it even when the app data is
      kept. A packaged build only — an unpackaged entry would point at `electron.exe`.
- [x] Empty and error state sweep: no folders (Home's welcome hero, Library's "No music folders yet"), no engine (the
      YouTube engine callout with size, progress and error), offline (the media element's own network error), YouTube
      blocked (the cooldown message with the remaining minutes), download failed (the row's own reason), disk full (the
      pre-flight free-space check before a save). Each state names what happened and what to do next; the visual pass on
      real hardware is part of 14.1.
- [ ] Narrator pass on the real app. The automated accessibility pass proves landmarks, focus and contrast, not spoken
      labels.

### 14.6 Quality bars

- [ ] Soak test: a day of use with sleep/resume, a long queue, repeated downloads and cache churn — no memory growth, no
      orphaned `yt-dlp`/`ffmpeg` processes, no stuck `.part` files.
- [ ] Format matrix on hardware: MP3, FLAC, Opus, M4A/AAC, WAV; 44.1/48/96 kHz; mono and stereo; VBR and CBR.
- [ ] Failure matrix: offline, DNS failure, 403 mid-stream, bot check, expired CDN URL, cancelled download, read-only
      library folder, locked file, disk full, a path over 260 characters, non-ASCII paths, a OneDrive-synced folder.
- [ ] Defender and one third-party antivirus on both the unsigned and the signed installer: no false positive.
- [ ] 10,000-track repeat on the release build, plus a 50,000-track sanity check.

### 14.7 Release process

- [ ] `CHANGELOG.md`: replace `[Unreleased]` with the released version and date; every release gets a section.
- [ ] One documented sequence, run in order: version bump → `npm run typecheck` → `npm run smoke` → `npm run build` →
      `npm run package:win` → `SHA256SUMS.txt` → `npm run publish:r2` → GitHub release with the `Suura-Setup.exe` alias.
      It is written in `docs/release/windows.md` and has been run once, by hand.
- [ ] Decide whether releases stay manual or become a tag-triggered workflow. Either is fine; leaving it unstated is not.
- [ ] Beta-channel rehearsal: bump to `0.2.0-beta.1`, confirm electron-builder writes `beta.yml`, publish it and install it
      through the Beta setting. The beta path has never been exercised.
- [ ] Bad-release drill: document how to yank a version (electron-updater never downgrades, so recovery is a new patch
      release) and how to pull the R2 alias.
- [ ] Tag `v1.0.0` only when 14.1–14.3 are done. 1.0 is a promise that "install, use, uninstall" is proven.

### 14.8 Deliberately not in 1.0

Last.fm scrobbling, Discord presence, a visualiser, plugins, hi-res/WASAPI exclusive output, local AI transcription
(M13 Phase 7), two-device continuity (M10) and Android (M9). Each is additive; none is needed for a finished Windows
release.
