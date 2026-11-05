# Internal notes

These files are working records, not documentation.

They exist because measurements and trial runs are worth keeping, and because some decisions only make sense next to
the numbers that produced them. They may contain machine-specific paths, raw command output, throwaway benchmarks or
half-finished reasoning. Nothing here is a promise about behaviour.

| File | What it is |
|---|---|
| `objective.md` | The current product-feedback brief that work is measured against. Replaced as passes finish. |
| `notes/yt-dlp-spike.md` | The first sidecar spike: what yt-dlp and ffmpeg do, and how long they take. |
| `notes/yt-dlp-sample.md` | The 20-link resolve sample. |
| `notes/yt-dlp-50.md` | The 50-link M3 measurement, used to set the cold-start target. |
| `notes/yt-dlp-50-results.json` | Raw results for the sample above. |

Do not link to these from `README.md`, the release docs or the app. User-facing documentation lives in the repository
root and in `docs/`.
