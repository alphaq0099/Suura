import type { TagArtworkWrite } from '@core/library/library-service'
import type { Logger } from '@core/logging/logger'
import type { PendingWriteKind, PendingWriteNotice, TrackTagFields } from '@shared/types'

export interface PendingWritesOptions {
  log: Logger
  /** Called when a write succeeds, or after repeated failures, never per retry. */
  onResult?: (notice: PendingWriteNotice) => void
  /** Wall clock, injectable so a test can reach the report window without waiting. */
  now?: () => number
}

interface PendingWrite {
  trackId: number
  kind: PendingWriteKind
  run: () => Promise<unknown>
  attempts: number
  /** When the first attempt failed, so a quick retry is not announced. */
  firstFailedAt: number | null
  /** A persistent failure is reported once, not on every retry. */
  reported: boolean
}

export interface PendingWriteFlush {
  /** Entries written during this drain. */
  written: number
  /** Entries still failing when the drain gave up; they stay queued. */
  failed: number
  /** Everything still queued, including writes waiting for playback to end. */
  remaining: number
}

/** A failed write is reported after this many attempts, not on every pause. */
const REPORT_AFTER = 3

/**
 * And only once it has been failing for this long.
 *
 * A drain retries a locked file a few times within a second, so attempts alone
 * would turn a momentary lock — the case the queue exists for — into an error
 * banner the user has to dismiss.
 */
const REPORT_GRACE_MS = 15_000

/**
 * How many times one drain retries a write whose file was still busy.
 *
 * The expected failure is transient: Windows can hold a file for a moment
 * after the media element lets go, and the next playback change may be hours
 * away. Retrying within the same drain means a write that was deferred while
 * listening lands when the user stops, rather than at some later track change.
 */
const RETRY_ATTEMPTS = 3
const RETRY_DELAY_MS = 300

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
 * still holding the file — pausing does not necessarily close it — so the same
 * drain retries a few times while the file settles, and a later playback state
 * change tries again after that. A real, permanent failure is reported once,
 * after a few attempts spread over a grace period, so a moment's lock stays
 * quiet and the UI can still say something about a file that will not take a
 * write at all.
 */
export class PendingWrites {
  private readonly entries = new Map<string, PendingWrite>()
  private running: Promise<PendingWriteFlush> | null = null
  /** A playback change arrived while a pass was running, so another is owed. */
  private rerun = false

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
      firstFailedAt: null,
      reported: false
    })
    this.options.log.debug('write deferred until playback ends', { trackId, kind })
  }

  /**
   * Runs every queued write whose file is not in use.
   *
   * `isInUse` is asked per track, so a pending write for the track that just
   * finished can run while a different one is playing. One drain at a time: a
   * caller that arrives while a pass is running joins it and asks for one more
   * pass afterwards, because that pass read the queue before this state change
   * and may not have seen a write it freed.
   */
  flush(isInUse: (trackId: number) => boolean): Promise<PendingWriteFlush> {
    if (this.running) {
      this.rerun = true
      return this.running
    }
    const run = this.drain(isInUse)
    this.running = run
    void run.finally(() => {
      if (this.running !== run) return
      this.running = null
      if (this.rerun) {
        // A caller arrived as the last pass was finishing, so that pass read
        // the queue before this write or state change existed.
        this.rerun = false
        void this.flush(isInUse)
      }
    })
    return run
  }

  /**
   * Runs passes until the queue is quiet.
   *
   * A state change during a pass earns one more pass. A write that failed is
   * retried a few times within the same drain: the usual cause is the file
   * still being held for a moment, and waiting for an unrelated state change
   * would leave the user's edit unwritten for as long as nothing else happens.
   */
  private async drain(isInUse: (trackId: number) => boolean): Promise<PendingWriteFlush> {
    let written = 0
    let failed = 0
    let retries = 0

    for (;;) {
      this.rerun = false
      const pass = await this.runFlush(isInUse)
      written += pass.written
      failed = pass.failed
      if (this.rerun) continue
      if (pass.failed > 0 && retries < RETRY_ATTEMPTS) {
        retries += 1
        await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
        continue
      }
      break
    }

    return { written, failed, remaining: this.entries.size }
  }

  private async runFlush(isInUse: (trackId: number) => boolean): Promise<PendingWriteFlush> {
    const due = [...this.entries.values()].filter((entry) => !isInUse(entry.trackId))
    let written = 0
    let failed = 0

    for (const entry of due) {
      let notice: PendingWriteNotice | null = null
      try {
        await entry.run()
        const key = keyOf(entry.trackId, entry.kind)
        // A newer write may have been queued while this one was running; only
        // remove the entry that actually succeeded.
        if (this.entries.get(key) === entry) this.entries.delete(key)
        written += 1
        notice = { trackId: entry.trackId, kind: entry.kind, ok: true, message: null }
      } catch (error) {
        failed += 1
        entry.attempts += 1
        const now = this.clock()
        if (entry.firstFailedAt === null) entry.firstFailedAt = now
        const message = error instanceof Error && error.message ? error.message : String(error)
        this.options.log.debug('deferred write could not run yet', {
          trackId: entry.trackId,
          kind: entry.kind,
          attempts: entry.attempts,
          message
        })
        if (
          !entry.reported &&
          entry.attempts >= REPORT_AFTER &&
          now - entry.firstFailedAt >= REPORT_GRACE_MS
        ) {
          entry.reported = true
          notice = { trackId: entry.trackId, kind: entry.kind, ok: false, message }
        }
      }
      // Announced after the entry's own outcome is settled, so a listener that
      // throws cannot turn a landed write into a failure.
      if (notice) this.report(notice)
    }

    return { written, failed, remaining: this.entries.size }
  }

  private report(notice: PendingWriteNotice): void {
    try {
      this.options.onResult?.(notice)
    } catch (error) {
      this.options.log.warn('a pending-write listener threw', error)
    }
  }

  private clock(): number {
    return (this.options.now ?? Date.now)()
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
