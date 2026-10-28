# yt-dlp sidecar spike

**Date:** 2026-10-19 · **Goal:** find out what resolving a YouTube track actually costs before M3 is designed around it.

## Environment

- Windows, 8 GB RAM, yt-dlp `2026.10.10.233141`, ffmpeg `2025-10-21` (gyan build), deno 2.5.4 for JS challenges.
- One public video: `jNQXAC9IVRw` ("Me at the zoo", 19 s). No download, only URL/metadata resolution.
- Timings are wall-clock `--get-url` runs, process included.

## Results

| What | Time |
|---|---|
| `yt-dlp --version` (process startup alone) | 1.7 / 2.6 / 2.6 s |
| Resolve, default settings, user's `yt-dlp.conf` | 10.8 / 11.0 / 11.3 s |
| Resolve, `--ignore-config` | 8.3 / 8.8 s |
| `--ignore-config`, `player_client=web_embedded` | 7.1 / 9.0 s |
| `--ignore-config`, `player_client=mweb` | 10.6 s |
| `--ignore-config`, `player_client=android_vr` | 4.5 / 4.8 s |
| `--ignore-config`, `player_client=tv` or `web` | fails (exit 1) |
| Unavailable video | ~6.3 s to fail |

The `android_vr` shortcut is not usable for a music player: it returns **one muxed format**, so there is no audio-only
stream and playback would pull video bytes. Everything else that returns audio-only costs 7–11 s here, of which 2–2.5 s is
process startup.

**Streaming works from the resolved URL**, with the headers yt-dlp reports:

```
Range: bytes=0-65535 + User-Agent  ->  206, audio/mp4, 65536 bytes
no Range                          ->  200
```

The URL is signed, IP-bound and expires (`expire=…` in the query), so it cannot be handed to the media element
directly — the proxy already planned for M3 is required rather than convenient.

## Findings that change the plan

1. **`--ignore-config` is mandatory.** This machine's `~/.yt-dlp.conf` applies `--cookies-from-browser firefox`, a download
   archive, subtitle downloads and output templates to every call. A sidecar that inherits it is slower and does things
   the app never asked for.
2. **The 3 s first-audio target is not reachable with a cold CLI call here.** Even the fastest audio-only path is 7 s,
   and process startup alone is over half the budget at best. Options, in order of preference:
   - resolve when the track is *chosen*, not when play is pressed (a hover/selection prefetch hides most of it, but
     each one is a full extraction: nine hover prefetches in a minute triggered the bot-check discussion, so this is
     not safe without a strict cap and working PO tokens);
   - keep resolved URLs for the session and re-resolve on `403` (already the retention design);
   - re-measure on the target machine and revise the roadmap number rather than pretending 3 s was met.
3. **Do not pin `player_client`.** The fast client loses audio-only formats; the pinned ones that would be acceptable fail
   outright. Keep yt-dlp's default chain, which is also what its maintainers test.
4. **Failures are slow too** (~6 s), so the UI needs a cancel that kills the child process, and a hard timeout (~20 s)
   rather than waiting for yt-dlp's own retries.
5. **Forward all of `http_headers`**, not just the User-Agent: the response includes `Accept`, `Accept-Language` and
   `Sec-Fetch-Mode` and googlevideo is entitled to check them.

## What was left for M3

The roadmap box asks for a success rate over 20 representative videos. This spike used one, plus client variants, which
was enough to price the architecture but not enough to quote a success rate.

That sample has since been run: [`yt-dlp-sample.md`](./yt-dlp-sample.md) records 20/20 resolves (median 8.8 s) and the
format, header and range evidence behind the resolver. The 50-link M3 exit check is still open.
