import type { TagArtworkWrite } from '@core/library/library-service'
import type { Logger } from '@core/logging/logger'
import type { PendingWriteKind, PendingWriteNotice, TrackTagFields } from '@shared/types'

export interface PendingWritesOptions {
  log: Logger
  /** Called when a write succeeds, or after repeated failures, never per retry. */
  onResult?: (notice: PendingWriteNotice) => void
}

interface PendingWrite {
  trackId: number
  kind: PendingWriteKind
  run: () => Promise<unknown>
  attempts: number
  /** A persistent failure is reported once, not on every retry. */
  reported: boolean
}

export interface PendingWriteFlush {
  written: number
  failed: number
  remaining: number
}

/** A failed write is retried after this many attempts, not on every pause. */
const REPORT_AFTER = 3

/**
 * Writes that were postponed because their file was open for playback.
 *
 * Windows will not replace a file while the media element is reading it. The
 * user can still fetch lyrics or edit tags during playback, so the work is kept
 * here instead of being refused: the last write for a track and kind wins, and
 * the queue is drained whenever the renderer reports that the track is no
 * longer the one playing.
 *
 * A drain that fails leaves the entry in place. The expected failure is the OS
 * still holding the file — pausing does not necessarily close it — so the next
 * playback state change tries again. A real, permanent failure is reported once
 * after a few attempts so the UI can say something instead of staying silent.
 */
export class PendingWrites {
  private readonly entries = new Map<string, PendingWrite>()
  private flushing: Promise<PendingWriteFlush> | null = null

  constructor(private readonly options: PendingWritesOptions) {}

  get size(): number {
    return this.entries.size
  }

  /** True when a write for this track and kind is waiting. */
  has(trackId: number, kind: PendingWriteKind): boolean {
    return this.entries.has(keyOf(trackId, kind))
  }

  /**
   * Queues a write, replacing an earlier one for the same track and kind.
   *
   * Replacing rather than appending is the point: the second edit already
   * contains everything the first would have written, and running both would
   * rewrite the same file twice.
   */
  enqueue(trackId: number, kind: PendingWriteKind, run: () => Promise<unknown>): void {
    this.entries.set(keyOf(trackId, kind), {
      trackId,
      kind,
      run,
      attempts: 0,
      reported: false
    })
    this.options.log.debug('write deferred until playback ends', { trackId, kind })
  }

  /**
   * Runs every queued write whose file is not in use.
   *
   * `isInUse` is asked per track, so a pending write for the track that just
   * finished can run while a different one is playing. One drain at a time: a
   * second call while the first is running joins it rather than starting a
   * competing pass over the same files.
   */
  flush(isInUse: (trackId: number) => boolean): Promise<PendingWriteFlush> {
    if (this.flushing) return this.flushing
    const run = this.runFlush(isInUse)
    this.flushing = run
    void run.finally(() => {
      if (this.flushing === run) this.flushing = null
    })
    return run
  }

  private async runFlush(isInUse: (trackId: number) => boolean): Promise<PendingWriteFlush> {
    const due = [...this.entries.values()].filter((entry) => !isInUse(entry.trackId))
    let written = 0
    let failed = 0

    for (const entry of due) {
      try {
        await entry.run()
        const key = keyOf(entry.trackId, entry.kind)
        // A newer write may have been queued while this one was running; only
        // remove the entry that actually succeeded.
        if (this.entries.get(key) === entry) this.entries.delete(key)
        written += 1
        this.options.onResult?.({
          trackId: entry.trackId,
          kind: entry.kind,
          ok: true,
          message: null
        })
      } catch (error) {
        failed += 1
        entry.attempts += 1
        const message = error instanceof Error && error.message ? error.message : String(error)
        this.options.log.debug('deferred write could not run yet', {
          trackId: entry.trackId,
          kind: entry.kind,
          attempts: entry.attempts,
          message
        })
        if (!entry.reported && entry.attempts >= REPORT_AFTER) {
          entry.reported = true
          this.options.onResult?.({
            trackId: entry.trackId,
            kind: entry.kind,
            ok: false,
            message
          })
        }
      }
    }

    return { written, failed, remaining: this.entries.size }
  }
}

function keyOf(trackId: number, kind: PendingWriteKind): string {
  return `${kind}:${trackId}`
}

/** The fields and cover a queued tag write still has to apply. */
export interface DeferredTagWrite {
  fields: TrackTagFields
  artwork: TagArtworkWrite | undefined
}

/**
 * Folds a newer tag save into the one already queued for the same file.
 *
 * Both saves are patches against a row that has not changed yet, because the
 * first write is still waiting for the file to close. A field the newer save
 * did not touch would otherwise be dropped from the queue: the row never
 * received the first edit, so the second patch has no reason to mention it.
 * New values — including an explicit blank — win, and the cover is only
 * replaced when the newer save chose one.
 */
export function mergeDeferredTagWrite(
  previous: DeferredTagWrite | undefined,
  next: DeferredTagWrite
): DeferredTagWrite {
  return {
    fields: { ...(previous?.fields ?? {}), ...next.fields },
    artwork: next.artwork !== undefined ? next.artwork : previous?.artwork
  }
}
