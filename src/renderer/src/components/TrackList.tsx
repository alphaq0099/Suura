import { useCallback, useEffect, useRef, useState } from 'react'
import { DENSITY_ROW_HEIGHT } from '@shared/appearance'
import type { DownloadStatus, LibraryClickAction, SortDirection, Track, TrackSortField } from '@shared/types'
import { formatDuration } from '@shared/format'
import { useRowReorder } from '../hooks/useRowReorder'
import { ArtworkImage } from './ArtworkImage'
import {
  CheckIcon,
  DownloadIcon,
  InfoIcon,
  MoreIcon,
  PlayIcon,
  QueueIcon,
  RevealIcon,
  SortIcon,
  SpinnerIcon,
  TrashIcon
} from './Icons'

/** How a configured click action reads in a tooltip or a footnote. */
export function describeClickAction(action: LibraryClickAction): string {
  switch (action) {
    case 'nothing':
      return 'nothing'
    case 'play':
      return 'play'
    case 'select-play':
      return 'select and play'
    default:
      return 'select'
  }
}

/** Rows rendered beyond the visible window, so a fast flick does not show blanks. */
const OVERSCAN = 6

export interface TrackListProps {
  tracks: Track[]
  /** Rows matching the query, including pages that have not been loaded yet. */
  total: number
  sort: TrackSortField | null
  direction: SortDirection
  currentTrackId: number | null
  isPlaying: boolean
  selectedIds: ReadonlySet<number>
  loadingMore: boolean
  onToggleSort: (field: TrackSortField) => void
  /** Play the row at this index of `tracks`. */
  onActivate: (index: number) => void
  onSelect: (trackId: number, mode: 'replace' | 'toggle') => void
  onSelectAll: () => void
  onClearSelection: () => void
  onReveal: (trackId: number) => void
  /**
   * Asks for the next page. Omitted when the whole list is already in hand — a
   * playlist, which is loaded in one request because its order is the data.
   */
  onRequestMore?: () => void
  /** What a single click on a row does. */
  singleClick: LibraryClickAction
  /** What a double click on a row does. */
  doubleClick: LibraryClickAction
  /**
   * False for a list whose order is the user's own. The header stays, the sort
   * buttons do not: a hand-ordered list that can be re-sorted by clicking a
   * column cannot keep an order.
   */
  sortable?: boolean
  /**
   * Height of a rendered row, in pixels. It comes from the density preference
   * and must match `--row-height` in styles.css; the virtualizer divides the
   * scroll offset by this number, so a mismatch shows up as rows jumping.
   */
  rowHeight?: number
  /** Turns rows into draggable items. Alt+arrow does the same thing from the keyboard. */
  reorder?: { onMove: (fromIndex: number, toIndex: number) => void }
  /** Adds a "Remove from this list" action to every row. */
  onRemove?: (track: Track) => void
  /** What the remove action says, e.g. "Remove from playlist". */
  removeLabel?: string
  /** Adds an "Add to queue" action to stream rows. */
  onQueue?: (track: Track) => void
  /**
   * Changes when the rows are a different list rather than a new page of the
   * same one. The virtualizer returns to the top when it changes.
   */
  listKey?: string
  /**
   * Right-click (or Shift+F10) on a row. The coordinates are page coordinates,
   * so the caller can open a menu where the pointer is. When this is passed, the
   * row's action button opens the same menu.
   */
  onRowContextMenu?: (track: Track, index: number, at: { x: number; y: number }) => void
  /**
   * Opens the technical sheet for a row. Used where there is no row menu (an
   * imported playlist, whose order is not the user's to act on).
   */
  onDetails?: (track: Track) => void
  /**
   * Adds a "Save to library" action to stream rows. Local rows never get one:
   * they are already a file, which is what saving produces.
   */
  onSave?: (track: Track) => void
  /** Whether a row already has a library copy, so the action becomes a tick. */
  isSaved?: (track: Track) => boolean
  /** Progress for a row that is saving, so the button becomes a spinner. */
  saveState?: (track: Track) => { status: DownloadStatus; percent: number | null; error: string | null } | undefined
}

interface Column {
  field: TrackSortField | null
  label: string
  className: string
}

const COLUMNS: Column[] = [
  { field: null, label: '#', className: 'col-index' },
  { field: 'title', label: 'Title', className: 'col-title' },
  { field: 'artist', label: 'Artist', className: 'col-artist' },
  { field: 'album', label: 'Album', className: 'col-album' },
  { field: 'duration', label: 'Duration', className: 'col-time' },
  { field: null, label: '', className: 'col-actions' }
]

/**
 * The library list.
 *
 * Rows are windowed: only what fits the scroll viewport (plus an overscan) is in
 * the DOM, so a 50 000 track library costs the same as a 30 track one. The
 * container is a single tab stop that owns `aria-activedescendant`, which is the
 * ARIA grid pattern for exactly this situation — 50 000 focusable rows would be
 * unusable with a keyboard.
 */
export function TrackList(props: TrackListProps) {
  const {
    tracks,
    total,
    sort,
    direction,
    currentTrackId,
    isPlaying,
    selectedIds,
    loadingMore,
    onToggleSort,
    onActivate,
    onSelect,
    onSelectAll,
    onClearSelection,
    onReveal,
    onRequestMore,
    singleClick,
    doubleClick,
    sortable = true,
    rowHeight = DENSITY_ROW_HEIGHT.comfortable,
    reorder,
    onRemove,
    removeLabel = 'Remove from this list',
    onQueue,
    listKey,
    onRowContextMenu,
    onDetails,
    onSave,
    isSaved,
    saveState
  } = props

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(480)
  const [activeIndex, setActiveIndex] = useState(0)

  const drag = useRowReorder({
    enabled: Boolean(reorder),
    itemCount: tracks.length,
    rowHeight: rowHeight,
    scroller: scrollerRef,
    onMove: (fromIndex, toIndex) => {
      reorder?.onMove(fromIndex, toIndex)
      // The cursor follows the row that moved, so a second Alt+arrow continues
      // from where the first one left it.
      setActiveIndex(toIndex)
    }
  })

  /**
   * Runs a configured gesture.
   *
   * `modifiers` is separate from the action because Shift and Ctrl mean the same
   * thing whatever the action is: extend or toggle the selection rather than
   * replacing it.
   */
  const applyClickAction = useCallback(
    (action: LibraryClickAction, index: number, track: Track, modifiers: boolean): void => {
      if (action === 'select' || action === 'select-play') {
        onSelect(track.id, modifiers ? 'toggle' : 'replace')
      }
      if (action === 'play' || action === 'select-play') {
        onActivate(index)
      }
    },
    [onSelect, onActivate]
  )

  // A double click arrives as two single clicks and *then* the double-click
  // handler, so when both gestures play, the second one would restart a track the
  // first has just started — audible, and not what anyone means by a double click.
  const doubleClickRepeats = doubleClick === 'play' && (singleClick === 'play' || singleClick === 'select-play')

  useEffect(() => {
    const element = scrollerRef.current
    if (!element) return
    const measure = (): void => setViewport(element.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // A new query means a new list: go back to the top and to the first row.
  useEffect(() => {
    setScrollTop(0)
    setActiveIndex(0)
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0
  }, [sort, direction, listKey])

  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN)
  const end = Math.min(tracks.length, Math.ceil((scrollTop + viewport) / rowHeight) + OVERSCAN)
  const visible = tracks.slice(start, end)

  // Fetch the next page once the window reaches the end of what is loaded.
  useEffect(() => {
    if (!onRequestMore) return
    if (tracks.length === 0) return
    if (end >= tracks.length - 1 && tracks.length < total) onRequestMore()
  }, [end, tracks.length, total, onRequestMore])

  /** Brings a row into the viewport, centring it when asked. */
  const scrollRowIntoView = useCallback((index: number, center = false): void => {
    const element = scrollerRef.current
    if (!element) return
    const top = index * rowHeight
    const bottom = top + rowHeight
    if (center) {
      element.scrollTop = Math.max(0, top - (element.clientHeight - rowHeight) / 2)
      return
    }
    if (top < element.scrollTop) element.scrollTop = top
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight
  }, [rowHeight])

  const moveActive = useCallback(
    (next: number): void => {
      const clamped = Math.min(Math.max(next, 0), Math.max(tracks.length - 1, 0))
      setActiveIndex(clamped)
      scrollRowIntoView(clamped)
    },
    [tracks.length, scrollRowIntoView]
  )

  // Playback brings its own row into view, so the list points at what is playing
  // instead of sitting at the top on row one.
  //
  // Two deliberate limits. It only fires when the row is off screen, because
  // re-centring on every auto-advance would yank the list out from under someone
  // reading further down — the opposite of the helpful thing. And a current track
  // that has not been paged in yet is not scrolled to: paging the rest of a
  // 50 000 track library to reach one row would be worse than doing nothing, and
  // the effect simply retries when the next page lands.
  const followedTrackRef = useRef<number | null>(null)
  useEffect(() => {
    if (currentTrackId === null) return
    if (followedTrackRef.current === currentTrackId) return
    const index = tracks.findIndex((track) => track.id === currentTrackId)
    if (index < 0) return
    followedTrackRef.current = currentTrackId

    const element = scrollerRef.current
    if (!element) return
    const top = index * rowHeight
    const bottom = top + rowHeight
    if (top >= element.scrollTop && bottom <= element.scrollTop + element.clientHeight) return
    scrollRowIntoView(index, true)
  }, [currentTrackId, tracks, scrollRowIntoView])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const page = Math.max(1, Math.floor(viewport / rowHeight) - 1)
    // Handled keys are also stopped from propagating: the global shortcut layer
    // listens on window, and the arrow keys mean "move the row cursor" here while
    // they mean "seek" and "volume" there.
    const take = (): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        // Alt turns the row cursor into a row *move*, which is the keyboard
        // equivalent of dragging: there is no other way to reorder a list with
        // the keyboard, and a pointer-only feature is half a feature.
        if (event.altKey && reorder) {
          take()
          const delta = event.key === 'ArrowDown' ? 1 : -1
          const to = drag.targetFor(activeIndex, delta)
          const moved = tracks[activeIndex]
          if (to !== null && moved) {
            reorder.onMove(activeIndex, to)
            setActiveIndex(to)
            scrollRowIntoView(to)
          }
          break
        }
        take()
        moveActive(activeIndex + (event.key === 'ArrowDown' ? 1 : -1))
        break
      }
      case 'PageDown':
        take()
        moveActive(activeIndex + page)
        break
      case 'PageUp':
        take()
        moveActive(activeIndex - page)
        break
      case 'Home':
        take()
        moveActive(0)
        break
      case 'End':
        take()
        moveActive(tracks.length - 1)
        break
      case 'Enter':
        take()
        if (tracks[activeIndex]) onActivate(activeIndex)
        break
      case 'a':
      case 'A':
        if (event.ctrlKey || event.metaKey) {
          take()
          onSelectAll()
        }
        break
      case 'Escape':
        take()
        onClearSelection()
        break
      // The keyboard's own context-menu key, and Shift+F10 for keyboards that do
      // not have one. The row's position is read from the DOM so the menu opens
      // where the row is, exactly as a right-click would.
      case 'ContextMenu':
      case 'F10': {
        const wantsMenu = event.key === 'ContextMenu' || event.shiftKey
        const track = tracks[activeIndex]
        if (!wantsMenu || !onRowContextMenu || !track) break
        const row = document.getElementById(`track-row-${activeIndex}`)
        if (!row) break
        take()
        const rect = row.getBoundingClientRect()
        onRowContextMenu(track, activeIndex, { x: rect.left + 48, y: rect.top + rect.height })
        break
      }
      default:
        break
    }
  }

  const activeId = tracks[activeIndex] ? `track-row-${activeIndex}` : undefined
  const columns = COLUMNS

  return (
    <div
      className={[
        'track-list',
        onRemove ? 'has-remove' : '',
        onSave ? 'has-save' : '',
        onQueue ? 'has-queue' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="track-head" role="row">
        {columns.map((column) => (
          <div
            key={column.className}
            role="columnheader"
            className={`head-cell ${column.className}`}
            aria-sort={column.field && sort === column.field ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}
          >
            {column.field && sortable ? (
              <button
                type="button"
                className="sort-button"
                onClick={() => onToggleSort(column.field as TrackSortField)}
                title={`Sort by ${column.label.toLowerCase()}`}
              >
                <span>{column.label}</span>
                {sort === column.field ? <SortIcon direction={direction} /> : null}
              </button>
            ) : column.label ? (
              <span>{column.label}</span>
            ) : (
              <span className="visually-hidden">Actions</span>
            )}
          </div>
        ))}
      </div>

      <div
        className="list-scroll"
        ref={scrollerRef}
        role="grid"
        tabIndex={0}
        aria-rowcount={total}
        aria-colcount={columns.length}
        aria-multiselectable
        aria-activedescendant={activeId}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={handleKeyDown}
      >
        <div className="list-rows" style={{ height: tracks.length * rowHeight }}>
          <div className="list-window" style={{ transform: `translateY(${start * rowHeight}px)` }}>
            {visible.map((track, offset) => {
              const index = start + offset
              const isCurrent = track.id === currentTrackId
              const isSelected = selectedIds.has(track.id)
              const isActive = index === activeIndex
              const isDragging = drag.draggingIndex === index
              const dropEdge = drag.dropAt && drag.dropAt.index === index ? drag.dropAt.edge : null
              const isStream = track.sourceKind === 'youtube' && track.sourceId !== null
              const rowSaved = isStream && (isSaved?.(track) ?? false)
              const saving = isStream ? saveState?.(track) : undefined
              const savingActive =
                saving !== undefined &&
                saving.status !== 'saved' &&
                saving.status !== 'failed' &&
                saving.status !== 'cancelled'
              const rowClass = [
                'track-row',
                isCurrent ? 'current' : '',
                isSelected ? 'selected' : '',
                isActive ? 'active' : '',
                isDragging ? 'dragging' : '',
                dropEdge ? `drop-${dropEdge}` : ''
              ]
                .filter(Boolean)
                .join(' ')

              return (
                <div
                  key={track.id}
                  id={`track-row-${index}`}
                  role="row"
                  aria-rowindex={index + 2}
                  aria-selected={isSelected}
                  className={rowClass}
                  style={{ height: rowHeight }}
                  draggable={Boolean(reorder) || undefined}
                  onDragStart={(event) => drag.start(event, index)}
                  onDragOver={(event) => drag.over(event, index)}
                  onDrop={(event) => drag.drop(event, index)}
                  onDragEnd={() => drag.end()}
                  onClick={(event) => {
                    // The keyboard cursor follows the pointer whatever the action
                    // is: it is where the arrow keys will start from, not a
                    // symptom of having selected something.
                    setActiveIndex(index)
                    applyClickAction(singleClick, index, track, event.ctrlKey || event.metaKey || event.shiftKey)
                  }}
                  onDoubleClick={(event) => {
                    // Skip a restart the first click of this double click just started.
                    if (doubleClickRepeats && isCurrent && isPlaying) return
                    applyClickAction(doubleClick, index, track, event.ctrlKey || event.metaKey || event.shiftKey)
                  }}
                  onContextMenu={(event) => {
                    if (!onRowContextMenu) return
                    event.preventDefault()
                    setActiveIndex(index)
                    onRowContextMenu(track, index, { x: event.clientX, y: event.clientY })
                  }}
                  title={`Click: ${describeClickAction(singleClick)} · Double-click: ${describeClickAction(
                    doubleClick
                  )}${reorder ? ' · Drag or Alt+↑/↓ to reorder' : ''}`}
                >
                  <div role="gridcell" className="cell col-index">
                    {isCurrent && isPlaying ? (
                      <span className="playing-dot" />
                    ) : (
                      <>
                        <span className="row-number">{index + 1}</span>
                        <button
                          type="button"
                          className="row-play"
                          tabIndex={-1}
                          title="Play"
                          aria-label={`Play ${track.title}`}
                          onClick={(event) => {
                            event.stopPropagation()
                            setActiveIndex(index)
                            onActivate(index)
                          }}
                        >
                          <PlayIcon size={12} />
                        </button>
                      </>
                    )}
                  </div>
                  <div role="gridcell" className="cell col-title" title={track.title}>
                    <ArtworkImage track={track} size={24} className="row-art" />
                    <span className="row-title-text">{track.title}</span>
                  </div>
                  <div role="gridcell" className="cell col-artist" title={track.artist ?? undefined}>
                    {track.artist ?? '—'}
                  </div>
                  <div role="gridcell" className="cell col-album" title={track.album ?? undefined}>
                    {track.album ?? '—'}
                  </div>
                  <div role="gridcell" className="cell col-time">
                    {formatDuration(track.durationMs)}
                  </div>
                  <div role="gridcell" className="cell col-actions">
                    {onSave && isStream ? (
                      <button
                        type="button"
                        className={rowSaved ? 'icon-button subtle saved' : 'icon-button subtle'}
                        title={
                          rowSaved
                            ? 'Already in your library'
                            : savingActive
                              ? `Saving… ${Math.round(saving?.percent ?? 0)}%`
                              : saving?.status === 'failed'
                                ? (saving.error ?? 'Could not save this track. Try again.')
                                : 'Save to your library'
                        }
                        aria-label={
                          rowSaved
                            ? `${track.title} is in your library`
                            : `Save ${track.title} to your library`
                        }
                        disabled={rowSaved || savingActive}
                        onClick={(event) => {
                          event.stopPropagation()
                          onSave(track)
                        }}
                      >
                        {rowSaved ? <CheckIcon /> : savingActive ? <SpinnerIcon /> : <DownloadIcon />}
                      </button>
                    ) : null}
                    {onQueue && isStream ? (
                      <button
                        type="button"
                        className="icon-button subtle"
                        title="Add to queue"
                        aria-label={`Add ${track.title} to the queue`}
                        onClick={(event) => {
                          event.stopPropagation()
                          onQueue(track)
                        }}
                      >
                        <QueueIcon size={15} />
                      </button>
                    ) : null}
                    {onRemove ? (
                      <button
                        type="button"
                        className="icon-button subtle"
                        title={removeLabel}
                        aria-label={`${removeLabel}: ${track.title}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          onRemove(track)
                        }}
                      >
                        <TrashIcon />
                      </button>
                    ) : null}
                    {onRowContextMenu ? (
                      <button
                        type="button"
                        className="icon-button subtle"
                        title="More actions"
                        aria-label={`More actions for ${track.title}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          setActiveIndex(index)
                          const rect = event.currentTarget.getBoundingClientRect()
                          onRowContextMenu(track, index, { x: rect.left, y: rect.bottom + 4 })
                        }}
                      >
                        <MoreIcon />
                      </button>
                    ) : onDetails ? (
                      <button
                        type="button"
                        className="icon-button subtle"
                        title="Details"
                        aria-label={`Details for ${track.title}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          onDetails(track)
                        }}
                      >
                        <InfoIcon />
                      </button>
                    ) : track.filePath ? (
                      <button
                        type="button"
                        className="icon-button subtle"
                        title="Show in folder"
                        aria-label={`Show ${track.title} in folder`}
                        onClick={(event) => {
                          event.stopPropagation()
                          onReveal(track.id)
                        }}
                      >
                        <RevealIcon />
                      </button>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {loadingMore ? (
        <div className="list-loading">
          <SpinnerIcon />
          <span>Loading more tracks…</span>
        </div>
      ) : null}
    </div>
  )
}
