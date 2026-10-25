# Windows release build

The installer is built with **electron-builder** and is per-user: it installs
under `%LOCALAPPDATA%\Programs\Player` and never asks for administrator rights.

## Build

```powershell
npm ci
npm run typecheck
npm run smoke
npm run runtime:check
npm run package:dir
npm run package:win
```

`package:dir` writes an unpacked application to `release/win-unpacked/`. Use it
to test the packaged main/preload bundles without building an installer.
`package:win` writes the NSIS installer to `release/`.

The Windows icon is generated from `tools/make-icon.ps1` into
`build/icon.png` and `build/icon.ico`. Run `npm run icon` after changing the
artwork; the generated files are committed so a build does not need PowerShell
drawing support.

## What the installer does

- Installs for the current user only, with no elevation prompt.
- Creates a Start-menu entry and a desktop shortcut.
- Lets the user choose the installation directory.
- Runs the app after a successful install unless the user clears that box.
- Uninstalling asks, **defaulting to No**, whether to delete the app data
  directory (`%APPDATA%\Player`). Choosing Yes removes the database, settings,
  logs, backups and caches. Music saved into `Music\Player` is never deleted by
  the uninstaller.

## Signing and SmartScreen

Unsigned installers work, but Windows SmartScreen may show *Windows protected
your PC*. For a public release, sign the installer and the executable with a
code-signing certificate. electron-builder reads the standard environment
variables:

```powershell
$env:CSC_LINK = 'C:\secure\player-signing.pfx'
$env:CSC_KEY_PASSWORD = '...'
npm run package:win
```

Never commit the certificate or its password. If no certificate is available,
publish the SHA-256 checksum of the installer beside it and document the
SmartScreen “More info → Run anyway” path; this is a temporary workaround, not
a substitute for signing.

## Diagnostics

**Settings → About → Save diagnostics** writes a plain-text bundle to a
user-chosen file. It contains the app and runtime versions, platform, app paths,
library-folder count, user agent, and the last 256 KB of
`%APPDATA%\Player\logs\player.log`. It is local and user-initiated: no crash
reporting service is configured and nothing is uploaded. Ask users to review the
file before sharing it, because log lines can contain local library paths.

**Copy diagnostics** remains the shorter clipboard-only snapshot without log
lines.

## Sidecars

The packaged app does **not** bundle `yt-dlp` or `ffmpeg` yet. The engine probes
`PATH`, the configured binary folder and a few well-known locations. A clean
machine with neither binary can still use the local library, but YouTube
playback and saving need both. Until sidecar packaging lands, the release notes
must say so and Settings → Streaming must be pointed at the folder that holds
them.

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
- Run the packaged self-test and require exit code 0:

  ```powershell
  $p = Start-Process .\release\win-unpacked\Player.exe -ArgumentList '--selftest' -Wait -PassThru
  $p.ExitCode
  ```

  Use `Start-Process -Wait`; PowerShell does not wait for a GUI executable
  started with `&`.
- Re-run `npm run smoke`, `npm run build` and `npm run selftest` from the
  repository before publishing.
