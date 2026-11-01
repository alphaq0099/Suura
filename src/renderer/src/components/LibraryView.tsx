import type { RefObject } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AddTracksOutcome,
  LibraryClickAction,
  LibraryFilter,
  LibraryStats,
  Playlist,
  ScanProgress,
  SortDirection,
  Track,
  TrackSortField
} from '@shared/types'
import { formatBytes, formatCount, formatTimestamp } from '@shared/format'
import { LIBRARY_FILTER_OPTIONS, RECENTLY_ADDED_DAYS } from '@shared/library'
import { api } from '../api'
import type { UseDownloadsResult } from '../hooks/useDownloads'
import { AddToPlaylistMenu } from './AddToPlaylistMenu'
import { FieldContextMenu, useFieldContextMenu } from './FieldContextMenu'
import { RowMenu } from './RowMenu'
import { TrackContextMenu } from './TrackContextMenu'
import { TrackDetails } from './TrackDetails'
import { TrackList } from './TrackList'
import { LyricsBatchDialog } from './LyricsBatchDialog'
import {
  CheckIcon,
  CloseIcon,
  FolderIcon,
  InfoIcon,
  LinkIcon,
  MusicIcon,
  LyricsIcon,
  PlayIcon,
  PlaylistIcon,
  QueueIcon,
  RefreshIcon,
  SearchIcon,
  SpinnerIcon,
  TrashIcon
} from './Icons'

export interface LibraryViewProps {
  tracks: Track[]
  /** Rows matching the current search, including pages not loaded yet. */
  total: number
  stats: LibraryStats | null
  progress: ScanProgress | null
  scanning: boolean
  loadingMore: boolean
  search: string
  error: string | null
  folders: string[]
  filter: LibraryFilter
  /** How many links the YouTube history remembers, before the local search. */
  streamCount: number
  /** True when the rows in `tracks` come from the YouTube history. */
  showingStreams: boolean
  streamsLoading: boolean
  sort: TrackSortField | null
  direction: SortDirection
  selectedIds: ReadonlySet<number>
  currentTrackId: number | null
  isPlaying: boolean
  /** Density-derived row height, shared with the virtualizer. */
  rowHeight: number
  searchInputRef: RefObject<HTMLInputElement | null>
  onSearchChange: (value: string) => void
  onToggleSort: (field: TrackSortField) => void
  onAddFolder: () => void
  onScan: () => void
  onCancelScan: () => void
  onPlay: (index: number) => void
  onPlaySelected: () => void
  onReveal: (trackId: number) => void
  onSelect: (trackId: number, mode: 'replace' | 'toggle') => void
  onSelectMany: (trackIds: number[]) => void
  onSelectAll: () => void
  onClearSelection: () => void
  onRequestMore: () => void
  onFilterChange: (filter: LibraryFilter) => void
  onOpenYouTube: () => void
  onQueueStream: (track: Track) => void
  onQueueSelected: () => void
  onRemoveTracks: (trackIds: number[]) => Promise<number>
  onRemoveStream: (track: Track) => void
  downloads: UseDownloadsResult
  /** Whether local lists keep their Album column. */
  showAlbumColumn: boolean
  /** What a click on a row does. See `LibraryClickAction`. */
  singleClick: LibraryClickAction
  doubleClick: LibraryClickAction
  playlists: Playlist[]
  onAddTracksToPlaylist: (playlistId: number, trackIds: number[]) => Promise<AddTracksOutcome>
  onCreatePlaylist: (name: string) => Promise<Playlist>
}

/** Where the "Add to playlist" menu is open, and what it is for. */
interface AddMenuState {
  x: number
  y: number
  trackIds: number[]
  heading: string
}

export function LibraryView(props: LibraryViewProps) {
  const {
    tracks,
    total,
    stats,
    progress,
    scanning,
    loadingMore,
    search,
    error,
    folders,
    filter,
    streamCount,
    showingStreams,
    streamsLoading,
    sort,
    direction,
    selectedIds,
    currentTrackId,
    isPlaying,
    rowHeight,
    searchInputRef,
    onSearchChange,
    onToggleSort,
    onAddFolder,
    onScan,
    onCancelScan,
    onPlay,
    onPlaySelected,
    onReveal,
    onSelect,
    onSelectMany,
    onSelectAll,
    onClearSelection,
    onRequestMore,
    onFilterChange,
    onOpenYouTube,
    onQueueStream,
    onQueueSelected,
    onRemoveTracks,
    onRemoveStream,
    downloads,
    showAlbumColumn,
    singleClick,
    doubleClick,
    playlists,
    onAddTracksToPlaylist,
    onCreatePlaylist
  } = props

  const [addMenu, setAddMenu] = useState<AddMenuState | null>(null)
  const [contextMenu, setContextMenu] = useState<{ track: Track; x: number; y: number } | null>(null)
  const [streamMenu, setStreamMenu] = useState<{ track: Track; x: number; y: number } | null>(null)
  const [detailsTrack, setDetailsTrack] = useState<Track | null>(null)
  // Set when the row menu asked for the editor rather than the sheet, so the
  // details dialog opens straight into it.
  const [detailsEditing, setDetailsEditing] = useState(false)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkError, setBulkError] = useState<string | null>(null)
  // The local tracks the batch dialog is scanning, or null when it is closed.
  const [lyricsBatchIds, setLyricsBatchIds] = useState<number[] | null>(null)
  const fieldMenu = useFieldContextMenu(searchInputRef)

  const { saved, states, save: saveToLibrary, refreshSaved } = downloads

  const pasteSearch = useCallback(async (): Promise<void> => {
    try {
      const text = (await api.readClipboardText()).trim()
      if (text.length > 0) onSearchChange(text)
    } catch {
      // The clipboard is best-effort; a denied read should not interrupt search.
    } finally {
      searchInputRef.current?.focus()
    }
  }, [onSearchChange, searchInputRef])

  const copySearch = useCallback(async (): Promise<void> => {
    try {
      await api.writeClipboardText(search)
    } catch {
      // As above: Copy failing is not worth a page-level error banner.
    }
    searchInputRef.current?.focus()
  }, [search, searchInputRef])

  const clearSearchField = useCallback((): void => {
    onSearchChange('')
    searchInputRef.current?.focus()
  }, [onSearchChange, searchInputRef])

  // Switching views changes what every row means; a menu opened on the old list
  // would otherwise stay floating over the new one.
  useEffect(() => {
    setAddMenu(null)
    setContextMenu(null)
    setStreamMenu(null)
  }, [filter])

  const streamVideoIds = useMemo(() => {
    if (!showingStreams) return []
    return tracks.flatMap((track) => (track.sourceId ? [track.sourceId] : []))
  }, [showingStreams, tracks])

  // Ask once per list which stream rows already have a library copy. The whole
  // history is loaded at once, so this is the same one-query-per-page contract
  // the YouTube view uses.
  useEffect(() => {
    if (!showingStreams) return
    void refreshSaved(streamVideoIds)
  }, [showingStreams, streamVideoIds, refreshSaved])

  const saveStream = useCallback(
    (track: Track): void => {
      if (track.sourceKind !== 'youtube' || !track.sourceId) return
      // The row shows its own progress and error; a failed save must not look
      // like a successful one, and the Saves dock keeps the retry.
      void saveToLibrary({
        videoId: track.sourceId,
        title: track.title,
        artist: track.artist,
        album: track.album
      }).catch(() => undefined)
    },
    [saveToLibrary]
  )

  const removeSelected = async (): Promise<void> => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    const confirmed = window.confirm(
      `Remove ${formatCount(ids.length)} track${ids.length === 1 ? '' : 's'} from the library?\n\nThe files stay on disk, so a later scan will find them again. Use Settings to remove a whole folder instead.`
    )
    if (!confirmed) return
    setBulkBusy(true)
    setBulkError(null)
    try {
      await onRemoveTracks(ids)
      onClearSelection()
    } catch (cause) {
      setBulkError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBulkBusy(false)
    }
  }

  const hasFolders = folders.length > 0
  const searching = search.trim().length > 0
  const subtitle = showingStreams
    ? `${formatCount(streamCount)} YouTube ${streamCount === 1 ? 'link' : 'links'} · streamed, not saved`
    : stats
      ? `${formatCount(stats.tracks)} tracks · ${formatCount(stats.albums)} albums · ${formatBytes(stats.totalBytes)} · scanned ${formatTimestamp(stats.lastScanAt)}`
      : 'Reading library…'

  const filterCount = (value: LibraryFilter): number | null => {
    if (value === 'streams') return streamCount
    if (!stats) return null
    switch (value) {
      case 'recent':
        return stats.recentTracks
      case 'most-played':
        return stats.playedTracks
      case 'never-played':
        return stats.unplayedTracks
      default:
        return stats.tracks
    }
  }

  const localEmptyTitle = searching
    ? 'No matching tracks'
    : filter === 'recent'
      ? `Nothing added in ${RECENTLY_ADDED_DAYS} days`
      : filter === 'most-played'
        ? 'Nothing played yet'
        : filter === 'never-played'
          ? 'Every track has been played'
          : 'Nothing indexed yet'
  const localEmptyCopy = searching
    ? 'Try a different search term.'
    : filter === 'recent'
      ? `Tracks added in the last ${RECENTLY_ADDED_DAYS} days appear here, newest first.`
      : filter === 'most-played'
        ? 'Finish a track, or listen for 30 seconds, and it will appear here.'
        : filter === 'never-played'
          ? 'Every track in this library has had a completed listen.'
          : 'Your folders are configured but no tracks have been indexed. Run a scan to pick them up.'

  return (
    <section className="main-view">
      <header className="view-header">
        <div className="view-heading">
          <h1>Library</h1>
          <p className="subtitle">{subtitle}</p>
        </div>
        <div className="header-actions">
          <div className="search-field" data-field-menu onContextMenu={fieldMenu.open}>
            <SearchIcon />
            <input
              ref={searchInputRef}
              id="library-search"
              type="search"
              placeholder={showingStreams ? 'Search YouTube links…' : 'Search title, artist, album…'}
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              onKeyDown={fieldMenu.onKeyDown}
              aria-label={showingStreams ? 'Search YouTube links' : 'Search library'}
            />
            {searching ? (
              <button
                type="button"
                className="icon-button subtle clear-search"
                title="Clear search"
                aria-label="Clear search"
                onClick={() => onSearchChange('')}
              >
                <CloseIcon />
              </button>
            ) : null}
          </div>
          <button type="button" onClick={onScan} disabled={scanning || !hasFolders} title="Rescan library folders">
            {scanning ? <SpinnerIcon /> : <RefreshIcon />}
            <span>{scanning ? 'Scanning' : 'Rescan'}</span>
          </button>
          <button type="button" className="primary" onClick={onAddFolder} disabled={scanning}>
            <FolderIcon />
            <span>Add folder</span>
          </button>
        </div>
      </header>

      <div className="library-filters" role="group" aria-label="Library view">
        {LIBRARY_FILTER_OPTIONS.map((option) => {
          const count = filterCount(option.value)
          return (
            <button
              key={option.value}
              type="button"
              className="filter-chip"
              aria-pressed={filter === option.value}
              title={option.hint}
              onClick={() => onFilterChange(option.value)}
            >
              <span>{option.label}</span>
              {count !== null ? <span className="filter-count">{formatCount(count)}</span> : null}
            </button>
          )
        })}
      </div>

      {error ? <div className="banner error">{error}</div> : null}

      {scanning && progress ? (
        <div className="banner scan">
          <div className="scan-line">
            <SpinnerIcon />
            <span>
              {progress.phase === 'enumerating' ? 'Finding audio files…' : 'Reading tags…'}{' '}
              <strong>{formatCount(progress.filesSeen)}</strong> found · <strong>{formatCount(progress.indexed)}</strong> new ·{' '}
              <strong>{formatCount(progress.updated)}</strong> updated · <strong>{formatCount(progress.skipped)}</strong> unchanged
              {progress.failed > 0 ? ` · ${formatCount(progress.failed)} unreadable` : ''}
            </span>
            <button type="button" className="link-button" onClick={onCancelScan}>
              Cancel
            </button>
          </div>
          <div className="scan-bar">
            <div className="scan-bar-fill" />
          </div>
          {progress.currentFile ? (
            <div className="scan-file" title={progress.currentFile}>
              {progress.currentFile}
            </div>
          ) : null}
        </div>
      ) : null}

      {selectedIds.size > 0 ? (
        <div className="banner selection-bar">
          <span>
            <strong>{formatCount(selectedIds.size)}</strong> selected
            {selectedIds.size < total ? ` · ${formatCount(total)} in this list` : ''}
          </span>
          <button type="button" onClick={onPlaySelected}>
            <PlayIcon size={14} />
            <span>Play selected</span>
          </button>
          {showingStreams ? (
            <button type="button" onClick={onQueueSelected}>
              <QueueIcon size={14} />
              <span>Add to queue</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                setAddMenu({
                  x: rect.left,
                  y: rect.bottom + 6,
                  trackIds: [...selectedIds],
                  heading: `${formatCount(selectedIds.size)} selected`
                })
              }}
            >
              <PlaylistIcon size={14} />
              <span>Add to playlist</span>
            </button>
          )}
          {!showingStreams ? (
            <button
              type="button"
              onClick={() => setLyricsBatchIds([...selectedIds])}
              title="Look for lyrics for every selected file that has none"
            >
              <LyricsIcon size={14} />
              <span>Fetch missing lyrics</span>
            </button>
          ) : null}
          {!showingStreams ? (
            <button
              type="button"
              className="danger-button"
              onClick={() => void removeSelected()}
              disabled={bulkBusy}
            >
              {bulkBusy ? <SpinnerIcon size={14} /> : <TrashIcon size={14} />}
              <span>Remove from library</span>
            </button>
          ) : null}
          <button type="button" className="selection-clear" onClick={onClearSelection}>
            Clear
          </button>
        </div>
      ) : null}
      {bulkError ? (
        <div className="banner error" role="alert">
          {bulkError}
        </div>
      ) : null}

      {showingStreams ? (
        tracks.length === 0 ? (
          <div className="empty-state">
            {streamsLoading ? <SpinnerIcon size={32} /> : <LinkIcon size={32} />}
            <h2>
              {streamsLoading
                ? 'Reading YouTube history…'
                : searching
                  ? 'No matching YouTube links'
                  : 'No streamed links yet'}
            </h2>
            <p>
              {streamsLoading
                ? 'The links you have played are being read from the library.'
                : searching
                  ? 'Try a different search term.'
                  : 'Play a YouTube link or a search result and it will appear here. A stream stays a link until you save it.'}
            </p>
            {streamsLoading || searching ? null : (
              <button type="button" className="primary" onClick={onOpenYouTube}>
                <LinkIcon />
                <span>Open YouTube</span>
              </button>
            )}
          </div>
        ) : (
          <TrackList
            tracks={tracks}
            total={total}
            sort={null}
            direction="asc"
            currentTrackId={currentTrackId}
            isPlaying={isPlaying}
            selectedIds={selectedIds}
            loadingMore={false}
            rowHeight={rowHeight}
            sortable={false}
            listKey="streams"
            onToggleSort={() => undefined}
            onActivate={onPlay}
            onSelect={onSelect}
            onSelectMany={onSelectMany}
            onSelectAll={onSelectAll}
            onClearSelection={onClearSelection}
            onReveal={onReveal}
            onSave={saveStream}
            isSaved={(track) => (track.sourceId ? saved.has(track.sourceId) : false)}
            saveState={(track) => (track.sourceId ? states[track.sourceId] : undefined)}
            onQueue={onQueueStream}
            onRowContextMenu={(track, _index, at) => setStreamMenu({ track, ...at })}
            artistLabel="Channel"
            showAlbumColumn={false}
            singleClick={singleClick}
            doubleClick={doubleClick}
          />
        )
      ) : !hasFolders ? (
        <div className="empty-state">
          <FolderIcon size={32} />
          <h2>No music folders yet</h2>
          <p>
            Add a folder and Suura will index every audio file inside it, including subfolders.
            {streamCount > 0 ? ' Your played YouTube links are under the YouTube chip above.' : ''}
          </p>
          <button type="button" className="primary" onClick={onAddFolder} disabled={scanning}>
            <FolderIcon />
            <span>Add music folder</span>
          </button>
        </div>
      ) : tracks.length === 0 ? (
        <div className="empty-state">
          {searching ? <SearchIcon size={32} /> : <MusicIcon size={32} />}
          <h2>{localEmptyTitle}</h2>
          <p>{localEmptyCopy}</p>
          {searching ? null : filter !== 'all' ? (
            <button type="button" onClick={() => onFilterChange('all')}>
              <span>Show all tracks</span>
            </button>
          ) : (
            <button type="button" className="primary" onClick={onScan} disabled={scanning}>
              <RefreshIcon />
              <span>Scan now</span>
            </button>
          )}
        </div>
      ) : (
        <TrackList
          tracks={tracks}
          total={total}
          sort={sort}
          direction={direction}
          currentTrackId={currentTrackId}
          isPlaying={isPlaying}
          selectedIds={selectedIds}
          loadingMore={loadingMore}
          rowHeight={rowHeight}
          listKey={filter}
          onToggleSort={onToggleSort}
          onActivate={onPlay}
          onSelect={onSelect}
          onSelectMany={onSelectMany}
          onSelectAll={onSelectAll}
          onClearSelection={onClearSelection}
          onReveal={onReveal}
          onRequestMore={onRequestMore}
          showAlbumColumn={showAlbumColumn}
          singleClick={singleClick}
          doubleClick={doubleClick}
          onRowContextMenu={(track, _index, at) => {
            // Right-clicking a row that is not selected acts on that row alone:
            // the menu belongs to the row under the pointer, not to a selection
            // the user cannot see from here.
            setContextMenu({ track, x: at.x, y: at.y })
          }}
        />
      )}

      {fieldMenu.at ? (
        <FieldContextMenu
          at={fieldMenu.at}
          hasValue={search.length > 0}
          onPaste={() => void pasteSearch()}
          onCopy={() => void copySearch()}
          onClear={clearSearchField}
          onClose={fieldMenu.close}
        />
      ) : null}

      {addMenu ? (
        <AddToPlaylistMenu
          playlists={playlists}
          trackIds={addMenu.trackIds}
          heading={addMenu.heading}
          at={{ x: addMenu.x, y: addMenu.y }}
          onAdd={onAddTracksToPlaylist}
          onCreate={onCreatePlaylist}
          onClose={() => setAddMenu(null)}
        />
      ) : null}

      {contextMenu ? (
        <TrackContextMenu
          track={contextMenu.track}
          at={{ x: contextMenu.x, y: contextMenu.y }}
          playlists={playlists}
          onAddTracks={onAddTracksToPlaylist}
          onCreatePlaylist={onCreatePlaylist}
          onPlay={() => {
            // The menu belongs to a row in this list, so the index always exists;
            // the guard is only against a list that changed under the menu.
            const index = tracks.findIndex((track) => track.id === contextMenu.track.id)
            if (index >= 0) onPlay(index)
          }}
          onDetails={() => {
            setDetailsEditing(false)
            setDetailsTrack(contextMenu.track)
          }}
          onEditTags={
            contextMenu.track.filePath
              ? () => {
                  setDetailsEditing(true)
                  setDetailsTrack(contextMenu.track)
                }
              : undefined
          }
          onReveal={() => onReveal(contextMenu.track.id)}
          isSelected={selectedIds.has(contextMenu.track.id)}
          onToggleSelection={() => onSelect(contextMenu.track.id, 'toggle')}
          onPlaySelected={onPlaySelected}
          onQueueSelected={onQueueSelected}
          trackIds={
            selectedIds.has(contextMenu.track.id) ? [...selectedIds] : [contextMenu.track.id]
          }
          addHeading={
            selectedIds.has(contextMenu.track.id) && selectedIds.size > 1
              ? `${formatCount(selectedIds.size)} selected`
              : 'Add to playlist'
          }
          onClose={() => setContextMenu(null)}
        />
      ) : null}

      {streamMenu ? (
        <RowMenu
          at={{ x: streamMenu.x, y: streamMenu.y }}
          title={streamMenu.track.title}
          items={[
            {
              id: 'select',
              label: selectedIds.has(streamMenu.track.id) ? 'Deselect' : 'Select',
              icon: <CheckIcon />,
              onSelect: () => onSelect(streamMenu.track.id, 'toggle')
            },
            ...(selectedIds.has(streamMenu.track.id)
              ? [
                  {
                    id: 'play-selected',
                    label: 'Play selected',
                    icon: <PlayIcon />,
                    onSelect: onPlaySelected
                  },
                  {
                    id: 'queue-selected',
                    label: 'Queue selected',
                    icon: <QueueIcon />,
                    onSelect: onQueueSelected
                  }
                ]
              : []),
            {
              id: 'details',
              label: 'Details',
              icon: <InfoIcon />,
              onSelect: () => {
                setDetailsEditing(false)
                setDetailsTrack(streamMenu.track)
              }
            },
            {
              id: 'remove',
              label: 'Remove from history',
              icon: <TrashIcon />,
              danger: true,
              onSelect: () => onRemoveStream(streamMenu.track)
            }
          ]}
          onClose={() => setStreamMenu(null)}
        />
      ) : null}

      {detailsTrack ? (
        <TrackDetails
          track={detailsTrack}
          initialEditing={detailsEditing}
          onReveal={showingStreams ? undefined : onReveal}
          onClose={() => {
            setDetailsTrack(null)
            setDetailsEditing(false)
          }}
        />
      ) : null}

      {lyricsBatchIds ? (
        <LyricsBatchDialog
          trackIds={lyricsBatchIds}
          onClose={() => setLyricsBatchIds(null)}
        />
      ) : null}
    </section>
  )
}
