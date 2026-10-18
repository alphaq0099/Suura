# ADR 0001 — Electron + TypeScript, and `node:sqlite` for storage

- **Status:** Accepted
- **Date:** 2026-10-16
- **Context:** M0.5 (framework skeleton + local-library thin slice). See `ROADMAP.md` §3, where this decision was deliberately deferred.

## Decision

Build the Windows application on **Electron + TypeScript + React**, and store the library in **SQLite via Node's built-in `node:sqlite`** rather than a native addon.

## Why

The stack choice was deferred until there was evidence. The evidence, gathered from this machine and from a working prototype:

| Finding | Consequence |
|---|---|
| Node 22.17 already installed; no Rust, no Flutter SDK, **no Visual Studio Build Tools** | Electron needs zero new toolchains. Rust would need ~300 MB of rustup; Flutter ~3 GB. More importantly, **no MSVC means no native compilation at all** |
| No MSVC ⇒ `better-sqlite3` cannot be built from source | Ruled out the conventional SQLite choice |
| `node:sqlite` ships in Node 22.17 **and** in Electron 44's Node 24.22, **with FTS5 working** (verified by `npm run runtime:check`) | SQLite with full-text search and *zero* native dependencies, and the same code runs in plain Node (which is what makes `tools/smoke.ts` possible) |
| `music-metadata` is ESM-only but publishes a `module-sync` export condition | Loadable from the CommonJS main bundle via dynamic `import()`. Verified inside Electron, not assumed |
| yt-dlp 2026.10.10 and ffmpeg are already installed (on this machine, `C:\Users\<user>\yt-dlp`) | The engine spike (roadmap §13) is unblocked before any engine code exists |

Alternatives rejected **for now**, not forever:

- **Tauri 2 + Rust** — a better Windows artifact (smaller, faster, native SMTC). Rejected because it adds a toolchain install before any user-visible progress, and the deferred decision left the core portable.
- **Flutter** — the only option giving one UI codebase for Windows *and* Android. Rejected because the Windows desktop story is weaker and it is a ~3 GB install.
- **WinUI 3 / .NET** — needs a .NET SDK install, and has the weakest Android path.

## Consequences

### Accepted costs

1. **Android will require rewriting the UI layer.** Electron has no Android target. This was already assumed in `ROADMAP.md` §7/M8: the engine layer gets replaced there anyway (yt-dlp is Python and cannot run on Android).
2. **`node:sqlite` is marked experimental** by Node. It emits an `ExperimentalWarning` and its API may change.
3. **Bundle size** — an Electron app ships Chromium. Roughly 150 MB installed versus ~15 MB for Tauri.
4. **`sandbox: false`** on the renderer, because the preload bundle is CommonJS. Flagged as an M7 hardening item.

### Mitigations that are already in the code

1. **The core does not import Electron.** `src/core/**` and `src/engine/**` are plain Node, which is why `tools/smoke.ts` can test scanning, the database, search, range parsing and file identity without a window. If the stack is revisited, this is the part that moves unchanged.
2. **SQLite is behind a driver interface.** `src/core/db/driver.ts` is the only file that mentions `node:sqlite`; swapping in `better-sqlite3` (once MSVC is available) is a one-file change. The parameter coercion and statement caching QA that would otherwise be duplicated is in there.
3. **The ESM dependency is behind one function.** `src/core/library/metadata.ts` is the only module that imports `music-metadata`.
4. **`IMediaResolver` exists from day one** (`src/engine/resolver.ts`), so the Android resolver is an implementation, not a refactor.

### Rules this decision imposes

- Do not import `electron` anywhere in `src/core/**` or `src/engine/**`.
- Do not add a dependency with a native build step without first confirming MSVC availability; the project currently has **no** way to compile one.
- Re-run `npm run runtime:check` after every Electron upgrade. It asserts the two bets above still hold.

## Evidence

```
$ npm run runtime:check
electron version : 44.8.0
node version     : 24.22.0
node:sqlite      : ok
sqlite FTS5      : ok
music-metadata   : ok (require)

$ npm run smoke     # 64 core checks, real files via ffmpeg
$ npm run selftest  # 23 end-to-end checks, includes real audio playback + seeking
```

## Revisit triggers

Revisit this ADR if any of these become true:

- Android becomes the priority ahead of Windows polish (→ reconsider Flutter, or plan the M8 rewrite).
- The installed size or memory footprint becomes a stated product requirement (→ Tauri).
- `node:sqlite` breaks in an Electron upgrade, or its API churn becomes costly (→ `better-sqlite3` behind the existing driver interface, or `sql.js`).
