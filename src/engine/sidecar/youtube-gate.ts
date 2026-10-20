import { isYouTubeBotCheck } from '@shared/youtube'

/**
 * A circuit breaker for YouTube's "confirm you're not a bot" page.
 *
 * A bot check is not an ordinary failure: retrying it immediately makes the
 * next one more likely. When one is seen, all new sidecar requests pause for a
 * few minutes. A second check soon after doubles the pause; a quiet period
 * clears the strike count. Cached resolves are unaffected, so the user can keep
 * playing music that was already warmed.
 */

export interface YouTubeGateOptions {
  now?: () => number
  /** First cooldown after a bot check. */
  cooldownMs?: number
  /** Cooldown after a second check inside the strike window. */
  longCooldownMs?: number
  /** How close two checks must be to count as a repeat. */
  strikeWindowMs?: number
}

const DEFAULT_COOLDOWN_MS = 5 * 60_000
const DEFAULT_LONG_COOLDOWN_MS = 15 * 60_000
const DEFAULT_STRIKE_WINDOW_MS = 30 * 60_000

export class YouTubeCooldownError extends Error {
  constructor(
    message: string,
    readonly retryAt: number
  ) {
    super(message)
    this.name = 'YouTubeCooldownError'
  }
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const detail = (error as Error & { detail?: unknown }).detail
  return `${error.message}\n${typeof detail === 'string' ? detail : ''}`
}

export class YouTubeGate {
  private readonly now: () => number
  private readonly cooldownMs: number
  private readonly longCooldownMs: number
  private readonly strikeWindowMs: number

  private blockedUntil = 0
  private strikes = 0
  private lastCheckAt = 0

  constructor(options: YouTubeGateOptions = {}) {
    this.now = options.now ?? Date.now
    this.cooldownMs = Math.max(0, options.cooldownMs ?? DEFAULT_COOLDOWN_MS)
    this.longCooldownMs = Math.max(this.cooldownMs, options.longCooldownMs ?? DEFAULT_LONG_COOLDOWN_MS)
    this.strikeWindowMs = Math.max(0, options.strikeWindowMs ?? DEFAULT_STRIKE_WINDOW_MS)
  }

  /** Throws before a sidecar is started while the cooldown is active. */
  assertReady(): void {
    const remaining = this.blockedUntil - this.now()
    if (remaining <= 0) return
    const minutes = Math.max(1, Math.ceil(remaining / 60_000))
    const unit = minutes === 1 ? 'minute' : 'minutes'
    throw new YouTubeCooldownError(
      `YouTube asked for a sign-in check or rate limit. New YouTube requests are paused for about ${minutes} more ${unit}. Cached tracks still play, and the app never signs in.`,
      this.blockedUntil
    )
  }

  /** Records a failure; only a bot check changes the gate. */
  recordFailure(error: unknown): void {
    if (!isYouTubeBotCheck(errorText(error))) return

    const now = this.now()
    this.strikes = now - this.lastCheckAt <= this.strikeWindowMs ? this.strikes + 1 : 1
    this.lastCheckAt = now
    const cooldown = this.strikes >= 2 ? this.longCooldownMs : this.cooldownMs
    this.blockedUntil = Math.max(this.blockedUntil, now + cooldown)
  }

  /** Milliseconds until requests are allowed again; `0` when ready. */
  remainingMs(): number {
    return Math.max(0, this.blockedUntil - this.now())
  }

  status(): { blocked: boolean; blockedUntil: number; strikes: number } {
    return { blocked: this.remainingMs() > 0, blockedUntil: this.blockedUntil, strikes: this.strikes }
  }
}
