import { useEffect, useState } from 'react'
import type { Track } from '@shared/types'
import { api } from '../api'

/**
 * Answers already received this session, including negative ones.
 *
 * A list is windowed but scrolls constantly, so rows mount and unmount the whole
 * time. Without this map, scrolling up and down would re-ask the main process
 * about the same tracks forever; with it, each track costs at most one round trip
 * per session.
 *
 * Keyed by source identity rather than row id: two imported playlists can show
 * the same video under different session ids, and one video must not reuse
 * another's picture just because both happened to be `-1`.
 */
const resolved = new Map<string, string | null>()

/** Requests in flight, so a track visible in several places is asked about once. */
const inFlight = new Map<string, Promise<string | null>>()

function identityOf(track: Track): string {
  if (track.sourceKind === 'youtube' && track.sourceId) return `youtube:${track.sourceId}`
  return `local:${track.id}`
}

interface ArtworkTarget {
  id: number
  sourceKind: Track['sourceKind']
  sourceId: string | null
}

function request(target: ArtworkTarget, identity: string): Promise<string | null> {
  const existing = inFlight.get(identity)
  if (existing) return existing
  const work = api
    .getArtwork(target)
    .catch(() => null)
    .then((key) => {
      resolved.set(identity, key)
      inFlight.delete(identity)
      return key
    })
  inFlight.set(identity, work)
  return work
}

/**
 * Resolves the cover art for a track.
 *
 * A track that already carries a key needs no round trip at all; only tracks the
 * artwork service has not looked at yet are requested, and the answer is cached
 * here afterwards. The result is paired with the identity it belongs to so
 * switching tracks never shows the previous track's cover for a frame.
 */
export function useArtwork(track: Track | null): string | null {
  const embedded = track?.artworkKey ?? null
  const identity = track ? identityOf(track) : null
  const trackId = track?.id ?? null
  const sourceKind = track?.sourceKind ?? null
  const sourceId = track?.sourceId ?? null
  const [looked, setLooked] = useState<{ identity: string; key: string | null } | null>(null)

  useEffect(() => {
    if (trackId === null || sourceKind === null || identity === null || embedded) return

    const known = resolved.get(identity)
    if (known !== undefined) {
      setLooked({ identity, key: known })
      return
    }

    let cancelled = false
    void request({ id: trackId, sourceKind, sourceId }, identity).then((key) => {
      if (!cancelled) setLooked({ identity, key })
    })
    return () => {
      cancelled = true
    }
  }, [trackId, sourceKind, sourceId, identity, embedded])

  if (embedded) return embedded
  return looked && looked.identity === identity ? looked.key : null
}
