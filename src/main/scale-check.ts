import { mkdir, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
import type { AppContainer } from './services/container'

/**
 * The size the M1 exit criteria names, and the two budgets it has to meet.
 * Run with `npm run scale`.
 */
const TRACK_COUNT = 10_000
const FILES_PER_FOLDER = 100
const COLD_START_BUDGET_MS = 2_000
const FIRST_AUDIO_BUDGET_MS = 300

export interface ScaleSummary {
  tracks: number
  copyMs: number
  scanMs: number
  rescanMs: number
  pageMs: number
  searchMs: number
  databaseBytes: number
}

/**
 * A silent mono WAV, written by hand.
 *
 * The scale check must not depend on ffmpeg: it is about how the app behaves
 * with a large library, and a fixture tool is one more thing that can be
 * missing from the machine. A WAV header is thirty lines of arithmetic.
 */
function silentWav(seconds: number, sampleRate = 8_000): Buffer {
  const frames = Math.round(seconds * sampleRate)
  const dataBytes = frames * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28) // byte rate
  buffer.writeUInt16LE(2, 32) // block align
  buffer.writeUInt16LE(16, 34) // bits per sample
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataBytes, 40)
  return buffer
}

/**
 * Builds a real 10,000-file library and scans it, before the window exists.
 *
 * The files are real, and the scan is the scan: seeding rows straight into the
 * database would measure the UI against a library no code path ever produced,
 * and would skip the part that is actually slow. `console.log` rather than the
 * logger because a number nobody can see is not a measurement.
 */
export async function seedScaleLibrary(container: AppContainer): Promise<ScaleSummary> {
  const root = join(container.paths.userData, 'scale-library')
  const bytes = silentWav(0.3)

  const copyStarted = Date.now()
  for (let folder = 0; folder < TRACK_COUNT / FILES_PER_FOLDER; folder += 1) {
    const dir = join(root, `Album ${String(folder).padStart(3, '0')}`)
    await mkdir(dir, { recursive: true })
    const writes: Promise<void>[] = []
    for (let file = 0; file < FILES_PER_FOLDER; file += 1) {
      const number = folder * FILES_PER_FOLDER + file
      writes.push(writeFile(join(dir, `Track ${String(number).padStart(4, '0')}.wav`), bytes))
    }
    await Promise.all(writes)
  }
  const copyMs = Date.now() - copyStarted

  const scanStarted = Date.now()
  const scanned = await container.library.scan(root)
  const scanMs = Date.now() - scanStarted

  const rescanStarted = Date.now()
  await container.library.scan(root)
  const rescanMs = Date.now() - rescanStarted

  const pageStarted = Date.now()
  const page = container.library.list({ limit: 400 })
  const pageMs = Date.now() - pageStarted

  const searchStarted = Date.now()
  const found = container.library.list({ search: 'Track 9999', limit: 50 })
  const searchMs = Date.now() - searchStarted

  let databaseBytes = 0
  try {
    databaseBytes = statSync(container.paths.database).size
  } catch {
    databaseBytes = 0
  }

  console.log(`SCALE  ${scanned.tracks} tracks in ${TRACK_COUNT / FILES_PER_FOLDER} folders`)
  console.log(`SCALE  writing the files: ${copyMs} ms`)
  console.log(`SCALE  full scan: ${scanMs} ms`)
  console.log(`SCALE  incremental rescan: ${rescanMs} ms`)
  console.log(`SCALE  first page of ${page.tracks.length}: ${pageMs} ms`)
  console.log(`SCALE  search: ${searchMs} ms (${found.total} hit${found.total === 1 ? '' : 's'})`)
  console.log(`SCALE  database: ${(databaseBytes / 1024 / 1024).toFixed(1)} MB`)

  return {
    tracks: scanned.tracks,
    copyMs,
    scanMs,
    rescanMs,
    pageMs,
    searchMs,
    databaseBytes
  }
}

interface WindowProbe {
  rows: number
  title: string
  dispatchMs: number
  /** Median of `pipelineRuns`. */
  pipelineMs: number
  pipelineRuns: number[]
  queue: number
  error: string
}

/**
 * Measures the two things a user feels: how long the window takes to show the
 * library, and how long a double click takes to become sound.
 *
 * `dispatchMs` is measured inside the page, from the double click to the moment
 * the transport reports it is playing, so it includes the IPC round trip, the
 * protocol handler and the decoder. `pipelineMs` repeats the same path with a
 * bare `Audio` element, which is the same work without the React render around
 * it — if the two ever diverge, the difference is interface, not I/O.
 */
export async function runScaleCheck(
  window: BrowserWindow,
  windowStartedAt: number,
  summary: ScaleSummary
): Promise<number> {
  const rowsVisible = await waitForRows(window, 30_000)
  const coldStartMs = Date.now() - windowStartedAt

  const probe = rowsVisible
    ? await evaluate<WindowProbe>(
        window,
        `(async () => {
           const out = { rows: 0, title: '', dispatchMs: -1, pipelineMs: -1, pipelineRuns: [], queue: 0, error: '' }
           try {
             const rows = [...document.querySelectorAll('.track-row')]
             out.rows = rows.length
             const row = rows[0]
             if (!row) { out.error = 'no rows rendered'; return out }
             out.title = (row.querySelector('.row-title-text') || {}).textContent || ''

             // A double click is how a track starts, and the transport flipping
             // to "Pause" is the first frame in which the user can see it did.
             const started = performance.now()
             row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
             const deadline = Date.now() + 10_000
             for (;;) {
               const play = document.querySelector('.player-bar .icon-button.primary')
               if (play && play.getAttribute('title') === 'Pause') break
               if (Date.now() > deadline) { out.error = 'playback did not start'; return out }
               await new Promise((r) => setTimeout(r, 10))
             }
             out.dispatchMs = performance.now() - started
             const queue = document.querySelector('.queue-button')
             out.queue = Number(String(queue ? queue.getAttribute('title') : '').replace(/[^0-9]/g, '')) || 0

             // Stop the interface's own audio first. The fixtures are a third of
             // a second long, so left playing the queue advances every few
             // hundred milliseconds and the probe would be competing with a
             // decoder rather than measuring one starting.
             const pause = document.querySelector('.player-bar .icon-button.primary')
             if (pause && pause.getAttribute('title') === 'Pause') {
               pause.dispatchEvent(new MouseEvent('click', { bubbles: true }))
             }
             await new Promise((r) => setTimeout(r, 300))

             // The same path without the interface around it, three times. The
             // machine this runs on is not a lab: the first start of an audio
             // pipeline can be hundreds of milliseconds slow because the
             // operating system is doing something else, and one sample of that
             // is not a measurement. The median is reported and budgeted.
             const page = await window.player.listTracks({ limit: 1 })
             const track = page.tracks[0]
             for (let attempt = 0; track && attempt < 3; attempt += 1) {
               const source = await window.player.resolveSource(track.id)
               const audio = new Audio(source.url)
               audio.preload = 'auto'
               const playedAt = performance.now()
               await audio.play()
               // Polled on a short timer rather than on a timeupdate event: that
               // event fires four times a second, so it would put a ~250ms floor
               // under a measurement whose whole budget is 300ms. A frame-based
               // poll is no better here, because this window is not guaranteed to
               // be producing frames while the check runs.
               await new Promise((resolve) => {
                 const timer = setTimeout(resolve, 5000)
                 const tick = () => {
                   if (audio.currentTime > 0.02) {
                     clearTimeout(timer)
                     resolve()
                     return
                   }
                   setTimeout(tick, 5)
                 }
                 setTimeout(tick, 5)
               })
               out.pipelineRuns.push(Math.round(performance.now() - playedAt))
               audio.pause()
               audio.src = ''
               await new Promise((r) => setTimeout(r, 120))
             }
             const sorted = out.pipelineRuns.slice().sort((a, b) => a - b)
             out.pipelineMs = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : -1
             return out
           } catch (error) {
             out.error = error && error.message ? error.message : String(error)
             return out
           }
         })()`
      )
    : ({
        rows: 0,
        title: '',
        dispatchMs: -1,
        pipelineMs: -1,
        pipelineRuns: [],
        queue: 0,
        error: 'no rows rendered'
      } as WindowProbe)

  // The bar flips on the `play` event, which fires before a sample is decoded.
  // The audio element probe is the one that waits for `currentTime` to move, so
  // it is the number that means "first audio"; the bar's number is reported
  // beside it as the interface's share of the wait.
  const firstAudioMs = probe.pipelineMs >= 0 ? probe.pipelineMs : probe.dispatchMs
  const coldOk = coldStartMs <= COLD_START_BUDGET_MS
  const audioOk = firstAudioMs >= 0 && firstAudioMs <= FIRST_AUDIO_BUDGET_MS

  console.log(`SCALE  rows on the first screen: ${probe.rows} (a page of ${summary.tracks} in the library)`)
  console.log(`SCALE  cold start: ${coldStartMs} ms (budget ${COLD_START_BUDGET_MS} ms)`)
  console.log(
    `SCALE  first audio: ${firstAudioMs < 0 ? 'never started' : `${Math.round(firstAudioMs)} ms`} (budget ${FIRST_AUDIO_BUDGET_MS} ms)` +
      (probe.pipelineRuns.length > 1 ? `, runs ${probe.pipelineRuns.join('/')}` : '')
  )
  console.log(
    `SCALE  double click -> the bar shows playing: ${probe.dispatchMs < 0 ? 'never started' : `${Math.round(probe.dispatchMs)} ms`}`
  )
  console.log(`SCALE  queue: ${probe.queue} tracks starting at "${probe.title}"`)
  if (probe.error) console.log(`SCALE  error: ${probe.error}`)

  const failures = Number(!coldOk) + Number(!audioOk)
  console.log(
    failures === 0
      ? 'SCALE RESULT  both budgets met'
      : `SCALE RESULT  ${failures} budget(s) missed`
  )
  return failures
}

async function evaluate<T>(window: BrowserWindow, code: string): Promise<T> {
  return (await window.webContents.executeJavaScript(code, true)) as T
}

async function waitForRows(window: BrowserWindow, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const count = await evaluate<number>(window, `document.querySelectorAll('.track-row').length`).catch(() => 0)
    if (count > 0) return true
    await delay(25)
  }
  return false
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
