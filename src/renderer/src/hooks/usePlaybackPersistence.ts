import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { PlaybackSnapshot } from '@shared/types'
import { api, messageOf } from '../api'
import type { UsePlayerResult } from './usePlayer'

/**
 * How often a moving position reaches the database.
 *
 * A queue change is written immediately; a position is not worth a disk write
 * four times a second, and losing four seconds of position in a crash is the
 * least interesting thing that would be lost. Changing track, pausing or
 * emptying the queue all change the snapshot's identity and are written at once.
 */
const SAVE_INTERVAL_MS = 5_000

/**
 * Remembers what was playing, and puts it back on the next start.
 *
 * The restore is silent by default: the track is loaded and seeked, then left
 * paused. Opening the app is not a request to make noise, and starting paused
 * also means a resume can never fight with a user who opened the app to do
 * something else. The user can opt into autoplay in Behaviour.
 *
 * Saving is fire-and-forget. The renderer is the only side that knows the
 * position, and the one moment the position matters most — the window closing —
 * is the one moment there is no time to await a reply.
 */
export function usePlaybackPersistence(
  player: UsePlayerResult,
  resumePlayback: boolean | undefined
): void {
  /** False until the saved state has been read, so an empty start cannot erase it. */
  const armedRef = useRef(false)
  /** Set once a saved queue was actually restored; later setting changes must not replay it. */
  const restoreStartedRef = useRef(false)
  const lastWriteRef = useRef(0)
  const lastIdentityRef = useRef('')
  const queueLengthRef = useRef(0)
  const snapshotRef = useRef<PlaybackSnapshot>({ trackIds: [], index: -1, positionMs: 0 })

  const { queue, index, positionMs, isPlaying } = player

  // Stream tracks live only in this session: they have no database row, and the
  // signed CDN URL behind them is gone by the next start. Writing their queue
  // would overwrite a resumable local queue with ids that `load` must drop.
  // Until remote tracks get real rows (M5), the last local queue is kept.
  const hasStreamTrack = queue.some((track) => track.sourceKind !== 'local')

  // Identity is everything except the position: joining a large queue is not
  // something to do on every timeupdate.
  const identity = useMemo(
    () => `${queue.map((track) => track.id).join(',')}|${index}|${isPlaying ? 'playing' : 'paused'}`,
    [queue, index, isPlaying]
  )

  const write = useCallback((force: boolean): void => {
    if (!armedRef.current) return
    if (hasStreamTrack) return
    const snapshot = snapshotRef.current
    const changed = lastIdentityRef.current !== identity || lastIdentityRef.current === ''
    const now = Date.now()
    if (!force && !changed && now - lastWriteRef.current < SAVE_INTERVAL_MS) return

    lastWriteRef.current = now
    lastIdentityRef.current = identity
    if (snapshot.trackIds.length === 0) api.clearPlayback()
    else api.savePlayback(snapshot)
  }, [identity, hasStreamTrack])

  // Read the saved queue once, after settings have arrived. Waiting for
  // `resumePlayback` keeps the restore from guessing before the preference is
  // known; the guard preserves the one-time nature if the setting changes later.
  useEffect(() => {
    if (resumePlayback === undefined) return undefined
    let cancelled = false

    void (async () => {
      try {
        const saved = await api.loadPlayback()
        if (cancelled || !saved || restoreStartedRef.current) return
        // If something is already queued, the user beat the restore to it and
        // their choice wins.
        if (queueLengthRef.current > 0) {
          restoreStartedRef.current = true
          return
        }
        restoreStartedRef.current = true
        player.restore(saved.tracks, saved.index, saved.positionMs, resumePlayback)
      } catch (cause) {
        // A broken snapshot must not stop the app from starting; the next save
        // replaces it with something sane.
        console.warn('could not restore playback:', messageOf(cause))
      } finally {
        if (!cancelled) armedRef.current = true
      }
    })()

    return () => {
      cancelled = true
    }
    // Restoring is a one-time action; re-running it would fight the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resumePlayback])

  useEffect(() => {
    snapshotRef.current = {
      trackIds: queue.map((track) => track.id),
      index,
      positionMs: Math.round(positionMs)
    }
    queueLengthRef.current = queue.length
    write(false)
  }, [queue, index, positionMs, identity, write])

  // The window is about to go away: this is the last chance to say where the
  // track was, and the throttle must not swallow it.
  useEffect(() => {
    const flush = (): void => write(true)
    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('pagehide', flush)
    }
  }, [write])
}
