# Objective — UI consistency and control polish

## Current phase

**Post-M7 consistency pass, before M8.** The M7 playlists/data-care milestone is complete. This pass closes the gaps exposed by screenshots `1.png`–`5.png`: the Library was updated first, but the YouTube Links table, the playlist Album behaviour and the Settings layout still behave like older screens.

## Objective

Make the Library, YouTube Links and imported-playlist track tables read as **one system**, and make every appearance control do exactly what its label says:

- The same row hierarchy everywhere: one flexible title, equal bounded metadata columns, fixed duration and compact fixed actions.
- A **Local lists** group with the Album checkbox, and a **YouTube lists** group with the Channel checkbox. Imported playlists always keep Album; YouTube Links always show Channel.
- YouTube Links replace Album with Channel. A separate Artist column appears only when yt-dlp reports an artist that differs from the uploader/channel.
- Extra Large remains selectable, but fixed columns scale with the text preset and labels never wrap or clip. Long Artist/Channel names truncate, then auto-scroll on hover.
- Settings puts type, icons and columns in the empty right-hand space and drops the decorative Motion preview.
- Playlists use a muted colour-coded `List` badge, the index no longer stretches into a large empty panel, and the playlist, queue and Settings icons are visually distinct.

## Current decisions

| Area | Decision |
|---|---|
| Library columns | Title `minmax(0, 1fr)`; Artist/Channel and Album equal `minmax(96px, 168px)`; index and duration fixed but text-scaled; actions fixed by icon count. Title is the only flexible track. |
| Track placement | Every header and row cell is placed explicitly. Hiding Album or Channel can no longer make Duration or Actions slide into the hidden track; Duration stays on the header's track and Actions stay on the row's right edge. |
| Album column | The Local lists checkbox hides Album in the Library and local playlists. Imported playlists always keep Album, apart from the `820px` container drop. |
| Channel column | The YouTube lists checkbox hides Channel in imported playlists only. YouTube Links ignore the toggle and always show Channel. |
| YouTube Links columns | Title, optional Artist, Channel, Duration, Download, Add to queue and the row menu. Album is no longer part of this table. |
| Artist metadata | yt-dlp's `artist`/`creator` is kept apart from `channel`/`uploader`. The Artist column appears when at least one row has a distinct artist; rows without one show an em dash. |
| Container limits | Keep the `820px` Album drop and `660px` Artist/Channel drop for TrackList. YouTube Links keep Channel at every width and drop only the optional Artist at `660px`. |
| Extra Large | Keep it. Fixed index/duration tracks grow with `--text-scale`; headers are no-wrap; title and metadata truncate rather than pushing the table wider. |
| Metadata overflow | Artist and Channel share equal bounded widths and reveal long names by scrolling while hovered, with the full value still in the native title. |
| YouTube labels | Use **Channel** for the uploader/channel and **Artist** only for a separately reported artist. |
| Playlist badge | `Mix` amber, `List` muted blue, `Album` neutral violet. Muted chips, not status colours. |
| Sidebar | Remove the Local/YouTube split. Keep one source line with the total and put the split in its tooltip. Quiet the row counts. |
| Icons | Redesign Playlists, Queue and Settings in both Modern and Classic sets so the silhouettes differ at 20px. |
| Playlist layout | Keep the shared footer, but let the index size to its content instead of stretching an empty box to the pane bottom. |
| Settings | Move **Text, icons & columns** to the right column, remove the Motion preview, show the text-size px values, and group the two column checkboxes by list family. |

## Out of scope

- No attempt to invent a track artist for every YouTube upload. The extractor prefers `artist`, then `creator`, then the uploader/channel; the UI shows Artist only when the first two produce a value different from the channel.
- No third-party icon pack, no arbitrary font-family picker, no new accent colours.
- No changes to playback, import/download, PO Token or cookie fallback. The only schema change is migration v10, which adds the separate `online_tracks.channel` column and backfills it from the old artist value.

## Acceptance criteria

- Library and YouTube Links share the same column priorities; only Download/Save and Add to queue are direct actions, with Details/Remove in the row menu.
- Hiding Album in a local list or Channel in an imported playlist visibly removes the column while Duration, Save/download and the action button stay aligned.
- YouTube Links show Channel at all widths and add Artist only when a distinct artist is available.
- Imported playlists keep Album and follow the Channel checkbox.
- All four text sizes keep Duration, headers and actions on one line with no wrapping or clipping.
- Extra Large is usable at 940px and 1200px windows.
- Settings has no Motion preview, the type/column card is in the right column, and the column controls are grouped by Local lists and YouTube lists.
- Playlist List/Mix/Album badges are colour-coded but muted.
- Sidebar has no Local/YouTube split and its counts are visually secondary.
- Playlist, Queue and Settings icons are clearly different in both icon sets.
- `npm run build`, `npm run smoke` and `npm run selftest` pass.

## Status

Implementation is in place and verified with `npm run build`, `npm run smoke` (**562/562**) and `npm run selftest` (**all checks passed**), including the hidden-column alignment checks at Extra Large and the imported-playlist Channel regression. The objective stays open for visual feedback on Extra Large and the hover reveal.
