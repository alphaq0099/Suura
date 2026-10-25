import { useEffect, useState } from 'react'
import type { ArtworkRequest } from '@shared/ipc'
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

function identityOf(target: ArtworkTarget): string {
  if (target.sourceKind === 'youtube' && target.sourceId) return `youtube:${target.sourceId}`
  return `local:${target.id}`
}

interface ArtworkTarget {
  id: number
  sourceKind: Track['sourceKind']
  sourceId: string | null
}

function targetOf(request: ArtworkRequest): ArtworkTarget {
  if (typeof request === 'number') return { id: request, sourceKind: 'local', sourceId: null }
  return { id: request.id, sourceKind: request.sourceKind, sourceId: request.sourceId }
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
 *
 * `fallback` lets a card ask about a representative track when it has no `Track`
 * object of its own (an album or artist summary). It is only consulted when
 * `track` is null.
 */
export function useArtwork(track: Track | null, fallback: ArtworkRequest | null = null): string | null {
  const embedded = track?.artworkKey ?? null
  const target = track ? targetOf(track) : fallback !== null ? targetOf(fallback) : null
  const identity = target ? identityOf(target) : null
  const trackId = target?.id ?? null
  const sourceKind = target?.sourceKind ?? null
  const sourceId = target?.sourceId ?? null
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
