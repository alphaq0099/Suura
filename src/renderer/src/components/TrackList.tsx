import { useCallback, useEffect, useRef, useState } from 'react'
import type { LibraryClickAction, SortDirection, Track, TrackSortField } from '@shared/types'
import { formatAudioSummary, formatDuration } from '@shared/format'
import { ArtworkImage } from './ArtworkImage'
import { PlayIcon, RevealIcon, SortIcon, SpinnerIcon } from './Icons'

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

/**
 * Fixed row height, in pixels. Must match `--row-height` in styles.css: the
 * virtualizer computes which rows are visible by dividing the scroll offset by
 * this number, so a mismatch shows up as rows jumping while scrolling.
 */
const ROW_HEIGHT = 38

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
  onRequestMore: () => void
  /** What a single click on a row does. */
  singleClick: LibraryClickAction
  /** What a double click on a row does. */
  doubleClick: LibraryClickAction
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
  { field: null, label: 'Format', className: 'col-format' },
  { field: 'duration', label: 'Time', className: 'col-time' },
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
    doubleClick
  } = props

  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(480)
  const [activeIndex, setActiveIndex] = useState(0)

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
  }, [sort, direction])

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(tracks.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN)
  const visible = tracks.slice(start, end)

  // Fetch the next page once the window reaches the end of what is loaded.
  useEffect(() => {
    if (tracks.length === 0) return
    if (end >= tracks.length - 1 && tracks.length < total) onRequestMore()
  }, [end, tracks.length, total, onRequestMore])

  /** Brings a row into the viewport, centring it when asked. */
  const scrollRowIntoView = useCallback((index: number, center = false): void => {
    const element = scrollerRef.current
    if (!element) return
    const top = index * ROW_HEIGHT
    const bottom = top + ROW_HEIGHT
    if (center) {
      element.scrollTop = Math.max(0, top - (element.clientHeight - ROW_HEIGHT) / 2)
      return
    }
    if (top < element.scrollTop) element.scrollTop = top
    else if (bottom > element.scrollTop + element.clientHeight) element.scrollTop = bottom - element.clientHeight
  }, [])

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
    const top = index * ROW_HEIGHT
    const bottom = top + ROW_HEIGHT
    if (top >= element.scrollTop && bottom <= element.scrollTop + element.clientHeight) return
    scrollRowIntoView(index, true)
  }, [currentTrackId, tracks, scrollRowIntoView])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const page = Math.max(1, Math.floor(viewport / ROW_HEIGHT) - 1)
    // Handled keys are also stopped from propagating: the global shortcut layer
    // listens on window, and the arrow keys mean "move the row cursor" here while
    // they mean "seek" and "volume" there.
    const take = (): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    switch (event.key) {
      case 'ArrowDown':
        take()
        moveActive(activeIndex + 1)
        break
      case 'ArrowUp':
        take()
        moveActive(activeIndex - 1)
        break
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
      default:
        break
    }
  }

  const activeId = tracks[activeIndex] ? `track-row-${activeIndex}` : undefined

  return (
    <div className="track-list">
      <div className="track-head" role="row">
        {COLUMNS.map((column) => (
          <div
            key={column.className}
            role="columnheader"
            className={`head-cell ${column.className}`}
            aria-sort={column.field && sort === column.field ? (direction === 'asc' ? 'ascending' : 'descending') : undefined}
          >
            {column.field ? (
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
        aria-colcount={COLUMNS.length}
        aria-multiselectable
        aria-activedescendant={activeId}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={handleKeyDown}
      >
        <div className="list-rows" style={{ height: tracks.length * ROW_HEIGHT }}>
          <div className="list-window" style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}>
            {visible.map((track, offset) => {
              const index = start + offset
              const isCurrent = track.id === currentTrackId
              const isSelected = selectedIds.has(track.id)
              const isActive = index === activeIndex
              const rowClass = [
                'track-row',
                isCurrent ? 'current' : '',
                isSelected ? 'selected' : '',
                isActive ? 'active' : ''
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
                  style={{ height: ROW_HEIGHT }}
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
                  title={`Click: ${describeClickAction(singleClick)} · Double-click: ${describeClickAction(doubleClick)}`}
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
                  <div role="gridcell" className="cell col-format">
                    {formatAudioSummary(track.codec, track.bitrateKbps)}
                  </div>
                  <div role="gridcell" className="cell col-time">
                    {formatDuration(track.durationMs)}
                  </div>
                  <div role="gridcell" className="cell col-actions">
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
