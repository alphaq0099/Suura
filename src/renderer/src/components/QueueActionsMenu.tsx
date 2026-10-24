import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { AddTracksOutcome, Playlist, RepeatMode } from '@shared/types'
import { formatCount } from '@shared/format'
import type { QueueTrack } from '@shared/queue'
import type { UseDownloadsResult } from '../hooks/useDownloads'
import { AddToPlaylistMenu } from './AddToPlaylistMenu'
import {
  CloseIcon,
  DownloadIcon,
  MoreIcon,
  PlayIcon,
  PlaylistIcon,
  RepeatIcon,
  ShuffleIcon,
  TrashIcon
} from './Icons'

export interface QueueActionsMenuProps {
  queue: QueueTrack[]
  index: number
  repeat: RepeatMode
  shuffle: boolean
  playlists: Playlist[]
  downloads: UseDownloadsResult
  onAddTracksToPlaylist: (playlistId: number, trackIds: number[]) => Promise<AddTracksOutcome>
  onCreatePlaylist: (name: string) => Promise<Playlist>
  onToggleShuffle: () => void
  onRepeatChange: (mode: RepeatMode) => void
  onRemovePlayed: () => void
  onClear: () => void
  /**
   * Rows the save/download actions should act on. Empty means the whole queue;
   * a non-empty set is the current selection and wins over the queue.
   */
  selectedTracks: QueueTrack[]
  onClearSelection: () => void
  /** Play only the selected rows and replace the queue with them. */
  onPlaySelected: (tracks: QueueTrack[]) => void
}

const REPEAT_MODES: ReadonlyArray<{ mode: RepeatMode; label: string }> = [
  { mode: 'off', label: 'Off' },
  { mode: 'all', label: 'All' },
  { mode: 'one', label: 'One' }
]

function activeDownload(status: string | undefined): boolean {
  return (
    status === 'queued' ||
    status === 'downloading' ||
    status === 'finishing' ||
    status === 'indexing'
  )
}

/**
 * The overflow menu shared by the player-window panel and the Queue view.
 *
 * "Save as playlist" used to be a dead end for a queue with streams: a playlist
 * row needs a local `tracks.id`, and a stream has none until it is saved. The
 * download item is the way out of that, and the save item enables once every
 * entry can be named by a library row.
 */
export function QueueActionsMenu(props: QueueActionsMenuProps) {
  const {
    queue,
    index,
    repeat,
    shuffle,
    playlists,
    downloads,
    onAddTracksToPlaylist,
    onCreatePlaylist,
    onToggleShuffle,
    onRepeatChange,
    onRemovePlayed,
    onClear,
    selectedTracks,
    onClearSelection,
    onPlaySelected
  } = props

  const [open, setOpen] = useState(false)
  const [saveAt, setSaveAt] = useState<{ x: number; y: number } | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  const selecting = selectedTracks.length > 0
  const actionTracks = selecting ? selectedTracks : queue

  const streams = useMemo(() => {
    const seen = new Set<string>()
    const result: QueueTrack[] = []
    for (const track of actionTracks) {
      if (track.sourceKind !== 'youtube' || !track.sourceId || seen.has(track.sourceId)) continue
      seen.add(track.sourceId)
      result.push(track)
    }
    return result
  }, [actionTracks])

  const streamIds = useMemo(
    () => streams.map((track) => track.sourceId).filter((id): id is string => Boolean(id)),
    [streams]
  )

  /**
   * The ids a playlist can be built from, or null when a stream has not been
   * saved yet. This is deliberately separate from `queue`: downloading a stream
   * gives the library a row but does not rewrite the row that is playing.
   */
  const playlistTrackIds = useMemo<number[] | null>(() => {
    if (actionTracks.length === 0) return null
    const ids: number[] = []
    for (const track of actionTracks) {
      if (track.sourceKind === 'local') {
        ids.push(track.id)
        continue
      }
      const trackId = track.sourceId ? downloads.states[track.sourceId]?.trackId : null
      if (trackId == null) return null
      ids.push(trackId)
    }
    return [...new Set(ids)]
  }, [actionTracks, downloads.states])

  const unresolved = streams.filter(
    (track) => !track.sourceId || downloads.states[track.sourceId]?.trackId == null
  )
  const missing = unresolved.filter(
    (track) => !track.sourceId || !downloads.saved.has(track.sourceId)
  )
  const downloading = streams.some((track) =>
    activeDownload(track.sourceId ? downloads.states[track.sourceId]?.status : undefined)
  )

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      const node = event.target as Node | null
      if (node && containerRef.current?.contains(node)) return
      setOpen(false)
    }
    // Escape belongs to the menu while it is open, not to the now-playing window
    // behind it. Listening here also covers the moment after the trigger was
    // pressed, when focus has not moved into the menu yet.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next && streamIds.length > 0) void downloads.refreshSaved(streamIds)
  }

  const downloadStreams = (): void => {
    // Ask for every unique stream, not only the missing ones: a video saved in an
    // earlier session has a library row but no state in this session, and asking
    // again is what resolves its id for the playlist. Only the selected rows are
    // in `streams` when a selection exists, so this never widens the scope.
    for (const track of streams) {
      if (!track.sourceId) continue
      void downloads
        .save({
          videoId: track.sourceId,
          title: track.title,
          artist: track.artist,
          album: track.album
        })
        .catch(() => undefined)
    }
    setOpen(false)
  }

  const openPlaylistMenu = (): void => {
    if (!playlistTrackIds) return
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) {
      setSaveAt({
        x: Math.max(8, rect.right - 260),
        y: Math.min(window.innerHeight - 320, rect.bottom + 8)
      })
    }
    setOpen(false)
  }

  if (queue.length === 0) return null

  const downloadLabel = downloading
    ? 'Downloading…'
    : missing.length > 0
      ? `Download ${formatCount(missing.length)} ${selecting ? 'selected ' : ''}streaming track${
          missing.length === 1 ? '' : 's'
        }`
      : selecting
        ? 'Download selected streaming tracks'
        : 'Download streaming tracks'

  return (
    <div className="queue-actions" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        className="icon-button subtle queue-actions-trigger"
        title="Queue actions"
        aria-label="Queue actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <MoreIcon />
      </button>

      {open ? (
        <div className="queue-actions-menu" role="menu" aria-label="Queue actions">
          {selecting ? (
            <button
              type="button"
              role="menuitem"
              className="queue-actions-item"
              onClick={() => {
                onPlaySelected(selectedTracks)
                setOpen(false)
              }}
            >
              <PlayIcon size={15} />
              <span>Play selected</span>
            </button>
          ) : null}

          <button
            type="button"
            role="menuitem"
            className="queue-actions-item"
            disabled={!playlistTrackIds}
            title={
              playlistTrackIds
                ? selecting
                  ? 'Add the selected tracks to a playlist'
                  : 'Add the queue to a playlist'
                : `Download the ${selecting ? 'selected ' : ''}streaming tracks first`
            }
            onClick={openPlaylistMenu}
          >
            <PlaylistIcon size={15} />
            <span>{selecting ? 'Save selected as playlist…' : 'Save as playlist…'}</span>
          </button>

          {streams.length > 0 ? (
            <button
              type="button"
              role="menuitem"
              className="queue-actions-item"
              disabled={downloading}
              title="Save the streaming rows into your library"
              onClick={downloadStreams}
            >
              <DownloadIcon size={15} />
              <span>{downloadLabel}</span>
            </button>
          ) : null}

          {!playlistTrackIds && streams.length > 0 ? (
            <p className="queue-actions-hint">
              Download the {selecting ? 'selected ' : ''}streaming tracks, then save{' '}
              {selecting ? 'them' : 'the queue'}.
            </p>
          ) : null}

          {selecting ? (
            <button
              type="button"
              role="menuitem"
              className="queue-actions-item"
              onClick={() => {
                onClearSelection()
                setOpen(false)
              }}
            >
              <CloseIcon size={15} />
              <span>Clear selection</span>
            </button>
          ) : null}

          <div className="queue-actions-sep" role="separator" />

          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={shuffle}
            className="queue-actions-item"
            onClick={onToggleShuffle}
          >
            <ShuffleIcon size={15} />
            <span>Shuffle</span>
            <span className="queue-actions-check" aria-hidden="true">
              {shuffle ? '✓' : ''}
            </span>
          </button>

          <div className="queue-actions-repeat" role="group" aria-label="Repeat">
            <span className="queue-actions-label">
              <RepeatIcon size={15} />
              <span>Repeat</span>
            </span>
            <span className="queue-actions-seg">
              {REPEAT_MODES.map((mode) => (
                <button
                  key={mode.mode}
                  type="button"
                  className={repeat === mode.mode ? 'active' : undefined}
                  aria-pressed={repeat === mode.mode}
                  onClick={() => onRepeatChange(mode.mode)}
                >
                  {mode.label}
                </button>
              ))}
            </span>
          </div>

          <div className="queue-actions-sep" role="separator" />

          <button
            type="button"
            role="menuitem"
            className="queue-actions-item"
            disabled={index <= 0}
            onClick={() => {
              onRemovePlayed()
              setOpen(false)
            }}
          >
            <TrashIcon size={15} />
            <span>Remove played tracks</span>
          </button>

          <button
            type="button"
            role="menuitem"
            className="queue-actions-item danger"
            onClick={() => {
              onClear()
              setOpen(false)
            }}
          >
            <CloseIcon size={15} />
            <span>Clear queue</span>
          </button>
        </div>
      ) : null}

      {saveAt && playlistTrackIds
        ? createPortal(
            <AddToPlaylistMenu
              playlists={playlists}
              trackIds={playlistTrackIds}
              heading={`${selecting ? 'Selected' : 'Queue'} · ${formatCount(actionTracks.length)} tracks`}
              at={saveAt}
              onAdd={onAddTracksToPlaylist}
              onCreate={onCreatePlaylist}
              onClose={() => setSaveAt(null)}
            />,
            document.body
          )
        : null}
    </div>
  )
}
