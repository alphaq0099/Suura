import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import type { LibraryClickAction, Playlist, PlaylistDetail, Track } from '@shared/types'
import { formatCount, formatDuration } from '@shared/format'
import {
  DEFAULT_PLAYLIST_INDEX_WIDTH,
  PLAYLIST_INDEX_MAX,
  PLAYLIST_INDEX_MIN,
  clampPlaylistIndexWidth
} from '@shared/playlists'
import { messageOf } from '../api'
import { TrackList, describeClickAction } from './TrackList'
import { PlayIcon, PlaylistIcon, PlusIcon, PencilIcon, TrashIcon } from './Icons'

export interface PlaylistsViewProps {
  playlists: Playlist[]
  selectedId: number | null
  detail: PlaylistDetail | null
  loading: boolean
  error: string | null
  currentTrackId: number | null
  isPlaying: boolean
  singleClick: LibraryClickAction
  doubleClick: LibraryClickAction
  /** Width of the list of playlists, in CSS pixels. */
  indexWidth: number
  onIndexWidthChange: (width: number) => void
  onSelect: (playlistId: number) => void
  /** The menu's creator: resolves to the new playlist, or throws a readable error. */
  onCreate: (name: string) => Promise<Playlist>
  onRename: (playlistId: number, name: string) => Promise<void>
  onDelete: (playlistId: number) => Promise<void>
  onClear: (playlistId: number) => Promise<void>
  onRemoveItems: (itemIds: number[]) => Promise<void>
  onMoveItem: (itemId: number, toIndex: number) => Promise<void>
  /** Replaces the queue with these tracks, starting at `index`. */
  onPlay: (tracks: Track[], index: number) => void
  onReveal: (trackId: number) => void
}

function totalDuration(tracks: Track[]): string {
  const known = tracks.filter((track) => track.durationMs !== null && track.durationMs > 0)
  if (known.length === 0) return ''
  const ms = known.reduce((sum, track) => sum + (track.durationMs ?? 0), 0)
  return ` · ${formatDuration(ms)}`
}

/**
 * The Playlists view: every playlist on the left, the selected one's tracks on
 * the right.
 *
 * The tracks are the same `TrackList` the library uses, with sorting switched
 * off (a hand-ordered list cannot also be sorted by column, and the header's
 * sort buttons would quietly throw the order away) and with row dragging turned
 * on. Alt+↑/↓ moves the focused row, which is the keyboard equivalent of a drag
 * rather than a second-class fallback.
 */
export function PlaylistsView(props: PlaylistsViewProps) {
  const {
    playlists,
    selectedId,
    detail,
    loading,
    error,
    currentTrackId,
    isPlaying,
    singleClick,
    doubleClick,
    indexWidth: storedIndexWidth,
    onIndexWidthChange,
    onSelect,
    onCreate,
    onRename,
    onDelete,
    onClear,
    onRemoveItems,
    onMoveItem,
    onPlay,
    onReveal
  } = props

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(() => new Set<number>())
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [indexWidth, setIndexWidth] = useState(() => clampPlaylistIndexWidth(storedIndexWidth))
  const [draggingSplitter, setDraggingSplitter] = useState(false)
  const newNameRef = useRef<HTMLInputElement | null>(null)
  const layoutRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ startX: number; startWidth: number; width: number } | null>(null)

  /**
   * The widest the index may get before the track list has no room left. The
   * pane needs ~440px; the splitter itself takes 16px. The layout collapses to
   * one column below 1040px, so this is only consulted while both are showing.
   */
  const maxIndexWidth = useCallback((): number => {
    const layoutWidth = layoutRef.current?.getBoundingClientRect().width ?? 0
    return Math.max(PLAYLIST_INDEX_MIN, Math.min(PLAYLIST_INDEX_MAX, Math.floor(layoutWidth) - 456))
  }, [])

  const commitIndexWidth = useCallback(
    (apply: boolean): void => {
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      setDraggingSplitter(false)
      if (apply) onIndexWidthChange(drag.width)
    },
    [onIndexWidthChange]
  )

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) return
      event.preventDefault()
      dragRef.current = { startX: event.clientX, startWidth: indexWidth, width: indexWidth }
      setDraggingSplitter(true)
      try {
        event.currentTarget.setPointerCapture(event.pointerId)
      } catch {
        // A synthesized event has no active pointer to capture; the handlers on
        // the element still see the moves, which is all the self-test needs.
      }
    },
    [indexWidth]
  )

  const moveDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      const drag = dragRef.current
      if (!drag) return
      const width = Math.min(clampPlaylistIndexWidth(drag.startWidth + (event.clientX - drag.startX)), maxIndexWidth())
      drag.width = width
      setIndexWidth(width)
    },
    [maxIndexWidth]
  )

  const resetIndexWidth = useCallback((): void => {
    const width = clampPlaylistIndexWidth(DEFAULT_PLAYLIST_INDEX_WIDTH)
    setIndexWidth(width)
    onIndexWidthChange(width)
  }, [onIndexWidthChange])

  const onSplitterKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      let next: number
      switch (event.key) {
        case 'ArrowLeft':
          next = indexWidth - 16
          break
        case 'ArrowRight':
          next = indexWidth + 16
          break
        case 'Home':
          next = PLAYLIST_INDEX_MIN
          break
        case 'End':
          next = maxIndexWidth()
          break
        default:
          return
      }
      event.preventDefault()
      const width = Math.max(PLAYLIST_INDEX_MIN, Math.min(next, maxIndexWidth()))
      setIndexWidth(width)
      onIndexWidthChange(width)
    },
    [indexWidth, maxIndexWidth, onIndexWidthChange]
  )

  const tracks = useMemo(() => detail?.items.map((item) => item.track) ?? [], [detail])
  const entryIdFor = useCallback(
    (trackId: number): number | null => detail?.items.find((item) => item.track.id === trackId)?.id ?? null,
    [detail]
  )

  // A different playlist is a different selection: carrying one over would let
  // "Remove selected" act on tracks that are not on screen any more.
  useEffect(() => {
    setSelectedIds(new Set<number>())
    setConfirmDelete(null)
    setConfirmClear(false)
  }, [selectedId])

  const submitNew = useCallback(async (): Promise<void> => {
    const trimmed = newName.trim()
    if (trimmed.length === 0) return
    setActionError(null)
    try {
      await onCreate(trimmed)
      setNewName('')
      setCreating(false)
    } catch (cause) {
      setActionError(messageOf(cause))
    }
  }, [newName, onCreate])

  const submitRename = useCallback(
    async (playlistId: number): Promise<void> => {
      const trimmed = renameValue.trim()
      if (trimmed.length === 0) {
        setRenamingId(null)
        return
      }
      setActionError(null)
      try {
        await onRename(playlistId, trimmed)
        setRenamingId(null)
      } catch (cause) {
        setActionError(messageOf(cause))
      }
    },
    [onRename, renameValue]
  )

  const removeSelected = useCallback((): void => {
    const ids = tracks
      .filter((track) => selectedIds.has(track.id))
      .map((track) => entryIdFor(track.id))
      .filter((id): id is number => id !== null)
    if (ids.length === 0) return
    void onRemoveItems(ids)
    setSelectedIds(new Set<number>())
  }, [entryIdFor, onRemoveItems, selectedIds, tracks])

  const playSelected = useCallback((): void => {
    const index = tracks.findIndex((track) => selectedIds.has(track.id))
    if (index < 0) return
    const chosen = tracks.filter((track) => selectedIds.has(track.id))
    onPlay(chosen, 0)
  }, [onPlay, selectedIds, tracks])

  const subtitle = detail ? `${formatCount(tracks.length)} tracks${totalDuration(tracks)}` : ''

  return (
    <section className="main-view playlists-view">
      <header className="view-header">
        <div className="view-heading">
          <h1>Playlists</h1>
          <p className="subtitle">
            {playlists.length === 0
              ? 'Collect tracks from your library into your own order.'
              : playlists.length === 1
                ? '1 playlist'
                : `${formatCount(playlists.length)} playlists`}
          </p>
        </div>
        <div className="header-actions">
          <button type="button" className="primary" onClick={() => setCreating(true)}>
            <PlusIcon />
            <span>New playlist</span>
          </button>
        </div>
      </header>

      {actionError ? (
        <div className="banner error">
          <span>{actionError}</span>
          <button type="button" className="link-button" onClick={() => setActionError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {error ? <div className="banner error">{error}</div> : null}

      <div
        className={draggingSplitter ? 'playlists-layout dragging' : 'playlists-layout'}
        ref={layoutRef}
        style={{ '--playlist-index-width': `${indexWidth}px` } as CSSProperties}
      >
        <aside className="playlist-index" aria-label="Playlists">
          {creating ? (
            <form
              className="playlist-new"
              onSubmit={(event) => {
                event.preventDefault()
                void submitNew()
              }}
            >
              <input
                ref={newNameRef}
                className="playlist-input"
                value={newName}
                autoFocus
                maxLength={120}
                placeholder="Playlist name"
                aria-label="New playlist name"
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') return
                  event.stopPropagation()
                  setCreating(false)
                  setNewName('')
                  setActionError(null)
                }}
              />
              <button type="submit" className="small primary">
                Create
              </button>
            </form>
          ) : null}

          {playlists.map((playlist) => (
            <div
              key={playlist.id}
              className={playlist.id === selectedId ? 'playlist-row active' : 'playlist-row'}
            >
              {renamingId === playlist.id ? (
                <form
                  className="playlist-rename"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void submitRename(playlist.id)
                  }}
                >
                  <input
                    className="playlist-input"
                    value={renameValue}
                    autoFocus
                    maxLength={120}
                    aria-label={`Rename ${playlist.name}`}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Escape') return
                      event.stopPropagation()
                      setRenamingId(null)
                    }}
                  />
                  <button type="submit" className="small primary">
                    Save
                  </button>
                </form>
              ) : (
                <>
                  <button type="button" className="playlist-open" onClick={() => onSelect(playlist.id)}>
                    <span className="playlist-name" title={playlist.name}>
                      {playlist.name}
                    </span>
                    <span className="playlist-count">{formatCount(playlist.trackCount)}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-button subtle"
                    title="Rename playlist"
                    aria-label={`Rename ${playlist.name}`}
                    onClick={() => {
                      setRenamingId(playlist.id)
                      setRenameValue(playlist.name)
                      setConfirmDelete(null)
                    }}
                  >
                    <PencilIcon />
                  </button>
                  {confirmDelete === playlist.id ? (
                    <button
                      type="button"
                      className="icon-button subtle danger"
                      title="Delete this playlist"
                      aria-label={`Confirm deleting ${playlist.name}`}
                      onClick={() => void onDelete(playlist.id)}
                    >
                      <TrashIcon />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="icon-button subtle"
                      title="Delete playlist"
                      aria-label={`Delete ${playlist.name}`}
                      onClick={() => setConfirmDelete(playlist.id)}
                    >
                      <TrashIcon />
                    </button>
                  )}
                </>
              )}
            </div>
          ))}

          {confirmDelete !== null ? (
            <p className="playlist-hint">Click the bin again to delete the playlist. Tracks stay in your library.</p>
          ) : null}
        </aside>

        <div
          className={draggingSplitter ? 'playlist-splitter dragging' : 'playlist-splitter'}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the list of playlists"
          aria-valuemin={PLAYLIST_INDEX_MIN}
          aria-valuemax={PLAYLIST_INDEX_MAX}
          aria-valuenow={indexWidth}
          tabIndex={0}
          title="Drag to resize · double-click to reset"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={(event) => {
            try {
              event.currentTarget.releasePointerCapture(event.pointerId)
            } catch {
              // Already released.
            }
            commitIndexWidth(true)
          }}
          onPointerCancel={() => commitIndexWidth(false)}
          onDoubleClick={resetIndexWidth}
          onKeyDown={onSplitterKeyDown}
        />

        <div className="playlist-pane">
          {!detail ? (
            <div className="empty-state">
              <PlaylistIcon size={32} />
              <h2>{playlists.length === 0 ? 'No playlists yet' : 'Pick a playlist'}</h2>
              <p>
                {playlists.length === 0
                  ? 'Create one, then add tracks from the library — select some rows and choose “Add to playlist”.'
                  : 'Choose one on the left to see what is in it.'}
              </p>
              {playlists.length === 0 ? (
                <button type="button" className="primary" onClick={() => setCreating(true)}>
                  <PlusIcon />
                  <span>New playlist</span>
                </button>
              ) : null}
            </div>
          ) : (
            <>
              <div className="playlist-pane-head">
                <div>
                  <h2>{detail.playlist.name}</h2>
                  <p className="subtitle">{subtitle}</p>
                </div>
                <div className="header-actions">
                  <button type="button" onClick={() => onPlay(tracks, 0)} disabled={tracks.length === 0}>
                    <PlayIcon size={14} />
                    <span>Play</span>
                  </button>
                  <button
                    type="button"
                    className={confirmClear ? 'link-button danger' : 'link-button'}
                    disabled={tracks.length === 0}
                    onClick={() => {
                      if (!confirmClear) {
                        setConfirmClear(true)
                        return
                      }
                      setConfirmClear(false)
                      void onClear(detail.playlist.id)
                    }}
                  >
                    {confirmClear ? 'Clear all?' : 'Clear'}
                  </button>
                </div>
              </div>

              {selectedIds.size > 0 ? (
                <div className="banner selection-bar">
                  <span>
                    <strong>{formatCount(selectedIds.size)}</strong> selected
                  </span>
                  <button type="button" onClick={playSelected}>
                    <PlayIcon size={14} />
                    <span>Play selected</span>
                  </button>
                  <button type="button" onClick={removeSelected}>
                    <TrashIcon size={14} />
                    <span>Remove from playlist</span>
                  </button>
                  <button type="button" className="link-button" onClick={() => setSelectedIds(new Set<number>())}>
                    Clear
                  </button>
                </div>
              ) : null}

              {tracks.length === 0 ? (
                <div className="empty-state">
                  <PlaylistIcon size={32} />
                  <h2>This playlist is empty</h2>
                  <p>Select tracks in the Library and use “Add to playlist”, or right-click a row there.</p>
                </div>
              ) : (
                <TrackList
                  tracks={tracks}
                  total={tracks.length}
                  sort={null}
                  direction="asc"
                  currentTrackId={currentTrackId}
                  isPlaying={isPlaying}
                  selectedIds={selectedIds}
                  loadingMore={loading}
                  onToggleSort={() => undefined}
                  onActivate={(index) => onPlay(tracks, index)}
                  onSelect={(trackId, mode) =>
                    setSelectedIds((previous) => {
                      if (mode === 'replace') return new Set([trackId])
                      const next = new Set(previous)
                      if (next.has(trackId)) next.delete(trackId)
                      else next.add(trackId)
                      return next
                    })
                  }
                  onSelectAll={() => setSelectedIds(new Set(tracks.map((track) => track.id)))}
                  onClearSelection={() => setSelectedIds(new Set<number>())}
                  onReveal={onReveal}
                  singleClick={singleClick}
                  doubleClick={doubleClick}
                  sortable={false}
                  reorder={{
                    onMove: (fromIndex, toIndex) => {
                      const item = detail.items[fromIndex]
                      if (!item) return
                      void onMoveItem(item.id, toIndex)
                    }
                  }}
                  onRemove={(track) => {
                    const itemId = entryIdFor(track.id)
                    if (itemId === null) return
                    void onRemoveItems([itemId])
                  }}
                  removeLabel="Remove from playlist"
                  showFormat={false}
                />
              )}

              {tracks.length > 0 ? (
                <p className="table-footnote">
                  Drag a row to reorder, or focus it and press Alt+↑/↓. Click: {describeClickAction(singleClick)},
                  double-click: {describeClickAction(doubleClick)}.
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
