import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent
} from 'react'
import type { AddTracksOutcome, ArtworkFit, Playlist, RepeatMode, Track } from '@shared/types'
import { buildArtworkUrl } from '@shared/artwork-url'
import { formatCount, formatDuration } from '@shared/format'
import type { QueueTrack } from '@shared/queue'
import type { UseDownloadsResult } from '../hooks/useDownloads'
import { useArtwork } from '../hooks/useArtwork'
import { useWheelVolume } from '../hooks/useWheelVolume'
import { ArtworkImage } from './ArtworkImage'
import { LyricsPanel } from './LyricsPanel'
import { QueueActionsMenu } from './QueueActionsMenu'
import { RowMenu } from './RowMenu'
import { SeekBar } from './SeekBar'
import {
  CheckIcon,
  ChevronDownIcon,
  LyricsIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PreviousIcon,
  QueueIcon,
  RepeatIcon,
  RepeatOneIcon,
  ShuffleIcon,
  SpinnerIcon,
  TrashIcon,
  VolumeIcon,
  VolumeLowIcon,
  VolumeMuteIcon
} from './Icons'

export interface NowPlayingViewProps {
  current: Track | null
  isPlaying: boolean
  isLoading: boolean
  /** True while a started stream is waiting for more data. */
  buffering: boolean
  /** True while an interrupted stream is being retried. */
  reconnecting: boolean
  positionMs: number
  durationMs: number
  /**
   * The playing position at frame rate, straight off the media element. The
   * lyric fill is the only thing that needs it; everything else waits for the
   * slower published position.
   */
  readPositionMs: () => number | null
  volume: number
  /** Percent per wheel notch. Shift still uses one percent. */
  volumeWheelStep: number
  queueIndex: number
  /** The real queue, in the order it will play. Drives the panel below. */
  queue: QueueTrack[]
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
  onRepeatChange: (mode: RepeatMode) => void
  onToggleShuffle: () => void
  onJumpQueue: (position: number) => void
  onRemoveQueueItem: (position: number) => void
  onPlaySelected: (tracks: QueueTrack[]) => void
  onQueueSelected: (tracks: QueueTrack[]) => void
  /** Drop every row before the current one. */
  onRemovePlayed: () => void
  onClearQueue: () => void
  onClose: () => void
  downloads: UseDownloadsResult
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
    buffering,
    reconnecting,
    positionMs,
    durationMs,
    readPositionMs,
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
    onRepeatChange,
    onToggleShuffle,
    onJumpQueue,
    onRemoveQueueItem,
    onPlaySelected,
    onQueueSelected,
    onRemovePlayed,
    onClearQueue,
    onClose,
    downloads,
    playlists,
    onAddTracksToPlaylist,
    onCreatePlaylist,
    closing = false
  } = props

  const artworkKey = useArtwork(current)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const currentRowRef = useRef<HTMLButtonElement | null>(null)
  const queueListRef = useRef<HTMLOListElement | null>(null)
  const [queueOpen, setQueueOpen] = useState(false)
  const [lyricsOpen, setLyricsOpen] = useState(false)
  const [selectedPositions, setSelectedPositions] = useState<ReadonlySet<number>>(
    () => new Set<number>()
  )
  const [rowMenu, setRowMenu] = useState<{ position: number; x: number; y: number } | null>(null)
  const selectionAnchorRef = useRef<number | null>(null)
  const focusPositionRef = useRef<number | null>(null)

  const toggleSelected = useCallback((position: number): void => {
    setSelectedPositions((previous) => {
      const next = new Set(previous)
      if (next.has(position)) next.delete(position)
      else next.add(position)
      return next
    })
    selectionAnchorRef.current = position
    focusPositionRef.current = position
  }, [])

  const selectRange = useCallback(
    (position: number): void => {
      // Anchor the range where selection started. Falling back to the playing
      // row (then the clicked row) keeps the first Shift-click a real range.
      const anchor = selectionAnchorRef.current ?? focusPositionRef.current ?? queueIndex
      selectionAnchorRef.current = anchor
      const from = Math.min(anchor, position)
      const to = Math.max(anchor, position)
      const next = new Set<number>()
      for (let at = from; at <= to; at += 1) next.add(at)
      setSelectedPositions(next)
      focusPositionRef.current = position
    },
    [queueIndex]
  )

  const clearSelection = useCallback((): void => {
    setSelectedPositions(new Set<number>())
    selectionAnchorRef.current = null
    focusPositionRef.current = null
  }, [])

  // Positions only mean something for the queue they were selected in.
  useEffect(() => {
    clearSelection()
    setRowMenu(null)
  }, [clearSelection, queue])

  const selectedTracks = useMemo(
    () =>
      [...selectedPositions]
        .sort((a, b) => a - b)
        .map((position) => queue[position])
        .filter((track): track is QueueTrack => Boolean(track)),
    [queue, selectedPositions]
  )
  const selecting = selectedPositions.size > 0

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
  // is no longer anywhere near the track that is playing. This runs before paint
  // and scrolls only the list itself: `scrollIntoView` after the slide started was
  // what made the opening panel jump for a frame.
  useLayoutEffect(() => {
    if (!queueOpen) return
    const list = queueListRef.current
    const row = currentRowRef.current
    if (!list || !row) return
    const listRect = list.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const rowTop = list.scrollTop + rowRect.top - listRect.top
    const rowBottom = rowTop + rowRect.height
    if (rowTop < list.scrollTop) list.scrollTop = rowTop
    else if (rowBottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = rowBottom - list.clientHeight
    }
  }, [queueOpen, queueIndex])

  // Escape unwinds one layer at a time: a menu, then whichever panel is open,
  // then the window. This runs on the dialog rather than the global shortcut so
  // that a closed panel still closes the window, and so the two never both fire.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    if (rowMenu) {
      setRowMenu(null)
      return
    }
    if (queueOpen) {
      setQueueOpen(false)
      return
    }
    if (lyricsOpen) {
      setLyricsOpen(false)
      return
    }
    onClose()
  }

  // A press anywhere outside the open panel closes it, so the black space and
  // the album art behave like the panel button and Escape. Presses inside the
  // panel are left alone: a row is how a track is picked, and that should not
  // also shut the panel. The buttons are excluded because their own handlers
  // toggle the panels, and both firing would only close them twice.
  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (!queueOpen && !lyricsOpen) return
    const target = event.target as HTMLElement | null
    if (
      target?.closest(
        '.np-queue-panel, .np-lyrics-panel, .np-lyrics-stage, .np-queue, .np-lyrics-button, .add-to-playlist, .queue-actions-menu, .context-menu'
      )
    ) {
      return
    }
    setQueueOpen(false)
    setLyricsOpen(false)
  }

  // Two panels share the same corner, so opening one closes the other rather
  // than stacking them.
  const toggleQueue = (): void => {
    setLyricsOpen(false)
    setQueueOpen((open) => !open)
  }

  const toggleLyrics = (): void => {
    setQueueOpen(false)
    setLyricsOpen((open) => !open)
  }

  const hasQueue = queue.length > 0 && queueIndex >= 0
  const queueTotalMs = queue.reduce((sum, track) => sum + (track.durationMs ?? 0), 0)
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
          {reconnecting
            ? 'Reconnecting…'
            : buffering
              ? 'Buffering…'
              : hasQueue
                ? `Playing from the queue · ${queueIndex + 1} of ${queue.length}`
                : 'Nothing queued'}
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
              {selecting
                ? `${formatCount(selectedPositions.size)} selected · click a title to play`
                : `${formatCount(queue.length)} tracks · ${formatDuration(queueTotalMs)}`}
            </span>
            <QueueActionsMenu
              queue={queue}
              index={queueIndex}
              repeat={repeat}
              shuffle={shuffle}
              downloads={downloads}
              playlists={playlists}
              onAddTracksToPlaylist={onAddTracksToPlaylist}
              onCreatePlaylist={onCreatePlaylist}
              onToggleShuffle={onToggleShuffle}
              onRepeatChange={onRepeatChange}
              onRemovePlayed={onRemovePlayed}
              onClear={onClearQueue}
              selectedTracks={selectedTracks}
              onClearSelection={clearSelection}
              onPlaySelected={onPlaySelected}
            />
          </header>
          <ol className="np-queue-list" ref={queueListRef}>
            {queue.map((track, index) => (
              <li key={`${track.id}-${index}`} className={selecting ? 'selecting' : undefined}>
                {selecting ? (
                  <label
                    className="np-queue-select"
                    title={selectedPositions.has(index) ? 'Deselect' : 'Select'}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onDragStart={(event) => event.stopPropagation()}
                  >
                    <input
                      type="checkbox"
                      checked={selectedPositions.has(index)}
                      onChange={() => toggleSelected(index)}
                      aria-label={`${selectedPositions.has(index) ? 'Deselect' : 'Select'} ${
                        track.title
                      }`}
                    />
                  </label>
                ) : null}
                <button
                  type="button"
                  className={index === queueIndex ? 'np-queue-row current' : 'np-queue-row'}
                  onClick={(event) => {
                    focusPositionRef.current = index
                    if (event.ctrlKey || event.metaKey) {
                      event.preventDefault()
                      toggleSelected(index)
                      return
                    }
                    if (event.shiftKey) {
                      event.preventDefault()
                      selectRange(index)
                      return
                    }
                    onJumpQueue(index)
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    focusPositionRef.current = index
                    setRowMenu({ position: index, x: event.clientX, y: event.clientY })
                  }}
                  ref={index === queueIndex ? currentRowRef : undefined}
                  title={track.title}
                  aria-current={index === queueIndex}
                >
                  <span className="np-queue-position">
                    {selecting ? null : index === queueIndex ? (
                      <span className="playing-dot" />
                    ) : (
                      index + 1
                    )}
                  </span>
                  <span className="np-queue-title">{track.title}</span>
                  <span className="np-queue-time">{formatDuration(track.durationMs)}</span>
                </button>
              </li>
            ))}
          </ol>
        </aside>
        <LyricsPanel
          track={current}
          positionMs={positionMs}
          durationMs={durationMs}
          readPositionMs={readPositionMs}
          open={lyricsOpen}
          onSeek={onSeek}
          artworkKey={artworkKey}
        />
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
              aria-busy={buffering}
            >
              {buffering ? (
                <SpinnerIcon size={24} />
              ) : isLoading && !isPlaying ? (
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
              className={`icon-button np-lyrics-button${lyricsOpen ? ' toggle-on' : ''}`}
              onClick={toggleLyrics}
              disabled={!current}
              title={lyricsOpen ? 'Hide lyrics' : 'Lyrics'}
              aria-label={lyricsOpen ? 'Hide lyrics' : 'Show lyrics'}
              aria-expanded={lyricsOpen}
              aria-controls="np-lyrics"
            >
              <LyricsIcon size={20} />
            </button>
            <button
              type="button"
              className={`icon-button queue-button np-queue${queueOpen ? ' toggle-on' : ''}`}
              onClick={toggleQueue}
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

      {rowMenu && queue[rowMenu.position] ? (
        <RowMenu
          portal
          at={{ x: rowMenu.x, y: rowMenu.y }}
          title={queue[rowMenu.position]?.title}
          items={[
            {
              id: 'select',
              label: selectedPositions.has(rowMenu.position) ? 'Deselect' : 'Select',
              icon: <CheckIcon />,
              onSelect: () => toggleSelected(rowMenu.position)
            },
            {
              id: 'play',
              label: 'Play',
              icon: <PlayIcon />,
              onSelect: () => onJumpQueue(rowMenu.position)
            },
            ...(selectedPositions.has(rowMenu.position)
              ? [
                  {
                    id: 'play-selected',
                    label: 'Play selected',
                    icon: <PlayIcon />,
                    onSelect: () => onPlaySelected(selectedTracks)
                  },
                  {
                    id: 'queue-selected',
                    label: 'Queue selected',
                    icon: <QueueIcon />,
                    onSelect: () => onQueueSelected(selectedTracks)
                  }
                ]
              : []),
            {
              id: 'remove',
              label: 'Remove from queue',
              icon: <TrashIcon />,
              danger: true,
              onSelect: () => onRemoveQueueItem(rowMenu.position)
            }
          ]}
          onClose={() => setRowMenu(null)}
        />
      ) : null}
    </div>
  )
}
