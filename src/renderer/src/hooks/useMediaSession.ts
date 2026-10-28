import { useEffect, useRef } from 'react'
import type { Track } from '@shared/types'
import { buildArtworkUrl } from '@shared/artwork-url'
import { useArtwork } from './useArtwork'

interface MediaSessionOptions {
  track: Track | null
  isPlaying: boolean
  positionMs: number
  durationMs: number
  onPlay: () => void
  onPause: () => void
  onNext: () => void
  onPrevious: () => void
  onSeek: (positionMs: number) => void
  onStop: () => void
}

/** Seconds to jump for a hardware or system "seek" command. */
const SEEK_STEP_S = 10

/**
 * The Windows System Media Transport Controls (SMTC) surface.
 *
 * Electron has no native SMTC API. Chromium's Media Session implementation is
 * what Windows sees in the volume flyout and the media overlay, so the renderer
 * publishes metadata, playback state and position here, and registers the
 * hardware buttons (`play`, `pause`, `nexttrack`, `previoustrack`, seek). The
 * action handlers use refs so the callbacks are registered once and still see
 * the current queue and position.
 */
export function useMediaSession(options: MediaSessionOptions): void {
  const { track, isPlaying, positionMs, durationMs } = options

  const artworkKey = useArtwork(track)

  // The latest values for the handlers, which are installed once and may fire
  // long after the render that created them.
  const latest = useRef(options)
  latest.current = options

  useEffect(() => {
    const session = typeof navigator === 'undefined' ? null : navigator.mediaSession
    if (!session) return

    if (!track) {
      session.metadata = null
      return
    }

    const artwork = artworkKey ? [{ src: buildArtworkUrl(artworkKey) }] : []
    try {
      session.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist ?? 'Unknown artist',
        album: track.album ?? '',
        artwork
      })
    } catch {
      // A malformed artwork URL must not take the player down. Metadata is
      // cosmetic; the transport still works through media keys and the tray.
    }
  }, [track, artworkKey])

  useEffect(() => {
    const session = typeof navigator === 'undefined' ? null : navigator.mediaSession
    if (!session) return
    try {
      session.playbackState = !track ? 'none' : isPlaying ? 'playing' : 'paused'
    } catch {
      // Unsupported in this shell.
    }
  }, [track, isPlaying])

  useEffect(() => {
    const session = typeof navigator === 'undefined' ? null : navigator.mediaSession
    if (!session) return
    try {
      if (!track || !Number.isFinite(durationMs) || durationMs <= 0) {
        session.setPositionState()
        return
      }
      const position = Math.min(Math.max(positionMs, 0), durationMs)
      session.setPositionState({
        duration: durationMs / 1000,
        playbackRate: 1,
        position: position / 1000
      })
    } catch {
      // Windows only takes a valid duration; the next timeupdate will retry.
    }
  }, [track, positionMs, durationMs])

  useEffect(() => {
    const session = typeof navigator === 'undefined' ? null : navigator.mediaSession
    if (!session) return

    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      ['play', () => { if (!latest.current.isPlaying) latest.current.onPlay() }],
      ['pause', () => { if (latest.current.isPlaying) latest.current.onPause() }],
      ['previoustrack', () => latest.current.onPrevious()],
      ['nexttrack', () => latest.current.onNext()],
      ['stop', () => latest.current.onStop()],
      [
        'seekto',
        (details) => {
          if (typeof details.seekTime === 'number') latest.current.onSeek(details.seekTime * 1000)
        }
      ],
      [
        'seekbackward',
        (details) => {
          const offset = typeof details.seekOffset === 'number' ? details.seekOffset : SEEK_STEP_S
          latest.current.onSeek(latest.current.positionMs - offset * 1000)
        }
      ],
      [
        'seekforward',
        (details) => {
          const offset = typeof details.seekOffset === 'number' ? details.seekOffset : SEEK_STEP_S
          latest.current.onSeek(latest.current.positionMs + offset * 1000)
        }
      ]
    ]

    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler)
      } catch {
        // Chromium rejects actions it does not implement for the platform.
      }
    }

    return () => {
      for (const [action] of handlers) {
        try {
          session.setActionHandler(action, null)
        } catch {
          // Nothing to clear.
        }
      }
    }
  }, [])
}
