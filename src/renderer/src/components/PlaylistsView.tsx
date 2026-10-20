import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import type {
  LibraryClickAction,
  OnlinePlaylist,
  OnlinePlaylistDetail,
  Playlist,
  PlaylistDetail,
  Track
} from '@shared/types'
import { formatCount, formatDuration } from '@shared/format'
import { onlinePlaylistItemToTrack } from '@shared/online'
import type { PlayingList } from '@shared/online'
import {
  DEFAULT_PLAYLIST_INDEX_WIDTH,
  PLAYLIST_INDEX_MAX,
  PLAYLIST_INDEX_MIN,
  clampPlaylistIndexWidth
} from '@shared/playlists'
import { messageOf } from '../api'
import type { UseDownloadsResult } from '../hooks/useDownloads'
import { ArtworkImage } from './ArtworkImage'
import { TrackDetails } from './TrackDetails'
import { TrackList, describeClickAction } from './TrackList'
import { PlayIcon, PlaylistIcon, PlusIcon, PencilIcon, QueueIcon, RefreshIcon, SpinnerIcon, TrashIcon, DownloadIcon } from './Icons'

export interface PlaylistsViewProps {
  playlists: Playlist[]
  selectedId: number | null
  detail: PlaylistDetail | null
  /** Playlists imported from a link, newest first. */
  onlinePlaylists: OnlinePlaylist[]
  selectedOnlineId: number | null
  onlineDetail: OnlinePlaylistDetail | null
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
  onSelectOnline: (playlistId: number) => void
  /** The menu's creator: resolves to the new playlist, or throws a readable error. */
  onCreate: (name: string) => Promise<Playlist>
  onRename: (playlistId: number, name: string) => Promise<void>
  onDelete: (playlistId: number) => Promise<void>
  onClear: (playlistId: number) => Promise<void>
  onRemoveItems: (itemIds: number[]) => Promise<void>
  onMoveItem: (itemId: number, toIndex: number) => Promise<void>
  /** Fetches the source list again and stores a fresh snapshot. */
  onReimportOnline: (playlistId: number, limit?: number) => Promise<unknown>
  /** Gives an imported list a name of its own; it survives a re-import. */
  onRenameOnline: (playlistId: number, name: string) => Promise<void>
  onDeleteOnline: (playlistId: number) => Promise<void>
  onRemoveOnlineItem: (itemId: number) => Promise<void>
  /** Replaces the queue with these tracks, starting at `index`. */
  onPlay: (tracks: Track[], index: number) => void
  /** Appends these tracks to the queue without replacing it. */
  onQueue: (tracks: Track[]) => void
  /**
   * Records which imported list is playing, so the Streaming view can name it even
   * after the user has been elsewhere. `null` means what is playing is not a list.
   */
  onPlayingListChange: (list: PlayingList | null) => void
  onReveal: (trackId: number) => void
  /** Saving imported entries into the library, shared with the Streaming view. */
  downloads: UseDownloadsResult
}

function totalDuration(tracks: Track[]): string {
  const known = tracks.filter((track) => track.durationMs !== null && track.durationMs > 0)
  if (known.length === 0) return ''
  const ms = known.reduce((sum, track) => sum + (track.durationMs ?? 0), 0)
  return ` · ${formatDuration(ms)}`
}

function listKindLabel(playlist: OnlinePlaylist): string {
  if (playlist.kind === 'album') return 'Album'
  if (playlist.kind === 'mix') return 'Mix'
  return 'Playlist'
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
    onlinePlaylists,
    selectedOnlineId,
    onlineDetail,
    loading,
    error,
    currentTrackId,
    isPlaying,
    singleClick,
    doubleClick,
    indexWidth: storedIndexWidth,
    onIndexWidthChange,
    onSelect,
    onSelectOnline,
    onCreate,
    onRename,
    onDelete,
    onClear,
    onRemoveItems,
    onMoveItem,
    onReimportOnline,
    onRenameOnline,
    onDeleteOnline,
    onRemoveOnlineItem,
    onPlay,
    onQueue,
    onPlayingListChange,
    onReveal,
    downloads
  } = props

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renamingOnlineId, setRenamingOnlineId] = useState<number | null>(null)
  const [renameOnlineValue, setRenameOnlineValue] = useState('')
  const [reimportLimit, setReimportLimit] = useState('')
  const [detailsTrack, setDetailsTrack] = useState<Track | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(() => new Set<number>())
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)
  const [confirmDeleteOnline, setConfirmDeleteOnline] = useState<number | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [reimporting, setReimporting] = useState(false)
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

  // An imported playlist is a snapshot of someone else's order: selecting it
  // clears the hand-made selection, so Remove can never act on hidden entries.
  const showingOnline = selectedOnlineId !== null && onlineDetail !== null && onlineDetail.playlist.id === selectedOnlineId

  const tracks = useMemo(() => {
    if (showingOnline && onlineDetail) {
      return onlineDetail.items.map((item) => onlinePlaylistItemToTrack(item, onlineDetail.playlist))
    }
    return detail?.items.map((item) => item.track) ?? []
  }, [detail, onlineDetail, showingOnline])

  const { saved, states, save: saveToLibrary, saveMany: saveManyToLibrary, refreshSaved } = downloads

  /** The ids whose "in your library" badge has to be answered for this pane. */
  const onlineVideoIds = useMemo(
    () => (showingOnline && onlineDetail ? onlineDetail.items.map((item) => item.videoId) : []),
    [showingOnline, onlineDetail]
  )

  useEffect(() => {
    void refreshSaved(onlineVideoIds)
  }, [onlineVideoIds, refreshSaved])

  /** Entries that do not have a library row yet, in source order. */
  const unsavedOnline = useMemo(
    () =>
      showingOnline && onlineDetail
        ? onlineDetail.items.filter((item) => !saved.has(item.videoId))
        : [],
    [showingOnline, onlineDetail, saved]
  )

  const saveOnlineTrack = useCallback(
    (track: Track): void => {
      if (track.sourceKind !== 'youtube' || !track.sourceId) return
      // The row reports its own progress and error; the pane has no banner for a
      // single failed file, and a failed save must not look like a successful one.
      void saveToLibrary({
        videoId: track.sourceId,
        title: track.title,
        artist: track.artist,
        album: track.album
      }).catch(() => undefined)
    },
    [saveToLibrary]
  )

  const entryIdFor = useCallback(
    (trackId: number): number | null => detail?.items.find((item) => item.track.id === trackId)?.id ?? null,
    [detail]
  )

  const onlineEntryIdFor = useCallback(
    (trackId: number): number | null => {
      if (!onlineDetail) return null
      const index = tracks.findIndex((track) => track.id === trackId)
      return index >= 0 ? (onlineDetail.items[index]?.id ?? null) : null
    },
    [onlineDetail, tracks]
  )

  // A different playlist is a different selection: carrying one over would let
  // "Remove selected" act on tracks that are not on screen any more.
  useEffect(() => {
    setSelectedIds(new Set<number>())
    setConfirmDelete(null)
    setConfirmDeleteOnline(null)
    setConfirmClear(false)
    setReimporting(false)
  }, [selectedId, selectedOnlineId])

  // The count beside Re-import starts at what the snapshot currently holds. A
  // re-import that returns a different number refreshes it; a number the user is
  // in the middle of typing is left alone.
  const onlinePlaylistId = onlineDetail?.playlist.id ?? null
  const onlineTrackCount = onlineDetail?.playlist.trackCount ?? 0
  useEffect(() => {
    setReimportLimit(onlinePlaylistId === null ? '' : String(onlineTrackCount))
    setRenamingOnlineId(null)
  }, [onlinePlaylistId, onlineTrackCount])

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

  const submitOnlineRename = useCallback(
    async (playlistId: number): Promise<void> => {
      const trimmed = renameOnlineValue.trim()
      if (trimmed.length === 0) {
        setRenamingOnlineId(null)
        return
      }
      setActionError(null)
      try {
        await onRenameOnline(playlistId, trimmed)
        setRenamingOnlineId(null)
      } catch (cause) {
        setActionError(messageOf(cause))
      }
    },
    [onRenameOnline, renameOnlineValue]
  )

  const removeSelected = useCallback((): void => {
    const ids = tracks
      .filter((track) => selectedIds.has(track.id))
      .map((track) => (showingOnline ? onlineEntryIdFor(track.id) : entryIdFor(track.id)))
      .filter((id): id is number => id !== null)
    if (ids.length === 0) return
    if (showingOnline) {
      void Promise.all(ids.map((id) => onRemoveOnlineItem(id)))
    } else {
      void onRemoveItems(ids)
    }
    setSelectedIds(new Set<number>())
  }, [entryIdFor, onlineEntryIdFor, onRemoveItems, onRemoveOnlineItem, selectedIds, showingOnline, tracks])

  /**
   * Plays a set of tracks and says where they came from.
   *
   * A track list does not carry the list it was read from, so an imported pane has
   * to hand its title over here; a hand-made playlist passes `null` and clears it.
   */
  const playList = useCallback(
    (queue: Track[], index: number, list: PlayingList | null): void => {
      onPlayingListChange(list)
      onPlay(queue, index)
    },
    [onPlay, onPlayingListChange]
  )

  const playSelected = useCallback((): void => {
    const index = tracks.findIndex((track) => selectedIds.has(track.id))
    if (index < 0) return
    const chosen = tracks.filter((track) => selectedIds.has(track.id))
    playList(
      chosen,
      0,
      showingOnline && onlineDetail
        ? { title: onlineDetail.playlist.title, tracks, playlistId: onlineDetail.playlist.id }
        : null
    )
  }, [playList, onlineDetail, selectedIds, showingOnline, tracks])

  const reimport = useCallback(async (): Promise<void> => {
    if (!onlineDetail) return
    const parsed = reimportLimit.trim().length === 0 ? Number.NaN : Number(reimportLimit)
    const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(1000, Math.round(parsed))) : undefined
    setReimporting(true)
    setActionError(null)
    try {
      await onReimportOnline(onlineDetail.playlist.id, limit)
      setSelectedIds(new Set<number>())
    } catch (cause) {
      setActionError(messageOf(cause))
    } finally {
      setReimporting(false)
    }
  }, [onlineDetail, onReimportOnline, reimportLimit])

  const kindLabel =
    onlineDetail?.playlist.kind === 'album'
      ? 'Album'
      : onlineDetail?.playlist.kind === 'mix'
        ? 'Mix'
        : 'Playlist'
  const subtitle = showingOnline
    ? `${formatCount(tracks.length)} tracks${totalDuration(tracks)} · ${kindLabel}`
    : detail
      ? `${formatCount(tracks.length)} tracks${totalDuration(tracks)}`
      : ''

  const totalLists = playlists.length + onlinePlaylists.length

  // The opened list's cover: an album's own sleeve when it has one, otherwise the
  // first track's picture, which is the best cover a hand-made list or a mix has.
  const headerTrack = tracks[0] ?? null

  const selectionBar =
    selectedIds.size > 0 ? (
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
          <span>{showingOnline ? 'Remove from this playlist' : 'Remove from playlist'}</span>
        </button>
        <button type="button" className="link-button" onClick={() => setSelectedIds(new Set<number>())}>
          Clear
        </button>
      </div>
    ) : null

  const onlineTruncated =
    onlineDetail !== null &&
    onlineDetail.playlist.totalCount !== null &&
    onlineDetail.playlist.totalCount > onlineDetail.playlist.trackCount

  return (
    <section className="main-view playlists-view">
      <header className="view-header">
        <div className="view-heading">
          <h1>Playlists</h1>
          <p className="subtitle">
            {totalLists === 0
              ? 'Collect tracks from your library into your own order, or import a playlist from a link.'
              : `${formatCount(playlists.length)} custom · ${formatCount(onlinePlaylists.length)} imported`}
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

          <div className="playlist-group" role="group" aria-label="Custom playlists">
            <h2 className="playlist-group-title">
              Custom <span className="playlist-group-count">{formatCount(playlists.length)}</span>
            </h2>
            {playlists.length === 0 ? (
              <p className="playlist-group-empty">Nothing here yet. Use “New playlist” to make one.</p>
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
                        <span className="playlist-title">{playlist.name}</span>
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
          </div>

          <div className="playlist-group" role="group" aria-label="Imported playlists">
            <h2 className="playlist-group-title">
              Imported <span className="playlist-group-count">{formatCount(onlinePlaylists.length)}</span>
            </h2>
            {onlinePlaylists.length === 0 ? (
              <p className="playlist-group-empty">
                Playlists, albums and mixes imported from a link appear here.
              </p>
            ) : null}

            {onlinePlaylists.map((playlist) => (
              <div
                key={playlist.id}
                className={
                  playlist.id === selectedOnlineId ? 'playlist-row online active' : 'playlist-row online'
                }
              >
                {renamingOnlineId === playlist.id ? (
                  <form
                    className="playlist-rename"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void submitOnlineRename(playlist.id)
                    }}
                  >
                    <input
                      className="playlist-input"
                      value={renameOnlineValue}
                      autoFocus
                      maxLength={120}
                      aria-label={`Rename ${playlist.title}`}
                      onChange={(event) => setRenameOnlineValue(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Escape') return
                        event.stopPropagation()
                        setRenamingOnlineId(null)
                      }}
                    />
                    <button type="submit" className="small primary">
                      Save
                    </button>
                  </form>
                ) : (
                  <>
                    <button
                      type="button"
                      className="playlist-open"
                      onClick={() => onSelectOnline(playlist.id)}
                      title={`${playlist.title}${playlist.owner ? ` · ${playlist.owner}` : ''} · YouTube list ${playlist.listId}`}
                    >
                      <span className="playlist-name">
                        <span className="playlist-title">{playlist.title}</span>
                        <span className={`playlist-kind ${playlist.kind}`}>{listKindLabel(playlist)}</span>
                      </span>
                      <span className="playlist-count">{formatCount(playlist.trackCount)}</span>
                    </button>
                    <button
                      type="button"
                      className="icon-button subtle"
                      title="Rename imported playlist"
                      aria-label={`Rename ${playlist.title}`}
                      onClick={() => {
                        setRenamingOnlineId(playlist.id)
                        setRenameOnlineValue(playlist.title)
                        setConfirmDeleteOnline(null)
                      }}
                    >
                      <PencilIcon />
                    </button>
                    {confirmDeleteOnline === playlist.id ? (
                      <button
                        type="button"
                        className="icon-button subtle danger"
                        title="Remove this imported playlist"
                        aria-label={`Confirm removing ${playlist.title}`}
                        onClick={() => void onDeleteOnline(playlist.id)}
                      >
                        <TrashIcon />
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="icon-button subtle"
                        title="Remove imported playlist"
                        aria-label={`Remove ${playlist.title}`}
                        onClick={() => setConfirmDeleteOnline(playlist.id)}
                      >
                        <TrashIcon />
                      </button>
                    )}
                  </>
                )}
              </div>
            ))}

            {confirmDeleteOnline !== null ? (
              <p className="playlist-hint">
                Click the bin again to remove the imported playlist. Saved files stay in your library.
              </p>
            ) : null}
          </div>
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
          {showingOnline && onlineDetail ? (
            <>
              <div className="playlist-pane-head">
                <div className="playlist-pane-heading">
                  <ArtworkImage
                    track={headerTrack}
                    artworkKey={onlineDetail.playlist.coverKey ?? undefined}
                    size={64}
                    iconSize={24}
                    className="playlist-cover"
                  />
                  <div className="playlist-pane-titles">
                    <h2>{onlineDetail.playlist.title}</h2>
                    <p className="subtitle">
                      {subtitle}
                      {onlineDetail.playlist.owner ? ` · ${onlineDetail.playlist.owner}` : ''} ·{' '}
                      <span className="playlist-source-id" title="YouTube list id">
                        {onlineDetail.playlist.listId}
                      </span>
                    </p>
                  </div>
                </div>
                <div className="header-actions">
                  <button
                    type="button"
                    onClick={() =>
                      playList(tracks, 0, {
                        title: onlineDetail.playlist.title,
                        tracks,
                        playlistId: onlineDetail.playlist.id
                      })
                    }
                    disabled={tracks.length === 0}
                  >
                    <PlayIcon size={14} />
                    <span>Play</span>
                  </button>
                  <button type="button" onClick={() => onQueue(tracks)} disabled={tracks.length === 0}>
                    <QueueIcon size={14} />
                    <span>Add all</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      saveManyToLibrary(
                        unsavedOnline.map((item) => ({
                          videoId: item.videoId,
                          title: item.title,
                          artist: item.artist,
                          album: item.album
                        }))
                      )
                    }
                    disabled={unsavedOnline.length === 0}
                    title="Download each track that is not in your library yet"
                  >
                    <DownloadIcon />
                    <span>Save all</span>
                  </button>
                  <button type="button" onClick={() => void reimport()} disabled={reimporting}>
                    {reimporting ? <SpinnerIcon /> : <RefreshIcon />}
                    <span>{reimporting ? 'Re-importing…' : 'Re-import'}</span>
                  </button>
                  <label
                    className="reimport-count"
                    title="How many tracks this snapshot keeps (1–1000). Leave empty to use the Engine setting."
                  >
                    <span>Tracks</span>
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      inputMode="numeric"
                      value={reimportLimit}
                      disabled={reimporting}
                      aria-label="Tracks to keep when re-importing"
                      onChange={(event) => setReimportLimit(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return
                        event.preventDefault()
                        void reimport()
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className={
                      confirmDeleteOnline === onlineDetail.playlist.id ? 'link-button danger' : 'link-button'
                    }
                    onClick={() => {
                      if (confirmDeleteOnline !== onlineDetail.playlist.id) {
                        setConfirmDeleteOnline(onlineDetail.playlist.id)
                        return
                      }
                      setConfirmDeleteOnline(null)
                      void onDeleteOnline(onlineDetail.playlist.id)
                    }}
                  >
                    {confirmDeleteOnline === onlineDetail.playlist.id ? 'Remove playlist?' : 'Remove'}
                  </button>
                </div>
              </div>

              {onlineTruncated ? (
                <p className="playlist-note">
                  YouTube lists {formatCount(onlineDetail.playlist.totalCount ?? 0)} tracks; this import kept the
                  first {formatCount(onlineDetail.playlist.trackCount)}. Change the count beside Re-import, or set
                  the default in Settings → Engine.
                </p>
              ) : null}

              {selectionBar}

              {tracks.length === 0 ? (
                <div className="empty-state">
                  <PlaylistIcon size={32} />
                  <h2>This imported playlist is empty</h2>
                  <p>Every entry was removed, or YouTube no longer offers them. Re-import to take a fresh snapshot.</p>
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
                  onActivate={(index) =>
                    playList(tracks, index, {
                      title: onlineDetail.playlist.title,
                      tracks,
                      playlistId: onlineDetail.playlist.id
                    })
                  }
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
                  onDetails={setDetailsTrack}
                  singleClick={singleClick}
                  doubleClick={doubleClick}
                  sortable={false}
                  onRemove={(track) => {
                    const itemId = onlineEntryIdFor(track.id)
                    if (itemId === null) return
                    void onRemoveOnlineItem(itemId)
                  }}
                  removeLabel="Remove from this playlist"
                  onSave={saveOnlineTrack}
                  isSaved={(track) => (track.sourceId ? saved.has(track.sourceId) : false)}
                  saveState={(track) => (track.sourceId ? states[track.sourceId] : undefined)}
                />
              )}

              {tracks.length > 0 ? (
                <p className="table-footnote">
                  Imported playlists keep their source order, so drag-to-reorder is off. Click:{' '}
                  {describeClickAction(singleClick)}, double-click: {describeClickAction(doubleClick)}. Saving
                  downloads a copy into your music folder; until then every track is streamed.
                </p>
              ) : null}
            </>
          ) : !detail ? (
            <div className="empty-state">
              <PlaylistIcon size={32} />
              <h2>{totalLists === 0 ? 'No playlists yet' : 'Pick a playlist'}</h2>
              <p>
                {totalLists === 0
                  ? 'Create one, then add tracks from the library — select some rows and choose “Add to playlist”. Or paste a playlist link in Streaming.'
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
                <div className="playlist-pane-heading">
                  <ArtworkImage track={headerTrack} size={64} iconSize={24} className="playlist-cover" />
                  <div className="playlist-pane-titles">
                    <h2>{detail.playlist.name}</h2>
                    <p className="subtitle">{subtitle}</p>
                  </div>
                </div>
                <div className="header-actions">
                  <button type="button" onClick={() => playList(tracks, 0, null)} disabled={tracks.length === 0}>
                    <PlayIcon size={14} />
                    <span>Play</span>
                  </button>
                  <button type="button" onClick={() => onQueue(tracks)} disabled={tracks.length === 0}>
                    <QueueIcon size={14} />
                    <span>Add all</span>
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

              {selectionBar}

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
                  onActivate={(index) => playList(tracks, index, null)}
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
                  onDetails={setDetailsTrack}
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

      {detailsTrack ? (
        <TrackDetails
          track={detailsTrack}
          onReveal={onReveal}
          onClose={() => setDetailsTrack(null)}
        />
      ) : null}
    </section>
  )
}
