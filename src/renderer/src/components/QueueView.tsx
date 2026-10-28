import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AddTracksOutcome, Playlist, RepeatMode } from '@shared/types'
import { formatCount, formatDuration } from '@shared/format'
import { queueSourceLabel, type QueueTrack } from '@shared/queue'
import type { UseDownloadsResult } from '../hooks/useDownloads'
import { useRowReorder } from '../hooks/useRowReorder'
import { AddToPlaylistMenu } from './AddToPlaylistMenu'
import { ArtworkImage } from './ArtworkImage'
import { QueueActionsMenu } from './QueueActionsMenu'
import { RowMenu } from './RowMenu'
import {
  CheckIcon,
  CloseIcon,
  GripIcon,
  PlayIcon,
  PlaylistIcon,
  QueueIcon,
  TrashIcon
} from './Icons'

export interface QueueViewProps {
  queue: QueueTrack[]
  index: number
  isPlaying: boolean
  repeat: RepeatMode
  shuffle: boolean
  downloads: UseDownloadsResult
  playlists: Playlist[]
  onJump: (position: number) => void
  onRemove: (position: number) => void
  onMove: (from: number, to: number) => void
  onRemovePlayed: () => void
  onClear: () => void
  onToggleShuffle: () => void
  onRepeatChange: (mode: RepeatMode) => void
  onAddTracksToPlaylist: (playlistId: number, trackIds: number[]) => Promise<AddTracksOutcome>
  onCreatePlaylist: (name: string) => Promise<Playlist>
  onBrowseLibrary: () => void
  /** Replaces the queue with the given rows and starts the first one. */
  onPlaySelected: (tracks: QueueTrack[]) => void
  /** Appends the given rows to the queue. */
  onQueueSelected: (tracks: QueueTrack[]) => void
}

/**
 * The play queue.
 *
 * This is the order the player will actually follow, which is not necessarily
 * library order: shuffle rewrites it. That is the point of showing it — with
 * shuffle on, "what plays next" is otherwise invisible.
 */
export function QueueView(props: QueueViewProps) {
  const {
    queue,
    index,
    isPlaying,
    repeat,
    shuffle,
    downloads,
    playlists,
    onJump,
    onRemove,
    onMove,
    onRemovePlayed,
    onClear,
    onToggleShuffle,
    onRepeatChange,
    onAddTracksToPlaylist,
    onCreatePlaylist,
    onBrowseLibrary,
    onPlaySelected,
    onQueueSelected
  } = props

  const listRef = useRef<HTMLOListElement | null>(null)
  const currentRowRef = useRef<HTMLButtonElement | null>(null)
  const [selectedPositions, setSelectedPositions] = useState<ReadonlySet<number>>(
    () => new Set<number>()
  )
  const [rowMenu, setRowMenu] = useState<{ position: number; x: number; y: number } | null>(null)
  const [saveAt, setSaveAt] = useState<{ x: number; y: number } | null>(null)
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
      // The anchor is the row where the selection started; a focused row is the
      // fallback when Shift is the very first gesture. Keeping it fixed is what
      // makes a second Shift-click extend the range instead of replacing it.
      const anchor = selectionAnchorRef.current ?? focusPositionRef.current ?? index
      selectionAnchorRef.current = anchor
      const from = Math.min(anchor, position)
      const to = Math.max(anchor, position)
      const next = new Set<number>()
      for (let at = from; at <= to; at += 1) next.add(at)
      setSelectedPositions(next)
      focusPositionRef.current = position
    },
    [index]
  )

  const selectAll = useCallback((): void => {
    setSelectedPositions(new Set(queue.map((_, position) => position)))
    selectionAnchorRef.current = queue.length > 0 ? 0 : null
  }, [queue.length])

  const clearSelection = useCallback((): void => {
    setSelectedPositions(new Set<number>())
    selectionAnchorRef.current = null
    focusPositionRef.current = null
  }, [])

  // A queue reorder, removal or replacement makes positions mean something else.
  useEffect(() => {
    clearSelection()
    setRowMenu(null)
    setSaveAt(null)
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
  const allSelected =
    queue.length > 0 && queue.every((_, position) => selectedPositions.has(position))
  const someSelected = queue.some((_, position) => selectedPositions.has(position))

  /**
   * A playlist row needs a library id. A stream has one only after it has been
   * saved, so this is the same rule the queue actions menu follows: enable the
   * button only when every selected row can be named.
   */
  const playlistTrackIds = useMemo<number[] | null>(() => {
    if (selectedTracks.length === 0) return null
    const ids: number[] = []
    for (const track of selectedTracks) {
      if (track.sourceKind === 'local') {
        ids.push(track.id)
        continue
      }
      const trackId = track.sourceId ? downloads.states[track.sourceId]?.trackId : null
      if (trackId == null) return null
      ids.push(trackId)
    }
    return [...new Set(ids)]
  }, [downloads.states, selectedTracks])

  // Entering the tab, jumping to a row and reaching the next track all leave the
  // current row somewhere in a long queue. Keep it in view without stealing the
  // list's own scroll position on every unrelated render.
  useEffect(() => {
    currentRowRef.current?.scrollIntoView({ block: 'center' })
  }, [index, queue.length])

  // Drag remains available while shuffled: the visible order is the queue the
  // player will follow, so reordering it is a real instruction, not a no-op.
  const drag = useRowReorder({
    enabled: queue.length > 1,
    itemCount: queue.length,
    rowHeight: 36,
    scroller: listRef,
    onMove
  })

  const totalMs = queue.reduce((sum, track) => sum + (track.durationMs ?? 0), 0)

  return (
    <section className="main-view">
      <header className="view-header">
        <div className="view-heading">
          <h1>Queue</h1>
          <p className="subtitle">
            {queue.length > 0
              ? `${formatCount(queue.length)} tracks · ${formatDuration(totalMs)} total`
              : 'Nothing queued'}
          </p>
        </div>
        {queue.length > 0 ? (
          <div className="header-actions">
            <QueueActionsMenu
              queue={queue}
              index={index}
              repeat={repeat}
              shuffle={shuffle}
              downloads={downloads}
              playlists={playlists}
              onAddTracksToPlaylist={onAddTracksToPlaylist}
              onCreatePlaylist={onCreatePlaylist}
              onToggleShuffle={onToggleShuffle}
              onRepeatChange={onRepeatChange}
              onRemovePlayed={onRemovePlayed}
              onClear={onClear}
              selectedTracks={selectedTracks}
              onClearSelection={clearSelection}
              onPlaySelected={onPlaySelected}
            />
          </div>
        ) : null}
      </header>

      {selecting ? (
        <div className="banner selection-bar">
          <span>
            <strong>{formatCount(selectedPositions.size)}</strong> selected · click a title to play
          </span>
          <button type="button" onClick={() => onPlaySelected(selectedTracks)}>
            <PlayIcon size={14} />
            <span>Play selected</span>
          </button>
          <button
            type="button"
            disabled={!playlistTrackIds}
            title={
              playlistTrackIds
                ? 'Save the selected tracks to a playlist'
                : 'Download the selected streaming tracks first'
            }
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              setSaveAt({ x: rect.left, y: rect.bottom + 6 })
            }}
          >
            <PlaylistIcon size={14} />
            <span>Save as playlist</span>
          </button>
          <button type="button" className="selection-clear" onClick={clearSelection}>
            Clear
          </button>
        </div>
      ) : null}

      {queue.length === 0 ? (
        <div className="empty-state">
          <QueueIcon size={32} />
          <h2>The queue is empty</h2>
          <p>Play something from the library and it will show up here, in the order it will play.</p>
          <button type="button" className="primary" onClick={onBrowseLibrary}>
            <span>Browse library</span>
          </button>
        </div>
      ) : (
        <div className="queue-table">
          <div className="queue-head">
            <span className={`head-cell col-index${selecting ? ' head-select-cell' : ''}`}>
              {selecting ? (
                <label
                  className="head-select"
                  title={allSelected ? 'Clear selection' : 'Select all queue tracks'}
                >
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(node) => {
                      if (node) node.indeterminate = someSelected && !allSelected
                    }}
                    onChange={() => {
                      if (allSelected) clearSelection()
                      else selectAll()
                    }}
                    aria-label={allSelected ? 'Clear selection' : 'Select all queue tracks'}
                  />
                </label>
              ) : (
                '#'
              )}
            </span>
            <span className="head-cell col-title">Title</span>
            <span className="head-cell col-artist">Artist</span>
            <span className="head-cell col-source">Source</span>
            <span className="head-cell col-time">Duration</span>
          </div>
          <ol className="queue-list" ref={listRef}>
            {queue.map((track, position) => {
              const isCurrent = position === index
              const dragging = drag.draggingIndex === position
              const drop =
                drag.draggingIndex !== null && drag.dropAt?.index === position
                  ? drag.dropAt.edge
                  : null
              const source = queueSourceLabel(track)
              return (
                <li
                  key={`${track.id}-${position}`}
                  className={[
                    'queue-item',
                    isCurrent ? 'current' : '',
                    selecting ? 'selecting' : '',
                    dragging ? 'dragging' : '',
                    drop ? `drop-${drop}` : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  draggable={queue.length > 1}
                  onDragStart={(event) => drag.start(event, position)}
                  onDragOver={(event) => drag.over(event, position)}
                  onDrop={(event) => drag.drop(event, position)}
                  onDragEnd={drag.end}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    focusPositionRef.current = position
                    setRowMenu({ position, x: event.clientX, y: event.clientY })
                  }}
                >
                  {selecting ? (
                    <label
                      className="queue-select"
                      title={selectedPositions.has(position) ? 'Deselect' : 'Select'}
                      onClick={(event) => event.stopPropagation()}
                      onDoubleClick={(event) => event.stopPropagation()}
                      onDragStart={(event) => event.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={selectedPositions.has(position)}
                        onChange={() => toggleSelected(position)}
                        aria-label={`${
                          selectedPositions.has(position) ? 'Deselect' : 'Select'
                        } ${track.title}`}
                      />
                    </label>
                  ) : null}
                  <button
                    type="button"
                    ref={isCurrent ? currentRowRef : undefined}
                    className="queue-jump"
                    onClick={(event) => {
                      focusPositionRef.current = position
                      if (event.ctrlKey || event.metaKey) {
                        event.preventDefault()
                        toggleSelected(position)
                        return
                      }
                      if (event.shiftKey) {
                        event.preventDefault()
                        selectRange(position)
                        return
                      }
                      onJump(position)
                    }}
                    title={isCurrent ? 'Restart this track' : 'Play this track'}
                    aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                    onKeyDown={(event) => {
                      if (!event.altKey) return
                      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
                      const to = drag.targetFor(position, event.key === 'ArrowUp' ? -1 : 1)
                      if (to === null) return
                      event.preventDefault()
                      onMove(position, to)
                    }}
                  >
                    <span className="queue-position">
                      {selecting ? null : (
                        <>
                          <span className="queue-grip" aria-hidden="true">
                            <GripIcon size={12} />
                          </span>
                          <span className="queue-number">
                            {isCurrent && isPlaying ? <span className="playing-dot" /> : position + 1}
                          </span>
                        </>
                      )}
                    </span>
                    <span className="queue-title-cell">
                      <ArtworkImage
                        track={track}
                        size={24}
                        iconSize={12}
                        className="row-art queue-row-art"
                      />
                      <span className="queue-title" title={track.title}>
                        {track.title}
                      </span>
                    </span>
                    <span className="queue-artist" title={track.artist ?? undefined}>
                      {track.artist ?? 'Unknown artist'}
                    </span>
                    <span className="queue-source" title={source}>
                      {source}
                    </span>
                    <span className="queue-time">{formatDuration(track.durationMs)}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-button subtle queue-remove"
                    title="Remove from queue"
                    aria-label={`Remove ${track.title} from the queue`}
                    onClick={() => onRemove(position)}
                  >
                    <CloseIcon />
                  </button>
                </li>
              )
            })}
          </ol>
        </div>
      )}

      {saveAt && playlistTrackIds ? (
        <AddToPlaylistMenu
          playlists={playlists}
          trackIds={playlistTrackIds}
          heading={`Selected � ${formatCount(selectedTracks.length)} tracks`}
          at={saveAt}
          onAdd={onAddTracksToPlaylist}
          onCreate={onCreatePlaylist}
          onClose={() => setSaveAt(null)}
        />
      ) : null}

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
              onSelect: () => onJump(rowMenu.position)
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
              onSelect: () => onRemove(rowMenu.position)
            }
          ]}
          onClose={() => setRowMenu(null)}
        />
      ) : null}
    </section>
  )
}
