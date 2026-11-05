#!/usr/bin/env node
/**
 * Measures the M3 streaming target against a fresh 50-link sample.
 *
 * This is a measurement harness, not part of the app. It picks 50 videos from
 * ten different YouTube searches, resolves each one exactly the way the app's
 * default *high* tier does, and then asks the CDN for the first two kilobytes
 * with the headers yt-dlp reported. The timings are wall-clock and include
 * process start-up, because that is what a user waits for on the first play.
 *
 *   node tools/measure-streams.mjs
 *
 * Results are written to docs/internal/notes/yt-dlp-50-results.json. It needs yt-dlp on
 * PATH (or set YTDLP to the executable) and network access. Nothing is written
 * outside this folder.
 */
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const YTDLP = process.env.YTDLP ?? 'yt-dlp'
const TARGET = 50
const SEARCHES = [
  'official music video 2021',
  'live concert full performance',
  'lofi hip hop mix 1 hour',
  'podcast episode interview',
  'classical symphony full',
  'official audio 2022',
  'indie folk playlist',
  'jazz standards',
  'bollywood song',
  'rock anthem'
]

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function ytdlp(args, timeout = 90_000) {
  const { stdout } = await execFileAsync(YTDLP, args, {
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  })
  return stdout
}

function commonArgs() {
  return ['--ignore-config', '--no-progress', '--socket-timeout', '15']
}

async function collectLinks() {
  const seen = new Set()
  const links = []
  for (const query of SEARCHES) {
    if (links.length >= TARGET) break
    process.stdout.write(`search  ${query} ... `)
    try {
      const stdout = await ytdlp([
        ...commonArgs(),
        '--flat-playlist',
        '--playlist-end',
        '10',
        '-J',
        `ytsearch10:${query}`
      ])
      const parsed = JSON.parse(stdout)
      const entries = Array.isArray(parsed.entries) ? parsed.entries : []
      let added = 0
      for (const entry of entries) {
        if (links.length >= TARGET) break
        if (!entry || typeof entry.id !== 'string' || seen.has(entry.id)) continue
        if (!/^[A-Za-z0-9_-]{11}$/.test(entry.id)) continue
        seen.add(entry.id)
        links.push({
          videoId: entry.id,
          searchTitle: entry.title ?? null,
          searchChannel: entry.uploader ?? entry.channel ?? null,
          durationSec: typeof entry.duration === 'number' ? entry.duration : null,
          query
        })
        added += 1
      }
      console.log(`${added} new (${links.length}/${TARGET})`)
    } catch (error) {
      console.log(`failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    }
    await sleep(500)
  }
  return links
}

function audioFormat(info) {
  const requested = Array.isArray(info.requested_formats) ? info.requested_formats : []
  const single = requested.length === 1 && requested[0] && typeof requested[0] === 'object' ? requested[0] : null
  return single ?? info
}

async function resolveOne(link) {
  const started = Date.now()
  const stdout = await ytdlp([
    ...commonArgs(),
    '--no-playlist',
    '-f',
    'bestaudio[abr>=128]/bestaudio/best',
    '-J',
    `https://www.youtube.com/watch?v=${link.videoId}`
  ])
  const elapsedMs = Date.now() - started
  const info = JSON.parse(stdout)
  const format = audioFormat(info)
  const url = typeof format.url === 'string' ? format.url : typeof info.url === 'string' ? info.url : null
  if (!url) throw new Error('no stream URL')

  let range = null
  const rangeStarted = Date.now()
  try {
    const response = await fetch(url, {
      headers: { ...(info.http_headers ?? {}), Range: 'bytes=0-2047' },
      signal: AbortSignal.timeout(20_000)
    })
    const body = await response.arrayBuffer()
    range = {
      status: response.status,
      bytes: body.byteLength,
      ms: Date.now() - rangeStarted,
      contentRange: response.headers.get('content-range')
    }
  } catch (error) {
    range = { status: null, bytes: 0, ms: Date.now() - rangeStarted, error: String(error) }
  }

  return {
    ...link,
    resolvedTitle: info.title ?? null,
    resolvedChannel: info.artist ?? info.uploader ?? info.channel ?? null,
    durationSec: typeof info.duration === 'number' ? info.duration : link.durationSec,
    resolveMs: elapsedMs,
    formatId: format.format_id ?? null,
    ext: format.ext ?? null,
    acodec: format.acodec ?? null,
    abr: typeof format.abr === 'number' ? Math.round(format.abr) : null,
    audioOnly: !Array.isArray(info.requested_formats) || info.requested_formats.length <= 1,
    range
  }
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

async function main() {
  console.log(`Measuring ${TARGET} links with ${YTDLP}\n`)
  const links = await collectLinks()
  console.log(`\nCollected ${links.length} unique links. Resolving each...\n`)

  const results = []
  for (const [index, link] of links.entries()) {
    let attempt = 0
    let result = null
    while (attempt < 2 && !result) {
      attempt += 1
      try {
        result = await resolveOne(link)
      } catch (error) {
        const message = error instanceof Error ? error.message.split('\n')[0] : String(error)
        if (attempt > 1) {
          results.push({ ...link, error: message })
          console.log(`${String(index + 1).padStart(2)}/${links.length}  FAIL  ${link.videoId}  ${message}`)
        } else {
          console.log(`${String(index + 1).padStart(2)}/${links.length}  retry ${link.videoId}`)
          await sleep(1500)
        }
      }
    }
    if (result) {
      results.push(result)
      console.log(
        `${String(index + 1).padStart(2)}/${links.length}  ${String(result.resolveMs).padStart(5)} ms  ` +
          `${result.ext}/${result.acodec} ${result.abr ?? '?'}k  range ${result.range?.status ?? 'ERR'} ` +
          `${result.range?.bytes ?? 0}B  ${result.resolvedTitle?.slice(0, 60) ?? ''}`
      )
    }
    await sleep(750)
  }

  const ok = results.filter((entry) => !entry.error)
  const resolveTimes = ok.map((entry) => entry.resolveMs)
  const rangeTimes = ok.map((entry) => entry.range?.ms).filter((value) => typeof value === 'number')
  const summary = {
    measuredAt: new Date().toISOString(),
    ytDlp: YTDLP,
    requested: TARGET,
    collected: links.length,
    resolved: ok.length,
    failed: results.length - ok.length,
    resolveMs: {
      median: median(resolveTimes),
      min: resolveTimes.length ? Math.min(...resolveTimes) : null,
      max: resolveTimes.length ? Math.max(...resolveTimes) : null
    },
    firstRangeMs: {
      median: median(rangeTimes),
      min: rangeTimes.length ? Math.min(...rangeTimes) : null,
      max: rangeTimes.length ? Math.max(...rangeTimes) : null
    },
    formats: [...new Set(ok.map((entry) => `${entry.ext}/${entry.acodec}`))],
    ranges: [...new Set(ok.map((entry) => `${entry.range?.status}/${entry.range?.bytes}`))]
  }

  const output = join(root, 'docs', 'notes', 'yt-dlp-50-results.json')
  writeFileSync(output, `${JSON.stringify({ summary, results }, null, 2)}\n`, 'utf8')
  console.log('\nSummary')
  console.log(JSON.stringify(summary, null, 2))
  console.log(`\nWrote ${output}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
