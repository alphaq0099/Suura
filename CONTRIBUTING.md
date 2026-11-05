# Contributing to Suura

Thanks for wanting to help. Suura is a Windows desktop music player built with Electron, TypeScript and React. This
file covers the parts that are easy to get wrong: the build, the test gates, and the rules the architecture depends on.

## Before you start

- **Small fixes** (typos, a broken selector, a clearer error message): open a pull request directly.
- **Anything larger** (a new view, a settings section, a schema change, a new dependency): open an issue first so the
  design can be agreed before you spend a weekend on it.
- **Security issues** do not go in an issue or a pull request. See [`SECURITY.md`](./SECURITY.md).

## Requirements

| | |
|---|---|
| Windows | 10 or 11, 64-bit |
| Node.js | 22.12 or newer (24 recommended) |
| npm | ships with Node.js |
| `yt-dlp`, `ffmpeg` | only for the YouTube features and the smoke test |

No C++ compiler is needed, and that is deliberate: the project has no native modules (see
[`docs/adr/0001-stack-and-storage.md`](./docs/adr/0001-stack-and-storage.md)). Please do not add a dependency with a
native build step — `node:sqlite` is used for exactly that reason.

## Setup

```powershell
npm install
npm run dev
```

`npm run dev` starts the app with hot reload and uses the same data folder as the installed build.

## The gates

Run these before opening a pull request. CI runs the same commands on `windows-latest`.

```powershell
npm run build     # typecheck (node + web) and bundle into out/
npm run smoke     # core checks against real files; needs ffmpeg on PATH
npm run selftest  # end-to-end run of the real app; uses out/, so build first
npm run perf      # performance budgets on a synthetic 10,000-track library
```

A few things about them:

- `npm run selftest` launches the real app against a throwaway data directory and drives the UI. A first run on Windows
  can fail a few deferred-write checks while antivirus scans the new files; re-run once before assuming a regression.
- `npm run perf` measures against fixed budgets and exits non-zero, naming the metric that missed. Do not relax a
  budget to make a change pass — either fix the change or explain why the budget was wrong.
- **Never weaken a test to get green.** Deleting a check, loosening an assertion or skipping a case is a review blocker.
- After an Electron upgrade, run `npm run runtime:check`. It re-asserts the two bets the storage layer rests on:
  `node:sqlite` with FTS5, and `music-metadata` loading through `require`.

## House rules

These come from [`docs/adr/0001-stack-and-storage.md`](./docs/adr/0001-stack-and-storage.md) and the milestones, and
they are what keep the core portable:

- **No `electron` import in `src/core/**` or `src/engine/**`.** Those layers are plain Node so `tools/smoke.ts` can
  test them without a window.
- **SQLite only through `src/core/db/driver.ts`.** Nothing else should mention `node:sqlite`.
- **Migrations are append-only.** Add a new numbered migration; never edit one that has shipped.
- **IPC is typed.** Add the channel to `src/shared/ipc.ts` and keep the preload surface minimal.
- **The renderer is sandboxed.** Do not widen the preload bridge without a reason recorded in the pull request.
- **No telemetry, no remote logging.** Diagnostics and crash reports stay local files.
- **Never overwrite a tag, lyric or setting the user did not touch.** Blanking is an explicit action.
- **Machine-readable identifiers are stable:** `player-backup`, `player-restore`, `player-playlist`, `player-media://`,
  `player-art://`, `player-stream://`, `window.player`, `player:last-view`, `player.appearance.v1`,
  `PLAYER_SKIP_ENGINE_UPDATE`.

## Style

There is no formatter config in the repository; match the file you are editing.

- TypeScript strict mode, no `any` unless it is genuinely unknown input being validated.
- Two-space indent, single quotes, no semicolons, ~120 columns.
- Comments explain *why* — a constraint, a workaround, a decision — not what the next line does.
- User-facing strings are sentence case, say what happened and what to do next, and avoid internal vocabulary
  (`sidecar`, `resolver`, `IPC`, `provenance`). Settings tooltips stay under 100 characters.
- UI changes need keyboard access, visible focus, and a check at the minimum window size (940×580) with extra-large
  text. The self-test has sections for both; extend them rather than testing by eye only.

## Commits and pull requests

- One logical change per commit. Subject in the imperative mood, roughly 50–72 characters, no trailing period.
- The body says why the change is needed and what it trades away. If it fixes an issue, reference it.
- Do not bump the version in `package.json`; releases do that.
- UI changes: include a before/after screenshot in the pull request. Do not commit screenshots to the repository.
- Do not commit `testreport.txt`, `*.png` from a real library, `release/`, `out/`, or anything in `docs/internal/` that
  is machine-specific.

## Documentation

- [`README.md`](./README.md) is for users. Keep it accurate: if a control moves, the README moves with it.
- [`docs/development.md`](./docs/development.md) is for contributors: architecture, test suite, project layout.
- [`ROADMAP.md`](./ROADMAP.md) is the plan and milestone state.
- [`docs/release/windows.md`](./docs/release/windows.md) is the packaging and release checklist.
- [`docs/internal/`](./docs/internal/) holds working notes and measurement records. They are not documentation; do not
  link to them from user-facing pages.

## Licence

Suura is MIT-licensed. By contributing you agree that your work is published under the same licence.
