import { useEffect, useRef } from 'react'
import type { Track, TrackLyrics } from '@shared/types'
import type { LyricLine } from '@shared/lyrics'
import { buildArtworkUrl } from '@shared/artwork-url'
import { CloseIcon } from './Icons'
import { LyricsBody, LyricsOffsetControls } from './LyricsLines'

export interface LyricsStageProps {
  track: Track | null
  artworkKey: string | null
  /** "File tags · Synced" and the like, already worked out by the panel. */
  meta: string
  loading: boolean
  error: string | null
  lyrics: TrackLyrics | null
  lines: LyricLine[]
  active: number
  lineProgress: number
  offsetMs: number
  saving: boolean
  onSeek: (line: LyricLine) => void
  onShift: (delta: number) => void
  onClose: () => void
}

/**
 * The whole player window as a lyric sheet.
 *
 * Rendered through a portal from the lyrics panel, so it is not boxed in by the
 * panel's own blur and transform, and the two views share one fetch and one
 * timing correction. The cover sits behind it, blurred and scrimmed; the words
 * are the only thing with contrast.
 *
 * Escape is handled here rather than by the player window: the portal is outside
 * the window's DOM, and the first Escape should close the stage, not the player.
 */
export function LyricsStage(props: LyricsStageProps) {
  const { track, artworkKey, meta, loading, error, lyrics, lines, active, lineProgress } = props
  const { offsetMs, saving, onSeek, onShift, onClose } = props
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    rootRef.current?.focus()
  }, [])

  const subtitle = track
    ? [track.artist ?? 'Unknown artist', track.album].filter(Boolean).join(' · ')
    : 'Pick a track from your library'

  return (
    <div
      className="np-lyrics-stage"
      role="dialog"
      aria-modal="true"
      aria-label="Lyrics"
      tabIndex={-1}
      ref={rootRef}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.stopPropagation()
        onClose()
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
        <div className="np-lyrics-stage-actions">
          <span className="np-lyrics-stage-source">{meta}</span>
          <button
            type="button"
            className="icon-button np-lyrics-stage-close"
            onClick={onClose}
            title="Back to the player (Esc)"
            aria-label="Close the lyrics"
          >
            <CloseIcon size={18} />
          </button>
        </div>
      </header>

      <div className="np-lyrics-body np-lyrics-stage-body">
        <LyricsBody
          track={track}
          loading={loading}
          error={error}
          lyrics={lyrics}
          lines={lines}
          active={active}
          lineProgress={lineProgress}
          onSeek={onSeek}
          resetKey={track?.id ?? null}
        />
      </div>

      {lyrics && lines.length > 0 ? (
        <footer className="np-lyrics-foot np-lyrics-stage-foot">
          <div className="np-lyrics-stage-offset">
            <LyricsOffsetControls offsetMs={offsetMs} saving={saving} onShift={onShift} />
          </div>
          <p className="np-lyrics-stage-hint">Click a line to play from there · Esc to close</p>
        </footer>
      ) : null}
    </div>
  )
}
