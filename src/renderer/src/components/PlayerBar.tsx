import { useEffect, useRef } from 'react'
import type { RepeatMode, Track } from '@shared/types'
import { buildArtworkUrl } from '@shared/artwork-url'
import { useArtwork } from '../hooks/useArtwork'
import { useWheelVolume } from '../hooks/useWheelVolume'
import { ArtworkImage } from './ArtworkImage'
import { SeekBar } from './SeekBar'
import {
  NextIcon,
  PauseIcon,
  PlayIcon,
  PreviousIcon,
  QueueIcon,
  RepeatIcon,
  RepeatOneIcon,
  ShuffleIcon,
  SpinnerIcon,
  VolumeIcon,
  VolumeMuteIcon
} from './Icons'

export interface PlayerBarProps {
  current: Track | null
  isPlaying: boolean
  isLoading: boolean
  positionMs: number
  durationMs: number
  volume: number
  /** Percent per wheel notch. Shift still uses one percent. */
  volumeWheelStep: number
  error: string | null
  queueIndex: number
  queueLength: number
  repeat: RepeatMode
  shuffle: boolean
  onToggle: () => void
  onNext: () => void
  onPrevious: () => void
  onSeek: (positionMs: number) => void
  onVolume: (volume: number) => void
  onCycleRepeat: () => void
  onToggleShuffle: () => void
  onOpenQueue: () => void
  onOpenNowPlaying: () => void
}

export function PlayerBar(props: PlayerBarProps) {
  const {
    current,
    isPlaying,
    isLoading,
    positionMs,
    durationMs,
    volume,
    volumeWheelStep,
    error,
    queueIndex,
    queueLength,
    repeat,
    shuffle,
    onToggle,
    onNext,
    onPrevious,
    onSeek,
    onVolume,
    onCycleRepeat,
    onToggleShuffle,
    onOpenQueue,
    onOpenNowPlaying
  } = props

  const hasQueue = queueLength > 0 && queueIndex >= 0
  const artworkKey = useArtwork(current)
  // The volume cluster answers the wheel as well as the slider's own drag.
  const volumeBoxRef = useWheelVolume(volume, onVolume, volumeWheelStep)

  // Mute is not a stored setting: it is only "the volume is zero, remember what
  // it was", so unmuting restores the level the user actually chose. The icon is
  // the toggle, matching the full-window player, so a click on it is not a no-op.
  const lastAudibleRef = useRef(volume > 0 ? volume : 0.8)
  useEffect(() => {
    if (volume > 0) lastAudibleRef.current = volume
  }, [volume])
  const muted = volume === 0
  const toggleMute = (): void => onVolume(muted ? lastAudibleRef.current : 0)

  return (
    <footer className="player-bar">
      {/* The cover, spread across the entire bar and masked away towards every
          edge. Confined to the now-playing tile it read as a lit rectangle with
          a border, sitting inside an otherwise flat bar — the opposite of
          ambient, and the thing that made it look awkward. */}
      <span className="player-bar-bg" aria-hidden="true">
        {artworkKey ? (
          <span
            className="player-bar-glow"
            style={{ backgroundImage: `url("${buildArtworkUrl(artworkKey)}")` }}
          />
        ) : null}
      </span>

      {/* A button rather than a div: it is the way into the full-window player,
          and a click target that big has to be reachable from the keyboard. */}
      <button
        type="button"
        className="player-track"
        onClick={onOpenNowPlaying}
        disabled={!current}
        title={current ? 'Open the player' : 'Nothing playing'}
      >
        <ArtworkImage track={current} size={42} artworkKey={artworkKey} className="player-art" />
        <div className="player-track-text">
          <div className="player-title-row">
            <div className="player-title" title={current?.title ?? undefined}>
              {current ? current.title : 'Nothing playing'}
            </div>
            {current?.sourceKind === 'youtube' ? (
              <span className="stream-badge" title="Playing from YouTube — nothing is saved">
                <span className="stream-dot" aria-hidden="true" />
                YouTube
              </span>
            ) : null}
          </div>
          <div className="player-subtitle">
            {current ? [current.artist ?? 'Unknown artist', current.album].filter(Boolean).join(' · ') : 'Pick a track from your library'}
            {hasQueue ? `  (${queueIndex + 1}/${queueLength})` : ''}
          </div>
          {error ? <div className="player-error">{error}</div> : null}
        </div>
      </button>

      <div className="player-controls">
        <div className="player-buttons">
          <button
            type="button"
            className={shuffle ? 'icon-button toggle-on' : 'icon-button'}
            onClick={onToggleShuffle}
            title={shuffle ? 'Shuffle on' : 'Shuffle off'}
            aria-pressed={shuffle}
          >
            <ShuffleIcon />
          </button>
          <button type="button" className="icon-button" onClick={onPrevious} disabled={!current} title="Previous">
            <PreviousIcon />
          </button>
          <button
            type="button"
            className="icon-button primary"
            onClick={onToggle}
            disabled={!current}
            title={isPlaying ? 'Pause' : 'Play'}
          >
            {isLoading && !isPlaying ? <SpinnerIcon size={18} /> : isPlaying ? <PauseIcon /> : <PlayIcon />}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={onNext}
            disabled={!current}
            title={repeat === 'all' ? 'Next (wraps to the start)' : 'Next'}
          >
            <NextIcon />
          </button>
          <button
            type="button"
            className={repeat === 'off' ? 'icon-button' : 'icon-button toggle-on'}
            onClick={onCycleRepeat}
            title={repeat === 'off' ? 'Repeat off' : repeat === 'all' ? 'Repeat all' : 'Repeat one'}
            aria-pressed={repeat !== 'off'}
          >
            {repeat === 'one' ? <RepeatOneIcon /> : <RepeatIcon />}
          </button>
        </div>

        <SeekBar
          className="player-seek"
          positionMs={positionMs}
          durationMs={durationMs}
          fallbackMs={current?.durationMs ?? 0}
          disabled={!current}
          onSeek={onSeek}
        />
      </div>

      <div className="player-volume" ref={volumeBoxRef}>
        <button
          type="button"
          className={queueLength > 0 ? 'icon-button queue-button' : 'icon-button queue-button muted'}
          onClick={onOpenQueue}
          title={`Queue (${queueLength})`}
          aria-label={`Open queue, ${queueLength} tracks`}
        >
          <QueueIcon />
          {queueLength > 0 ? <span className="queue-count">{queueLength}</span> : null}
        </button>
        <button
          type="button"
          className="icon-button volume-toggle"
          onClick={toggleMute}
          title={muted ? 'Unmute' : 'Mute'}
          aria-label={muted ? 'Unmute' : 'Mute'}
          aria-pressed={muted}
        >
          {muted ? <VolumeMuteIcon /> : <VolumeIcon />}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(event) => onVolume(Number(event.target.value))}
          aria-label="Volume"
        />
      </div>
    </footer>
  )
}
