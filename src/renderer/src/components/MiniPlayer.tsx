import type { Track } from '@shared/types'
import { buildArtworkUrl } from '@shared/artwork-url'
import { useArtwork } from '../hooks/useArtwork'
import { ArtworkImage } from './ArtworkImage'
import { SeekBar } from './SeekBar'
import {
  ExpandIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PreviousIcon,
  SpinnerIcon,
  VolumeIcon
} from './Icons'

export interface MiniPlayerProps {
  current: Track | null
  isPlaying: boolean
  isLoading: boolean
  /** True while a started stream is waiting for more data. */
  buffering: boolean
  reconnecting: boolean
  positionMs: number
  durationMs: number
  volume: number
  error: string | null
  queueIndex: number
  queueLength: number
  onToggle: () => void
  onNext: () => void
  onPrevious: () => void
  onSeek: (positionMs: number) => void
  onVolume: (volume: number) => void
  onExpand: () => void
}

/**
 * The compact player.
 *
 * This is a layout, not a second player: the window is resized by the main
 * process and the renderer hides everything except this panel. Playback, the
 * queue and the audio element never move, so expanding is instant and nothing
 * restarts.
 */
export function MiniPlayer(props: MiniPlayerProps) {
  const {
    current,
    isPlaying,
    isLoading,
    buffering,
    reconnecting,
    positionMs,
    durationMs,
    volume,
    error,
    queueIndex,
    queueLength,
    onToggle,
    onNext,
    onPrevious,
    onSeek,
    onVolume,
    onExpand
  } = props

  const artworkKey = useArtwork(current)
  const hasQueue = queueLength > 0 && queueIndex >= 0
  const subtitle = current
    ? [current.artist ?? 'Unknown artist', current.album].filter(Boolean).join(' · ')
    : 'Pick a track from your library'

  return (
    <section className="mini-player" aria-label="Mini player">
      <span
        className="mini-player-ambience"
        aria-hidden="true"
        style={artworkKey ? { backgroundImage: `url("${buildArtworkUrl(artworkKey)}")` } : undefined}
      />
      <ArtworkImage track={current} size={62} artworkKey={artworkKey} className="mini-player-art" />
      <div className="mini-player-main">
        <div className="mini-player-head">
          <div className="mini-player-text">
            <div className="mini-player-title" title={current?.title ?? 'Nothing playing'}>
              {current?.title ?? 'Nothing playing'}
            </div>
            <div className="mini-player-subtitle" title={subtitle}>
              {subtitle}
            </div>
          </div>
          <button
            type="button"
            className="icon-button mini-player-expand"
            onClick={onExpand}
            title="Back to the full window"
            aria-label="Leave mini player"
          >
            <ExpandIcon />
          </button>
        </div>

        {reconnecting ? (
          <div className="mini-player-error reconnecting" title="Reconnecting…">
            Reconnecting…
          </div>
        ) : error ? (
          <div className="mini-player-error" title={error}>
            {error}
          </div>
        ) : buffering ? (
          <div className="mini-player-error buffering" title="Buffering…">
            Buffering…
          </div>
        ) : null}

        <SeekBar
          className="mini-player-seek"
          positionMs={positionMs}
          durationMs={durationMs}
          fallbackMs={current?.durationMs ?? 0}
          disabled={!current}
          onSeek={onSeek}
        />

        <div className="mini-player-controls">
          <button
            type="button"
            className="icon-button"
            onClick={onPrevious}
            disabled={!current}
            title="Previous"
          >
            <PreviousIcon />
          </button>
          <button
            type="button"
            className="icon-button primary mini-player-play"
            onClick={onToggle}
            disabled={!current}
            title={isPlaying ? 'Pause' : 'Play'}
            aria-busy={buffering}
          >
            {buffering ? (
              <SpinnerIcon size={18} />
            ) : isLoading && !isPlaying ? (
              <SpinnerIcon size={18} />
            ) : isPlaying ? (
              <PauseIcon />
            ) : (
              <PlayIcon />
            )}
          </button>
          <button type="button" className="icon-button" onClick={onNext} disabled={!current} title="Next">
            <NextIcon />
          </button>
          <span className="mini-player-volume">
            <VolumeIcon size={14} />
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={volume}
              onChange={(event) => onVolume(Number(event.target.value))}
              aria-label="Volume"
              aria-valuetext={`${Math.round(volume * 100)}%`}
            />
          </span>
          {hasQueue ? (
            <span className="mini-player-count" title={`${queueIndex + 1} of ${queueLength}`}>
              {queueIndex + 1}/{queueLength}
            </span>
          ) : null}
        </div>
      </div>
    </section>
  )
}
