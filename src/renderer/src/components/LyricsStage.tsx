import { useEffect, useRef, useState } from 'react'
import type { Track, TrackLyrics } from '@shared/types'
import type { LyricLine } from '@shared/lyrics'
import { buildArtworkUrl } from '@shared/artwork-url'
import { CloseIcon } from './Icons'
import { LyricsBody } from './LyricsLines'

export interface LyricsStageProps {
  track: Track | null
  artworkKey: string | null
  loading: boolean
  error: string | null
  lyrics: TrackLyrics | null
  lines: LyricLine[]
  positionMs: number
  offsetMs: number
  durationMs: number
  readPositionMs: (() => number | null) | null
  onSeek: (line: LyricLine) => void
  onClose: () => void
}

/** How long the exit animation runs before the portal is torn down. */
const CLOSE_MS = 180

function prefersReducedMotion(): boolean {
  const root = document.documentElement
  if (root.dataset.motion === 'reduced') return true
  if (root.dataset.motion === 'full') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * The whole player window as a lyric sheet.
 *
 * Rendered through a portal from the lyrics panel, so it is not boxed in by the
 * panel's own blur and transform, and the two views share one fetch and one
 * timing correction. The cover sits behind it, blurred and scrimmed; the words
 * are the only thing with contrast.
 *
 * Closing is delayed by one short animation rather than unmounting on the click,
 * so the stage can pull back toward the panel it came from instead of vanishing.
 *
 * Escape is handled here rather than by the player window: the portal is outside
 * the window's DOM, and the first Escape should close the stage, not the player.
 */
export function LyricsStage(props: LyricsStageProps) {
  const { track, artworkKey, loading, error, lyrics, lines, onSeek, onClose } = props
  const { positionMs, offsetMs, durationMs, readPositionMs } = props
  const rootRef = useRef<HTMLDivElement | null>(null)
  const closeTimer = useRef<number | null>(null)
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  useEffect(
    () => () => {
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current)
    },
    []
  )

  const requestClose = (): void => {
    if (closing) return
    setClosing(true)
    closeTimer.current = window.setTimeout(onClose, prefersReducedMotion() ? 0 : CLOSE_MS)
  }

  const subtitle = track
    ? [track.artist ?? 'Unknown artist', track.album].filter(Boolean).join(' · ')
    : 'Pick a track from your library'

  return (
    <div
      className={closing ? 'np-lyrics-stage closing' : 'np-lyrics-stage'}
      role="dialog"
      aria-modal="true"
      aria-label="Lyrics"
      tabIndex={-1}
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        requestClose()
      }}
    >
      <div
        className={
          artworkKey ? 'np-lyrics-stage-art' : 'np-lyrics-stage-art np-lyrics-stage-art-fallback'
        }
        style={artworkKey ? { backgroundImage: `url("${buildArtworkUrl(artworkKey)}")` } : undefined}
      />
      <div className="np-lyrics-stage-scrim" />

      <header className="np-lyrics-stage-head">
        <div className="np-lyrics-stage-meta">
          <p className="np-lyrics-stage-kicker">Now playing</p>
          <h2 className="np-lyrics-stage-title">{track?.title ?? 'Nothing playing'}</h2>
          <p className="np-lyrics-stage-sub">{subtitle}</p>
        </div>
        <button
          type="button"
          className="icon-button np-lyrics-stage-close"
          onClick={requestClose}
          title="Back to the player (Esc)"
          aria-label="Close the lyrics"
        >
          <CloseIcon size={18} />
        </button>
      </header>

      <div className="np-lyrics-body np-lyrics-stage-body">
        <LyricsBody
          track={track}
          loading={loading}
          error={error}
          lyrics={lyrics}
          lines={lines}
          positionMs={positionMs}
          offsetMs={offsetMs}
          durationMs={durationMs}
          readPositionMs={readPositionMs}
          onSeek={onSeek}
          resetKey={track?.id ?? null}
        />
      </div>
    </div>
  )
}
