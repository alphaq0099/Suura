# Windows release build

The installer is built with **electron-builder** and is per-user: it installs
under `%LOCALAPPDATA%\Programs\Suura` and never asks for administrator rights.

## Build

```powershell
npm ci
npm run typecheck
npm run smoke
npm run perf
npm run runtime:check
npm run package:dir
npm run package:win
```

`package:dir` writes an unpacked application to `release/win-unpacked/`. Use it
to test the packaged main/preload bundles without building an installer.
`package:win` writes the NSIS installer to `release/`, together with the update
channel file (`latest.yml`, or `beta.yml` when `package.json` holds a
pre-release version such as `0.2.0-beta.1`). `electron-builder.yml` declares a
generic publish provider so that file is always generated; nothing is uploaded
unless `--publish` is passed explicitly.

The icon set is generated from the master artwork at `build/icon-source.png` by
`tools/make-icon.ps1` into `build/icon.png`, `build/icon.ico` and the embedded
tray bitmap in `src/main/tray-icon.ts`. Replace the master and run `npm run
icon` after changing the artwork; the generated files are committed so a build
does not need PowerShell drawing support.

## What the installer does

- Installs for the current user only, with no elevation prompt.
- Creates a Start-menu entry and a desktop shortcut.
- Lets the user choose the installation directory.
- Runs the app after a successful install unless the user clears that box.
- Ships no engine binaries: `yt-dlp`, `ffmpeg` and the optional `fpcalc` are
  downloaded on first use from the **YouTube** view (or **Settings → Streaming**)
  into `%APPDATA%\Suura\engine`.
- Uninstalling asks, **defaulting to No**, whether to delete the app data
  directory (`%APPDATA%\Suura`). Choosing Yes removes the database, settings,
  logs, backups and caches. Music saved into `Music\Suura` is never deleted by
  the uninstaller.

## Signing and SmartScreen

Public builds are **unsigned** until a certificate exists; the policy, the
SignPath application and what would change are in
[`CODE_SIGNING.md`](../../CODE_SIGNING.md). SmartScreen therefore warns on a
downloaded installer, and the README documents the *More info → Run anyway*
path. Publish `SHA256SUMS.txt` beside the installer so a download can at least
be proved intact.

When a certificate becomes available, electron-builder reads the standard
environment variables:

```powershell
$env:CSC_LINK = 'C:\secure\suura-signing.pfx'
$env:CSC_KEY_PASSWORD = '...'
npm run package:win
```

Never commit the certificate or its password. CI-signed builds are the only
builds that may ship once signing is in place — a local signing pass is for
testing the pipeline, not for a release.

## Publishing a release

The order matters: the installer, the channel file and the checksum must all
come from the same `package:win` run, on the same commit that is tagged.

1. Bump `version` in `package.json` as the final commit before the tag. That
   value becomes the installer name, the channel file's `version` and About.
2. Run every gate above, then `npm run package:win`.
3. Write `SHA256SUMS.txt` beside the installer. Uppercase hex matches what
   `Get-FileHash` prints, so a reader can compare by eye:

   ```powershell
   Get-FileHash .\release\Suura-0.1.0-Setup.exe -Algorithm SHA256 |
     ForEach-Object { "$($_.Hash)  Suura-0.1.0-Setup.exe" } |
     Set-Content .\release\SHA256SUMS.txt -Encoding ascii
   ```

4. Tag the commit and create the GitHub release from it. Attach
   `Suura-<version>-Setup.exe`, `Suura-<version>-Setup.exe.blockmap`,
   `latest.yml` (or `beta.yml`) and `SHA256SUMS.txt`. The README links to the
   newest release, so the release has to exist before the repository is made
   public with that text.
5. Optional mirror: copy the same four files into the feed folder on a static
   host (Cloudflare R2, S3, any HTTPS server) and point **Settings → About →
   Feed folder** at it. Nothing else is required — the updater reads
   `latest.yml` and the installer it names, both relative to that folder.

Do not attach `release/win-unpacked/`, and do not rebuild after tagging: a
channel file that names one installer while another is attached is exactly the
kind of mismatch the updater is designed to reject.

## App updates

The app updates from a **static HTTPS folder**: no update server is required.
Any host that serves files unchanged works (S3, a web server, a CDN). The
folder is configured in **Settings → About → Feed folder**; until a URL is
entered the updater is dormant and About says *Not configured*.

A published folder holds, for each channel:

```text
https://updates.example.com/suura/
  latest.yml                       stable channel file
  beta.yml                         beta channel file
  Suura-0.1.0-Setup.exe            installer
  Suura-0.1.0-Setup.exe.blockmap   differential download
```

- **Stable** reads `latest.yml`; **Beta** reads `beta.yml`. A pre-release
  version makes electron-builder write `beta.yml`, so promoting a build to
  stable means publishing a stable-versioned build and its `latest.yml`.
- Keep the channel file, installer and blockmap together in one folder, and
  regenerate all three from the same `package:win` run. `latest.yml` carries
  the installer's size and SHA-512; a hand-edited or stale file is rejected.
- Signing is unchanged: if `CSC_LINK` was set when packaging, the installer and
  the app executable are signed, and the update is verified against that
  signature before it is installed.

The app never downloads or installs behind the user's back. **Check now** finds
a version, **Download update** fetches it (with progress), and **Restart and
install** is the only action that quits. When **Check once a day in the
background** is on, an installed build checks once per 24 h after a 30 s
settle; the check is package-only and still waits for the user to download.

Local testing without a host is possible with any static file server pointed at
`release/`, for example:

```powershell
npx http-server release -p 8080
```

then set the feed to `http://localhost:8080` in About. HTTP is only accepted
for localhost; every other feed must be `https://`.

## yt-dlp rollback

The daily `yt-dlp -U` can also ship a broken extractor. Before updating, the app
copies the working managed binary to `yt-dlp.previous.exe` and writes
`yt-dlp.previous.json` next to it in `%APPDATA%\Suura\engine`. The updated
binary is then checked with `--version`; if it will not start, or the update
itself fails, the saved copy is restored. Three extractor failures inside ten
minutes also trigger one automatic restore (with a 30-minute cooldown) — three
such failures in that window are not a flaky video. **Settings → Streaming →
Previous yt-dlp → Restore previous** does the same by hand.

A fresh pinned engine download clears the fallback, because it must not outlive
the install it came from. The file is a plain copy rather than an archive so a
restore still works when the new binary cannot start.

## Diagnostics

**Settings → About → Save diagnostics** writes a plain-text bundle to a
user-chosen file. It contains the app and runtime versions, platform, app paths,
library-folder count, user agent, and the last 256 KB of
`%APPDATA%\Suura\logs\suura.log`. It is local and user-initiated, and nothing is
uploaded. **Settings → Misc → Crash reports** is a separate opt-in switch: it
writes small JSON reports under `%APPDATA%\Suura\crashes`, which can be exported
or cleared from the same card. No remote crash service is configured; the only
way a crash report leaves the machine is if the user exports and shares it. Ask
users to review either file before sharing it, because log lines and stack
traces can contain local library paths.

**Copy diagnostics** remains the shorter clipboard-only snapshot without log
lines.

## Sidecars

The installer ships **no** engine binaries. `yt-dlp`, `ffmpeg` and the optional
`fpcalc` are fetched on first use into `%APPDATA%\Suura\engine`, so the download
stays small and the app does not redistribute ffmpeg.

Each asset is pinned in `src/engine/sidecar/manifest.ts` by version, exact byte
count and SHA-256. A download is written to a temporary file, checked against the
pinned digest and size, then renamed into place; a mismatch is deleted and
reported, never installed. `install-record.json` in that folder records what was
installed. The versions and licences are:

| Asset | Version | Licence |
|---|---|---|
| `yt-dlp` | 2026.10.26 | Unlicense |
| `ffmpeg` (ffmpeg-static b6.1.1) | 6.1.1 | GPL-3.0-or-later |
| `fpcalc` (optional) | 1.6.2 | LGPL-2.1-or-later |

The engine probes the configured folder first, then `%APPDATA%\Suura\engine`,
then `PATH` and the usual install locations. A machine with an existing copy
keeps working offline; **Settings → Streaming** shows each file, downloads the
missing ones with progress and Cancel, and treats `fpcalc` as optional because
only fingerprinting needs it.

When publishing, confirm the pinned URLs still resolve to the same bytes: the
digests are the whole provenance story. If an upstream release is withdrawn,
bump the version and digest in `manifest.ts` rather than loosening the check.

## Display and scaling

Windows sizes windows in device-independent pixels, so scaling does not change
the CSS viewport: a 4K panel at 200% reports roughly the same 1920x1080 CSS
pixels as a 1080p panel at 100%. What changes is how many device pixels sit
behind each CSS pixel. Layout and sharpness are therefore separate checks.

**Layout.** The window opens at 1200x780 and cannot be narrowed below 940x580.
Every view must fit at that minimum, including the `Extra large` text setting
(`--text-scale: 1.3`), which multiplies every label and caption by 1.3. The
responsive breakpoints (1120, 1150 and 900 px) fold card grids to one column and
drop table columns; they are CSS pixels, so they behave identically at every
scaling level. `npm run selftest` now repeats the fit checks for all six views
and the full-window player at 940x580 with extra-large text.

**Sharpness.** Cached covers are capped at 1280px on their longest edge. The
largest cover the UI draws is the full-window player's artwork, up to 624 CSS px
at the extra-large artwork preset; at 200% scaling that needs 1248 device
pixels, which the cap covers. Smaller embedded covers are stored at their own
size and never enlarged. The cache key is a content hash, so a cover cached at
the old 512px cap would otherwise live forever: schema migration 18 clears the
recorded keys, and the first view of each album re-extracts it at the new cap.
Old files stay in `%APPDATA%\Suura\cache\artwork` until that folder is cleaned
up by hand; deleting them is safe, since the keys point at the new files.
YouTube thumbnails go through the same cap; imported playlist covers keep the
size they were cached at until the playlist is imported again, which is invisible
at the list-card size they are drawn at.

**Multiple monitors.** The window is created on the primary display and
Chromium follows per-monitor DPI changes while it is dragged. The mini player
centres on the display that owns the current window bounds, and when it closes
it restores the saved normal rectangle through `clampToWorkArea`, so a monitor
unplugged while the mini player was up cannot strand the window off-screen.
Normal bounds are not persisted across restarts, so a relaunch after unplugging
a display opens on the remaining one.

Check this on real hardware; the automated pass cannot change the device pixel
ratio or emulate unplugging a monitor.

## Verification checklist

- Install as a standard user with no UAC prompt; launch from the shortcut.
- Confirm the installed app opens a library and plays a local file.
- Confirm **Settings → About** shows the packaged version and Copy diagnostics
  includes the log path.
- Confirm **Save diagnostics** writes a text file and that it includes the recent
  log lines. The file may include local library paths; do not attach it without
  reviewing it.
- Confirm the installer's uninstall entry resolves and that uninstall defaults
  to keeping app data.
- Confirm `npm run package:win` leaves `release/latest.yml` beside the
  installer (or `beta.yml` for a pre-release version), and that the file names
  the same installer.
- On an installed build, set **Settings → About → Feed folder** to the static
  folder, press **Check now**, then **Download update**, then **Restart and
  install**; confirm the version changes and the library is untouched. With no
  feed set, confirm About says *Not configured* and no request is made.
- Update yt-dlp once from Settings → Streaming, confirm
  `%APPDATA%\Suura\engine\yt-dlp.previous.exe` appears, then press
  **Restore previous** and confirm extraction works again and the saved copy is
  consumed. A fresh engine download must leave no `yt-dlp.previous.*` files.
- On a clean profile with no `yt-dlp`/`ffmpeg` on `PATH`, open Settings →
  Streaming, download the engine files, and confirm the progress bar, Cancel,
  and that `%APPDATA%\Suura\engine` now holds `yt-dlp.exe` and `ffmpeg.exe`.
  Then play a YouTube link and save one track. Remove the folder and confirm
  the app reports the files as missing instead of crashing.
- **Windows 10 and Windows 11**, each at 100%, 125%, 150% and 200%: resize the
  window down to 940x580 and confirm no view gains a horizontal scrollbar;
  switch to **Extra large** text and repeat Home, Library, Search, Settings,
  Queue, YouTube and the full-window player.
- **4K at 150% and 200%**: open an album's largest cover in the full-window
  player at the **Extra large** artwork preset and confirm it is sharp. The
  matching file in `%APPDATA%\Suura\cache\artwork` should be up to 1280px on its
  long edge, or match a smaller embedded source; a 512px file means the
  migration did not run or the cache was not regenerated.
- **Two monitors with different scaling**: drag the window between them and
  confirm text, dialogs and the full-window player stay legible and on-screen;
  enter the mini player on the secondary display, close it, and confirm the
  normal window returns to the same place. Unplug the secondary display while
  the mini player is up, then close it: the window must appear on the remaining
  display.
- **High contrast**: with a Windows high-contrast theme, confirm the current
  sidebar row, selected list rows and focused controls use the system
  `Highlight` and `ButtonText` colours and remain readable.
- Run the packaged self-test and require exit code 0:

  ```powershell
  $p = Start-Process .\release\win-unpacked\Suura.exe -ArgumentList '--selftest' -Wait -PassThru
  $p.ExitCode
  ```

  Use `Start-Process -Wait`; PowerShell does not wait for a GUI executable
  started with `&`.
- Re-run `npm run smoke`, `npm run build` and `npm run selftest` from the
  repository before publishing.
