# Linux release notes

Suura for Linux is **in progress and not released**. Windows 10/11 remains the
1.0 target; this file exists so the Linux work has the same written trail the
Windows one has, and so nobody has to rediscover what already works.

The short version: the core is already portable — `node:sqlite`, `app.getPath()`
for every folder, `navigator.mediaSession` (which Chromium maps to MPRIS), no
native modules and no Windows-only build step. What is Windows-shaped is the
*edges*: the engine manifest, the executable bit, the autostart entry, packaging,
the update channel file and the docs.

## Status: first build, 2026-11-09

Built and tested on Ubuntu 24.04 (kernel 6.8, Node 24.21, Electron 44.10.2):

- `npm run build`, `npm run smoke` (1404/1404) and `npm run selftest` (428/428)
  pass.
- `npx electron-builder --linux AppImage` produces `Suura-0.1.0.AppImage`
  (124 MB) and a `latest-linux.yml` channel file.
- The packaged AppImage runs its own self-test from `release/` and passes
  428/428.
- The window renders, the Home screen lays out correctly, and the app writes to
  `~/.config/Suura`.

What the run taught us:

- The test box has no `libfuse2`, so the AppImage was started with
  `APPIMAGE_EXTRACT_AND_RUN=1`. A normal desktop installs FUSE 2; the fallback
  belongs in the docs either way.
- GitHub release downloads returned 504 during the run, and `npm ci` then left
  Electron uninstalled without failing. `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`
  fetched it. This is an outage workaround, not a permanent setting.
- There is no audio device (ALSA reports "Unknown PCM default"), and every check
  still passes: the suite does not depend on a real sink.
- Media keys are refused as "already held by another app" on XFCE/X11. The app
  degrades correctly, and it is the same class of problem as the Wayland note
  below.
- electron-builder warned that `desktopName` was unset, so a running window was
  not grouped under the launcher icon. `package.json` now sets `suura` and
  `linux.syncDesktopName` is on.

## Target

- Ubuntu 24.04 x86_64 first; an AppImage, because it is the only Linux packaging
  electron-updater can update in place.
- GNOME and KDE on X11 and Wayland are the intended desktops, in that order.
- A `.deb` is built beside the AppImage for people who prefer a package manager.
  It does not update itself: electron-updater only replaces an AppImage, and a
  `.deb` belongs to `dpkg`. The app reports that instead of offering a check the
  feed cannot satisfy. Snap and Flatpak are not planned for the first release.

## What already works without a change

| Area | Why |
| --- | --- |
| Library, search, playlists, tags | `node:sqlite` and plain `fs`; no native module to rebuild |
| App data, music and cache folders | `app.getPath(...)` everywhere; no `%APPDATA%` literal in `src/` |
| Playback, EQ, ReplayGain, gapless | Web Audio and two `<audio>` decks, both Chromium features |
| Now-playing overlay | `navigator.mediaSession`; Chromium publishes it over MPRIS/D-Bus |
| Tray icon and mini player | `Tray` plus a data-URL `nativeImage`; the desktop supplies the host |
| Taskbar thumbnail buttons | Already guarded by `process.platform !== 'win32'` and skipped |
| Sidecar lookup and rollback | `locate.ts`, `rollback.ts`, `process-tree.ts` already branch on the platform |

## What changed for Linux

- `src/engine/sidecar/manifest.ts` — two pinned tables, one per platform, and
  `assetsForPlatform()` refuses a platform it has no rows for instead of handing
  a Windows `.exe` to a Linux spawn.
- `src/engine/sidecar/install.ts` — `chmod 0755` after install on non-Windows.
  A download arrives `0644`; without this the first spawn fails with `EACCES`.
- `src/main/login-item.ts` — Linux writes `~/.config/autostart/suura.desktop`
  (honouring `XDG_CONFIG_HOME`) and registers `$APPIMAGE` when set, because an
  AppImage's `app.getPath('exe')` is a temporary mount that disappears at reboot.
- `electron-builder.yml` — an AppImage target for x64 and `build/icon.png`.
- `electron-builder.deb.yml` — the `.deb` as a separate build with `publish: null`,
  so it carries no `app-update.yml` and adds no entry to `latest-linux.yml`.
- `src/shared/platform.ts` — two platform facts that do not need Electron, so the
  smoke suite checks both: `hasGlobalMediaKeys` (Wayland has no global grab) and
  `canUpdateInPlace` (a Windows install or a Linux AppImage can replace itself).
- `src/main/update-service.ts` — a `.deb` reports that updates come from the
  package manager instead of offering a check that would ask for a root password,
  and the channel file it names is `latest-linux.yml` on Linux.
- `package.json` — `npm run package:linux`, and a `homepage` so the deb's
  Homepage field does not depend on a `.git` folder being present.
- `src/engine/sidecar/tar.ts` — a `.tar.gz` reader beside the ZIP one, because
  AcoustID publishes `fpcalc` for Linux only in that shape.
- `src/main/media-keys.ts` — Wayland leaves the four keys to the compositor and
  says so in the log.
- `src/main/tray.ts` — asks the session bus for a StatusNotifier host before
  creating the icon, so a session without one gets no tray and close-to-tray
  stays off instead of an invisible window.
- `tools/publish-r2.ps1` and `worker/src/index.js` — the AppImage, its blockmap,
  `latest-linux.yml` and the `Suura.AppImage` alias are published and served
  beside the Windows files, with the same channel/size/checksum checks.
- `src/renderer/src/components/SettingsView.tsx` — the update hint names the
  channel file per platform instead of promising an installer and a blockmap.
- `tools/smoke.ts` — checks both platform tables, so a wrong Linux digest fails
  on Windows CI rather than on a user's first download.

## Pinned Linux engine binaries

| Binary | Source | Why this file |
| --- | --- | --- |
| `yt-dlp` | `yt-dlp/yt-dlp` `2026.10.26` → `yt-dlp_linux` | The PyInstaller x86_64 build; the `_aarch64` and `.zip` variants are different digests |
| `ffmpeg` | `eugeneware/ffmpeg-static` `b6.1.1` → `ffmpeg-linux-x64` | Same immutable tag as the Windows pin; GPL-3.0-or-later, disclosed in `THIRD-PARTY.md` |
| `fpcalc` | `acoustid/chromaprint` `v1.6.2` → `chromaprint-fpcalc-1.6.2-linux-x86_64.tar.gz` | AcoustID ships Linux only as a `.tar.gz`, so the archive reader gained a tar branch; LGPL-2.1-or-later |

To re-pin a Linux row (or add fpcalc), download the exact asset, then record all
three values together — the URL, the byte count and the SHA-256:

```bash
curl -L -o /tmp/yt-dlp_linux \
  https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp_linux
wc -c < /tmp/yt-dlp_linux
sha256sum /tmp/yt-dlp_linux
```

A row whose size or digest is wrong is rejected after download, so a mistyped
value costs a user a failed download, not a corrupted engine.

## Building

On Ubuntu 24.04 (or any distribution with the Electron runtime libraries):

```bash
npm ci
npm run typecheck
npm run smoke
npm run build
npm run package:linux                       # AppImage + deb in release/
npx electron-builder --linux AppImage       # just the updatable one
npx electron-builder --config electron-builder.deb.yml --linux deb
```

The second command is separate on purpose: the `.deb` config clears `publish`,
so that build writes no update metadata and cannot put a `.deb` in the
`latest-linux.yml` the AppImage updater reads.

Electron needs the usual Chromium libraries, and the AppImage needs FUSE 2 to
run (or `--appimage-extract-and-run` where FUSE is unavailable):

```bash
sudo apt-get install -y libnss3 libgbm1 libasound2t64 libfuse2
```

Headless runs (CI, a server) need a display:

```bash
xvfb-run -a npx electron . --selftest
```

## Publishing

The Linux build writes two files, and both belong in the same feed folder as
the Windows release:

- `Suura-<version>.AppImage`, the download itself, cached forever;
- `latest-linux.yml` (or `beta-linux.yml` for a prerelease), revalidated on
  every request. electron-updater asks for this name on Linux by itself, so no
  setting changes.

`tools/publish-r2.ps1` publishes whichever platforms are present in `release/`,
or one explicitly:

```powershell
pwsh -File tools/publish-r2.ps1 -Bucket surra -BaseUrl https://updates.example.com
pwsh -File tools/publish-r2.ps1 -Platform linux -DryRun
```

It checks that `latest-linux.yml` names the AppImage, that the size matches and
that `SHA256SUMS.txt` has the AppImage's digest before uploading anything, then
re-downloads every object over HTTPS. The stable alias is `Suura.AppImage`, for
the same reason `Suura-Setup.exe` exists: one URL that survives releases.

An AppImage updates by being replaced on disk at quit, not by running an
installer, so "Restart and install" is already the honest wording. It only
works when the running file is writable; an AppImage started from a read-only
location must be updated by downloading the new one yourself.

The `.deb` is not part of the update feed: `dpkg` owns it, and electron-updater
does not replace it. Publish it on the releases page with its own checksum, and
let the package manager own upgrades. Its maintainer field is
`alphaq0099@users.noreply.github.com`, the only public address this project has.
The app knows the difference: a `.deb` install reports updates as unavailable
and names the package manager, rather than downloading a package it could not
install without root.

## What still has to be done

- [x] First build on Linux, and the self-test there. The first run found five
      Windows assumptions in the smoke suite and one real handler bug (a `..`
      path was resolved for the allowlist but not before `stat`), all fixed.
- [ ] Run it on a real desktop session with a sound device, and open the tag
      editor, the full-window player and the mini player.
- [x] `fpcalc` on Linux: a `.tar.gz` reader beside the ZIP one, and the pinned row. The member is extracted,
      `chmod 0755` applies like any other sidecar, and the smoke test installs a tar.gz asset end to end.
- [x] Media keys on Wayland: decided. They are not grabbed there, because a
      compositor owns the key and `globalShortcut` cannot take it; the app says so
      in its log and leaves the desktop's own routing alone. The XDG portal's
      GlobalShortcuts interface is the later upgrade, not a prerequisite.
- [x] Tray under GNOME: on Linux the app asks the session bus whether a
      StatusNotifier host exists before creating the icon. No host means no tray
      and close-to-tray stays off, instead of an invisible icon. A probe that
      cannot run counts as "cannot tell" and is allowed through.
- [x] Updates: `tools/publish-r2.ps1` publishes the AppImage, its blockmap,
      `latest-linux.yml` and the `Suura.AppImage` alias beside the Windows files,
      verifying the channel file and the checksum first. The Settings hint now
      names the Linux channel file, and the "Restart and install" wording was
      already true for a file that replaces itself at quit.
- [x] Packaging: a `.deb` target beside the AppImage, and the desktop file with
      the icon and categories. Both are built by `npm run package:linux` and by
      the Linux CI job; the `.deb` build has no `publish` config, so it carries no
      update metadata and the app says its updates come from the package manager.
- [ ] Docs and site: a Linux download with its own SHA-256, the FAQ's "Windows
      only" answer, and README's platform table.
- [x] CI: an `ubuntu-latest` job that installs ffmpeg and the Chromium libraries,
      builds, smokes and runs the self-test under Xvfb, packages the AppImage and
      the .deb, checks that `latest-linux.yml` names the AppImage but not the
      .deb, and reads the deb's file list to prove it carries no `app-update.yml`
      or `package-type`. `--no-sandbox` is passed to Electron there because the
      runner restricts user namespaces; it is a runner concession, not a shipped
      default.
- [ ] A Linux hardware pass, mirroring `windows.md`: GNOME/KDE, X11/Wayland,
      100–200% scaling, HiDPI, audio device switching, a 10k-track library.

## Verification checklist for a first build

1. The AppImage starts, and `~/.config/Suura` is created rather than a Windows
   path.
2. Add a music folder, scan, play MP3 and FLAC; pause, seek, next, previous.
3. Paste a YouTube link and play it; install the engine from the same callout and
   confirm `yt-dlp` and `ffmpeg` are executable (`ls -l`).
4. Tray icon appears (with AppIndicator installed); close-to-tray works or is
   refused cleanly.
5. Media keys work on X11; on Wayland, note what happens.
6. Turn on the sign-in switch, log out and back in: Suura starts. Turn it off:
   the desktop file is gone.
7. Save a track and confirm it lands in `~/Music/Suura`.
8. Point the feed at a local `npx http-server release` folder and run one update
   cycle with `latest-linux.yml`.
9. Install the `.deb` (`sudo apt install ./Suura-<version>.deb`), launch it from
   the menu, and confirm About says updates come through the package manager
   rather than offering a check.
