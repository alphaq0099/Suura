/** A track counts as played once it is finished or has been listened to this long. */
export const PLAY_COUNT_THRESHOLD_MS = 30_000

/** Whether a playback report crosses the point where the listen counts. */
export function countsAsPlay(playedMs: number, completed: boolean): boolean {
  return completed || (Number.isFinite(playedMs) && playedMs >= PLAY_COUNT_THRESHOLD_MS)
}

/**
 * Remembers which track's current listen has already been counted.
 *
 * The player reports twice per listen: once the moment it crosses the
 * threshold, so Recently played updates while the track is still playing, and
 * once when the track ends or is replaced, to carry the final position. Only
 * the first of those may increment the play count.
 */
export class PlaySession {
  private countedTrackId: number | null = null

  /** Starts a fresh listen, for a new track or a replay of the current one. */
  begin(): void {
    this.countedTrackId = null
  }

  /** False when this listen has already been counted and must not be sent again. */
  shouldReport(trackId: number, playedMs: number, completed: boolean): boolean {
    if (this.countedTrackId === trackId) return false
    if (countsAsPlay(playedMs, completed)) this.countedTrackId = trackId
    return true
  }
}
