# Security policy

## Supported versions

Suura is a pre-release. Only the newest build is supported.

| Version | Supported |
|---|---|
| 0.1.x (latest release) | Yes |
| Anything older | No |

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private reporting: [Report a vulnerability](https://github.com/alphaq0099/Suura/security/advisories/new).
If that is unavailable, open a public issue that says only *"I would like to report a security issue privately"* and a
maintainer will arrange a channel.

Useful reports include:

- the Suura version (Settings → About), Windows version, and whether it is an installed or a source build;
- what an attacker gains, and what they need to start (a crafted media file, a malicious feed, a local user, …);
- reproduction steps or a proof of concept;
- whether the issue is already public anywhere.

Please give us a reasonable window to fix it before publishing details. We will credit you in the release notes unless
you ask us not to.

## What is in scope

- The Electron main process, preload bridge and renderer (`src/main`, `src/preload`, `src/renderer`).
- The custom protocols (`player-media://`, `player-art://`, `player-stream://`) — path traversal, range handling,
  header replay.
- The sidecar installer: download, SHA-256 verification, atomic replace, zip extraction
  (`src/engine/sidecar`).
- The updater: feed parsing, signature handling, and the rule that nothing installs without an explicit restart.
- Tag and lyrics writing, where a crafted file could corrupt data or escape the library folder.
- The database layer and migrations.
- Anything that sends data off the machine without the user asking.

## What is out of scope

- Vulnerabilities in `yt-dlp`, `ffmpeg` or `fpcalc`. Report those upstream; Suura only launches them.
- YouTube's terms of service, or the legality of downloading media. That is covered in the README under **Legal**.
- The SmartScreen warning on unsigned builds. That is a known, documented state — see `CODE_SIGNING.md`.
- Attacks that require an already-compromised machine, physical access, or administrator rights.
- Denial of service against your own library.

## What Suura does and does not send

Suura has no telemetry, no analytics and no update pings until a feed is configured. Network requests happen only for
actions you take: YouTube playback and search, artwork for streamed tracks, and the metadata/lyrics providers whose
buttons you press. Diagnostics and crash reports are written to local files and never uploaded.

## Disclosure

Fixes ship in the next release. Because Suura is unsigned, there is no separate security-only channel; the release
notes name the issue once a fix is available.
