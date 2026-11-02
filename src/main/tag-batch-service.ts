import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { tagBatchChanges, tagBatchFields } from '@shared/tag-batch'
import type {
  TagBatchApplyResult,
  TagBatchFailure,
  TagBatchItem,
  TagBatchMatch,
  TagBatchMode,
  TagBatchProgress,
  TagBatchSnapshot,
  TagBatchUndoResult,
  TagCandidate,
  TagLookupQuery,
  TagLookupResult,
  TagProviderReport,
  Track
} from '@shared/types'
import type { Logger } from '@core/logging/logger'
import type { LibraryService } from '@core/library/library-service'
import type { TagLookup } from '@core/library/tag-lookup'
import type { TrackRepository } from '@core/library/track-repository'

/**
 * Fixes the tags of a selection, in two passes.
 *
 * The scan is the slow half: every track is looked up by its own title, artist
 * and length, and the match's differences from the row are computed here. The
 * candidate stays in the main process until the review dialog returns the items
 * the user accepted, so a large selection does not push every candidate through
 * IPC just to draw a list of titles.
 *
 * Nothing is written during the scan. Applying re-reads each row and recomputes
 * the write for the chosen mode, so a row edited between the scan and the write
 * cannot be overwritten by a stale decision. Every write records the backup the
 * tag writer took, and undo puts each file back from it — but only while the
 * file still holds the bytes the batch wrote, because a file edited afterwards
 * is the user's, not the batch's.
 */
export interface TagBatchServiceOptions {
  repo: TrackRepository
  library: LibraryService
  tagLookup: TagLookup
  log: Logger
  onProgress: (progress: TagBatchProgress) => void
}

interface AppliedItem {
  itemId: string
  trackId: number
  title: string
  /** The pre-write backup, or null when the writer could not take one. */
  backupPath: string | null
  /** The row's mtime right after the write, to notice a later edit. */
  fileMtimeMs: number | null
}

interface BatchJob {
  id: string
  items: TagBatchItem[]
  /** The full candidate per item id; the snapshot only carries summaries. */
  candidates: Map<string, TagCandidate>
  snapshot: TagBatchSnapshot | null
  cancelled: boolean
  applied: AppliedItem[]
}

/** How many finished jobs are kept for review and undo. */
const JOB_KEEP = 5

export class TagBatchService {
  private readonly jobs = new Map<string, BatchJob>()

  constructor(private readonly options: TagBatchServiceOptions) {}

  /**
   * Starts a scan and returns at once.
   *
   * Progress arrives on the event, and `get` returns the finished snapshot. A
   * stream is not a file, so its id is dropped here rather than scanned and
   * skipped: a batch writes tags into files, and a stream has none.
   */
  start(trackIds: number[]): { jobId: string } {
    const ids = [...new Set(trackIds.filter((id) => Number.isInteger(id) && id > 0))]
    if (ids.length === 0) throw new Error('Choose at least one track to fix tags for.')

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
      this.options.log.warn('tag batch scan failed', error)
      job.snapshot = { jobId: job.id, items: job.items, providers: [], message: messageOf(error) }
      this.emit(job, 'review', job.items.length, job.items.length, null)
    })
    return { jobId: job.id }
  }

  /** The finished scan, or null while it is still running or was cancelled. */
  get(jobId: string): TagBatchSnapshot | null {
    return this.jobs.get(jobId)?.snapshot ?? null
  }

  /** Stops before the next track; the dialog that asked is closing. */
  cancel(jobId: string): void {
    const job = this.jobs.get(jobId)
    if (job) job.cancelled = true
  }

  /**
   * Writes the accepted matches.
   *
   * `mode` decides what may be written: `fill` touches only empty fields,
   * `replace` also overwrites a value the match disagrees with. The fields are
   * recomputed from the live row rather than taken from the scan, so a row that
   * gained a value in the meantime is not written over. `canWriteFile` is the
   * live playback guard: Windows will not replace a file that is open for
   * playback, and the result says so instead of failing the whole batch.
   */
  async apply(
    jobId: string,
    itemIds: string[],
    mode: TagBatchMode,
    canWriteFile: (trackId: number) => boolean = () => true
  ): Promise<TagBatchApplyResult> {
    const job = this.jobs.get(jobId)
    if (!job || !job.snapshot) throw new Error('That tag batch is no longer open.')

    const wanted = new Set(itemIds)
    const result: TagBatchApplyResult = { jobId, written: 0, skipped: 0, failed: [] }
    const already = new Set(job.applied.map((entry) => entry.itemId))

    for (const item of job.items) {
      if (!wanted.has(item.id) || already.has(item.id)) continue
      const candidate = job.candidates.get(item.id)
      if (!candidate) continue

      const track = this.options.repo.getById(item.trackId)
      if (!track) {
        result.failed.push(failureOf(item, 'That track is no longer in the library.'))
        continue
      }

      const fields = tagBatchFields(tagBatchChanges(track, candidate), mode)
      if (Object.keys(fields).length === 0) {
        // Nothing in this mode: the review should have left it unticked, and
        // this is the honest answer if it did not.
        result.skipped += 1
        continue
      }

      if (!canWriteFile(item.trackId)) {
        result.failed.push(failureOf(item, 'Not written: the file is open for playback.'))
        continue
      }

      try {
        const written = await this.options.library.writeTags(item.trackId, fields, undefined, {
          notify: false
        })
        result.written += 1
        job.applied.push({
          itemId: item.id,
          trackId: item.trackId,
          title: item.title,
          backupPath: written.backupPath,
          fileMtimeMs: written.fileMtimeMs
        })
      } catch (error) {
        result.failed.push(failureOf(item, messageOf(error)))
      }
    }

    // One refresh for the whole batch: the library list would otherwise reload
    // once per file while the dialog is still open.
    this.options.library.notifyChanged()
    this.options.log.debug('tag batch applied', {
      jobId,
      mode,
      written: result.written,
      skipped: result.skipped,
      failed: result.failed.length
    })
    return result
  }

  /**
   * Reverses everything this job wrote.
   *
   * A file is restored from its backup, but only while its mtime still matches
   * the one recorded right after the batch wrote it: a file edited since is the
   * user's, and putting the old bytes back would silently discard that edit.
   * Undo is one-shot: the list is cleared first, so a second press cannot
   * restore an older backup over a file that has since been edited.
   */
  async undo(jobId: string): Promise<TagBatchUndoResult> {
    const job = this.jobs.get(jobId)
    if (!job) throw new Error('That tag batch is no longer open.')

    const result: TagBatchUndoResult = { jobId, restored: 0, skipped: 0, failed: [] }
    const applied = job.applied.reverse()
    job.applied = []

    for (const entry of applied) {
      if (!entry.backupPath) {
        result.skipped += 1
        continue
      }

      const track = this.options.repo.getById(entry.trackId)
      if (!track) {
        result.failed.push({
          trackId: entry.trackId,
          title: entry.title,
          message: 'That track is no longer in the library.'
        })
        continue
      }
      if (entry.fileMtimeMs !== null) {
        const current = track.filePath
          ? await stat(track.filePath).then(
              (info) => Math.trunc(info.mtimeMs),
              () => null
            )
          : null
        if (current !== entry.fileMtimeMs) {
          result.skipped += 1
          continue
        }
      }

      try {
        await this.options.library.restoreTags(entry.trackId, entry.backupPath, { notify: false })
        result.restored += 1
      } catch (error) {
        result.failed.push({
          trackId: entry.trackId,
          title: entry.title,
          message: messageOf(error)
        })
      }
    }

    this.options.library.notifyChanged()
    this.options.log.debug('tag batch undone', {
      jobId,
      restored: result.restored,
      skipped: result.skipped,
      failed: result.failed.length
    })
    return result
  }

  private async scan(job: BatchJob): Promise<void> {
    const total = job.items.length
    const providers = new Map<string, { ok: boolean; message: string | null; count: number }>()
    const failures = new Set<string>()
    let scanned = 0
    let lookups = 0
    let answered = 0

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
        const found = await this.options.tagLookup.lookup(queryOf(track))
        lookups += 1
        const failure = this.collectProviders(providers, found, failures)
        if (failure === null) answered += 1

        const best = found.candidates[0] ?? null
        if (!best) {
          item.status = 'no-match'
          item.message = failure ?? 'No close match.'
        } else {
          const changes = tagBatchChanges(track, best)
          if (changes.length === 0) {
            item.status = 'skipped'
            item.message = 'Tags already match.'
          } else {
            job.candidates.set(item.id, best)
            item.status = 'match'
            item.match = summaryOf(best, changes)
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
      provider: provider as TagProviderReport['provider'],
      ok: value.ok,
      message: value.message,
      count: value.count
    }))
    // A sentence about the services, not about one track: only when no lookup
    // got an answer at all.
    const message = lookups > 0 && answered === 0 && failures.size > 0
      ? [...failures].join(' ')
      : null

    job.snapshot = { jobId: job.id, items: job.items, providers: reports, message }
    this.options.log.debug('tag batch scanned', {
      jobId: job.id,
      total,
      matches: job.candidates.size,
      skipped: job.items.filter((item) => item.status === 'skipped').length
    })
    this.emit(job, 'review', scanned, total, null)
  }

  /**
   * Folds one lookup's reports into the scan totals, and returns the sentence
   * to show for that track when every provider failed.
   */
  private collectProviders(
    into: Map<string, { ok: boolean; message: string | null; count: number }>,
    found: TagLookupResult,
    failures: Set<string>
  ): string | null {
    let anyOk = false
    const messages: string[] = []
    for (const report of found.providers) {
      const entry = into.get(report.provider) ?? { ok: true, message: null, count: 0 }
      entry.count += report.count
      if (report.ok) anyOk = true
      else {
        entry.ok = false
        entry.message ??= report.message
        if (report.message) {
          messages.push(report.message)
          failures.add(report.message)
        }
      }
      into.set(report.provider, entry)
    }
    return anyOk || messages.length === 0 ? null : [...new Set(messages)].join(' ')
  }

  private placeholder(trackId: number): TagBatchItem {
    const track = this.options.repo.getById(trackId)
    return {
      id: `track:${trackId}`,
      trackId,
      title: track?.title ?? 'Unknown track',
      artist: track?.artist ?? null,
      album: track?.album ?? null,
      status: 'no-match',
      message: null,
      match: null
    }
  }

  private emit(
    job: BatchJob,
    phase: TagBatchProgress['phase'],
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

/** What the finder searches with: the row's own values. */
function queryOf(track: Track): TagLookupQuery {
  return {
    title: track.title,
    artist: track.artist,
    album: track.album,
    durationMs: track.durationMs
  }
}

function summaryOf(
  candidate: TagCandidate,
  changes: TagBatchMatch['changes']
): TagBatchMatch {
  return {
    provider: candidate.provider,
    providerId: candidate.providerId,
    title: candidate.title,
    artist: candidate.artist,
    album: candidate.album,
    year: candidate.year,
    durationMs: candidate.durationMs,
    score: candidate.score,
    confidence: candidate.confidence,
    changes
  }
}

function failureOf(item: TagBatchItem, message: string): TagBatchFailure {
  return { trackId: item.trackId, title: item.title, message }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error)
}
