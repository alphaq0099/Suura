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
- The hero offers Resume for the newest played item and no action before the first listen.
- Cream mode shows the hero artwork through a left fade instead of a haze.
- An artist with tracks but no albums opens their track list, not an empty album grid.
- Every shelf has prev/next arrows that disable at its ends.
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

A counted listen (30 seconds or completion) now refreshes **Recently played** while Home is open, and is counted once per listen instead of again when the track ends or changes. A played file with no album tag now appears there as a track card, merged with the played albums by newest listen, instead of being omitted because it has no album summary. The equalizer is one row of upright faders with the preamp apart, hangs above the player bar without covering it, and uses a faders icon that cannot be confused with Settings or Queue. Album-card play badges keep their accent when hovered or focused.

Home now shows what the user actually has, not only what fits an album shelf:

- **Recently played** merges played albums, played albumless files and counted YouTube listens, newest first. A stream keeps its own card even when YouTube gives it an album name, and a downloaded copy replaces the stream card by video id instead of doubling the listen.
- **Recently added** merges added albums with added files that have no album tag, so a new single is no longer invisible there.
- **Playlists** lists imported YouTube lists beside custom ones; an imported card shows its kind and track count and opens the list in Playlists, where it can be played, saved or edited.
- Stream listens are written after the same 30 s threshold, in a `stream_plays` table keyed by video id. That is deliberately separate from the YouTube history: playing an imported entry still does not echo into `online_tracks`, but the listen still reaches Home.
- A shelf scrolls back to its first card when a new one is prepended, and does nothing when reduced motion is on.

The Home hero and shelves now point at what the user actually just did:

- The hero action is **Resume <newest played item>**, named after the top of Recently played, and it does not appear before the first listen. It no longer replays a fixed album that the shelves already show as a card.
- The hero backdrop is masked to fade out under the copy and is stronger in cream mode, so the artwork reads as art rather than a haze.
- An artist card with no albums opens that artist's tracks in the detail view, with the album column on, instead of filtering the album grid to an empty page.
- Every shelf heading has small prev/next arrows that disable at the ends, move by a page and use instant movement under reduced motion.

Each slice passed `npm run typecheck`, `npm run smoke`, `npm run build` and `npm run selftest`. Manual acceptance of the visual slices (P3, P13, the equalizer, the play badge, the hero backdrop and the new Home cards) is still required. M8 stays open on signing, updates, crash reporting, sidecars, compatibility and a clean-Windows pass. The tree also contains an unrelated, uncommitted performance-harness change in `src/main/scale-check.ts`; it is not part of this feedback pass and must not be mixed into these commits.
