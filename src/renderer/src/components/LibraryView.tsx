import type { RefObject } from 'react'
import type {
  LibraryClickAction,
  LibraryStats,
  ScanProgress,
  SortDirection,
  Track,
  TrackSortField
} from '@shared/types'
import { formatBytes, formatCount, formatTimestamp } from '@shared/format'
import { TrackList, describeClickAction } from './TrackList'
import { CloseIcon, FolderIcon, PlayIcon, RefreshIcon, SearchIcon, SpinnerIcon } from './Icons'

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
    onPlay,
    onPlaySelected,
    onReveal,
    onSelect,
    onSelectAll,
    onClearSelection,
    onRequestMore,
    singleClick,
    doubleClick
  } = props

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
        />
      )}

      {tracks.length > 0 ? (
        <p className="table-footnote">
          Showing {formatCount(tracks.length)} of {formatCount(total)} {searching ? 'matching' : ''} tracks. Click:{' '}
          {describeClickAction(singleClick)}, double-click: {describeClickAction(doubleClick)}.{' '}
          {sort ? 'Sorting is applied to the whole library.' : ''}
        </p>
      ) : null}
    </section>
  )
}
