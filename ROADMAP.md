# Roadmap — Music Player (working name: **Player**)

A music player that manages a **local music library** and can also **search, stream and download songs from YouTube** through a backend engine built on **yt-dlp**.

- **Platform order:** Windows desktop first → Android later
- **Streaming first:** play immediately, no waiting for a full download
- **User's choice:** decide per-track / per-playlist whether downloaded audio is kept on disk, cached temporarily, or never written to disk at all
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
- No iOS (revisit only after Android ships)

### 1.4 Success criteria for v1 (Windows)
- Library of 10,000 tracks scans, indexes and is searchable; cold start < 2 s
- Playing a local file: < 300 ms to first audio
- Playing a YouTube track: < 3 s to first audio on a normal connection
- Cache/download manager never exceeds the configured disk budget
- Crash-free sessions > 99%; no orphaned yt-dlp processes after exit

---

## 2. Architecture (target end-state)

```
┌──────────────────────────────────────────────────────────────┐
│  UI LAYER                                                    │
│  Library · Search · Now Playing · Queue · Playlists ·        │
│  Downloads · Cache Manager · Settings                        │
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
%APPDATA%/Player/
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
- **Job queue with concurrency limits** (e.g. max 2 concurrent downloads, max 4 concurrent resolves) to avoid triggering YouTube throttling.
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
| Bot checks / "Sign in to confirm you're not a bot" | Cookie jar import from the user's browser (opt-in), `--cookies`, and PO-token/JS-runtime support; surface a clear in-app message |
| Rate limiting (`429`) | Global concurrency cap, staggered requests, backoff, and a UI-visible cooldown |
| Extractor breakage | yt-dlp ships frequent fixes → **auto-update the sidecar**, keep the last-known-good binary, roll back on failure |
| Bundling ffmpeg | Ship an LGPL build to keep licensing simpler, or fetch on first use; verify checksums |
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
- [ ] Wireframe the 6 core screens: Library, Now Playing, Queue, Search, Downloads, Settings — five are built; Downloads
      arrives with M4
- [x] Write the `IMediaResolver` interface and the IPC event schema (as a spec, not code) — built, not just specified:
      `src/engine/resolver.ts` and `src/shared/ipc.ts`
- [ ] Verify yt-dlp + ffmpeg work as sidecars on a clean Windows machine; measure resolve latency and success rate on 20
      representative videos — presence is checked by `npm run smoke`, and the first timings are in
      [`docs/notes/yt-dlp-spike.md`](./docs/notes/yt-dlp-spike.md); the 20-video sample is still open
- [x] Legal/ToS note drafted (§10) — in the README under **Scope and legal**
**Exit:** a one-page architecture doc + stack ADR + working sidecar smoke test.

### M1 — Local Library MVP  *(~2–3 weeks)*
**Goal:** it is a genuinely usable local music player.
- [x] Folder scanning (recursive, incremental index into SQLite)
- [x] Tag reading → Artist/Album/Track ingestion; compilation & multi-artist handling
- [x] Library UI: virtualized list, sort by title/artist/album/duration/year/added/played, search via FTS5
- [x] Artwork: embedded covers extracted lazily, resized, cached content-addressed, served over `player-art://`
- [x] Now Playing: full-window player with a blurred art backdrop, transport, volume, queue and a scrubber; the queue
      as a panel inside the window, slid in by the button that opened it and dismissed by a press anywhere outside it
- [x] Visuals settings: artwork square or circular, cropped to a square or given the cover's own shape, and sized from
      small to extra large; ambient player-bar background masked to no hard edge; volume as mute-on-click with the
      slider revealed on hover, and a wheel over the control nudging it by five percent
- [x] Click behaviour setting: single click and double click each choose select / play / select-and-play / nothing
- [x] Playback: play/pause/next/prev/seek, volume, shuffle, repeat (off/all/one)
- [x] Queue management (add to queue, jump, remove, clear)
- [x] File watching for changes: an OS watcher per folder, debounced, turning any change into an incremental scan that
      prunes what disappeared; a setting to turn it off for slow or network drives
- [x] Basic playlists: create, rename, delete; add from the library selection bar, a row's context menu or the queue in
      the player window; remove entries; reorder by drag or Alt+↑/↓ with a gap-based position that keeps the order exact
- [x] Persist play state; resume last session on start
- [x] 10,000-track check (`npm run scale`): cold start 0.5 s, first audio 46 ms (median), first page 12 ms, search 2 ms
**Exit:** 10,000-track library is fast, searchable and pleasant; audio starts in < 300 ms.

### M2 — Player Quality & System Integration  *(~2 weeks)*
- [ ] Gapless playback between consecutive tracks (album continuity)
- [x] Media keys (global shortcuts for play/pause, next, previous, stop)
- [ ] Windows SMTC (now-playing overlay), taskbar thumbnail controls
- [ ] Mini player, tray icon, close-to-tray behaviour
- [ ] 10-band EQ + presets, preamp, optional crossfade
- [ ] Volume normalization for local files (ReplayGain scan)
- [x] Keyboard shortcuts (space, arrows, N/P, M, Ctrl+F, Escape)
- [ ] Drag & drop of files/folders
**Exit:** feels like a real desktop music app, not a tech demo.

### M3 — Engine Skeleton (resolve + stream, no downloads)  *(~2–3 weeks)*
**Goal:** **the core differentiator.** Paste a YouTube link, hear audio in seconds, nothing kept.
- [ ] Sidecar manager: locate/verify/launch/kill yt-dlp & ffmpeg, capture stderr into logs
- [ ] Resolver: URL → metadata + playable source; search-by-text if the backend allows
- [ ] Local HTTP stream proxy with range-request support and a stable per-track URL
- [ ] Player integration: **Stream only** mode works end-to-end
- [ ] Playback state machine for stream sources (loading → buffering → playing → failed)
- [ ] Error taxonomy & user-facing messages (expired URL, bot check, geo-block, unavailable, network)
- [ ] Re-resolve on failure/expiry, transparent to the player
- [ ] Resolve-result metadata cache (avoid re-resolving the same video within a session)
**Exit:** 50 hand-picked YouTube links play directly, ≥ 90% on first attempt, < 3 s to first audio, and seeking works.

### M4 — Retention: Cache & Download  *(~3 weeks)*
**Goal:** the "keep it or not" requirement, fully realised.
- [ ] Cache manager: write-while-playing, LRU eviction, size/age budgets, janitor task, manual "empty cache"
- [ ] Download manager: queue, concurrency cap, pause/resume/cancel, progress + speed + ETA, retries, `.part` handling, disk-space pre-flight check
- [ ] **Keep** action: download → transcode per quality policy → tag → artwork → atomic move into the library → library row appears instantly
- [ ] **Remove download**: delete file, keep the track in playlists/queue, fall back to streaming (availability model from §4)
- [ ] **Pin in cache** (never evict) and "keep after this play" quick action
- [ ] Downloads screen: active/completed/failed tabs, retry, reveal in Explorer, per-item retention toggle
- [ ] Settings: default retention mode, cache budget, download folder, naming template, quality tier, concurrency
- [ ] Offline detection: when offline, stream-only tracks show as unavailable; cached/downloaded ones still play
**Exit:** disk usage never exceeds budget; killing the app mid-download leaves no corruption; "keep" → "remove" round-trips cleanly.

### M5 — Discovery & YouTube Library Surface  *(~2–3 weeks)*
- [ ] Unified search: local results **and** YouTube results in one list, clearly badged
- [ ] Playlist import from a YouTube playlist URL (resolve all → show which ones are already local)
- [ ] Channel/artist pages (basic), "more from this channel"
- [ ] Auto-attach YouTube metadata: upgrade titles from `Title (Official Video)` → canonical tags, and optionally match against MusicBrainz
- [ ] Smart playlists / filters (recently added, most played, never played, stream-only tracks)
- [ ] Fold "YouTube-only" tracks into the normal library views so it feels like one library
**Exit:** a user can go from "no music" to "a 40-track playlist playing" without touching a folder.

### M6 — Playlists, Sync & Data Care  *(~2 weeks)*
- [ ] M3U / M3U8 and JSON import-export of playlists; CSV export of the library
- [ ] Backup/restore of `library.db` + config; automatic rotating DB backups
- [ ] DB migrations framework (needed before any real users)
- [ ] Duplicate detection with safe merge (audio-hash based)
- [ ] Missing-file handling: detect moved/deleted files, offer relocate by hash
- [ ] Bulk operations: multi-select edit, tag editing, bulk keep/remove-download
**Exit:** data survives a crash, a reinstall and a folder move.

### M7 — Windows Release Engineering  *(~2 weeks)*
- [ ] Installer (per-user, no admin): MSIX or NSIS; clean uninstall; opt-in "also delete cache/library DB"
- [ ] Code signing (or at least a documented SmartScreen workaround plan)
- [ ] Auto-update channel (stable/beta) + engine auto-update with rollback
- [ ] Crash reporting (opt-in) and log export ("Send diagnostics" button)
- [ ] Windows 10/11 compatibility matrix, HiDPI, multi-monitor, 4K scaling
- [ ] Performance budget tests in CI: cold start, scan 10k files, memory under playback
- [ ] Accessibility pass: keyboard-only navigation, screen-reader labels, contrast
**Exit:** a stranger can install, use and uninstall it without instructions.

### M8 — Android Port  *(~4–6 weeks)*
**Goal:** reuse the core, replace the platform-specific layers.
- [ ] Confirm the shared/reused surface (data model, DB, settings, playlists, retention policy) vs. what must be rewritten (engine, player, UI, storage permissions)
- [ ] Embed the resolver: NewPipeExtractor-based engine (or an embedded-Python yt-dlp via Chaquopy — evaluate size and stability), behind the same `IMediaResolver`
- [ ] Android player: background playback, notification + lock-screen controls, audio focus, Bluetooth/metadata, MediaSession
- [ ] Scoped storage: app-private cache + user-chosen library folder (SAF), correct permission flows
- [ ] Mobile UX rework: bottom nav (Library / Search / Downloads / Playing), mini-player, gesture controls, Material 3
- [ ] Battery/data-saver awareness: "stream only on Wi-Fi", download only on Wi-Fi, cache budget in MB
- [ ] Play Store requirements: target API level, data-safety form, privacy policy, and a serious decision about whether an app whose purpose is downloading from YouTube can be distributed there at all (alternative: direct APK / F-Droid)
**Exit:** feature parity on the core loop (library + search + stream + keep), signed APK released.

### M9 — Two-Device Continuity *(optional, ~2–4 weeks)*
- [ ] Optional **companion server mode**: one device (usually the PC) exposes its resolved stream + library over LAN so the other device can play/download from it
- [ ] Playlist/play-state sync between devices (local network, no cloud account)
- [ ] "Send to device" (Cast-like) for the same-network case
**Exit:** start a song on the PC, continue on the phone.

### M10 — Long-Term / Nice-to-Have  *(continuous)*
- [ ] Last.fm scrobbling · Discord Rich Presence
- [ ] Lyrics: local `.lrc` + fetched with offset editor
- [ ] Audio visualiser, spectrum analyser
- [ ] Podcast/soundtrack mode, chapters, playback speed & pitch
- [ ] Advanced: WASAPI exclusive output, ASIO, bit-perfect/hi-res path, device selection
- [ ] Plugin/extension API for community resolvers
- [ ] Optional CLI companion for scripting

---

## 8. Milestone Summary

| # | Milestone | Focus | Est. | Dependency |
|---|---|---|---|---|
| M0 | Foundations & Decisions | Stack, architecture, sidecar spike | 1 w | — |
| M1 | Local Library MVP | Scan, index, play, queue | 2–3 w | M0 |
| M2 | Player Quality & System Integration | Gapless, EQ, SMTC, tray | 2 w | M1 |
| M3 | Engine Skeleton | Resolve + **stream** | 2–3 w | M0, M1 |
| M4 | Retention: Cache & Download | Stream-only / cache / keep | 3 w | M3 |
| M5 | Discovery & YouTube Surface | Unified search, playlist import | 2–3 w | M4 |
| M6 | Playlists, Sync & Data Care | Import/export, migrations, dedupe | 2 w | M5 |
| M7 | Windows Release Engineering | Installer, update, telemetry, a11y | 2 w | M6 |
| M8 | Android Port | New engine + player + UI | 4–6 w | M7 |
| M9 | Two-Device Continuity *(optional)* | LAN companion server | 2–4 w | M8 |
| M10 | Long-term extras | Scrobbling, lyrics, hi-res | continuous | — |

**Critical path:** M0 → M1 → M3 → M4 → M7 → M8. M2, M5 and M6 can be reordered or interleaved; M2 is the best "make it feel good" buffer if you need a morale win early.

---

## 9. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| yt-dlp extractor breaks after a YouTube change | Streaming stops working | **High** — recur periodically | Auto-update + last-known-good rollback; abstraction layer so a broken resolver degrades to "local library still works" |
| YouTube bot checks / `403`s | Feature unreliable for some users | High | Cookie import, PO-token/JS-runtime support, re-resolve, clear messaging |
| Signed-URL expiry mid-listening | Playback stalls | Medium | Re-resolve on 403, buffer-ahead, local proxy that hides expiry |
| Legal / ToS exposure | Distribution blocked, takedown | Medium | Personal-use framing, no bundled catalogue, no redistribution features, documented disclaimer; keep Android distribution decision (Play Store vs APK) explicit |
| Disk bloat from cache/downloads | User frustration, data loss trust | Medium | Hard budgets, visible manager, sane defaults (stream-only), pin/evict rules |
| Player engine limitations (seeking, gapless, formats) | Core UX feels amateur | Medium | Pick the engine with a known escape hatch to a native path; validate gapless in M2 |
| Sidecar packaging/licensing (ffmpeg) | Ship blocker | Low–Medium | LGPL build or fetch-on-first-use with checksum verification |
| Scope creep in the UI | Delayed delivery | High | Freeze the 6 core screens in M0; everything else goes to M10 |
| Android engine gap (no yt-dlp) | Rewrite instead of port | Medium | `IMediaResolver` from day one + capability negotiation in the UI |

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
│   └─ android/              # (M8) MediaSession, SAF, foreground service
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

1. **Run the sidecar spike** — do this before choosing the stack (§3 is deferred, and this spike is portable across all three options): on a clean Windows machine, script yt-dlp + ffmpeg to (a) resolve a video to a direct audio URL, (b) verify seeking against that URL, (c) download + transcode + tag one file. Measure latency and failure modes. This single spike de-risks M3 and M4 more than any amount of planning, and it will inform the stack choice. **Still open — this is the next thing to do.**
2. ~~**Decide the stack** (§3) once the spike has told you what the engine actually needs. Write it down as an ADR.~~ Done: `docs/adr/0001-stack-and-storage.md` (Electron + TypeScript + React, `node:sqlite`, no native build tools).
3. ~~**Wireframe the 6 core screens**~~ Done, and built: Library, Queue, Settings and Now Playing all exist; Search is the library search field; Downloads arrives with M4.
4. ~~**Write the two specs**~~ Done: `IMediaResolver` is `src/engine/resolver.ts`; the IPC event schema is `src/shared/ipc.ts`.
5. ~~**Pick the retention defaults**~~ Done: stream-only default, 5 GB / 30-day cache budget, keep only on request.
