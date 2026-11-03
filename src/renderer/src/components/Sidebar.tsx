import type { IconSet, LibraryStats } from '@shared/types'
import { formatCount } from '@shared/format'
import {
  BrandMarkIcon,
  CogIcon,
  HomeIcon,
  LibraryIcon,
  LinkIcon,
  ListMusicIcon,
  MusicIcon,
  PlaylistIcon,
  QueueIcon,
  QueueModernIcon,
  SearchIcon,
  SlidersIcon,
  YouTubeIcon
} from './Icons'

export type ViewName =
  | 'home'
  | 'library'
  | 'search'
  | 'online'
  | 'playlists'
  | 'queue'
  | 'settings'

export interface SidebarProps {
  view: ViewName
  stats: LibraryStats | null
  queueLength: number
  /** How many playlists exist, or 0 when they have not loaded yet. */
  playlistCount: number
  /** How many links the YouTube history remembers. */
  onlineCount: number
  /** Sidebar glyph family. */
  iconSet: IconSet
  onSelect: (view: ViewName) => void
}

export function Sidebar({
  view,
  stats,
  queueLength,
  playlistCount,
  onlineCount,
  iconSet,
  onSelect
}: SidebarProps) {
  const modern = iconSet === 'modern'
  const localCount = stats ? formatCount(stats.tracks) : '--'
  const youtubeCount = formatCount(onlineCount)
  const totalTracks = stats ? stats.tracks + onlineCount : null

  return (
    <nav className="sidebar" data-icon-set={iconSet}>
      <div className="brand">
        {modern ? <BrandMarkIcon size={20} /> : <MusicIcon size={18} />}
        <span>Suura</span>
      </div>

      <button
        type="button"
        className={view === 'home' ? 'nav-item active' : 'nav-item'}
        onClick={() => onSelect('home')}
        title="Recently added albums, artists and your whole collection"
      >
        <HomeIcon />
        <span>Home</span>
      </button>

      <button
        type="button"
        className={view === 'library' ? 'nav-item active' : 'nav-item'}
        onClick={() => onSelect('library')}
      >
        {modern ? <LibraryIcon /> : <MusicIcon />}
        <span>Library</span>
        {stats ? <span className="nav-count">{formatCount(stats.tracks)}</span> : null}
      </button>

      <button
        type="button"
        className={view === 'online' ? 'nav-item active' : 'nav-item'}
        onClick={() => onSelect('online')}
        title="Pasted links, saved downloads and the offline cache"
      >
        {modern ? <YouTubeIcon /> : <LinkIcon />}
        <span>YouTube</span>
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
        {modern ? <ListMusicIcon /> : <PlaylistIcon />}
        <span>Playlists</span>
        {playlistCount > 0 ? <span className="nav-count">{formatCount(playlistCount)}</span> : null}
      </button>

      <button
        type="button"
        className={view === 'queue' ? 'nav-item active' : 'nav-item'}
        onClick={() => onSelect('queue')}
      >
        {modern ? <QueueModernIcon /> : <QueueIcon />}
        <span>Queue</span>
        {queueLength > 0 ? <span className="nav-count">{formatCount(queueLength)}</span> : null}
      </button>

      <button
        type="button"
        className={view === 'settings' ? 'nav-item active' : 'nav-item'}
        onClick={() => onSelect('settings')}
      >
        {modern ? <SlidersIcon /> : <CogIcon />}
        <span>Settings</span>
      </button>

      <div className="sidebar-footer">
        <div
          className="sidebar-source"
          title={`All sources: ${totalTracks === null ? '--' : formatCount(totalTracks)} tracks. Local library: ${localCount}. YouTube: ${youtubeCount} remembered links. YouTube links stream through yt-dlp.`}
        >
          <span className="sidebar-source-label">All sources</span>
          <strong className="sidebar-source-total">{totalTracks === null ? '--' : formatCount(totalTracks)}</strong>
        </div>
        <div className="sidebar-stat">
          <span>Artists</span>
          <strong>{stats ? formatCount(stats.artists) : '--'}</strong>
        </div>
        <div className="sidebar-stat">
          <span>Albums</span>
          <strong>{stats ? formatCount(stats.albums) : '--'}</strong>
        </div>
      </div>
    </nav>
  )
}
