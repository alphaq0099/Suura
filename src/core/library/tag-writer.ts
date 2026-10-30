import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, copyFile, mkdir, readdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import NodeID3 from 'node-id3'
import { extensionOf } from '@shared/mime'
import { extensionForMime, extractArtwork } from './artwork'
import { loadMetadataParser, youtubeOriginOf } from './metadata'
import { rawLyricsOf } from './lyrics'

// The reader owns the frame lookup; the writer only needs it to prove a write
// landed. Re-exported so the smoke tests and any caller keep one import.
export { rawLyricsOf } from './lyrics'

/**
 * Writing tags back into local files.
 *
 * This is the one place in the app that modifies a user's music, so the rules
 * are stricter than anywhere else:
 *
 *  1. The original is never written to. A temp file in the *same folder* is
 *     built, verified by parsing it, and only then renamed over the original.
 *     A crash at any point leaves either the old file or the new one, never a
 *     half-written file.
 *  2. Every write is backed up first, under `backups/tags`.
 *  3. The result is read back with the same parser the scanner uses. A writer
 *     that claims success but produces a file the library cannot read is a
 *     failure, not a success.
 *
 * The container decides the tool, because no single writer is correct for all
 * of them:
 *
 *  - MP3 needs real ID3 frames. ffmpeg writes `-metadata lyrics=` as
 *    `TXXX:USLT`, which is not a `USLT` frame and is invisible to every reader
 *    (including ours), so MP3 goes through `node-id3`.
 *  - FLAC and M4A take ffmpeg's *global* metadata dictionary.
 *  - Ogg/Opus keep their Vorbis comments on the *stream*, and ffmpeg's global
 *    `-metadata` is silently overridden by the copied stream tags. Those need
 *    `-metadata:s:a:0`.
 *
 * Everything is `-c copy`, so the audio is never re-encoded.
 */

export type TagWriteStrategy = 'id3' | 'ffmpeg-global' | 'ffmpeg-stream'

const STRATEGY_BY_EXTENSION: Readonly<Record<string, TagWriteStrategy>> = {
  '.mp3': 'id3',
  '.flac': 'ffmpeg-global',
  '.m4a': 'ffmpeg-global',
  '.m4b': 'ffmpeg-global',
  '.ogg': 'ffmpeg-stream',
  '.oga': 'ffmpeg-stream',
  '.opus': 'ffmpeg-stream',
  '.spx': 'ffmpeg-stream'
}

/**
 * Temp files keep the extension, because ffmpeg picks the muxer from it, and
 * carry a prefix the scanner skips. A crash can leave one behind; without the
 * skip rule it would be indexed as a duplicate of the track being edited.
 */
export const TAG_TEMP_PREFIX = 'suura-tag-tmp-'
const TAG_TEMP_MAX_AGE_MS = 60 * 60 * 1000

export function isTagTempFile(name: string): boolean {
  return name.startsWith(TAG_TEMP_PREFIX)
}

/** The strategy for a file, or null when this format cannot be written yet. */
export function tagStrategyFor(filePath: string): TagWriteStrategy | null {
  return STRATEGY_BY_EXTENSION[extensionOf(filePath)] ?? null
}

/**
 * The fields the editor can change.
 *
 * `undefined` means "leave alone"; `null` means "clear". That distinction is
 * what lets the auto-tagger write three fields without touching the rest.
 */
export interface TagFields {
  title?: string | null
  artist?: string | null
  albumArtist?: string | null
  album?: string | null
  trackNo?: number | null
  trackTotal?: number | null
  discNo?: number | null
  discTotal?: number | null
  year?: number | null
  genre?: string | null
  lyrics?: string | null
  /**
   * The cover to embed, or `null` to remove it. Absent leaves the picture alone.
   *
   * The bytes are the already-cached copy the picker showed, so what is written
   * is exactly what the user chose rather than a second, differently cropped
   * download.
   */
  artwork?: TagArtwork | null
}

/** An image to embed: the bytes plus the type the container will store. */
export interface TagArtwork {
  data: Uint8Array
  mime: string
}

/** The text fields, which are the ones a partial patch can name. */
export type TagFieldName = Exclude<keyof TagFields, 'artwork'>

export const TAG_FIELD_NAMES: readonly TagFieldName[] = [
  'title',
  'artist',
  'albumArtist',
  'album',
  'trackNo',
  'trackTotal',
  'discNo',
  'discTotal',
  'year',
  'genre',
  'lyrics'
]

export type TagWriteErrorCode =
  | 'unsupported'
  | 'missing'
  | 'locked'
  | 'ffmpeg-missing'
  | 'write-failed'
  | 'verify-failed'

export class TagWriteError extends Error {
  constructor(
    readonly code: TagWriteErrorCode,
    message: string,
    readonly detail?: unknown
  ) {
    super(message)
    this.name = 'TagWriteError'
  }
}

export interface TagWriteResult {
  filePath: string
  strategy: TagWriteStrategy
  /** Field names that were actually written. */
  fields: TagFieldName[]
  /** True when the cover was replaced or removed by this write. */
  artworkWritten: boolean
  /** The copy taken before the replace, or null when the backup failed. */
  backupPath: string | null
  bytesBefore: number
  bytesAfter: number
}

export interface TagWriterOptions {
  /** Where the pre-write copies live. Created on first use. */
  backupDir: string
  /** Resolved lazily: ffmpeg is optional until the first write that needs it. */
  resolveFfmpeg: () => Promise<string>
  /** How many per-file backups to keep. Oldest are pruned first. */
  backupKeep?: number
}

/** One write per file at a time, so two dialogs cannot interleave. */
const writeChains = new Map<string, Promise<unknown>>()

export class TagWriter {
  constructor(private readonly options: TagWriterOptions) {}

  async write(filePath: string, fields: TagFields, now = Date.now()): Promise<TagWriteResult> {
    const strategy = tagStrategyFor(filePath)
    if (!strategy) {
      throw new TagWriteError(
        'unsupported',
        `Suura cannot write tags to ${extensionOf(filePath) || 'this'} files yet.`
      )
    }

    const changes = normalizeFields(fields)
    const names = Object.keys(changes) as TagFieldName[]
    const artwork = 'artwork' in fields ? (fields.artwork ?? null) : undefined
    if (names.length === 0 && artwork === undefined) {
      throw new TagWriteError('write-failed', 'No tag fields were given.')
    }
    // Ogg/Opus keep their comments on the audio stream, and this ffmpeg build
    // cannot attach a picture there. Refusing before the copy is made means the
    // text edit the user also asked for does not land while the cover silently
    // does not.
    if (artwork !== undefined && strategy === 'ffmpeg-stream') {
      throw new TagWriteError(
        'unsupported',
        'Cover art cannot be written to Ogg or Opus files yet. The other tags can still be saved.'
      )
    }

    const key = filePath.toLowerCase()
    const previous = writeChains.get(key) ?? Promise.resolve()
    const run = previous.then(
      () => this.writeNow(filePath, strategy, changes, names, artwork, now),
      () => this.writeNow(filePath, strategy, changes, names, artwork, now)
    )
    const queued = run.catch(() => undefined)
    writeChains.set(key, queued)
    try {
      return await run
    } finally {
      // Only the last queued write has to clean up; earlier ones leave the
      // chain in place so a third write still waits behind them.
      if (writeChains.get(key) === queued) writeChains.delete(key)
    }
  }

  private async writeNow(
    filePath: string,
    strategy: TagWriteStrategy,
    changes: NormalizedFields,
    names: TagFieldName[],
    artwork: TagArtwork | null | undefined,
    now: number
  ): Promise<TagWriteResult> {
    let before: Awaited<ReturnType<typeof stat>>
    try {
      before = await stat(filePath)
    } catch (error) {
      throw new TagWriteError('missing', 'That file is no longer on disk.', error)
    }
    if (!before.isFile()) {
      throw new TagWriteError('missing', 'That path is not a file.')
    }

    const temp = join(dirname(filePath), `${TAG_TEMP_PREFIX}${randomUUID()}${extname(filePath)}`)
    let imageTemp: string | null = null
    let backupPath: string | null = null

    try {
      if (strategy === 'id3') {
        // node-id3 edits in place, so the copy is made first and the edit
        // happens on the copy. The copy inherits a read-only flag from the
        // original; clearing it here means the *replace* is what reports a
        // read-only file, instead of a confusing failure inside the writer.
        await copyFile(filePath, temp)
        await chmod(temp, 0o666).catch(() => undefined)
        writeId3(temp, changes, artwork)
      } else {
        if (artwork) {
          // ffmpeg takes the picture as a second input, and the extension has
          // to match the bytes or it guesses the wrong demuxer.
          imageTemp = join(
            dirname(filePath),
            `${TAG_TEMP_PREFIX}${randomUUID()}${extensionForMime(artwork.mime) ?? '.jpg'}`
          )
          await writeFile(imageTemp, artwork.data)
        }
        await runFfmpeg(
          await this.options.resolveFfmpeg(),
          ffmpegArgs(filePath, temp, strategy, changes, artwork, imageTemp)
        )
      }

      await verifyTagWrite(temp, changes, artwork)

      backupPath = await this.backup(filePath, now)
      await replaceFile(temp, filePath)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw asTagWriteError(error)
    } finally {
      if (imageTemp) await rm(imageTemp, { force: true }).catch(() => undefined)
    }

    const after = await stat(filePath).catch(() => null)
    void this.pruneBackups()

    return {
      filePath,
      strategy,
      fields: names,
      artworkWritten: artwork !== undefined,
      backupPath,
      bytesBefore: before.size,
      bytesAfter: after?.size ?? before.size
    }
  }

  /**
   * A copy next to the other backups, named so that sorting by name sorts by
   * time. Best effort: a failed backup must not block the write the user asked
   * for, but it is reported as null so the caller can say so.
   */
  private async backup(filePath: string, now: number): Promise<string | null> {
    try {
      await mkdir(this.options.backupDir, { recursive: true })
      const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
      const target = join(this.options.backupDir, `${stamp}-${basename(filePath)}`)
      await copyFile(filePath, target)
      return target
    } catch {
      return null
    }
  }

  private async pruneBackups(): Promise<void> {
    const keep = this.options.backupKeep ?? 200
    try {
      const entries = (await readdir(this.options.backupDir)).sort()
      const excess = entries.length - keep
      if (excess <= 0) return
      for (const name of entries.slice(0, excess)) {
        await unlink(join(this.options.backupDir, name)).catch(() => undefined)
      }
    } catch {
      // No backup directory yet, or it is not ours to prune.
    }
  }
}

/**
 * Deletes temp files a crash left behind, and reports whether `name` is one so
 * the scanner can skip it. Called while walking a folder, which is the one
 * place that already looks at every file.
 */
export async function sweepTagTempFile(directory: string, name: string): Promise<void> {
  if (!isTagTempFile(name)) return
  const filePath = join(directory, name)
  try {
    const info = await stat(filePath)
    if (Date.now() - info.mtimeMs < TAG_TEMP_MAX_AGE_MS) return
    await unlink(filePath)
  } catch {
    // Another write may have just replaced it, or it is not ours.
  }
}

type NormalizedFields = Partial<Record<TagFieldName, string | null>>

/**
 * Turns the caller's fields into the string form each writer wants.
 *
 * Empty strings are treated as "clear" rather than as a value: an editor that
 * submits every input in the form should not have to translate blank to null.
 */
export function normalizeFields(fields: TagFields): NormalizedFields {
  const out: NormalizedFields = {}
  for (const name of TAG_FIELD_NAMES) {
    if (!(name in fields)) continue
    const value = fields[name]
    if (value === undefined) continue
    if (value === null) {
      out[name] = null
      continue
    }
    if (typeof value === 'number') {
      out[name] = Number.isFinite(value) ? String(Math.trunc(value)) : null
      continue
    }
    const text = normalizeText(value)
    out[name] = text
  }
  return out
}

function normalizeText(value: string): string | null {
  // CRLF would end up in the file as-is, and every reader would then disagree
  // about the number of lines.
  const text = value.replace(/\r\n?/g, '\n').trim()
  return text.length > 0 ? text : null
}

// ---- MP3 (node-id3) -------------------------------------------------------

/** The ID3v2.3 frame each field maps to. */
const ID3_FRAME_BY_FIELD: Readonly<Record<TagFieldName, string>> = {
  title: 'TIT2',
  artist: 'TPE1',
  albumArtist: 'TPE2',
  album: 'TALB',
  trackNo: 'TRCK',
  trackTotal: 'TRCK',
  discNo: 'TPOS',
  discTotal: 'TPOS',
  year: 'TYER',
  genre: 'TCON',
  lyrics: 'USLT'
}

/**
 * Moves a saved video's comment from `TXXX` to the standard `COMM` frame.
 *
 * ffmpeg writes `-metadata comment=` as `TXXX` in ID3v2.4, where the URL
 * survives. node-id3 writes ID3v2.3, and a v2.3 text frame may hold several
 * values separated by `/`, so `https://www.youtube.com/watch?v=...` reads back
 * as four fragments and the link to the video is lost. `COMM` is a real
 * comment frame: every parser reads it whole, including the one that decides
 * whether a file is already in the library.
 *
 * Only a value that is exactly a YouTube watch URL is moved, and only when the
 * file has no comment frame of its own.
 */
function migrateVideoComment(raw: Record<string, unknown>): void {
  const frames = raw.TXXX
  if (!Array.isArray(frames) || raw.COMM) return
  const kept: unknown[] = []
  let moved = false
  for (const frame of frames) {
    const { description, value } = (frame ?? {}) as { description?: unknown; value?: unknown }
    if (!moved && description === 'comment' && typeof value === 'string' && youtubeOriginOf([{ text: value }])) {
      raw.COMM = { language: 'eng', shortText: '', text: value.trim() }
      moved = true
      continue
    }
    kept.push(frame)
  }
  if (kept.length > 0) raw.TXXX = kept
  else delete raw.TXXX
}

/**
 * Applies the changes to the raw frame table and writes the whole table back.
 *
 * `update()` would be shorter, but it cannot remove a frame: an empty value
 * clears a text frame and leaves `SYLT` in place, which would keep showing the
 * *old* synced lyrics next to the new unsynced ones. Editing the raw frames is
 * also what `update()` does internally, so this is not a private API.
 */
function writeId3(
  filePath: string,
  changes: NormalizedFields,
  artwork: TagArtwork | null | undefined
): void {
  const current = NodeID3.read(filePath)
  const raw: Record<string, unknown> = { ...(current.raw ?? {}) }
  migrateVideoComment(raw)

  if (artwork !== undefined) {
    if (artwork === null) {
      // Delete the frame rather than writing an empty one: an `APIC` with no
      // bytes still counts as a picture to some readers.
      delete raw.APIC
    } else {
      raw.APIC = {
        type: 3,
        mime: artwork.mime,
        description: '',
        imageBuffer: Buffer.from(artwork.data)
      }
    }
  }

  for (const [name, value] of Object.entries(changes) as Array<[TagFieldName, string | null]>) {
    if (name === 'trackNo' || name === 'trackTotal') {
      setOrDelete(raw, 'TRCK', positionOf(changes.trackNo, changes.trackTotal))
      continue
    }
    if (name === 'discNo' || name === 'discTotal') {
      setOrDelete(raw, 'TPOS', positionOf(changes.discNo, changes.discTotal))
      continue
    }
    if (name === 'lyrics') {
      // Plain text in `USLT`. LRC timestamps survive in it and music-metadata
      // turns them into `syncText` when it reads the file, so a separate SYLT
      // frame would only be a second, competing copy.
      setOrDelete(raw, 'USLT', value === null ? null : { language: 'eng', shortText: '', text: value })
      delete raw.SYLT
      continue
    }
    setOrDelete(raw, ID3_FRAME_BY_FIELD[name], value)
  }

  const result = NodeID3.write(raw, filePath)
  if (result !== true) {
    const code = (result as NodeJS.ErrnoException | undefined)?.code
    if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
      throw new TagWriteError(
        'locked',
        'That file is read-only or in use by another program.',
        result
      )
    }
    throw new TagWriteError('write-failed', 'The MP3 tag writer refused this file.', result)
  }
}

/**
 * `3/12` is one frame, so the two halves travel together. A total without a
 * number is dropped rather than written as `0/12`: a track number of zero is a
 * value the user did not ask for.
 *
 * Callers always send both halves (the library fills in the row's current
 * number when only the total changed), which is why this needs no "existing"
 * argument.
 */
function positionOf(no: string | null | undefined, total: string | null | undefined): string | null {
  if (!no) return null
  return total ? `${no}/${total}` : no
}

function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === null || value === undefined || value === '') delete target[key]
  else target[key] = value
}

// ---- ffmpeg ---------------------------------------------------------------

const FFMPEG_TIMEOUT_MS = 120_000

function ffmpegArgs(
  input: string,
  output: string,
  strategy: TagWriteStrategy,
  changes: NormalizedFields,
  artwork: TagArtwork | null | undefined,
  imagePath: string | null
): string[] {
  // Ogg/Opus comments belong to the audio stream; every other container keeps
  // them in the global dictionary.
  const flag = strategy === 'ffmpeg-stream' ? '-metadata:s:a:0' : '-metadata'
  const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', input]

  if (artwork !== undefined) {
    // Changing the cover means rebuilding the stream map: keep every audio
    // stream, drop the old picture, and attach the new one. With `null` the
    // picture streams are simply not mapped, which is how it is removed.
    if (imagePath) args.push('-i', imagePath)
    args.push('-map', '0:a')
    if (imagePath) args.push('-map', '1:v')
    args.push('-c', 'copy')
    if (imagePath) {
      args.push(
        '-disposition:v:0',
        'attached_pic',
        '-metadata:s:v:0',
        'title=Album cover',
        '-metadata:s:v:0',
        'comment=Cover (front)'
      )
    }
  } else {
    // Every stream is copied, which is what keeps cover art attached. `-c copy`
    // means the audio bytes are untouched.
    args.push('-map', '0', '-c', 'copy')
  }

  const push = (key: string, value: string | null): void => {
    args.push(flag, `${key}=${value ?? ''}`)
  }

  if (changes.title !== undefined) push('title', changes.title)
  if (changes.artist !== undefined) push('artist', changes.artist)
  if (changes.albumArtist !== undefined) push('album_artist', changes.albumArtist)
  if (changes.album !== undefined) push('album', changes.album)
  if (changes.year !== undefined) push('date', changes.year)
  if (changes.genre !== undefined) push('genre', changes.genre)
  if (changes.lyrics !== undefined) push('lyrics', changes.lyrics)

  if ('trackNo' in changes || 'trackTotal' in changes) {
    push('track', positionOf(changes.trackNo, changes.trackTotal))
  }
  if ('discNo' in changes || 'discTotal' in changes) {
    push('disc', positionOf(changes.discNo, changes.discTotal))
  }

  args.push(output)
  return args
}

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (error) {
      reject(new TagWriteError('ffmpeg-missing', 'ffmpeg could not be started.', error))
      return
    }

    let stderr = ''
    let settled = false
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, FFMPEG_TIMEOUT_MS)

    const finish = (error: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (stderr.length > 8000) stderr = stderr.slice(-4000)
    })

    child.on('error', (error) => {
      finish(new TagWriteError('ffmpeg-missing', 'ffmpeg could not be started.', error))
    })

    child.on('close', (code) => {
      if (timedOut) {
        finish(new TagWriteError('write-failed', 'ffmpeg took too long and was stopped.', stderr))
        return
      }
      if (code !== 0) {
        finish(
          new TagWriteError(
            'write-failed',
            'ffmpeg could not write the tags into this file.',
            stderr.trim() || `exit code ${code ?? 'unknown'}`
          )
        )
        return
      }
      finish(null)
    })
  })
}

// ---- verification ---------------------------------------------------------

/**
 * Reads the temp file back and checks every field that was written.
 *
 * Lyrics are checked against the *raw* tag value rather than `common.lyrics`,
 * because the parser reinterprets LRC text into per-line timestamps and would
 * make a faithful write look different. Everything else is compared through the
 * same `common` view the library stores.
 */
async function verifyTagWrite(
  filePath: string,
  changes: NormalizedFields,
  artwork: TagArtwork | null | undefined
): Promise<void> {
  const parseFile = await loadMetadataParser()
  let parsed: Awaited<ReturnType<typeof parseFile>>
  try {
    parsed = await parseFile(filePath, { duration: false, skipCovers: true })
  } catch (error) {
    throw new TagWriteError('verify-failed', 'The rewritten file could not be read back.', error)
  }

  if (artwork !== undefined) {
    // Presence is the honest check. ffmpeg may re-encode an attached picture
    // for a container, so comparing bytes would fail a write that worked.
    const written = await extractArtwork(filePath).catch(() => null)
    if (artwork === null && written !== null) {
      throw new TagWriteError('verify-failed', 'The cover art was still in the file after removing it.')
    }
    if (artwork !== null && written === null) {
      throw new TagWriteError('verify-failed', 'The cover art was not readable after writing it.')
    }
  }

  const actual = fieldValuesOf(parsed.common)
  for (const [name, expected] of Object.entries(changes) as Array<[TagFieldName, string | null]>) {
    if (name === 'trackNo' || name === 'trackTotal' || name === 'discNo' || name === 'discTotal') {
      continue
    }
    if (name === 'lyrics') {
      const written = rawLyricsOf(parsed.native)
      if (!sameText(expected, written)) {
        throw new TagWriteError('verify-failed', 'The lyrics were not readable after writing them.', {
          expected,
          actual: written
        })
      }
      continue
    }
    if (!sameText(expected, actual[name])) {
      throw new TagWriteError('verify-failed', `The ${name} tag did not survive the write.`, {
        expected,
        actual: actual[name]
      })
    }
  }

  // The two halves of a track/disc number live in one frame, so they are
  // checked together rather than as separate fields.
  for (const [kind, noName, totalName] of [
    ['track', 'trackNo', 'trackTotal'],
    ['disc', 'discNo', 'discTotal']
  ] as const) {
    if (!(noName in changes) && !(totalName in changes)) continue
    const expected = positionOf(changes[noName], changes[totalName])
    const written = positionString(parsed.common, kind)
    if (!sameText(expected, written)) {
      throw new TagWriteError('verify-failed', `The ${kind} number did not survive the write.`, {
        expected,
        actual: written
      })
    }
  }
}

type CommonTags = Awaited<ReturnType<Awaited<ReturnType<typeof loadMetadataParser>>>>['common']

function fieldValuesOf(common: CommonTags): Record<TagFieldName, string | null> {
  return {
    title: common.title ?? null,
    artist: common.artist ?? null,
    albumArtist: common.albumartist ?? null,
    album: common.album ?? null,
    trackNo: common.track?.no != null ? String(common.track.no) : null,
    trackTotal: common.track?.of != null ? String(common.track.of) : null,
    discNo: common.disk?.no != null ? String(common.disk.no) : null,
    discTotal: common.disk?.of != null ? String(common.disk.of) : null,
    year: common.year != null ? String(common.year) : null,
    genre: common.genre?.map((entry) => entry.trim()).filter(Boolean).join(', ') || null,
    lyrics: null
  }
}

/**
 * The `no/total` string a container holds, read back through `common`. Used to
 * compare a position as one value, because that is how it was written.
 */
function positionString(common: CommonTags, kind: 'track' | 'disc'): string | null {
  const current = kind === 'track' ? common.track : common.disk
  const no = current?.no != null ? String(current.no) : null
  const total = current?.of != null ? String(current.of) : null
  return positionOf(no, total)
}

function sameText(expected: string | null, actual: string | null | undefined): boolean {
  const left = expected?.replace(/\r\n?/g, '\n').trim() || null
  const right = actual?.replace(/\r\n?/g, '\n').trim() || null
  return left === right
}

// ---- filesystem -----------------------------------------------------------

/**
 * Renames over the original. On Windows `rename` replaces an existing file in
 * one step, which is why the temp file has to be in the same folder: a
 * cross-volume move is a copy and would not be atomic.
 */
async function replaceFile(temp: string, target: string): Promise<void> {
  try {
    await rename(temp, target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
      throw new TagWriteError(
        'locked',
        'That file is read-only or in use by another program. Close it, or clear its read-only flag, and try again.',
        error
      )
    }
    throw error
  }
}

function asTagWriteError(error: unknown): TagWriteError {
  if (error instanceof TagWriteError) return error
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT') return new TagWriteError('missing', 'That file is no longer on disk.', error)
  if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') {
    return new TagWriteError(
      'locked',
      'That file is read-only or in use by another program.',
      error
    )
  }
  return new TagWriteError('write-failed', 'The tags could not be written.', error)
}
