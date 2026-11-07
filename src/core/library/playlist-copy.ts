import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { sanitizeFilePart } from '@shared/files'
import type { PlaylistDetail, PlaylistCopyResult } from '@shared/types'
import { exportPlaylistM3UForFolder } from './playlist-file'

/**
 * Sending a playlist to a phone, without a phone app.
 *
 * A phone player cannot use the absolute paths an ordinary M3U holds, so the
 * playlist is copied as a folder: every local file under its own name, and one
 * `.m3u8` beside them that points at those names. The folder can be dropped
 * onto a phone or an SD card and opened by PowerAmp or anything else that reads
 * M3U8.
 *
 * Streamed YouTube rows have no file, so they are counted and left out rather
 * than turned into dead entries. A library row whose file has vanished is
 * counted separately: that is a surprise worth showing, not a stream.
 */

export interface PlaylistCopyEntry {
  /** Index in the playlist, so the M3U keeps playlist order. */
  index: number
  trackId: number
  source: string
  /** Unique within the destination folder, case-insensitively. */
  fileName: string
}

export interface PlaylistCopyPlan {
  entries: PlaylistCopyEntry[]
  /** Rows with no file at all: a stream, not a missing file. */
  streamed: number
}

/** Name collisions are resolved with a suffix, before the extension. */
function uniqueFileName(original: string, used: Set<string>): string {
  let candidate = original
  let suffix = 2
  while (used.has(candidate.toLowerCase())) {
    const extension = extname(original)
    const stem = original.slice(0, original.length - extension.length)
    candidate = `${stem} (${suffix})${extension}`
    suffix += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}

/**
 * Turns a playlist into copy instructions without touching the disk.
 *
 * Kept separate from the copy itself so the naming rules are testable and so
 * the confirmation dialog can count the work before anything is written.
 */
export function planPlaylistCopy(detail: PlaylistDetail): PlaylistCopyPlan {
  const used = new Set<string>()
  const entries: PlaylistCopyEntry[] = []
  let streamed = 0

  detail.items.forEach((item, index) => {
    const source = item.track.filePath
    if (!source) {
      streamed += 1
      return
    }
    entries.push({
      index,
      trackId: item.track.id,
      source,
      fileName: uniqueFileName(basename(source), used)
    })
  })

  return { entries, streamed }
}

/**
 * Copies the playlist's files and writes the `.m3u8` that names them.
 *
 * One bad file does not abandon the rest: the copy is a transfer of a library,
 * and 39 of 40 tracks on the phone is more useful than an error box. The result
 * says exactly what happened, and the playlist only lists files that exist.
 */
export async function copyPlaylistToFolder(
  detail: PlaylistDetail,
  folder: string,
  onProgress?: (done: number, total: number) => void
): Promise<PlaylistCopyResult> {
  const plan = planPlaylistCopy(detail)
  if (plan.entries.length === 0) {
    throw new Error(
      plan.streamed > 0
        ? 'This playlist only has streamed tracks, so there are no files to copy.'
        : 'This playlist has no tracks to copy.'
    )
  }

  await mkdir(folder, { recursive: true })

  const written = new Map<number, string>()
  let missing = 0
  let failed = 0
  let firstFailure: string | null = null
  let done = 0

  for (const entry of plan.entries) {
    const target = join(folder, entry.fileName)
    try {
      // Re-exporting to the folder the files already live in should be a no-op,
      // not a copy onto itself, which some filesystems refuse.
      if (resolve(entry.source).toLowerCase() !== resolve(target).toLowerCase()) {
        await copyFile(entry.source, target)
      }
      written.set(entry.index, entry.fileName)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        missing += 1
      } else {
        failed += 1
        firstFailure ??= error instanceof Error ? error.message : String(error)
      }
      // A failed copy may have left a partial file behind; it must not appear in
      // the playlist or look like a good track on the phone.
      await rm(target, { force: true }).catch(() => undefined)
    }
    done += 1
    onProgress?.(done, plan.entries.length)
  }

  if (written.size === 0) {
    if (missing === plan.entries.length) {
      throw new Error('None of the files in this playlist could be found on disk.')
    }
    throw new Error(`The playlist could not be copied. ${firstFailure ?? 'The folder could not be written.'}`)
  }

  const playlistFile = join(folder, `${sanitizeFilePart(detail.playlist.name, 'playlist')}.m3u8`)
  await writeFile(
    playlistFile,
    exportPlaylistM3UForFolder(detail, (index) => written.get(index) ?? null),
    'utf8'
  )

  return {
    folder,
    playlistFile,
    copied: written.size,
    streamed: plan.streamed,
    missing,
    failed
  }
}
