import type { LibraryStats } from '@shared/types'
import { formatCount } from '@shared/format'
import { CogIcon, MusicIcon, PlaylistIcon, QueueIcon } from './Icons'

export type ViewName = 'library' | 'playlists' | 'queue' | 'settings'

export interface SidebarProps {
  view: ViewName
  stats: LibraryStats | null
  queueLength: number
  /** How many playlists exist, or 0 when they have not loaded yet. */
  playlistCount: number
  onSelect: (view: ViewName) => void
}

export function Sidebar({ view, stats, queueLength, playlistCount, onSelect }: SidebarProps) {
  return (
    <nav className="sidebar">
      <div className="brand">
        <MusicIcon size={18} />
        <span>Player</span>
      </div>

      <button
        type="button"
        className={view === 'library' ? 'nav-item active' : 'nav-item'}
        onClick={() => onSelect('library')}
      >
        <MusicIcon />
        <span>Library</span>
        {stats ? <span className="nav-count">{formatCount(stats.tracks)}</span> : null}
      </button>

      <button
        type="button"
        className={view === 'playlists' ? 'nav-item active' : 'nav-item'}
        onClick={() => onSelect('playlists')}
      >
        <PlaylistIcon />
        <span>Playlists</span>
        {playlistCount > 0 ? <span className="nav-count">{formatCount(playlistCount)}</span> : null}
      </button>

      <button
        type="button"
        className={view === 'queue' ? 'nav-item active' : 'nav-item'}
        onClick={() => onSelect('queue')}
      >
        <QueueIcon />
        <span>Queue</span>
        {queueLength > 0 ? <span className="nav-count">{formatCount(queueLength)}</span> : null}
      </button>

      <button
        type="button"
        className={view === 'settings' ? 'nav-item active' : 'nav-item'}
        onClick={() => onSelect('settings')}
      >
        <CogIcon />
        <span>Settings</span>
      </button>

      <div className="sidebar-footer">
        <div className="sidebar-stat">
          <span>Artists</span>
          <strong>{stats ? formatCount(stats.artists) : '--'}</strong>
        </div>
        <div className="sidebar-stat">
          <span>Albums</span>
          <strong>{stats ? formatCount(stats.albums) : '--'}</strong>
        </div>
        <p className="sidebar-note">Local library · streaming engine lands in M3</p>
      </div>
    </nav>
  )
}
