/**
 * One rate-limit answer, handled once.
 *
 * Every remote service the app asks has the same failure mode: it says "not
 * now" with a 429, or "not yet" with a 502/503, and means it. Pacing the starts
 * (see `RequestScheduler`) keeps the app from causing that answer; this handles
 * the answer itself, because the pace a batch needs is the one the service
 * states, not the one guessed before the first reply.
 *
 * The policy is deliberately small: one retry per request, a wait taken from
 * `Retry-After` when the service sends one, otherwise a short doubling backoff,
 * and a ceiling so a bad header cannot stall a batch. A second failure is the
 * answer: the finder reports the sentence and moves on rather than spending the
 * user's selection on a service that is closed.
 */

/** Statuses that mean "later", not "no". */
const RETRYABLE_STATUSES = new Set([429, 502, 503])

/** Total attempts per request: the first one plus a single retry. */
export const PROVIDER_ATTEMPTS = 2

/** The first fallback wait, doubled per attempt, when no header says otherwise. */
export const PROVIDER_BACKOFF_MS = 400

/** A ceiling on both the header and the backoff, so a batch stays cancellable. */
export const PROVIDER_MAX_WAIT_MS = 5_000

/**
 * `Retry-After` in milliseconds, or null when the header is absent or unusable.
 *
 * The header is either delta-seconds or an HTTP date. Both forms appear in the
 * wild, and a garbage value is a missing value rather than an exception.
 */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  const text = header?.trim()
  if (!text) return null
  if (/^\d+$/.test(text)) return Number(text) * 1000
  const at = Date.parse(text)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - now)
}

/**
 * How long to wait before retrying this response, or null when it is not a
 * rate-limit answer at all. `attempt` is one-based.
 */
export function retryWaitMs(
  status: number,
  headers: Headers | null,
  attempt: number,
  now = Date.now()
): number | null {
  if (!RETRYABLE_STATUSES.has(status)) return null
  const asked = retryAfterMs(headers?.get('retry-after') ?? null, now)
  const backoff = PROVIDER_BACKOFF_MS * 2 ** Math.max(0, attempt - 1)
  return Math.min(PROVIDER_MAX_WAIT_MS, Math.max(0, asked ?? backoff))
}

export interface ProviderRetryOptions {
  /**
   * Called with the wait before the next attempt (and again after the last,
   * so the provider's whole queue keeps its distance from a service that just
   * asked for one).
   */
  onCooldown?: (ms: number) => void
  /** Total attempts; the default is `PROVIDER_ATTEMPTS`. */
  attempts?: number
  /** Injectable for tests. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Runs one request, retrying it once when the service answers "later".
 *
 * The last response is returned even when it is still a failure: deciding what
 * a 429 means belongs to the caller that knows the provider's sentences. A
 * thrown error (offline, timeout) is not retried here — those already have a
 * deadline, and asking again would only spend it twice.
 */
export async function withProviderRetry(
  request: () => Promise<Response>,
  options: ProviderRetryOptions = {}
): Promise<Response> {
  const attempts = Math.max(1, Math.floor(options.attempts ?? PROVIDER_ATTEMPTS))
  const now = options.now ?? (() => Date.now())
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))

  for (let attempt = 1; ; attempt += 1) {
    const response = await request()
    const wait = retryWaitMs(response.status, response.headers, attempt, now())
    if (wait === null) return response
    options.onCooldown?.(wait)
    if (attempt >= attempts) return response
    if (wait > 0) await sleep(wait)
  }
}
