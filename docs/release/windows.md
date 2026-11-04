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

The Windows icon is generated from `tools/make-icon.ps1` into
`build/icon.png` and `build/icon.ico`. Run `npm run icon` after changing the
artwork; the generated files are committed so a build does not need PowerShell
drawing support.

## What the installer does

- Installs for the current user only, with no elevation prompt.
- Creates a Start-menu entry and a desktop shortcut.
- Lets the user choose the installation directory.
- Runs the app after a successful install unless the user clears that box.
- Ships no engine binaries: `yt-dlp`, `ffmpeg` and the optional `fpcalc` are
  downloaded from Settings → Streaming into `%APPDATA%\Suura\engine` on first
  use.
- Uninstalling asks, **defaulting to No**, whether to delete the app data
  directory (`%APPDATA%\Suura`). Choosing Yes removes the database, settings,
  logs, backups and caches. Music saved into `Music\Suura` is never deleted by
  the uninstaller.

## Signing and SmartScreen

Unsigned installers work, but Windows SmartScreen may show *Windows protected
your PC*. For a public release, sign the installer and the executable with a
code-signing certificate. electron-builder reads the standard environment
variables:

```powershell
$env:CSC_LINK = 'C:\secure\suura-signing.pfx'
$env:CSC_KEY_PASSWORD = '...'
npm run package:win
```

Never commit the certificate or its password. If no certificate is available,
publish the SHA-256 checksum of the installer beside it and document the
SmartScreen “More info → Run anyway” path; this is a temporary workaround, not
a substitute for signing.

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
- Run the packaged self-test and require exit code 0:

  ```powershell
  $p = Start-Process .\release\win-unpacked\Suura.exe -ArgumentList '--selftest' -Wait -PassThru
  $p.ExitCode
  ```

  Use `Start-Process -Wait`; PowerShell does not wait for a GUI executable
  started with `&`.
- Re-run `npm run smoke`, `npm run build` and `npm run selftest` from the
  repository before publishing.
