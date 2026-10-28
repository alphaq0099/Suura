# Objective — feedback pass from `1.png`–`4.png`

## Current phase

**Post-M12b product feedback, before M8 is closed.** The previous UI-consistency objective is complete. This pass turns the annotations in `1.png`, `2.png`, `3.png` and `4.png` into a single, ordered body of work.

The feedback is not one visual-polish pass. It contains:

1. trust bugs (Home shelves and Downloads do not reflect what the user just did),
2. information-architecture changes (Downloads and Equalizer become first-class surfaces),
3. settings copy cleanup,
4. visual polish that must not compromise accessibility or motion preferences.

## Objective

### P1 — Fix the trust bugs first

- Home shelves must update after playback, after a download is saved, and after library changes. This applies to **Recently played**, **Recently added**, and every other shelf, not only the first one.
- The Downloads list must survive a relaunch. A saved/downloaded track must still be visible in Downloads after restarting the app.
- Cache cleanup must not look like a blanket wipe on every restart. The existing age/size pruning must be understandable and controllable; nothing should be deleted merely because the app started.
- Fix the Downloads header padding so the `LIBRARY & OFFLINE` / `Downloads` block no longer hugs the top border.

### P2 — Make the surfaces do their job

- Turn Downloads into a persistent management view, not a second library table:
  - selection per row and bulk selection,
  - play directly from Downloads,
  - add to queue from Downloads,
  - the necessary selection submenus,
  - **Remove from list** and **Delete file** as separate actions,
  - reveal the saved file,
  - cache controls that are useful rather than decorative.
- Offline cache:
  - show what is cached and how much space it uses,
  - offer an explicit **Clean now** action,
  - expose the automatic age limit and size budget in the UI,
  - do not clear the cache on restart unless the configured age/size policy actually requires eviction,
  - allow a cached copy to be promoted into the library / saved without downloading it again.
- Move the Equalizer out of Settings to the player bar:
  - add an Equalizer button between Queue and Mini player,
  - open a small panel/card like the queue panel,
  - keep all bands and the preamp there,
  - leave room for more controls later,
  - keep a discoverable Settings link to the same panel.
- Remove the long explanatory paragraph under **Volume normalization** and left-align **Analyse missing tracks**.
- Replace the Home shelf hint strings **“Back where you left off”** and **“Newest albums first”** with a consistent **More** action.
- Remove **Last scan** from the Home hero.
- Replace the duplicate Home hero actions (**Open library** / **Add folder**) with one contextual, useful primary action.
- Shorten every Settings tooltip to the minimum needed to explain the control or card. Keep warnings for destructive actions; move long explanations to docs.

### P3 — Visual polish

- Add accent-aware blur/tint to the Home statistic cards without hurting contrast.
- Replace the static Home hero background with a gentle slideshow of recent covers. Respect reduced motion, pause when the window is hidden, and avoid fast autoplay.
- Replace the album-card hover shadow with a small, gentle pop-up. It must also work on keyboard focus and must not cover the card's own controls.

### P13 — Vertical volume, last

- Make the player-bar volume control match the player window's vertical, keyboard-accessible volume control.
- When the user changes volume from the keyboard, the vertical slider must visibly open and move, not just change the value silently.
- This is the last item in the pass and must not block P1–P3.

### Home follow-up — the annotated `1.png`

- Show the hero art at full strength in both themes; the mask and overlay keep the copy readable, not a wash.
- Move the hero pace out of the preview panel and into **Settings → Appearance** (3–60 seconds, default 12).
- Remove the hero tagline and the Resume action; the stats sit under the heading on the left and the right side stays art.
- Put All tracks' filter chip and search in a toolbar under the heading instead of on the heading's row.
- Replace All tracks' Album column with **Source**, with each row's badge in that column.
- Give YouTube rows in All tracks the same save action as YouTube Links.
- Make a one-track album's card play the song instead of opening a one-row detail page; a real album keeps its detail.
- Give the opened playlist the album page's hero: large sleeve, kicker, name, facts and actions above the rows.

## Decisions

| Area | Decision |
|---|---|
| Scope order | P1 bugs → P2 structure/copy → P3 visual polish → P13 vertical volume. |
| Home shelves | A shelf is stale if the underlying play/download/library change is not reflected. Fix the event/cache invalidation at the source, not by forcing a full reload on every render. |
| Downloads identity | Downloads remains the place for saved files and the offline cache; it is not a duplicate of Library. It should share row actions with Library where that reduces inconsistency. |
| Remove vs delete | **Remove from list** forgets the download-history row but leaves the file. **Delete file** removes the file from disk after confirmation. |
| Cache policy | The cache is a bounded copy. Age and size limits are user-visible. Startup reconciliation may remove missing/incomplete files, but must not masquerade as "clearing the cache". |
| Cache to library | Promoting a cached file to a saved library track should reuse the cached bytes, not re-download. |
| Equalizer | Playback control, so it lives on the player bar. The panel is non-modal, keyboard-operable and closable with Escape. Settings keeps a shortcut. |
| Tooltips | One sentence where it adds information; otherwise remove. Destructive-action warnings remain. |
| Motion | The hero slideshow and card pop-up must honour the existing motion preference and avoid layout shift. |
| Volume | Reuse the player-window volume behaviour. Do not invent a second volume model. |
| Verification | Every slice must pass `npm run typecheck`, `npm run smoke`, `npm run build` and `npm run selftest` before it is called complete. Manual acceptance is still required for visual changes. |

## Out of scope

- No new accent colours, icon packs, fonts or playback engines.
- No third-party UI framework.
- No remote crash reporting, auto-update or sidecar packaging in this pass; those remain M8 work.
- No destructive cache or download migration that cannot be undone.
- No attempt to make Downloads a second library editor. Selection actions should reuse the existing track actions.

## Acceptance criteria

- Playing a track and saving a download updates the relevant Home shelves without a restart.
- An imported playlist appears on Home's Playlists shelf and its card opens it in Playlists.
- A counted YouTube listen appears on Recently played as a track card, including one played from an imported list.
- A newly added file with no album tag appears on Recently added without displacing its album cards.
- The hero never becomes a transport: no Resume, no duplicate Library or Add folder action, and the stats sit under its heading.
- The hero art shows at full strength in both themes, with the left fade keeping the copy readable.
- The hero pace is set in Settings → Appearance, and Reset returns it to 12 seconds.
- All tracks shows a Source column with each row's badge in that column, and only YouTube rows offer Save.
- A one-track album card plays its song; a multi-track album card opens its detail page and Back returns to Home.
- The opened playlist, custom or imported, shows the album-style hero above its rows.
- An artist with tracks but no albums opens their track list, not an empty album grid.
- Every shelf has prev/next arrows that disable at its ends.
- Typing fills **On this device** and **Imported** without a network call; the button or Enter is the only way to ask YouTube.
- Each local shelf shows at most eight cards with **Show all**, and a YouTube answer is one **Best match** plus four alternatives, with one **+5 more** page and a ceiling of ten.
- Editing the query returns the YouTube shelf to its call to action instead of leaving stale rows under a new query.
- Search warms the best YouTube match only when both local shelves are empty, once per attempt, and stops when the user plays a card or edits the query.
- A saved download is still listed in Downloads after a relaunch.
- A restart does not clear cached entries unless the configured age/size policy requires it.
- Downloads has correct top padding and no clipped tab labels.
- Downloads supports select, play, queue, remove-from-list, delete, reveal and cache management.
- The Equalizer opens from the player bar between Queue and Mini player, works from the keyboard, and is still reachable from Settings.
- The long Volume normalization paragraph is gone; **Analyse missing tracks** is left-aligned.
- Home shelf hints are replaced by **More** actions.
- The Home hero no longer shows **Last scan** or duplicate Library/Add folder actions.
- Every Settings tooltip is brief; no tooltip buries the control it describes.
- Home stat cards use accent-aware blur with readable contrast.
- The Home hero slideshow and album-card popover respect reduced motion and keyboard focus.
- The player-bar volume is vertical and keyboard-visible, matching the player window.
- `npm run typecheck`, `npm run smoke`, `npm run build` and `npm run selftest` pass after each completed slice.

## Status

All four slices are implemented and verified.

- P1 trust fixes: `79ccbe0`
- P2 Downloads and offline cache: `626dc14`
- P2 Equalizer on the player bar: `7c0f1c7`
- P2 Home More actions and hero cleanup: `af939d4`
- P2 Settings tooltip copy: `dd978c2`
- P3 hero slideshow, stat tint and card lift: `da879d8`
- P13 vertical player-bar volume: `07e44bd`
- Quick check: live play counting and the album-card play badge: `5c01337`
- Quick check: compact equalizer fader strip and its own trigger icon: `66793f4`
- Quick check: played albumless files as track cards on Recently played: `212fc4c`
- Quick check: imported playlists and YouTube listens on the Home shelves: `56a21a3`
- Quick check: hero resume, shelf arrows and the albumless artist view: `f62d0da`
- Search redesign, grouped live shelves: `259e9d7`
- Search redesign, card grid, best match and guarded warm-up: `25ae4da`
- Home All tracks, source badges and the shelf More filter: `9c0ad2a`
- Home hero bake, Source column and the All tracks toolbar: `5ed40c7`
- Home single-card play and the real-album detail test: `f541a9c`
- Playlist pane hero, matching the album page: `6c879c8`

A counted listen (30 seconds or completion) now refreshes **Recently played** while Home is open, and is counted once per listen instead of again when the track ends or changes. A played file with no album tag now appears there as a track card, merged with the played albums by newest listen, instead of being omitted because it has no album summary. The equalizer is one row of upright faders with the preamp apart, hangs above the player bar without covering it, and uses a faders icon that cannot be confused with Settings or Queue. Album-card play badges keep their accent when hovered or focused.

Home now shows what the user actually has, not only what fits an album shelf:

- **Recently played** merges played albums, played albumless files and counted YouTube listens, newest first. A stream keeps its own card even when YouTube gives it an album name, and a downloaded copy replaces the stream card by video id instead of doubling the listen.
- **Recently added** merges added albums with added files that have no album tag, so a new single is no longer invisible there.
- **Playlists** lists imported YouTube lists beside custom ones; a card shows its kind and track count and starts the list when clicked, while its **…** menu opens it in Playlists for editing.
- Stream listens are written after the same 30 s threshold, in a `stream_plays` table keyed by video id. That is deliberately separate from the YouTube history: playing an imported entry still does not echo into `online_tracks`, but the listen still reaches Home.
- A shelf scrolls back to its first card when a new one is prepended, and does nothing when reduced motion is on.

The Home hero and shelves now point at what the user actually just did:

- The hero is atmosphere, not a second transport: no Resume, no tagline and no duplicate Library/Add folder button. Its stats sit under **Your music, at a glance.** on the left, and the right side is left to the art.
- The hero backdrop is masked to fade out under the copy and now shows at full strength in both themes; the mask and overlay keep the copy readable rather than washing the picture.
- The pace of the backdrop is a setting (**Settings → Appearance → Home hero**, 3–60 seconds, default 12), so a slower or quicker crossfade no longer needs a code change.
- An artist card opens that artist's tracks in the detail view, with the album column on, instead of filtering an album grid to an empty page.
- Every shelf heading has small prev/next arrows that disable at the ends, move by a page and use instant movement under reduced motion.

The bottom of Home is now a list rather than an album grid:

- **All tracks** merges local files, counted stream listens, imported playlist entries and remembered YouTube links, deduped by video id (a downloaded copy hides its remembered twin) and newest activity first. The fourth column is **Source**, with each row's **Library**, **YouTube** or **Playlist** badge in that column, and the filter chip and search sit in a toolbar under the heading.
- A local row queues this list's local files from that row; a YouTube row plays that one stream, exactly as a stream row elsewhere, and carries the same **Save to your library** action as YouTube Links.
- **More** on Recently played or Recently added scrolls to the list and filters it in place: to tracks with a listen, or to local files only. A chip names the filter and clears back to All tracks.
- The feed is merged and paged in the main process: each source contributes a bounded window, pages are 100 rows, and a footer says when the scan stopped at its limit rather than claiming the whole library is shown.
- Artist cards open the artist's tracks instead of filtering an album grid, which this list replaced.

A card is now the play control a song deserves:

- A one-track album is a single. Its card plays the song instead of opening a detail page with one row; the card's own play badge still does the same thing. A multi-track album keeps its detail page, with Play and Queue, and Back returns to Home.
- The opened playlist borrows the album page's hero: a large sleeve, a kicker naming the kind (Playlist, Album, Mix), the name, the track count and duration, then Play, Add all and the list's own actions, with the rows underneath. Custom and imported lists share the layout; imported lists keep their owner and YouTube list id in the meta line.

Search is now three shelves rather than one mixed list:

- Typing filters **On this device** and **Imported** from the database as it settles; the network is only touched by the button or Enter, whose label is always **Search YouTube** when there is a query.
- A local shelf shows eight cards, then **Show all**; the YouTube answer is one **Best match** and four alternatives, with one **+5 more** control that fills a second row and stops at ten, so the page shape stays stable and past ten only guesses remain.
- Imported means remembered, not downloaded: YouTube history entries and imported playlist entries, deduped by video id, with a local copy hiding its remembered twin.
- Prefetching is a single guarded guess: the best match only, 1.8 s after an answer that found nothing locally, one in flight, a 45 s cooldown, paused by a bot check and cancelled by playing a card or editing the query.

Each slice passed `npm run typecheck`, `npm run smoke`, `npm run build` and `npm run selftest`. The temporary **Hero look** panel is gone: the tested opacity is written into the stylesheet and the pace is a real setting, so nothing about the hero lives in localStorage. Manual acceptance of the visual slices (P3, P13, the equalizer, the play badge, the hero backdrop, the Home cards and the Search shelf layout) is still required. M8 stays open on signing, updates, crash reporting, sidecars, compatibility and a clean-Windows pass. The tree also contains an unrelated, uncommitted performance-harness change in `src/main/scale-check.ts`; it is not part of this feedback pass and must not be mixed into these commits.
