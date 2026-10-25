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

Feedback captured from `1.png`–`4.png`. Implementation starts with P1. The tree also contains an unrelated, uncommitted performance-harness change in `src/main/scale-check.ts`; it is not part of this feedback pass and must not be mixed into these commits.
