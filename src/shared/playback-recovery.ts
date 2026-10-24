import type { SourceKind } from './types'

/**
 * How long to wait before each automatic attempt to reconnect a stream.
 *
 * The sequence is deliberately short at the start (a dropped Wi-Fi packet should
 * not be a visible event) and long at the end (a genuine outage should not turn
 * into a request storm). After the last delay the player stops and asks the
 * listener to press play; regaining connectivity retries immediately anyway.
 */
export const PLAYBACK_RECOVERY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000] as const

/** `null` once the retry budget is spent. */
export function recoveryDelayMs(attempt: number): number | null {
  if (!Number.isFinite(attempt) || attempt < 0) return PLAYBACK_RECOVERY_DELAYS_MS[0]
  return PLAYBACK_RECOVERY_DELAYS_MS[Math.floor(attempt)] ?? null
}

/** `MediaError` codes, duplicated here because this module also runs in tests. */
export const MEDIA_ERROR_ABORTED = 1
export const MEDIA_ERROR_NETWORK = 2
export const MEDIA_ERROR_DECODE = 3
export const MEDIA_ERROR_SRC_NOT_SUPPORTED = 4

/**
 * Whether an element error is worth retrying.
 *
 * A network interruption is retryable. A custom protocol answering 502/503 is
 * reported by Chromium as "source not supported", so that is retryable for a
 * stream as well -- but not for a local file, where the same code means a codec
 * this build genuinely cannot play. Decode and abort errors never recover by
 * reloading the same bytes.
 */
export function shouldRecoverPlayback(
  code: number | null,
  sourceKind: SourceKind | null,
  wantsPlay: boolean
): boolean {
  if (!wantsPlay || sourceKind !== 'youtube') return false
  return code === MEDIA_ERROR_NETWORK || code === MEDIA_ERROR_SRC_NOT_SUPPORTED
}
