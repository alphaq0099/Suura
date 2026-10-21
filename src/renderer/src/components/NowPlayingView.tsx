import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent
} from 'react'
import type { AddTracksOutcome, ArtworkFit, Playlist, RepeatMode, Track } from '@shared/types'
import { buildArtworkUrl } from '@shared/artwork-url'
import { formatCount, formatDuration } from '@shared/format'
import { useArtwork } from '../hooks/useArtwork'
import { useWheelVolume } from '../hooks/useWheelVolume'
import { ArtworkImage } from './ArtworkImage'
import { AddToPlaylistMenu } from './AddToPlaylistMenu'
import { SeekBar } from './SeekBar'
import {
  ChevronDownIcon,
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
  VolumeLowIcon,
  VolumeMuteIcon
} from './Icons'

export interface NowPlayingViewProps {
  current: Track | null
  isPlaying: boolean
  isLoading: boolean
  positionMs: number
  durationMs: number
  volume: number
  /** Percent per wheel notch. Shift still uses one percent. */
  volumeWheelStep: number
  queueIndex: number
  /** The real queue, in the order it will play. Drives the panel below. */
  queue: Track[]
  repeat: RepeatMode
  shuffle: boolean
  /** How the large artwork is drawn. Small artwork always crops. */
  artworkFit: ArtworkFit
  onToggle: () => void
  onNext: () => void
  onPrevious: () => void
  onSeek: (positionMs: number) => void
  onVolume: (volume: number) => void
  onCycleRepeat: () => void
  onToggleShuffle: () => void
  onJumpQueue: (position: number) => void
  onClose: () => void
  playlists: Playlist[]
  onAddTracksToPlaylist: (playlistId: number, trackIds: number[]) => Promise<AddTracksOutcome>
  onCreatePlaylist: (name: string) => Promise<Playlist>
  /** True while the exit animation plays, before this view is unmounted. */
  closing?: boolean
}

/**
 * The full-window player.
 *
 * Laid out from the top down as three bands: a thin header, the album art at
 * whatever size the window allows, and the controls. Everything behind it is
 * covered rather than unmounted, so closing it does not disturb the list's
 * scroll position or the queue.
 *
 * The backdrop is the album art itself, blurred and pushed into ambient colour:
 * brightened and saturated before it is dropped to opacity, so a dark cover still
 * fills the frame instead of leaving a smudge in one corner. Over it sit a wash
 * that reaches every corner and a vignette that keeps the middle the brightest
 * part and lands the bottom on the app colour. It is all CSS filters on one
 * element rather than a second copy of the image at a larger size, because the
 * blur is what a compositor is good at; the scrim is what guarantees the text
 * underneath stays readable no matter how bright or how dark the cover is.
 *
 * The queue is a panel inside this window rather than a trip back to the Queue
 * view. Leaving the window to see what plays next loses the track that is
 * playing, which is the one thing the window exists to show.
 */
export function NowPlayingView(props: NowPlayingViewProps) {
  const {
    current,
    isPlaying,
    isLoading,
    positionMs,
    durationMs,
    volume,
    volumeWheelStep,
    queueIndex,
    queue,
    repeat,
    shuffle,
    artworkFit,
    onToggle,
    onNext,
    onPrevious,
    onSeek,
    onVolume,
    onCycleRepeat,
    onToggleShuffle,
    onJumpQueue,
    onClose,
    playlists,
    onAddTracksToPlaylist,
    onCreatePlaylist,
    closing = false
  } = props

  const artworkKey = useArtwork(current)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const currentRowRef = useRef<HTMLButtonElement | null>(null)
  const [queueOpen, setQueueOpen] = useState(false)
  const [saveMenuOpen, setSaveMenuOpen] = useState(false)

  // Mute is deliberately not a stored setting. It is only "the volume is zero,
  // but remember what it was", so unmuting restores the level the user actually
  // chose rather than a default.
  const lastAudibleRef = useRef(volume > 0 ? volume : 0.8)
  useEffect(() => {
    if (volume > 0) lastAudibleRef.current = volume
  }, [volume])

  const muted = volume === 0
  const toggleMute = (): void => onVolume(muted ? lastAudibleRef.current : 0)

  // The wheel works anywhere on the volume control, not only over the button:
  // the fold-out slider lives inside the same box, so the whole control answers
  // to it.
  const volumeBoxRef = useWheelVolume(volume, onVolume, volumeWheelStep)

  // Focus moves into the dialog so the window it covers cannot be activated by
  // a stray Space, and so Escape has somewhere to land.
  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  // Playback advancing on its own should not leave the panel showing a row that
  // is no longer anywhere near the track that is playing. `nearest` so opening
  // the panel on a visible row does not shunt the list for no reason.
  useEffect(() => {
    if (!queueOpen) return
    currentRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [queueOpen, queueIndex])

  // Escape unwinds one layer at a time: the panel first, then the window. This
  // runs on the dialog rather than the global shortcut so that a closed panel
  // still closes the window, and so the two never both fire.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    if (queueOpen) {
      setQueueOpen(false)
      return
    }
    onClose()
  }

  // A press anywhere outside the panel closes it, so the black space and the
  // album art behave like the queue button and Escape. Presses inside the panel
  // are left alone: a row is how a track is picked, and that should not also
  // shut the panel. The queue button is excluded because its own handler
  // toggles the panel, and both firing would only close it twice.
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (!queueOpen) return
    const target = event.target as HTMLElement | null
    if (target?.closest('.np-queue-panel, .np-queue')) return
    setQueueOpen(false)
  }

  const hasQueue = queue.length > 0 && queueIndex >= 0
  const queueTotalMs = queue.reduce((sum, track) => sum + (track.durationMs ?? 0), 0)
  // A playlist is a set of library rows. Stream links are session-only, so saving
  // one would silently produce an empty playlist; say so instead.
  const queueHasStream = queue.some((track) => track.sourceKind !== 'local')
  const backdrop = artworkKey ? { backgroundImage: `url("${buildArtworkUrl(artworkKey)}")` } : undefined

  return (
    <div
      className={closing ? 'now-playing np-closing' : 'now-playing'}
      role="dialog"
      aria-modal="true"
      aria-label={current ? `Now playing: ${current.title}` : 'Now playing'}
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
    >
      {/* The background lives in its own clipping layer. The backdrop is wider
          than the window by design (a blurred image samples transparent pixels
          at its edges otherwise), and `overflow: hidden` on the view itself is
          not enough: a transformed descendant still counts as scrollable
          overflow, which is what made this view scroll sideways. */}
      <div className="np-bg" aria-hidden="true">
        <div
          className={artworkKey ? 'np-backdrop' : 'np-backdrop np-backdrop-fallback'}
          style={backdrop}
        />
        {/* Sits over the art so the frame is tinted everywhere, not only where
            the cover happens to be bright. */}
        <div className="np-wash" />
        <div className="np-scrim" />
      </div>

      <header className="np-top">
        <button
          type="button"
          className="icon-button np-close"
          onClick={onClose}
          title="Close player (Esc)"
          aria-label="Close player"
        >
          <ChevronDownIcon size={22} />
        </button>
        <span className="np-context">
          {hasQueue ? `Playing from the queue · ${queueIndex + 1} of ${queue.length}` : 'Nothing queued'}
        </span>
      </header>

      <div className="np-stage">
        <ArtworkImage
          track={current}
          size="var(--np-art-size)"
          iconSize={56}
          artworkKey={artworkKey}
          className="np-art"
          sizing={artworkFit === 'contain' ? 'fit' : 'square'}
        />
      </div>

      {/* The panel lives in a clipping host: a sliding transform is scrollable
          overflow, and an unclipped one makes this window scroll sideways. */}
      <div className="np-queue-host">
        <aside
          id="np-queue"
          className={queueOpen ? 'np-queue-panel open' : 'np-queue-panel'}
          aria-label="Queue"
        >
          <header className="np-queue-head">
            <h2>Queue</h2>
            <span className="np-queue-meta">
              {formatCount(queue.length)} tracks · {formatDuration(queueTotalMs)}
            </span>
            <button
              type="button"
              className="link-button np-queue-save"
              disabled={queue.length === 0 || queueHasStream}
              title={queueHasStream ? 'Stream links cannot be saved to a playlist yet' : undefined}
              onClick={(event) => {
                event.stopPropagation()
                setSaveMenuOpen(true)
              }}
            >
              Save as playlist…
            </button>
          </header>

          {saveMenuOpen ? (
            <AddToPlaylistMenu
              playlists={playlists}
              trackIds={queue.map((track) => track.id)}
              heading={`Queue · ${formatCount(queue.length)} tracks`}
              onAdd={onAddTracksToPlaylist}
              onCreate={onCreatePlaylist}
              onClose={() => setSaveMenuOpen(false)}
            />
          ) : null}
          <ol className="np-queue-list">
            {queue.map((track, index) => (
              <li key={`${track.id}-${index}`}>
                <button
                  type="button"
                  className={index === queueIndex ? 'np-queue-row current' : 'np-queue-row'}
                  onClick={() => onJumpQueue(index)}
                  ref={index === queueIndex ? currentRowRef : undefined}
                  title={track.title}
                  aria-current={index === queueIndex}
                >
                  <span className="np-queue-position">
                    {index === queueIndex ? <span className="playing-dot" /> : index + 1}
                  </span>
                  <span className="np-queue-title">{track.title}</span>
                  <span className="np-queue-time">{formatDuration(track.durationMs)}</span>
                </button>
              </li>
            ))}
          </ol>
        </aside>
      </div>

      <div className="np-bottom">
        <div className="np-meta">
          <h1 className="np-title" title={current?.title ?? undefined}>
            {current?.title ?? 'Nothing playing'}
          </h1>
          <p className="np-subtitle">
            {current
              ? [current.artist ?? 'Unknown artist', current.album].filter(Boolean).join(' · ')
              : 'Pick a track from your library'}
          </p>
        </div>

        <div className="np-transport">
          <div className="np-side">
            <button
              type="button"
              className={shuffle ? 'icon-button toggle-on' : 'icon-button'}
              onClick={onToggleShuffle}
              title={shuffle ? 'Shuffle on' : 'Shuffle off'}
              aria-pressed={shuffle}
            >
              <ShuffleIcon size={20} />
            </button>
            <button
              type="button"
              className={repeat === 'off' ? 'icon-button' : 'icon-button toggle-on'}
              onClick={onCycleRepeat}
              title={repeat === 'off' ? 'Repeat off' : repeat === 'all' ? 'Repeat all' : 'Repeat one'}
              aria-pressed={repeat !== 'off'}
            >
              {repeat === 'one' ? <RepeatOneIcon size={20} /> : <RepeatIcon size={20} />}
            </button>
          </div>

          <div className="np-center">
            <button
              type="button"
              className="icon-button np-skip"
              onClick={onPrevious}
              disabled={!current}
              title="Previous"
            >
              <PreviousIcon size={26} />
            </button>
            <button
              type="button"
              className="icon-button primary np-play"
              onClick={onToggle}
              disabled={!current}
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isLoading && !isPlaying ? (
                <SpinnerIcon size={24} />
              ) : isPlaying ? (
                <PauseIcon size={26} />
              ) : (
                <PlayIcon size={26} />
              )}
            </button>
            <button type="button" className="icon-button np-skip" onClick={onNext} disabled={!current} title="Next">
              <NextIcon size={26} />
            </button>
          </div>

          <div className="np-side np-side-right">
            <button
              type="button"
              className={`icon-button queue-button np-queue${queueOpen ? ' toggle-on' : ''}`}
              onClick={() => setQueueOpen((open) => !open)}
              title={queueOpen ? 'Hide queue' : `Queue (${queue.length})`}
              aria-label={queueOpen ? 'Hide queue' : `Show queue, ${queue.length} tracks`}
              aria-expanded={queueOpen}
              aria-controls="np-queue"
            >
              <QueueIcon size={20} />
              {queue.length > 0 ? <span className="queue-count">{queue.length}</span> : null}
            </button>
            {/* Click mutes; the slider is folded away until the pointer or the
                keyboard is on this control. */}
            <div className="np-volume" ref={volumeBoxRef}>
              <button
                type="button"
                className="icon-button"
                onClick={toggleMute}
                title={muted ? 'Unmute' : 'Mute'}
                aria-label={muted ? 'Unmute' : 'Mute'}
                aria-pressed={muted}
              >
                {muted ? (
                  <VolumeMuteIcon size={20} />
                ) : volume <= 0.5 ? (
                  <VolumeLowIcon size={20} />
                ) : (
                  <VolumeIcon size={20} />
                )}
              </button>
              <div className="np-volume-pop">
                <input
                  className="np-volume-slider"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={volume}
                  onChange={(event) => onVolume(Number(event.target.value))}
                  aria-label="Volume level"
                  // Published so the track can paint its filled portion without
                  // React re-rendering on every pointer move.
                  style={{ '--volume-progress': `${volume * 100}%` } as CSSProperties}
                />
              </div>
            </div>
          </div>
        </div>

        <SeekBar
          className="np-seek"
          positionMs={positionMs}
          durationMs={durationMs}
          fallbackMs={current?.durationMs ?? 0}
          disabled={!current}
          onSeek={onSeek}
        />
      </div>
    </div>
  )
}
