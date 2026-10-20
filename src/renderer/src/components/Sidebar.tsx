import type { LibraryStats } from '@shared/types'
import { formatCount } from '@shared/format'
import { CogIcon, LinkIcon, MusicIcon, PlaylistIcon, QueueIcon, SearchIcon } from './Icons'

export type ViewName = 'library' | 'search' | 'online' | 'playlists' | 'queue' | 'settings'

export interface SidebarProps {
  view: ViewName
  stats: LibraryStats | null
  queueLength: number
  /** How many playlists exist, or 0 when they have not loaded yet. */
  playlistCount: number
  /** How many links the Streaming history remembers. */
  onlineCount: number
  onSelect: (view: ViewName) => void
}

export function Sidebar({ view, stats, queueLength, playlistCount, onlineCount, onSelect }: SidebarProps) {
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
        className={view === 'online' ? 'nav-item active' : 'nav-item'}
        onClick={() => onSelect('online')}
        title="Links you have pasted, streamed from YouTube"
      >
        <LinkIcon />
        <span>Streaming</span>
        {onlineCount > 0 ? <span className="nav-count">{formatCount(onlineCount)}</span> : null}
      </button>

      <button
        type="button"
        className={view === 'search' ? 'nav-item active' : 'nav-item'}
        onClick={() => onSelect('search')}
        title="Search your library and YouTube together"
      >
        <SearchIcon />
        <span>Search</span>
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
        <p className="sidebar-note">Local library · pasted links stream through yt-dlp</p>
      </div>
    </nav>
  )
}
