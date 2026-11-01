/**
 * A small queue for outbound requests.
 *
 * Every remote service the app talks to has an opinion about how fast it may be
 * asked. Firing a search, a resolve and a prefetch in the same tick is exactly
 * the pattern a bot check is meant to catch, so starts are paced instead of
 * being left to the event loop.
 *
 * The queue is deliberately generic and lives in `core` because it is not about
 * any one client: `YtDlpClient` gives playback metadata and downloads separate
 * schedulers, because a download can hold its slot for minutes and must never
 * sit in front of a play request, and the lyrics providers each get their own so
 * one slow service cannot spend another's budget.
 */

export interface RequestSchedulerOptions {
  /** How many jobs may run at once. */
  maxConcurrent: number
  /** Minimum quiet time between two starts, in milliseconds. */
  minGapMs?: number
  /** Extra, per-job delay up to this many milliseconds. */
  jitterMs?: number
  /** Injectable for tests. */
  now?: () => number
  random?: () => number
}

export interface ScheduleOptions {
  signal?: AbortSignal
  /** Builds the error used when the job is cancelled while still queued. */
  onAbort?: () => Error
}

interface QueuedJob {
  work: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
  signal?: AbortSignal
  onAbort?: () => Error
  abortListener?: () => void
  jitterMs: number
}

function abortError(build?: () => Error): Error {
  return build?.() ?? new Error('Request cancelled.')
}

export class RequestScheduler {
  private readonly maxConcurrent: number
  private readonly minGapMs: number
  private readonly jitterMs: number
  private readonly now: () => number
  private readonly random: () => number

  private readonly queue: QueuedJob[] = []
  private active = 0
  private lastStartAt: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(options: RequestSchedulerOptions) {
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent))
    this.minGapMs = Math.max(0, options.minGapMs ?? 0)
    this.jitterMs = Math.max(0, options.jitterMs ?? 0)
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
  }

  get pending(): number {
    return this.queue.length
  }

  get running(): number {
    return this.active
  }

  schedule<T>(work: () => Promise<T>, options: ScheduleOptions = {}): Promise<T> {
    const { signal } = options
    if (signal?.aborted) return Promise.reject(abortError(options.onAbort))

    return new Promise<T>((resolve, reject) => {
      const job: QueuedJob = {
        work: work as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        signal,
        onAbort: options.onAbort,
        jitterMs: this.jitterMs === 0 ? 0 : Math.floor(this.random() * (this.jitterMs + 1))
      }

      if (signal) {
        const abortListener = (): void => {
          const index = this.queue.indexOf(job)
          if (index < 0) return
          this.queue.splice(index, 1)
          reject(abortError(options.onAbort))
          this.pump()
        }
        job.abortListener = abortListener
        signal.addEventListener('abort', abortListener, { once: true })
      }

      this.queue.push(job)
      this.pump()
    })
  }

  private pump(): void {
    // A timer means the next start is already scheduled; adding another would
    // let two jobs cross the gap together.
    if (this.timer) return

    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const now = this.now()
      const job = this.queue[0]
      if (!job) return
      // The first job starts at once; gap and jitter only separate starts.
      const dueAt = this.lastStartAt === null ? now : this.lastStartAt + this.minGapMs + job.jitterMs
      const wait = dueAt - now
      if (wait > 0) {
        this.timer = setTimeout(() => {
          this.timer = null
          this.pump()
        }, wait)
        return
      }

      this.queue.shift()
      this.active += 1
      this.lastStartAt = now
      void this.execute(job)
    }
  }

  private async execute(job: QueuedJob): Promise<void> {
    try {
      job.resolve(await job.work())
    } catch (error) {
      job.reject(error)
    } finally {
      this.active -= 1
      if (job.signal && job.abortListener) {
        job.signal.removeEventListener('abort', job.abortListener)
      }
      this.pump()
    }
  }
}
