import type { RefObject } from 'react'
import { useState } from 'react'
import type {
  AddTracksOutcome,
  LibraryClickAction,
  LibraryStats,
  Playlist,
  ScanProgress,
  SortDirection,
  Track,
  TrackSortField
} from '@shared/types'
import { formatBytes, formatCount, formatTimestamp } from '@shared/format'
import { AddToPlaylistMenu } from './AddToPlaylistMenu'
import { TrackContextMenu } from './TrackContextMenu'
import { TrackList, describeClickAction } from './TrackList'
import { CloseIcon, FolderIcon, LinkIcon, PlayIcon, PlaylistIcon, RefreshIcon, SearchIcon, SpinnerIcon } from './Icons'

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
  sort: TrackSortField | null
  direction: SortDirection
  selectedIds: ReadonlySet<number>
  currentTrackId: number | null
  isPlaying: boolean
  searchInputRef: RefObject<HTMLInputElement | null>
  onSearchChange: (value: string) => void
  onToggleSort: (field: TrackSortField) => void
  onAddFolder: () => void
  onScan: () => void
  onCancelScan: () => void
  /** Opens the paste-a-link dialog for a stream-only YouTube track. */
  onPlayLink: () => void
  onPlay: (index: number) => void
  onPlaySelected: () => void
  onReveal: (trackId: number) => void
  onSelect: (trackId: number, mode: 'replace' | 'toggle') => void
  onSelectAll: () => void
  onClearSelection: () => void
  onRequestMore: () => void
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
    sort,
    direction,
    selectedIds,
    currentTrackId,
    isPlaying,
    searchInputRef,
    onSearchChange,
    onToggleSort,
    onAddFolder,
    onScan,
    onCancelScan,
    onPlayLink,
    onPlay,
    onPlaySelected,
    onReveal,
    onSelect,
    onSelectAll,
    onClearSelection,
    onRequestMore,
    singleClick,
    doubleClick,
    playlists,
    onAddTracksToPlaylist,
    onCreatePlaylist
  } = props

  const [addMenu, setAddMenu] = useState<AddMenuState | null>(null)
  const [contextMenu, setContextMenu] = useState<{ track: Track; x: number; y: number } | null>(null)

  const hasFolders = folders.length > 0
  const searching = search.trim().length > 0
  const subtitle = stats
    ? `${formatCount(stats.tracks)} tracks · ${formatCount(stats.albums)} albums · ${formatBytes(stats.totalBytes)} · scanned ${formatTimestamp(stats.lastScanAt)}`
    : 'Reading library…'

  return (
    <section className="main-view">
      <header className="view-header">
        <div className="view-heading">
          <h1>Library</h1>
          <p className="subtitle">{subtitle}</p>
        </div>
        <div className="header-actions">
          <div className="search-field">
            <SearchIcon />
            <input
              ref={searchInputRef}
              id="library-search"
              type="search"
              placeholder="Search title, artist, album…"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              aria-label="Search library"
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
          <button type="button" onClick={onPlayLink} title="Play a YouTube link">
            <LinkIcon />
            <span>Play link</span>
          </button>
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
          {selectedIds.size < tracks.length ? (
            <button type="button" onClick={onSelectAll}>
              <span>Select all loaded ({formatCount(tracks.length)})</span>
            </button>
          ) : null}
          <button type="button" className="link-button" onClick={onClearSelection}>
            Clear
          </button>
        </div>
      ) : null}

      {!hasFolders ? (
        <div className="empty-state">
          <FolderIcon size={32} />
          <h2>No music folders yet</h2>
          <p>Add a folder and Player will index every audio file inside it, including subfolders.</p>
          <button type="button" className="primary" onClick={onAddFolder} disabled={scanning}>
            <FolderIcon />
            <span>Add music folder</span>
          </button>
        </div>
      ) : tracks.length === 0 ? (
        <div className="empty-state">
          <SearchIcon size={32} />
          <h2>{searching ? 'No matching tracks' : 'Nothing indexed yet'}</h2>
          <p>
            {searching
              ? 'Try a different search term.'
              : 'Your folders are configured but no tracks have been indexed. Run a scan to pick them up.'}
          </p>
          {searching ? null : (
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
          onToggleSort={onToggleSort}
          onActivate={onPlay}
          onSelect={onSelect}
          onSelectAll={onSelectAll}
          onClearSelection={onClearSelection}
          onReveal={onReveal}
          onRequestMore={onRequestMore}
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

      {tracks.length > 0 ? (
        <p className="table-footnote">
          Showing {formatCount(tracks.length)} of {formatCount(total)} {searching ? 'matching' : ''} tracks. Click:{' '}
          {describeClickAction(singleClick)}, double-click: {describeClickAction(doubleClick)}.{' '}
          {sort ? 'Sorting is applied to the whole library.' : ''}
        </p>
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
          onReveal={() => onReveal(contextMenu.track.id)}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
    </section>
  )
}
