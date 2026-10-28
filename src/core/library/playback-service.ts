import type { PlaybackSnapshot, SavedPlayback } from '@shared/types'
import type { PlayStateRepository } from './play-state-repository'
import type { TrackRepository } from './track-repository'

/** A resumed position this close to the end is treated as "start of the track". */
const END_MARGIN_MS = 2_000

/**
 * Saves and restores what was playing.
 *
 * The interesting work is all in `load`. A saved queue names tracks by id, and
 * between sessions the library can change: a file can be deleted, or a folder
 * removed. What comes back has to be a queue that can actually be played, which
 * means dropping rows that are gone and moving the cursor to a track that still
 * exists — a restore that hands the renderer an index pointing at nothing would
 * show an empty player over a full queue.
 */
export class PlaybackService {
  constructor(
    private readonly state: PlayStateRepository,
    private readonly tracks: TrackRepository
  ) {}

  load(): SavedPlayback | null {
    const saved = this.state.read()
    if (!saved) return null

    const tracks = this.tracks.byIds(saved.trackIds)
    if (tracks.length === 0) {
      // Everything in the saved queue has been pruned. Keeping the row would
      // mean failing the same way on every start, so it goes.
      this.state.clear()
      return null
    }

    const currentId = saved.trackIds[saved.index]
    const found = currentId === undefined ? -1 : tracks.findIndex((track) => track.id === currentId)
    const index = found >= 0 ? found : 0

    // Resuming a second before the end just plays the end and stops, which reads
    // as a bug. The margin also covers a track whose stored duration is wrong.
    const duration = tracks[index]?.durationMs ?? null
    const limit = duration !== null && duration > END_MARGIN_MS ? duration - END_MARGIN_MS : null
    const positionMs = found >= 0 ? (limit === null ? saved.positionMs : Math.min(saved.positionMs, limit)) : 0

    return { tracks, index, positionMs }
  }

  save(snapshot: PlaybackSnapshot, now: number): void {
    if (snapshot.trackIds.length === 0) {
      this.state.clear()
      return
    }
    this.state.write(snapshot, now)
  }

  clear(): void {
    this.state.clear()
  }
}
