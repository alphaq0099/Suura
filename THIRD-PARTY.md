# Third-party notices

Suura itself is MIT-licensed (see [`LICENSE`](./LICENSE)). It is built on, and
runs alongside, the software below. These are notices, not a change to Suura's
licence.

## Bundled with the app

| Component | Licence | Notes |
|---|---|---|
| [Electron](https://github.com/electron/electron) | MIT | Runtime |
| [Chromium](https://www.chromium.org/) | BSD-3-Clause and others | Ships inside Electron |
| [Node.js](https://nodejs.org/) | MIT | Ships inside Electron |
| [React](https://react.dev/) / [React DOM](https://react.dev/) | MIT | Renderer |
| [music-metadata](https://github.com/Borewit/music-metadata) | MIT | Tag and duration reading |
| [node-id3](https://github.com/Zazama/node-id3) | MIT | MP3 lyrics and comment frames |
| [Inter](https://github.com/rsms/inter) via `@fontsource-variable/inter` | SIL OFL 1.1 | Bundled typeface |
| [electron-updater](https://github.com/electron-userland/electron-builder) | MIT | Update channel |

Electron's own distribution includes the full Chromium licence file; after
installing Suura it is at `resources/eula.html` inside the application folder.

## Downloaded on request, not bundled

Suura's installer contains no media engine. The engine is fetched from its
upstream release page, verified against a pinned SHA-256, and run as a separate
program:

| Component | Licence | Notes |
|---|---|---|
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Unlicense | Resolves and downloads YouTube audio |
| [ffmpeg](https://ffmpeg.org/) (build: `eugeneware/ffmpeg-static` b6.1.1) | **GPL-3.0-or-later** | Transcoding, muxing, tag writing |
| [Chromaprint / fpcalc](https://github.com/acoustid/chromaprint) | LGPL-2.1-or-later | Optional audio fingerprinting |

The ffmpeg build is a separate executable that Suura calls; it is not linked
into Suura's own code. If you redistribute Suura together with that binary, the
GPL's terms apply to the binary and to the combined distribution — check them
before shipping a bundle. The default build downloads it on the user's machine
instead.

## Not affiliated

Suura is not affiliated with, endorsed by, or supported by YouTube, Google,
AcoustID, MusicBrainz or any of the projects above. Downloading media may
breach YouTube's Terms of Service and copyright law where you live; that is the
user's decision and responsibility.
