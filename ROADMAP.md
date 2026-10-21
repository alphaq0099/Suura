# Roadmap — Music Player (working name: **Player**)

A music player that manages a **local music library** and can also **search, stream and download songs from YouTube** through a backend engine built on **yt-dlp**.

- **Platform order:** Windows desktop first → Android later
- **Streaming first:** play immediately, no waiting for a full download
- **User's choice:** decide per-track / per-playlist whether downloaded audio is kept on disk, cached temporarily, or never written to disk at all. **Offline caching is deferred to M12**; stream-only and explicit saving are what ship today.
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
- Playing a YouTube track already resolved this session (or prefetched): < 3 s to first audio; a cold paste has a
  ≤ 10 s median display target while it resolves
- Cache/download manager never exceeds the configured disk budget *(cache arrives in M12; explicit saves are bounded by
  the queue and reported in the Saves dock)*
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
- [ ] Wireframe the 6 core screens: Library, Now Playing, Queue, Search, Downloads, Settings — all but Downloads are
      built; a compact Saves dock covers the download case until the full screen arrives with M12
- [x] Write the `IMediaResolver` interface and the IPC event schema (as a spec, not code) — built, not just specified:
      `src/engine/resolver.ts` and `src/shared/ipc.ts`
- [ ] Verify yt-dlp + ffmpeg work as sidecars on a clean Windows machine; measure resolve latency and success rate on 20
      representative videos — presence is checked by `npm run smoke`; the 20-video sample (**20/20**, median 8.8 s) and
      the 50-video M3 sample (**50/50**, median 8.3 s) are done, in [`docs/notes/yt-dlp-sample.md`](./docs/notes/yt-dlp-sample.md)
      and [`docs/notes/yt-dlp-50.md`](./docs/notes/yt-dlp-50.md); the clean-machine pass is still open
- [x] Legal/ToS note drafted (§10) — in the README under **Scope and legal**
**Exit:** a one-page architecture doc + stack ADR + working sidecar smoke test.

### M1 — Local Library MVP  *(~2–3 weeks)*
**Goal:** it is a genuinely usable local music player.
- [x] Folder scanning (recursive, incremental index into SQLite)
- [x] Tag reading → Artist/Album/Track ingestion; compilation & multi-artist handling
- [x] Library UI: virtualized list, sort by title/artist/album/duration/year/added/played, search via FTS5. Columns are
      **#, Title, Artist, Album, Duration, Action**; Format is not a column but a row's **Details** sheet (format, codec,
      bitrate, sample rate, channels, size, path, added/played, YouTube origin), opened from the ⋯ button or the row menu.
      The Queue view carries the same six-column header, aligned with its rows.
- [x] Artwork: embedded covers extracted lazily, resized, cached content-addressed, served over `player-art://`
- [x] Now Playing: full-window player with a blurred art backdrop, transport, volume, queue and a scrubber; the queue
      as a panel inside the window, slid in by the button that opened it and dismissed by a press anywhere outside it
- [x] Visuals settings: artwork square or circular, cropped to a square or given the cover's own shape, and sized from
      small to extra large; ambient player-bar background masked to no hard edge; volume as mute-on-click with the
      slider revealed on hover, and a wheel over the control nudging it by five percent; the player bar's own speaker
      icon is the same kind of toggle
- [x] Click behaviour setting: single click and double click each choose select / play / select-and-play / nothing
- [x] Playback: play/pause/next/prev/seek, volume, shuffle, repeat (off/all/one)
- [x] Queue management (add to queue, jump, remove, clear)
- [x] File watching for changes: an OS watcher per folder, debounced, turning any change into an incremental scan that
      prunes what disappeared; a setting to turn it off for slow or network drives
- [x] Basic playlists: create, rename, delete; add from the library selection bar, a row's context menu or the queue in
      the player window; remove entries; reorder by drag or Alt+↑/↓ with a gap-based position that keeps the order exact;
      a resizable (and remembered) playlist index; playlist columns that respond to the pane's own width
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
- [x] Sidecar manager: locate/verify/launch/kill yt-dlp & ffmpeg, capture stderr into logs
- [x] Resolver: URL → metadata + playable source
- [x] Search-by-text — **landed in M5**, as an explicit search rather than a catalogue browser; paste remains the
      shortest path and nothing browses recommendations on its own
- [x] Local HTTP stream proxy with range-request support and a stable per-track URL — implemented as the
      `player-stream://` custom protocol instead of a localhost server, with header replay, stable tokens and range
      forwarding
- [x] Player integration: **Stream only** mode works end-to-end
- [ ] Playback state machine for stream sources (loading → buffering → playing → failed) — loading and failed are
      carried by the existing player state; a distinct *buffering* state is still open
- [x] Error taxonomy & user-facing messages (expired URL, bot check, geo-block, unavailable, network)
- [x] Re-resolve on failure/expiry, transparent to the player
- [x] Resolve-result metadata cache (avoid re-resolving the same video within a session)
- [x] Request governor: at most two yt-dlp metadata processes (playlist imports), jittered start gap, a five-minute
      search/channel cache with single-flight, one transient-failure retry, and a bot-check breaker (5 min / 15 min on
      a repeat) that leaves already-resolved streams playing. Search/channel now use InnerTube, so they do not start a
      sidecar at all. Prefetch is a setting. Browser cookies are off by default and can be used never, once after a
      bot check, or always; a PO Token provider is an optional external HTTP server with an optional managed command.
- [x] Next-track prefetch: four seconds into a stream the player asks the main process to resolve the entry it will
      play next (`media:prefetch` → `ResolverRegistry.prefetch` → `YouTubeResolver.prefetch`), filling the cache the
      play will read without registering a token, recording history or failing the caller. A video id is asked for once
      per session and the timer dies with the track, so skimming a queue does not spawn a sidecar per row. Only the
      resolve is brought forward; the bytes are still streamed on demand.
- [x] Paste surface: a dedicated **YouTube** view (sidebar, under Library) with a persistent link history — a pasted link
      becomes a row at once (*Resolving…*), then fills in; **Add to queue** / **Play now**, per-row album/artist/duration,
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
(and a larger install), which is deliberately not this milestone. The remaining M3 buffering state is open. Evidence:
[`docs/notes/yt-dlp-50.md`](./docs/notes/yt-dlp-50.md).*

### M4 — Save to Library (lite)  *(done; full cache moved to M12)*
**Goal:** keep the "save it explicitly" half of §2.2; **offline caching is switched off for now**, because it is not
needed for the current use and was making Settings promise behaviour that did not exist.
- [x] **Keep** action: download → tag → embed cover → move into the library → scanned row appears (default Opus, or
      MP3/M4A; folder, quality and format are settings). Verified live: 12 s for a 4.9 MB Opus, tags and JPEG cover intact.
- [x] **Keep an imported entry**: the same path from the imported playlist pane — a per-entry *Save to library* button and
      a *Save all* that queues every entry not already in the library. The library row keeps the video id in
      `origin_kind`/`origin_id`, so *sourceId* is preserved without pretending the file is a stream.
- [x] Download manager: per-track queue, concurrency cap, progress parsed from yt-dlp, a per-save temporary folder,
      `.part`-safe final moves, and **cancel** (queued or running). Cancelling is reported as a decision, not an error.
- [x] Startup sweep: a crash or force-quit never runs the per-save cleanup, so the next start removes its own UUID temp
      folders and orphaned `.part` files. Unrelated folders in `downloads/` are left alone.
- [x] **Saves dock**: one compact panel mounted by the app, visible from every view, with cancel while running, retry
      after a failure or cancel, and reveal-in-Explorer once the row is indexed. No permanent Downloads screen yet.
- [x] Settings honest: *stream only* is pinned on load (an older config saying `cache` is rewritten to `stream`), the
      cache-budget/age controls are gone, and the page says plainly that offline replay is a later phase.
- [ ] **Remove download**, **pin in cache**, per-item retention, pause/resume, speed + ETA, disk pre-flight and a
      full Downloads history — all deferred with the cache to **M12**.
**Exit:** saving a history row or imported entry round-trips into an ordinary tagged library track; a killed process
leaves no temp folder; cancel and retry work from the dock. The disk-budget/offline half of the old exit moves to M12.

### M5 — Discovery & YouTube Library Surface  *(complete)*
- [x] Unified search: local results **and** YouTube results in one list, clearly badged. The new **Search** view queries
      both in parallel; every row carries a **Local** or **YouTube** badge. A local row plays a file at once. A
      YouTube row goes through the same add-link path as a pasted URL, so it is remembered in the YouTube history and
      uses the same resolve cache. Rows offer Play, Add to queue and Save to library; a YouTube search returns metadata
      only, so no result is resolved or written until it is chosen. The view stays mounted for the session, so leaving
      Search and returning keeps the query, results and open channel; a restart clears them.
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
      Remove from history and Details. The rows stay links (they are not local tracks and the local chips do not count
      them), but the user no longer has to leave the Library to see them.
**Exit:** a user can go from "no music" to "a 40-track playlist playing" without touching a folder.
*Status: complete. Search finds local and YouTube rows together, channels open in place, smart chips cover recent,
played and unplayed views, and the YouTube chip folds stream-only history into the Library. Imported lists plus the link
history cover the "start from nothing" path. The channel page is a flat recent-videos list on purpose — no subscriptions,
no channel import, no "download all".*

### M6 — Settings Revamp  *(complete)*
**Goal:** one deliberate pass over Settings after M5, instead of growing it card by card. The page currently mixes
library folders, engine paths, playback choices, artwork, saving, import caps and about text in one long scroll; it
works, but it has no hierarchy and no way to find a single option.

- [x] Structure agreed with the user: **six top tabs** — General, Appearance, Behaviour, Streaming, Misc, About — with
      one scrollable panel at a time. The heading and tab strip stay put; the panel owns the scrollbar.
- [x] Make every control state what it changes and whether it applies now or on restart; no dead or duplicate controls
- [x] Move diagnostics (engine status, paths, logs, database location) behind **Misc** rather than the main flow
- [x] Give saving one honest home: folder, quality, format and concurrency, plus the deferred offline-cache note in one
      place under **Streaming**
- [x] Streaming controls for the request budget: next-track prefetch, daily yt-dlp self-update, an optional external PO
      Token provider (URL, command, auto-start, status), and a three-mode browser-cookie fallback with its privacy caveat
- [x] Bounded Appearance: Midnight/Cream/Follow Windows, five contrast-checked accents, Compact/Comfortable/Spacious
      density, Solid/Accented surfaces (accent wash and CSS blur, not native acrylic or album-art frost), motion
      preference with a live preview, info-icon explanations, cover-art options and reset. No arbitrary CSS, icon packs,
      custom fonts, layout builder, custom accent or Material theme in v1
- [x] Review defaults and reset-to-default. **Misc → Reset preferences** restores playback, appearance, behaviour, import
      limits, saving quality and request-budget choices from the same defaults a first launch uses, while keeping the
      library, engine and download folders and the last engine-update timestamp. Settings export/restore is deliberately
      left to the backup work in M7
- [x] Density pass after first use: Streaming is one column with two-column fields (no dead half-page under short
      cards), PO Token and cookie fallback are separate cards, and long explanations moved from General, Behaviour,
      Misc and About into info tooltips behind one-line hints
- [x] Accessibility and keyboard pass: tablist arrow/Home/End movement with roving focus, focusable scrollable panels,
      real `<label>` elements around every field, `aria-pressed` on the choice buttons, a live error banner and a
      two-step reset confirmation with a status message
- [x] Search within Settings considered and deferred: six tabs keep every option one click away, so a second search box
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
      migration, and the ten newest managed copies rotate.
- [x] DB migrations framework: append-only versioned migrations, a `user_version` guard that refuses a newer schema, and
      a pre-migration backup whose path is named in a migration failure.
- [x] Duplicate detection with safe merge: present local files are fingerprinted lazily with SHA-256, grouped, and
      merged oldest row first. Playlist entries and play counts move to the keeper; the redundant file is deleted only
      after the rows merge. The scanner resets a hash when a file changes.
- [x] Missing-file handling: a vanished file keeps its row with `missing_at`, stays in its playlists and history, and
      is hidden from normal lists. Relocation scans a chosen folder and matches by stored hash first, then by exact
      size and modification time, folding any already-indexed target into the retained row.
- [x] Bulk operations: multi-select play, queue, add-to-playlist and remove-from-library. Removing rows never deletes
      files. Tag writing needs a tag writer, and keep/remove-download belongs to the M12 cache, so both remain deferred.
**Exit:** data survives a crash, a reinstall and a folder move. **Met:** manual and rotating automatic backups, staged
restore, migration guard, and id-preserving relocation were exercised in the smoke test and the UI self-test.
**Status:** complete.

### M8 — Windows Release Engineering  *(~2 weeks)*
- [ ] Installer (per-user, no admin): MSIX or NSIS; clean uninstall; opt-in "also delete cache/library DB"
- [ ] Code signing (or at least a documented SmartScreen workaround plan)
- [x] Daily yt-dlp self-update, throttled to once per 24 h and recorded in `engine.lastUpdateCheckAt`
- [ ] App auto-update channel (stable/beta) and engine rollback
- [ ] Crash reporting (opt-in) and log export ("Send diagnostics" button)
- [ ] Windows 10/11 compatibility matrix, HiDPI, multi-monitor, 4K scaling
- [ ] Performance budget tests in CI: cold start, scan 10k files, memory under playback
- [ ] Accessibility pass: keyboard-only navigation, screen-reader labels, contrast
**Exit:** a stranger can install, use and uninstall it without instructions.

### M9 — Android Port  *(~4–6 weeks)*
**Goal:** reuse the core, replace the platform-specific layers.
- [ ] Confirm the shared/reused surface (data model, DB, settings, playlists, retention policy) vs. what must be rewritten (engine, player, UI, storage permissions)
- [ ] Embed the resolver: NewPipeExtractor-based engine (or an embedded-Python yt-dlp via Chaquopy — evaluate size and stability), behind the same `IMediaResolver`
- [ ] Android player: background playback, notification + lock-screen controls, audio focus, Bluetooth/metadata, MediaSession
- [ ] Scoped storage: app-private cache + user-chosen library folder (SAF), correct permission flows
- [ ] Mobile UX rework: bottom nav (Library / Search / Downloads / Playing), mini-player, gesture controls, Material 3
- [ ] Battery/data-saver awareness: "stream only on Wi-Fi", download only on Wi-Fi, cache budget in MB
- [ ] Play Store requirements: target API level, data-safety form, privacy policy, and a serious decision about whether an app whose purpose is downloading from YouTube can be distributed there at all (alternative: direct APK / F-Droid)
**Exit:** feature parity on the core loop (library + search + stream + keep), signed APK released.

### M10 — Two-Device Continuity *(optional, ~2–4 weeks)*
- [ ] Optional **companion server mode**: one device (usually the PC) exposes its resolved stream + library over LAN so the other device can play/download from it
- [ ] Playlist/play-state sync between devices (local network, no cloud account)
- [ ] "Send to device" (Cast-like) for the same-network case
**Exit:** start a song on the PC, continue on the phone.

### M11 — Long-Term / Nice-to-Have  *(continuous)*
- [ ] Last.fm scrobbling · Discord Rich Presence
- [ ] Lyrics: local `.lrc` + fetched with offset editor
- [ ] Audio visualiser, spectrum analyser
- [ ] Podcast/soundtrack mode, chapters, playback speed & pitch
- [ ] Advanced: WASAPI exclusive output, ASIO, bit-perfect/hi-res path, device selection
- [ ] Plugin/extension API for community resolvers
- [ ] Optional CLI companion for scripting

### M12 — Offline Cache & Downloads *(deferred to the end, ~2–3 weeks)*
**Goal:** the other half of the original M4, deliberately postponed until the library, discovery and Settings work is
settled. Nothing here is needed for the current use of the app.

- [ ] Cache manager: write-while-playing, LRU eviction, size/age budgets, janitor task, manual "empty cache"
- [ ] Pin in cache (never evict) and "keep after this play" quick action
- [ ] Remove download: delete the file, keep the track in playlists/queue, fall back to streaming
- [ ] Offline detection: stream-only rows show as unavailable; cached/downloaded ones still play
- [ ] Full Downloads history: active/completed/failed, pause/resume, speed + ETA, disk pre-flight
- [ ] Re-enable the cache controls in Settings only when the manager behind them exists
**Exit:** disk usage never exceeds a budget; killing the app mid-cache leaves no corruption; offline replay works for
cached tracks; "keep" → "remove" round-trips cleanly.

---

## 8. Milestone Summary

| # | Milestone | Focus | Est. | Dependency |
|---|---|---|---|---|
| M0 | Foundations & Decisions | Stack, architecture, sidecar spike | 1 w | — |
| M1 | Local Library MVP | Scan, index, play, queue | 2–3 w | M0 |
| M2 | Player Quality & System Integration | Gapless, EQ, SMTC, tray | 2 w | M1 |
| M3 | Engine Skeleton | Resolve + **stream** | 2–3 w | M0, M1 |
| M4 | Save to Library (lite) | Stream-only / explicit keep / saves dock | 1–2 w | M3 |
| M5 | Discovery & YouTube Surface | Unified search, channels, smart Library views | 2–3 w | M4 |
| M6 | Settings Revamp | Hierarchy, grouping, honest controls | 1–2 w | M5 |
| M7 | Playlists, Sync & Data Care | Import/export, migrations, dedupe | 2 w | M6 |
| M8 | Windows Release Engineering | Installer, update, telemetry, a11y | 2 w | M7 |
| M9 | Android Port | New engine + player + UI | 4–6 w | M8 |
| M10 | Two-Device Continuity *(optional)* | LAN companion server | 2–4 w | M9 |
| M11 | Long-term extras | Scrobbling, lyrics, hi-res | continuous | — |
| M12 | Offline Cache & Downloads *(deferred)* | Cache, pin, remove, offline replay | 2–3 w | M4, M6 |

**Critical path:** M0 → M1 → M3 → M4 → M5 → M6 → M8 → M9. M2 can be interleaved, M7 is data-care hygiene, and M12
stays at the end until offline listening is actually wanted; it touches M4 and M6, so it should follow them rather than
run beside them.

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

1. ~~**Run the sidecar spike**~~ Done: `docs/notes/yt-dlp-spike.md`, followed by the 20-link sample and the 50-link M3
   measurement in `docs/notes/yt-dlp-50.md`. yt-dlp + ffmpeg resolve, seek, download and tag on this machine.
2. ~~**Decide the stack** (§3) once the spike has told you what the engine actually needs. Write it down as an ADR.~~ Done: `docs/adr/0001-stack-and-storage.md` (Electron + TypeScript + React, `node:sqlite`, no native build tools).
3. ~~**Wireframe the 6 core screens**~~ Done, and built: Library, YouTube, Search, Playlists, Queue, Settings and Now
   Playing all exist; the full Downloads screen is deferred to M12.
4. ~~**Write the two specs**~~ Done: `IMediaResolver` is `src/engine/resolver.ts`; the IPC event schema is `src/shared/ipc.ts`.
5. ~~**Pick the retention defaults**~~ Done: stream-only is the default and is currently the only accepted mode; the
   5 GB / 30-day cache fields remain dormant for M12, and saving is always explicit.

Where things stand: the stack and storage decisions are recorded (ADR 0001). YouTube playback has a real surface — the
**YouTube** view with a persistent link history and a separate **Imported** box, one card per list — and playlist,
album and mix import stores a snapshot that the Playlists view can play, queue, re-import, rename and trim, with a
per-import track count for mixes and radios. **Saving to the library works**: a history row, a search result or an
imported entry downloads once, is tagged with embedded artwork, moves into the music folder and is indexed as an
ordinary local track that remembers its video id. A compact **Saves** dock shows running, failed and finished saves
from every view, with cancel, retry and reveal. **M3 is measured** at 50/50 links, a 8.3 s median cold resolve and a
0.46 s median to the CDN's first bytes, so `< 3 s` is adopted for warm/prefetched playback and cold paste has a 10 s
display target. **M5's core is in**: a unified **Search** view over the local library and YouTube, channel pages, and
title/artist cleanup. Every track list shares the **# / Title / Artist / Album / Duration / Action** grid, with Format
in a row's **Details** sheet, and the Queue has a header aligned with its rows. Next is the **Settings revamp (M6)**,
whose design is still to be agreed, then data care (M7), which is now complete. Offline caching and the full Downloads
screen stay deferred to M12.
