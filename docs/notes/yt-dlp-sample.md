# yt-dlp 20-link sample

**Date:** 2026-10-19 · **Goal:** turn the spike's single-link timing into a success rate and a format/header baseline
before M3's resolver was wired to the UI.

## Method

- yt-dlp `2026.10.10.233141`, ffmpeg `2025-10-21`, Windows, 8 GB RAM.
- The 20 links were the top four results of five searches (`official music video 2021`, `live concert full
  performance`, `lofi hip hop mix 1 hour`, `podcast episode interview`, `classical symphony full`), so the sample spans
  short music videos, long concerts, mixes, podcasts and classical works instead of one uploader's catalogue.
- Every resolve used `-f bestaudio/best`. The app's default *high* tier first asks for `bestaudio[abr>=128]` and falls
  back to `bestaudio/best`; on all 20 links both end at the same Opus/WebM stream, so these timings and formats apply to
  the app's default too.

  ```
  yt-dlp --ignore-config --no-playlist --socket-timeout 15 -f bestaudio/best -J <watch url>
  ```

  `--ignore-config` matters on this machine: `~/.yt-dlp.conf` adds cookies, an archive file, subtitle options and output
  templates.
- Each returned URL was then requested with `curl -r 0-1023` using exactly the `http_headers` yt-dlp returned.

## Results

**20/20 resolved.** Median **8.8 s**, minimum 7.1 s, maximum 10.2 s.

| # | Title (short) | Length | Format | kbps | Resolve |
|---|---|---|---|---|---|
| 1 | Bella Poarch — Build a B*tch | 2:50 | webm/opus 251 | 131 | 9.5 s |
| 2 | VALORANT — Die For You | 3:38 | webm/opus 251 | 127 | 8.1 s |
| 3 | Anupam Roy — Mrigonabhi | 4:58 | webm/opus 251 | 143 | 9.1 s |
| 4 | Marshmello × Jonas Brothers — Leave Before You Love Me | 2:45 | webm/opus 251 | 130 | 9.1 s |
| 5 | Anupam Roy — full concert, Balurghat | 91:13 | webm/opus 251 | 134 | 8.4 s |
| 6 | BTS live fancam, day 2 | 18:04 | webm/opus 251 | 123 | 8.9 s |
| 7 | Tyla — full live concert, Brixton | 99:09 | webm/opus 251 | 129 | 9.8 s |
| 8 | BTS live fancam, day 3 | 18:46 | webm/opus 251 | 124 | 7.4 s |
| 9 | Lofi Girl — 1 A.M. study session | 61:14 | webm/opus 251 | 140 | 9.2 s |
| 10 | One lofi — one hour of pure lofi | 63:55 | webm/opus 251 | 134 | 8.8 s |
| 11 | Lofi Girl — lofi hip hop mix, part 1 | 170:40 | webm/opus 251 | 141 | 8.9 s |
| 12 | Settle — chill lofi mix | 104:52 | webm/opus 251 | 140 | 7.5 s |
| 13 | Raj Shamani — Death Investigator | 130:25 | webm/opus 251-1* | 112 | 8.8 s |
| 14 | Raj Shamani — Vijay Mallya | 258:48 | webm/opus 251 | 109 | 7.7 s |
| 15 | Shubhankar Mishra — Unplugged | 78:27 | webm/opus 251-4* | 116 | 9.2 s |
| 16 | Ranveer Allahbadia — Ekta Kapoor | 53:05 | webm/opus 251-4* | 109 | 10.2 s |
| 17 | Oslo Philharmonic — Rachmaninoff 2 | 61:21 | webm/opus 251 | 131 | 7.3 s |
| 18 | Classical Symphony Music — best of | 213:50 | webm/opus 251 | 138 | 8.8 s |
| 19 | DW Classical — Beethoven 9 | 67:39 | webm/opus 251 | 135 | 8.3 s |
| 20 | DW Classical — Beethoven 7 | 41:51 | webm/opus 251 | 134 | 7.1 s |

\* Three of the long podcasts resolved a numbered variant of 251; the protocol was still `https` and the codec the same.

Every one:

- selected an Opus/WebM audio stream (format **251**, or a numbered variant of it on three videos), 48 kHz,
- had a **direct `url`** at the top level and no `requested_formats`, so nothing needed muxing or ffmpeg,
- returned `http_headers` with `User-Agent`, `Accept`, `Accept-Language` and `Sec-Fetch-Mode`,
- answered the byte-range request with **`206` and 1024 bytes** in about half a second.

## What this changed

1. **An audio-only selector is right.** All 20 had an audio-only stream; the `/best` fallback is for the small minority
   that only offers a muxed file. The app's default `high` tier prefers ≥128 kbps and drops to `bestaudio/best` for the
   rest, which is exactly the fallback this sample exercised.
2. **The proxy is mandatory, not a convenience.** The CDN requires the headers yt-dlp reported, and the URL expires
   (the first probe's `expire` was about six hours out). Handing the URL to the renderer would work until it didn't.
3. **Process startup is not the problem.** The spike measured 1.7–2.6 s just to start yt-dlp; the remaining 5–7 s is
   extraction and network. A resident sidecar would help, but on its own it would not reach the M3 exit target of
   “< 3 s to first audio”.
4. **Prefetch is the useful lever.** The app resolves when the link is pasted, so pressing Play is a cache hit. In the
   app probe below, the second resolve took **1 ms**.
5. **The 8.8 s is wall-clock from paste.** If M3's exit criterion is read literally, it needs either a resident worker
   with much of the extraction pre-warmed, or a revised definition measured from “Play” rather than from “paste”. That
   decision belongs with the 50-link run, not with this sample.

## In-app probe

After the resolver, proxy and protocol were wired:

```
resolve 9300 ms -> "Bella Poarch - Build a B*tch", 170 s, Opus, 131 kbps, audio/webm
second resolve (session cache) 1 ms
Range: bytes=0-2047 -> 206, content-range bytes 0-2047/2791562, 2048 bytes, EBML magic 1a45dfa3
full GET -> 200, accept-ranges: bytes
thumbnail (hqdefault.jpg) -> 200, image/jpeg, 20 615 bytes
```

The last two lines are why the app caches the thumbnail into its artwork cache instead of hot-linking it.

## Reproduce

```powershell
yt-dlp --ignore-config --no-playlist --socket-timeout 15 -f bestaudio/best -J "https://www.youtube.com/watch?v=FLGCGc7sAUw"
```

Add `-r 0-1023` to a request for the returned `url`, with each returned `http_headers` entry as a header, to check the
range response. The 20-link script was a throwaway; the command above is the part worth keeping.
