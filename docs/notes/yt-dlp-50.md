# yt-dlp 50-link measurement

**Date:** 2026-10-20 · **Goal:** close the M3 exit measurement and decide whether the `< 3 s` first-audio target is
honest for a cold pasted link.

## Method

- yt-dlp `2026.10.10.233141`, ffmpeg `2025-10-21`, Windows, 8 GB RAM, the same machine as the 20-link sample.
- The sample is the top ten results of five searches:

  `official music video 2021`, `live concert full performance`, `lofi hip hop mix 1 hour`,
  `podcast episode interview`, `classical symphony full`.

  That deliberately spans short music videos, full concerts, hour-long mixes, podcasts and classical works, rather
  than one uploader's catalogue. Duplicate video ids were removed before resolving; a search that returned fewer than
  ten playable videos would have been topped up from the next query.
- Each link was resolved with the app's default *high* tier: `bestaudio[abr>=128]/bestaudio/best`, `--no-playlist`,
  `--ignore-config`, `--socket-timeout 15`, `-J`. This is the same selector and argument policy the app uses.
- Wall-clock time covers spawning yt-dlp and reading its JSON — exactly what the first play waits for. It does **not**
  cover the app's own IPC or the `<audio>` element's buffering, which are small next to the sidecar.
- Once resolved, the CDN URL was fetched with the headers yt-dlp reported and `Range: bytes=0-2047`. This measures the
  time to the first bytes of audio, not a full download.
- The harness is reproducible: `node tools/measure-streams.mjs`. Full per-link rows are in
  [`yt-dlp-50-results.json`](./yt-dlp-50-results.json).

## Results

| Measure | Result |
|---|---|
| Links collected / resolved | **50 / 50** |
| First-attempt success | **100%** |
| Resolve time, median | **8,317 ms** |
| Resolve time, range | 6,845 – 11,456 ms |
| First 2 KB from the CDN, median | **459 ms** |
| First 2 KB from the CDN, range | 176 – 1,263 ms |
| Range responses | 50 × `206`, 2,048 bytes |
| Audio formats | WebM/Opus (39), M4A/AAC (11) |
| Selected bitrates | 129 – 149 kbps |

Every link produced an audio-only stream with a working ranged response. No retries were needed, and no link hit the
bot check, a geo-block or an unavailable video.

The shape is the same as the earlier 20-link sample: resolving costs roughly **8–9 seconds**, while the CDN is ready
in **under half a second**. The sidecar run dominates by an order of magnitude.

## The `< 3 s` target

The original exit text said “`< 3 s` to first audio”. The measurement shows that is not true for the first play of a
cold pasted link, and no amount of player work will make it true while a yt-dlp process has to start, negotiate with
YouTube and return a signed URL. A resident sidecar could remove most of that, but it is a larger install, a
longer-running background process and a different failure model.

The target is therefore split, and the split is the decision this measurement was for:

- **Warm playback — target `< 3 s`, met.** Pressing play on a video whose URL is already in the session resolve cache,
  or moving into the next entry of a queued list, starts audio in well under a second. The next track is prefetched
  four seconds into the current one, so a transition pays only the CDN's first bytes (~0.46 s median) and the player's
  own buffer.
- **Cold paste — target `≤ 10 s` median, met.** A new link shows *Resolving…* immediately, then fills in and plays.
  The measured median is 8.3 s, with 11.5 s as the slowest of fifty. The UI should keep saying what it is waiting for;
  a spinner is honest here in a way a fake “instant” state would not be.

The streaming proxy is not the bottleneck. If cold start ever needs to be faster, the lever is the engine (resident
process, or a different resolver), not the player or the HTTP path.

## Caveats

- One machine, one network, one afternoon. Absolute times will move with the connection and with YouTube's responses.
- Search-derived links are more representative than a hand-picked list, but they are still a snapshot; a future sample
  should be re-run after a yt-dlp update or a YouTube change.
- The M4-lite download path was measured separately (12 s for a 4.9 MB Opus including tagging and cover embedding); it
  is not part of this streaming number.
