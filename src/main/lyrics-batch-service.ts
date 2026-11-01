import { randomUUID } from 'node:crypto'
import type {
  LyricsBatchApplyResult,
  LyricsBatchFailure,
  LyricsBatchItem,
  LyricsBatchMatch,
  LyricsBatchProgress,
  LyricsBatchSnapshot,
  LyricsBatchUndoResult,
  LyricsCandidate,
  LyricsLookupResult,
  LyricsProviderReport
} from '@shared/types'
import type { Logger } from '@core/logging/logger'
import type { LyricsService } from '@core/library/lyrics-service'
import type { TrackRepository } from '@core/library/track-repository'

/**
 * Fetches lyrics for a selection, in two passes.
 *
 * The scan is the slow half: for every track it reads what the file already has
 * and, only when there is nothing, asks the providers. The candidate's text
 * stays here until the review dialog returns the items the user accepted, so a
 * large selection does not push every lyric body through IPC just to draw a
 * list of titles.
 *
 * Nothing is written during the scan. Applying stores the accepted copies, and
 * optionally writes each into its file's own tag; every file write records the
 * backup the writer took, so undo can put the file back. A stored-only copy is
 * undone by deleting the row, but only while it still holds the batch's words —
 * a lyric the user fetched again afterwards is theirs, not the batch's.
 */
export interface LyricsBatchServiceOptions {
  repo: TrackRepository
  lyrics: LyricsService
  log: Logger
  onProgress: (progress: LyricsBatchProgress) => void
}

interface AppliedItem {
  itemId: string
  trackId: number
  title: string
  /** The text the batch stored, so undo can prove nothing replaced it. */
  text: string
  /** The pre-write backup, when the batch wrote into the file. */
  backupPath: string | null
  wrote: boolean
}

interface BatchJob {
  id: string
  items: LyricsBatchItem[]
  /** The full candidate per item id; the snapshot only carries summaries. */
  candidates: Map<string, LyricsCandidate>
  snapshot: LyricsBatchSnapshot | null
  cancelled: boolean
  applied: AppliedItem[]
}

/** How many finished jobs are kept for review and undo. */
const JOB_KEEP = 5

export class LyricsBatchService {
  private readonly jobs = new Map<string, BatchJob>()

  constructor(private readonly options: LyricsBatchServiceOptions) {}

  /**
   * Starts a scan and returns at once.
   *
   * Progress arrives on the event, and `get` returns the finished snapshot. A
   * stream is not a file, so its id is dropped here rather than being scanned
   * and skipped: the batch is about files, and a stream's lyrics stay per-video
   * in the panel.
   */
  start(trackIds: number[]): { jobId: string } {
    const ids = [...new Set(trackIds.filter((id) => Number.isInteger(id) && id > 0))]
    if (ids.length === 0) throw new Error('Choose at least one track to fetch lyrics for.')

    const job: BatchJob = {
      id: randomUUID(),
      items: ids.map((trackId) => this.placeholder(trackId)),
      candidates: new Map(),
      snapshot: null,
      cancelled: false,
      applied: []
    }
    this.jobs.set(job.id, job)
    this.pruneJobs()
    void this.scan(job).catch((error: unknown) => {
      this.options.log.warn('lyrics batch scan failed', error)
      job.snapshot = { jobId: job.id, items: job.items, providers: [], message: messageOf(error) }
      this.emit(job, 'review', job.items.length, job.items.length, null)
    })
    return { jobId: job.id }
  }

  /** The finished scan, or null while it is still running or was cancelled. */
  get(jobId: string): LyricsBatchSnapshot | null {
    return this.jobs.get(jobId)?.snapshot ?? null
  }

  /** Stops before the next track; the dialog that asked is closing. */
  cancel(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (job) job.cancelled = true
  }

  /**
   * Stores the accepted matches, optionally writing each into its file.
   *
   * `canWriteFile` is the live playback guard: Windows will not replace a file
   * that is open for playback, so a track that is playing is stored but not
   * written, and the result says so. A file that fails to write is left stored,
   * which is still a result the user asked for and still undoable.
   */
  async apply(
    jobId: string,
    itemIds: string[],
    writeToFile: boolean,
    canWriteFile: (trackId: number) => boolean = () => true
  ): Promise<LyricsBatchApplyResult> {
    const job = this.jobs.get(jobId)
    if (!job || !job.snapshot) throw new Error('That lyrics batch is no longer open.')

    const wanted = new Set(itemIds)
    const result: LyricsBatchApplyResult = { jobId, stored: 0, written: 0, failed: [] }
    const already = new Set(job.applied.map((entry) => entry.itemId))

    for (const item of job.items) {
      if (!wanted.has(item.id) || already.has(item.id)) continue
      const candidate = job.candidates.get(item.id)
      if (!candidate) continue

      try {
        await this.options.lyrics.use(item.trackId, candidate)
      } catch (error) {
        result.failed.push(failureOf(item, messageOf(error)))
        continue
      }

      if (!writeToFile) {
        result.stored += 1
        job.applied.push(this.appliedEntry(item, candidate, null, false))
        continue
      }

      if (!canWriteFile(item.trackId)) {
        result.stored += 1
        result.failed.push(failureOf(item, 'Stored, but not written: the file is open for playback.'))
        job.applied.push(this.appliedEntry(item, candidate, null, false))
        continue
      }

      try {
        const { backupPath } = await this.options.lyrics.writeFetchedToFile(item.trackId)
        result.written += 1
        job.applied.push(this.appliedEntry(item, candidate, backupPath, true))
      } catch (error) {
        // The copy is still stored, so it is still shown and still undoable;
        // only the file did not take it.
        result.stored += 1
        result.failed.push(failureOf(item, `Stored, but not written: ${messageOf(error)}`))
        job.applied.push(this.appliedEntry(item, candidate, null, false))
      }
    }

    this.options.log.debug('lyrics batch applied', {
      jobId,
      stored: result.stored,
      written: result.written,
      failed: result.failed.length
    })
    return result
  }

  /**
   * Reverses everything this job applied.
   *
   * A written file is put back from its backup; a stored row is dropped only if
   * it still holds the words the batch put there. Undo is one-shot: the list is
   * cleared first, so a second press cannot restore an older backup over a file
   * that has since been edited.
   */
  async undo(jobId: string): Promise<LyricsBatchUndoResult> {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error('That lyrics batch is no longer open.')

    const result: LyricsBatchUndoResult = {
      jobId,
      removed: 0,
      restored: 0,
      skipped: 0,
      failed: []
    }
    const applied = job.applied.reverse()
    job.applied = []

    for (const entry of applied) {
      try {
        if (!entry.wrote) {
          const removed = await this.options.lyrics.forgetFetchedIfUnchanged(
            entry.trackId,
            entry.text
          )
          if (removed) result.removed += 1
          else result.skipped += 1
          continue
        }
        if (!entry.backupPath) {
          result.failed.push({
            trackId: entry.trackId,
            title: entry.title,
            message: 'This file was written, but its backup is gone.'
          })
          continue
        }
        await this.options.lyrics.restoreFromBackup(entry.trackId, entry.backupPath)
        result.restored += 1
      } catch (error) {
        result.failed.push({
          trackId: entry.trackId,
          title: entry.title,
          message: messageOf(error)
        })
      }
    }

    this.options.log.debug('lyrics batch undone', {
      jobId,
      removed: result.removed,
      restored: result.restored,
      skipped: result.skipped,
      failed: result.failed.length
    })
    return result
  }

  private async scan(job: BatchJob): Promise<void> {
    const total = job.items.length
    const providers = new Map<string, { ok: boolean; message: string | null; count: number }>()
    let scanned = 0
    let lookups = 0
    let failedLookups = 0
    const lookupMessages = new Set<string>()

    this.emit(job, 'scanning', 0, total, null)

    for (const item of job.items) {
      if (job.cancelled) return

      const track = this.options.repo.getById(item.trackId)
      if (!track || track.sourceKind !== 'local' || !track.filePath) {
        item.status = 'skipped'
        item.message = 'Not a file in the library.'
        scanned += 1
        this.emit(job, 'scanning', scanned, total, item.title)
        continue
      }

      try {
        const existing = await this.options.lyrics.read(track.id)
        if (existing) {
          item.status = 'skipped'
          item.message = 'Already has lyrics.'
        } else {
          const found = await this.options.lyrics.find(track.id)
          lookups += 1
          this.collectProviders(providers, found)
          if (found.message) {
            failedLookups += 1
            lookupMessages.add(found.message)
          }
          const best = bestCandidate(found)
          if (!best) {
            item.status = 'no-match'
            item.message = found.message ?? 'No close match.'
          } else {
            job.candidates.set(item.id, best)
            item.status = 'match'
            item.match = summaryOf(best)
            item.message = null
          }
        }
      } catch (error) {
        item.status = 'failed'
        item.message = messageOf(error)
      }

      scanned += 1
      this.emit(job, 'scanning', scanned, total, item.title)
    }

    if (job.cancelled) return

    const reports = [...providers.entries()].map(([provider, value]) => ({
      provider: provider as LyricsProviderReport['provider'],
      ok: value.ok,
      message: value.message,
      count: value.count
    }))
    // A sentence about the service, not about one track: only when every lookup
    // that ran failed, and they failed for the same reason.
    const message =
      lookups > 0 && failedLookups === lookups && lookupMessages.size === 1
        ? ([...lookupMessages][0] ?? null)
        : null

    job.snapshot = { jobId: job.id, items: job.items, providers: reports, message }
    this.options.log.debug('lyrics batch scanned', {
      jobId: job.id,
      total,
      matches: job.candidates.size,
      skipped: job.items.filter((item) => item.status === 'skipped').length
    })
    this.emit(job, 'review', scanned, total, null)
  }

  private collectProviders(
    into: Map<string, { ok: boolean; message: string | null; count: number }>,
    found: LyricsLookupResult
  ): void {
    for (const report of found.providers) {
      const entry = into.get(report.provider) ?? { ok: true, message: null, count: 0 }
      entry.count += report.count
      if (!report.ok) {
        entry.ok = false
        entry.message ??= report.message
      }
      into.set(report.provider, entry)
    }
  }

  private placeholder(trackId: number): LyricsBatchItem {
    const track = this.options.repo.getById(trackId)
    return {
      id: `track:${trackId}`,
      trackId,
      title: track?.title ?? 'Unknown track',
      artist: track?.artist ?? null,
      album: track?.album ?? null,
      durationMs: track?.durationMs ?? null,
      status: 'no-match',
      message: null,
      match: null
    }
  }

  private appliedEntry(
    item: LyricsBatchItem,
    candidate: LyricsCandidate,
    backupPath: string | null,
    wrote: boolean
  ): AppliedItem {
    return {
      itemId: item.id,
      trackId: item.trackId,
      title: item.title,
      text: candidate.text,
      backupPath,
      wrote
    }
  }

  private emit(
    job: BatchJob,
    phase: LyricsBatchProgress['phase'],
    scanned: number,
    total: number,
    currentTitle: string | null
  ): void {
    this.options.onProgress({ jobId: job.id, phase, scanned, total, currentTitle })
  }

  private pruneJobs(): void {
    while (this.jobs.size > JOB_KEEP) {
      const oldest = this.jobs.keys().next().value
      if (!oldest) return
      this.jobs.delete(oldest)
    }
  }
}

/** The best match worth proposing: scored first, and never an instrumental. */
function bestCandidate(found: LyricsLookupResult): LyricsCandidate | null {
  return (
    found.candidates.find(
      (candidate) => !candidate.instrumental && candidate.text.trim().length > 0
    ) ?? null
  )
}

function summaryOf(candidate: LyricsCandidate): LyricsBatchMatch {
  return {
    provider: candidate.provider,
    providerId: candidate.providerId,
    title: candidate.title,
    artist: candidate.artist,
    album: candidate.album,
    durationMs: candidate.durationMs,
    synced: candidate.synced,
    instrumental: candidate.instrumental,
    url: candidate.url,
    score: candidate.score,
    confidence: candidate.confidence
  }
}

function failureOf(item: LyricsBatchItem, message: string): LyricsBatchFailure {
  return { trackId: item.trackId, title: item.title, message }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}
