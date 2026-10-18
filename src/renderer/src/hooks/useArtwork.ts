import { useEffect, useState } from 'react'
import type { Track } from '@shared/types'
import { api } from '../api'

/**
 * Answers already received this session, including negative ones.
 *
 * A list is windowed but scrolls constantly, so rows mount and unmount the whole
 * time. Without this map, scrolling up and down would re-ask the main process
 * about the same tracks forever; with it, each track id costs at most one round
 * trip per session.
 */
const resolved = new Map<number, string | null>()

/** Requests in flight, so a track visible in several places is asked about once. */
const inFlight = new Map<number, Promise<string | null>>()

function request(trackId: number): Promise<string | null> {
  const existing = inFlight.get(trackId)
  if (existing) return existing
  const work = api
    .getArtwork(trackId)
    .catch(() => null)
    .then((key) => {
      resolved.set(trackId, key)
      inFlight.delete(trackId)
      return key
    })
  inFlight.set(trackId, work)
  return work
}

/**
 * Resolves the cover art for a track.
 *
 * A track that already carries a key needs no round trip at all; only tracks the
 * artwork service has not looked at yet are requested, and the answer is cached
 * here afterwards. The result is paired with the id it belongs to so switching
 * tracks never shows the previous track's cover for a frame.
 */
export function useArtwork(track: Track | null): string | null {
  const embedded = track?.artworkKey ?? null
  const trackId = track?.id ?? null
  const [looked, setLooked] = useState<{ id: number; key: string | null } | null>(null)

  useEffect(() => {
    if (trackId === null || embedded) return

    const known = resolved.get(trackId)
    if (known !== undefined) {
      setLooked({ id: trackId, key: known })
      return
    }

    let cancelled = false
    void request(trackId).then((key) => {
      if (!cancelled) setLooked({ id: trackId, key })
    })
    return () => {
      cancelled = true
    }
  }, [trackId, embedded])

  if (embedded) return embedded
  return looked && looked.id === trackId ? looked.key : null
}
