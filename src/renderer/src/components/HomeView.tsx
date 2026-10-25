import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import type {
  AddTracksOutcome,
  AlbumSummary,
  ArtistSummary,
  LibraryClickAction,
  LibraryStats,
  Playlist,
  ScanProgress,
  Track
} from '@shared/types'
import { buildArtworkUrl } from '@shared/artwork-url'
import { formatBytes, formatCount, formatDuration } from '@shared/format'
import { api, messageOf } from '../api'
import { useAlbums } from '../hooks/useAlbums'
import { useArtwork } from '../hooks/useArtwork'
import { ArtworkImage } from './ArtworkImage'
import {
  ArrowLeftIcon,
  ArtistIcon,
  CloseIcon,
  DiscIcon,
  FolderIcon,
  LibraryIcon,
  PlayIcon,
  QueueIcon,
  RefreshIcon,
  SearchIcon,
  SpinnerIcon
} from './Icons'
import { TrackContextMenu } from './TrackContextMenu'
import { TrackDetails } from './TrackDetails'
import { TrackList } from './TrackList'

export interface HomeViewProps {
  stats: LibraryStats | null
  progress: ScanProgress | null
  scanning: boolean
  error: string | null
  playlists: Playlist[]
  currentTrackId: number | null
  isPlaying: boolean
  rowHeight: number
  singleClick: LibraryClickAction
  doubleClick: LibraryClickAction
  onAddFolder: () => void
  onScan: () => void
  onCancelScan: () => void
  onOpenLibrary: () => void
  onOpenPlaylist: (playlistId: number) => void
  onPlayLocal: (tracks: Track[], index: number) => void
  onQueueLocal: (tracks: Track[]) => void
  onReveal: (trackId: number) => void
  onAddTracksToPlaylist: (playlistId: number, trackIds: number[]) => Promise<AddTracksOutcome>
  onCreatePlaylist: (name: string) => Promise<Playlist>
}

const LOCAL_REQUEST = (trackId: number) => ({ id: trackId, sourceKind: 'local' as const, sourceId: null })

function albumKeyOf(album: AlbumSummary): string {
  return `${album.album}\u001f${album.albumArtist}`
}

function initialOf(value: string): string {
  return value.trim().charAt(0).toUpperCase() || '?'
}

function toneOf(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return hash % 5
}

/** Watches a card until it is near the viewport, then stops observing it. */
function useNearViewport(ref: RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (visible) return
    const element = ref.current
    if (!element) return
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { rootMargin: '260px' }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref, visible])
  return visible
}

function AlbumCard({
  album,
  busy,
  onOpen,
  onPlay
}: {
  album: AlbumSummary
  busy: boolean
  onOpen: (album: AlbumSummary) => void
  onPlay: (album: AlbumSummary) => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const visible = useNearViewport(ref)
  const meta = [
    album.year ? String(album.year) : null,
    `${formatCount(album.trackCount)} ${album.trackCount === 1 ? 'track' : 'tracks'}`
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="album-card" ref={ref}>
      <button type="button" className="album-card-main" onClick={() => onOpen(album)}>
        <span className="album-card-art">
          <ArtworkImage
            track={null}
            size="100%"
            artworkKey={album.artworkKey ?? undefined}
            request={visible ? LOCAL_REQUEST(album.trackId) : null}
            className="album-cover"
          />
          <span className="album-card-shade" aria-hidden="true" />
        </span>
        <span className="album-card-title" title={album.album}>
          {album.album}
        </span>
        <span className="album-card-meta" title={`${album.albumArtist || 'Unknown artist'} · ${meta}`}>
          {album.albumArtist || 'Unknown artist'}
          {meta ? ` · ${meta}` : ''}
        </span>
      </button>
      <button
        type="button"
        className="album-card-play"
        onClick={() => onPlay(album)}
        disabled={busy}
        aria-label={`Play ${album.album}`}
        title={`Play ${album.album}`}
      >
        {busy ? <SpinnerIcon size={16} /> : <PlayIcon size={16} />}
      </button>
    </div>
  )
}

function ArtistCard({
  artist,
  busy,
  onFilter,
  onPlay
}: {
  artist: ArtistSummary
  busy: boolean
  onFilter: (artist: ArtistSummary) => void
  onPlay: (artist: ArtistSummary) => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const visible = useNearViewport(ref)

  return (
    <div className="artist-card" ref={ref}>
      <button type="button" className="artist-card-main" onClick={() => onFilter(artist)}>
        <span className="artist-card-art">
          <ArtworkImage
            track={null}
            size="100%"
            artworkKey={artist.artworkKey ?? undefined}
            request={visible ? LOCAL_REQUEST(artist.trackId) : null}
            className="artist-cover"
          />
        </span>
        <span className="artist-card-name" title={artist.artist}>
          {artist.artist}
        </span>
        <span className="artist-card-meta">
          {formatCount(artist.albumCount)} {artist.albumCount === 1 ? 'album' : 'albums'} ·{' '}
          {formatCount(artist.trackCount)} {artist.trackCount === 1 ? 'track' : 'tracks'}
        </span>
      </button>
      <button
        type="button"
        className="album-card-play artist-card-play"
        onClick={() => onPlay(artist)}
        disabled={busy}
        aria-label={`Play all tracks by ${artist.artist}`}
        title={`Play all tracks by ${artist.artist}`}
      >
        {busy ? <SpinnerIcon size={16} /> : <PlayIcon size={16} />}
      </button>
    </div>
  )
}

function PlaylistCard({ playlist, onOpen }: { playlist: Playlist; onOpen: (playlist: Playlist) => void }) {
  return (
    <button
      type="button"
      className="playlist-card"
      onClick={() => onOpen(playlist)}
      title={`Open ${playlist.name}`}
    >
      <span className="playlist-card-cover" data-tone={toneOf(playlist.name)}>
        <span className="playlist-card-initial">{initialOf(playlist.name)}</span>
      </span>
      <span className="album-card-title" title={playlist.name}>
        {playlist.name}
      </span>
      <span className="album-card-meta">
        {formatCount(playlist.trackCount)} {playlist.trackCount === 1 ? 'track' : 'tracks'}
      </span>
    </button>
  )
}

function Shelf({
  title,
  hint,
  icon,
  children
}: {
  title: string
  hint?: string
  icon?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="home-section">
      <div className="home-section-head">
        <h2>
          {icon}
          {title}
        </h2>
        {hint ? <span>{hint}</span> : null}
      </div>
      <div className="home-shelf">{children}</div>
    </section>
  )
}

/**
 * Home is the one view that is allowed to be decorative: a large recent album
 * backdrop, then the few shelves people actually use to start listening. Every
 * control here funnels into the same player and playlist actions as the lists,
 * so it is a shortcut rather than a second way to manage the library.
 */
export function HomeView(props: HomeViewProps) {
  const {
    stats,
    progress,
    scanning,
    error,
    playlists,
    currentTrackId,
    isPlaying,
    rowHeight,
    singleClick,
    doubleClick,
    onAddFolder,
    onScan,
    onCancelScan,
    onOpenLibrary,
    onOpenPlaylist,
    onPlayLocal,
    onQueueLocal,
    onReveal,
    onAddTracksToPlaylist,
    onCreatePlaylist
  } = props

  const albums = useAlbums()
  const [recentAlbums, setRecentAlbums] = useState<AlbumSummary[]>([])
  const [playedAlbums, setPlayedAlbums] = useState<AlbumSummary[]>([])
  const [artists, setArtists] = useState<ArtistSummary[]>([])
  const [shelvesLoading, setShelvesLoading] = useState(true)
  const [shelvesError, setShelvesError] = useState<string | null>(null)
  const [busyAlbum, setBusyAlbum] = useState<string | null>(null)
  const [busyArtist, setBusyArtist] = useState<string | null>(null)

  const [openAlbum, setOpenAlbum] = useState<AlbumSummary | null>(null)
  const [albumTracks, setAlbumTracks] = useState<Track[]>([])
  const [albumLoading, setAlbumLoading] = useState(false)
  const [albumError, setAlbumError] = useState<string | null>(null)
  const [albumSelection, setAlbumSelection] = useState<ReadonlySet<number>>(() => new Set())
  const [albumMenu, setAlbumMenu] = useState<{ track: Track; at: { x: number; y: number } } | null>(null)
  const [albumDetails, setAlbumDetails] = useState<Track | null>(null)

  const scrollRef = useRef<HTMLElement | null>(null)
  const gridRef = useRef<HTMLElement | null>(null)
  const gridScrollRef = useRef(0)
  /** Bumped per shelf load so a slow scan refresh cannot overwrite a newer one. */
  const shelvesTokenRef = useRef(0)

  const loadShelves = useCallback(async (): Promise<void> => {
    const token = ++shelvesTokenRef.current
    setShelvesLoading(true)
    try {
      const [recent, played, artistRows] = await Promise.all([
        api.listAlbums({ sort: 'recent', direction: 'desc', limit: 12 }),
        api.listAlbums({ sort: 'played', direction: 'desc', limit: 24 }),
        api.listArtists(12)
      ])
      if (token !== shelvesTokenRef.current) return
      setRecentAlbums(recent.albums)
      setPlayedAlbums(played.albums.filter((album) => album.lastPlayedAt !== null).slice(0, 12))
      setArtists(artistRows)
      setShelvesError(null)
    } catch (cause) {
      if (token === shelvesTokenRef.current) setShelvesError(messageOf(cause))
    } finally {
      if (token === shelvesTokenRef.current) setShelvesLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadShelves()
  }, [loadShelves])

  useEffect(() => {
    const token = api.on('libraryChanged', () => {
      void loadShelves()
    })
    return () => api.off(token)
  }, [loadShelves])

  const heroAlbum = playedAlbums[0] ?? recentAlbums[0] ?? null
  const heroFallback = heroAlbum && !heroAlbum.artworkKey ? LOCAL_REQUEST(heroAlbum.trackId) : null
  const heroResolved = useArtwork(null, heroFallback)
  const heroKey = heroAlbum?.artworkKey ?? heroResolved

  const hasLibrary = (stats?.tracks ?? 0) > 0
  const combinedError = error ?? shelvesError ?? albums.error

  const openAlbumDetail = useCallback((album: AlbumSummary): void => {
    gridScrollRef.current = scrollRef.current?.scrollTop ?? 0
    setAlbumSelection(new Set())
    setAlbumMenu(null)
    setAlbumDetails(null)
    setOpenAlbum(album)
  }, [])

  const closeAlbumDetail = useCallback((): void => {
    setOpenAlbum(null)
    setAlbumTracks([])
    setAlbumError(null)
    setAlbumMenu(null)
    setAlbumDetails(null)
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: gridScrollRef.current })
    })
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [openAlbum])

  useEffect(() => {
    if (!openAlbum) return
    let cancelled = false
    setAlbumLoading(true)
    setAlbumError(null)
    setAlbumTracks([])
    setAlbumSelection(new Set())
    void api
      .listTracks({
        album: openAlbum.album,
        albumArtist: openAlbum.albumArtist,
        limit: 5000,
        sort: 'album',
        direction: 'asc'
      })
      .then((page) => {
        if (!cancelled) setAlbumTracks(page.tracks)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setAlbumError(messageOf(cause))
      })
      .finally(() => {
        if (!cancelled) setAlbumLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [openAlbum])

  const playAlbum = useCallback(
    async (album: AlbumSummary): Promise<void> => {
      setBusyAlbum(albumKeyOf(album))
      try {
        const page = await api.listTracks({
          album: album.album,
          albumArtist: album.albumArtist,
          limit: 5000,
          sort: 'album',
          direction: 'asc'
        })
        if (page.tracks.length > 0) onPlayLocal(page.tracks, 0)
      } catch (cause) {
        setShelvesError(messageOf(cause))
      } finally {
        setBusyAlbum(null)
      }
    },
    [onPlayLocal]
  )

  const playArtist = useCallback(
    async (artist: ArtistSummary): Promise<void> => {
      setBusyArtist(artist.artist)
      try {
        const page = await api.listTracks({
          artist: artist.artist,
          limit: 5000,
          sort: 'artist',
          direction: 'asc'
        })
        if (page.tracks.length > 0) onPlayLocal(page.tracks, 0)
      } catch (cause) {
        setShelvesError(messageOf(cause))
      } finally {
        setBusyArtist(null)
      }
    },
    [onPlayLocal]
  )

  const filterByArtist = useCallback((artist: ArtistSummary): void => {
    albums.setArtist(artist.artist)
    requestAnimationFrame(() => {
      gridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [albums])

  const selectedTracks = useMemo(
    () => albumTracks.filter((track) => albumSelection.has(track.id)),
    [albumTracks, albumSelection]
  )

  const playOpenAlbum = useCallback((): void => {
    if (albumTracks.length > 0) onPlayLocal(albumTracks, 0)
  }, [albumTracks, onPlayLocal])

  const queueOpenAlbum = useCallback((): void => {
    if (albumTracks.length > 0) onQueueLocal(albumTracks)
  }, [albumTracks, onQueueLocal])

  const toggleAlbumSelection = useCallback((trackId: number): void => {
    setAlbumSelection((current) => {
      const next = new Set(current)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })
  }, [])

  const selectAlbumRow = useCallback((trackId: number, mode: 'replace' | 'toggle'): void => {
    setAlbumSelection((current) => {
      if (mode === 'replace') return new Set([trackId])
      const next = new Set(current)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })
  }, [])

  if (openAlbum) {
    const detailMeta = [
      openAlbum.year ? String(openAlbum.year) : null,
      `${formatCount(openAlbum.trackCount)} ${openAlbum.trackCount === 1 ? 'track' : 'tracks'}`,
      formatDuration(openAlbum.durationMs)
    ]
      .filter(Boolean)
      .join(' · ')

    return (
      <section className="main-view home-view" ref={scrollRef}>
        <div className="album-detail">
          <button type="button" className="home-back" onClick={closeAlbumDetail}>
            <ArrowLeftIcon />
            <span>Back to Home</span>
          </button>

          <header className="album-detail-head">
            <span className="album-detail-art">
              <ArtworkImage
                track={albumTracks[0] ?? null}
                size="100%"
                artworkKey={openAlbum.artworkKey ?? undefined}
                request={openAlbum.artworkKey ? null : LOCAL_REQUEST(openAlbum.trackId)}
                className="album-detail-cover"
              />
            </span>
            <div className="album-detail-copy">
              <span className="home-kicker">Album</span>
              <h2>{openAlbum.album}</h2>
              <p className="album-detail-artist">{openAlbum.albumArtist || 'Unknown artist'}</p>
              <p className="album-detail-meta">{detailMeta}</p>
              <div className="album-detail-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={playOpenAlbum}
                  disabled={albumLoading || albumTracks.length === 0}
                >
                  <PlayIcon size={16} />
                  <span>Play</span>
                </button>
                <button
                  type="button"
                  onClick={queueOpenAlbum}
                  disabled={albumLoading || albumTracks.length === 0}
                >
                  <QueueIcon />
                  <span>Queue</span>
                </button>
              </div>
            </div>
          </header>

          {combinedError ? <div className="banner error">{combinedError}</div> : null}
          {albumError ? <div className="banner error">{albumError}</div> : null}

          {albumSelection.size > 0 ? (
            <div className="selection-bar album-selection-bar">
              <strong>
                {formatCount(albumSelection.size)} selected
              </strong>
              <button
                type="button"
                onClick={() => onPlayLocal(selectedTracks, 0)}
                disabled={selectedTracks.length === 0}
              >
                <PlayIcon size={14} />
                <span>Play</span>
              </button>
              <button
                type="button"
                onClick={() => onQueueLocal(selectedTracks)}
                disabled={selectedTracks.length === 0}
              >
                <QueueIcon />
                <span>Queue</span>
              </button>
              <button
                type="button"
                className="selection-clear"
                onClick={() => setAlbumSelection(new Set())}
              >
                Clear
              </button>
            </div>
          ) : null}

          <div className="album-detail-tracks">
            {albumLoading ? (
              <div className="album-detail-loading">
                <SpinnerIcon size={18} />
                <span>Loading album…</span>
              </div>
            ) : albumTracks.length > 0 ? (
              <TrackList
                tracks={albumTracks}
                total={albumTracks.length}
                sort={null}
                direction="asc"
                currentTrackId={currentTrackId}
                isPlaying={isPlaying}
                selectedIds={albumSelection}
                loadingMore={false}
                onToggleSort={() => undefined}
                onActivate={(index) => onPlayLocal(albumTracks, index)}
                onSelect={selectAlbumRow}
                onSelectMany={(ids) => setAlbumSelection(new Set(ids))}
                onSelectAll={() => setAlbumSelection(new Set(albumTracks.map((track) => track.id)))}
                onClearSelection={() => setAlbumSelection(new Set())}
                onReveal={onReveal}
                singleClick={singleClick}
                doubleClick={doubleClick}
                sortable={false}
                rowHeight={rowHeight}
                listKey={albumKeyOf(openAlbum)}
                showAlbumColumn={false}
                onRowContextMenu={(track, _index, at) => setAlbumMenu({ track, at })}
              />
            ) : (
              <div className="empty-state album-detail-empty">
                <DiscIcon size={28} />
                <h2>No tracks in this album</h2>
                <p>The files may have moved or been removed since the album was indexed.</p>
              </div>
            )}
          </div>
        </div>

        {albumMenu ? (
          <TrackContextMenu
            track={albumMenu.track}
            at={albumMenu.at}
            playlists={playlists}
            onAddTracks={onAddTracksToPlaylist}
            onCreatePlaylist={onCreatePlaylist}
            onPlay={() => {
              const index = albumTracks.findIndex((track) => track.id === albumMenu.track.id)
              if (index >= 0) onPlayLocal(albumTracks, index)
              setAlbumMenu(null)
            }}
            onDetails={() => {
              setAlbumDetails(albumMenu.track)
              setAlbumMenu(null)
            }}
            onReveal={() => {
              onReveal(albumMenu.track.id)
              setAlbumMenu(null)
            }}
            isSelected={albumSelection.has(albumMenu.track.id)}
            onToggleSelection={() => toggleAlbumSelection(albumMenu.track.id)}
            onPlaySelected={() => onPlayLocal(selectedTracks, 0)}
            onQueueSelected={() => onQueueLocal(selectedTracks)}
            trackIds={albumSelection.has(albumMenu.track.id) ? [...albumSelection] : [albumMenu.track.id]}
            onClose={() => setAlbumMenu(null)}
          />
        ) : null}

        {albumDetails ? (
          <TrackDetails track={albumDetails} onReveal={onReveal} onClose={() => setAlbumDetails(null)} />
        ) : null}
      </section>
    )
  }

  return (
    <section className="main-view home-view" ref={scrollRef}>
      <header className="view-header home-header">
        <div className="view-heading">
          <h1>Home</h1>
          <p className="subtitle">
            {hasLibrary
              ? 'Jump back in, or browse the whole collection.'
              : 'Your library starts with one folder.'}
          </p>
        </div>
        <div className="header-actions">
          <button type="button" onClick={onOpenLibrary}>
            <LibraryIcon />
            <span>Library</span>
          </button>
          <button type="button" onClick={onScan} disabled={scanning} title="Rescan library folders">
            {scanning ? <SpinnerIcon /> : <RefreshIcon />}
            <span>{scanning ? 'Scanning' : 'Rescan'}</span>
          </button>
          <button type="button" className="primary" onClick={onAddFolder} disabled={scanning}>
            <FolderIcon />
            <span>Add folder</span>
          </button>
        </div>
      </header>

      {combinedError ? <div className="banner error">{combinedError}</div> : null}

      <section className="home-hero">
        {heroKey ? <img className="home-hero-backdrop" src={buildArtworkUrl(heroKey)} alt="" /> : null}
        <div className="home-hero-copy">
          <span className="home-kicker">{hasLibrary ? 'Your collection' : 'Welcome to Player'}</span>
          <h2>
            {hasLibrary ? 'Your music, at a glance.' : 'A quiet home for your music.'}
          </h2>
          <p>
            {hasLibrary
              ? 'Recent albums, familiar artists and playlists, with the full library one click away.'
              : 'Add a folder of audio files and Player will index everything inside it. Nothing is uploaded or moved.'}
          </p>
          <div className="home-hero-actions">
            {hasLibrary ? (
              <button type="button" className="primary" onClick={onOpenLibrary}>
                <LibraryIcon />
                <span>Open library</span>
              </button>
            ) : (
              <button type="button" className="primary" onClick={onAddFolder}>
                <FolderIcon />
                <span>Add music folder</span>
              </button>
            )}
            {hasLibrary ? (
              <button type="button" onClick={onAddFolder}>
                <FolderIcon />
                <span>Add folder</span>
              </button>
            ) : null}
            {scanning ? (
              <button type="button" className="link-button" onClick={onCancelScan}>
                Cancel scan
              </button>
            ) : null}
          </div>
          {scanning ? (
            <div className="home-scan" role="status">
              <SpinnerIcon size={14} />
              <span>
                Scanning
                {progress
                  ? ` · ${formatCount(progress.filesSeen)} files seen · ${formatCount(progress.indexed)} added`
                  : '…'}
              </span>
            </div>
          ) : stats?.lastScanAt ? (
            <span className="home-scan-note">
              Last scan {new Date(stats.lastScanAt).toLocaleDateString()}
            </span>
          ) : null}
        </div>
        <div className="home-stats">
          <div className="home-stat">
            <strong>{stats ? formatCount(stats.tracks) : '--'}</strong>
            <span>Tracks</span>
          </div>
          <div className="home-stat">
            <strong>{stats ? formatCount(stats.albums) : '--'}</strong>
            <span>Albums</span>
          </div>
          <div className="home-stat">
            <strong>{stats ? formatCount(stats.artists) : '--'}</strong>
            <span>Artists</span>
          </div>
          <div className="home-stat">
            <strong>{stats ? formatBytes(stats.totalBytes) : '--'}</strong>
            <span>On disk</span>
          </div>
        </div>
      </section>

      {!hasLibrary ? (
        <div className="empty-state home-empty">
          <FolderIcon size={32} />
          <h2>No albums yet</h2>
          <p>
            Once a folder is indexed, recent albums and artists appear here. Your playlists and
            YouTube links still live in the sidebar.
          </p>
          <button type="button" className="primary" onClick={onAddFolder} disabled={scanning}>
            <FolderIcon />
            <span>Add music folder</span>
          </button>
        </div>
      ) : shelvesLoading && recentAlbums.length === 0 ? (
        <div className="home-shelves-loading" role="status">
          <SpinnerIcon size={18} />
          <span>Loading your shelves…</span>
        </div>
      ) : (
        <>
          {playedAlbums.length > 0 ? (
            <Shelf title="Recently played" hint="Back where you left off" icon={<PlayIcon size={15} />}>
              {playedAlbums.map((album) => (
                <AlbumCard
                  key={albumKeyOf(album)}
                  album={album}
                  busy={busyAlbum === albumKeyOf(album)}
                  onOpen={openAlbumDetail}
                  onPlay={(next) => void playAlbum(next)}
                />
              ))}
            </Shelf>
          ) : null}

          {recentAlbums.length > 0 ? (
            <Shelf title="Recently added" hint="Newest albums first" icon={<DiscIcon size={15} />}>
              {recentAlbums.map((album) => (
                <AlbumCard
                  key={albumKeyOf(album)}
                  album={album}
                  busy={busyAlbum === albumKeyOf(album)}
                  onOpen={openAlbumDetail}
                  onPlay={(next) => void playAlbum(next)}
                />
              ))}
            </Shelf>
          ) : null}

          {artists.length > 0 ? (
            <Shelf title="Artists" hint="Click one to filter the albums" icon={<ArtistIcon size={15} />}>
              {artists.map((artist) => (
                <ArtistCard
                  key={artist.artist}
                  artist={artist}
                  busy={busyArtist === artist.artist}
                  onFilter={filterByArtist}
                  onPlay={(next) => void playArtist(next)}
                />
              ))}
            </Shelf>
          ) : null}

          {playlists.length > 0 ? (
            <Shelf title="Playlists" hint="Your hand-made running orders" icon={<PlayIcon size={15} />}>
              {playlists.map((playlist) => (
                <PlaylistCard
                  key={playlist.id}
                  playlist={playlist}
                  onOpen={(next) => onOpenPlaylist(next.id)}
                />
              ))}
            </Shelf>
          ) : null}
        </>
      )}

      <section className="home-section album-grid-section" ref={gridRef} hidden={!hasLibrary}>
        <div className="album-grid-head">
          <div>
            <h2>
              <DiscIcon size={16} />
              {albums.artist ? `Albums by ${albums.artist}` : 'All albums'}
            </h2>
            <p>
              {albums.loading
                ? 'Loading albums…'
                : `${formatCount(albums.total)} ${albums.total === 1 ? 'album' : 'albums'}`}
              {albums.search ? ` matching “${albums.search}”` : ''}
            </p>
          </div>
          <div className="album-grid-tools">
            {albums.artist ? (
              <button
                type="button"
                className="filter-chip album-artist-chip"
                onClick={() => albums.setArtist(null)}
                title="Show every artist"
              >
                <span>{albums.artist}</span>
                <CloseIcon size={12} />
              </button>
            ) : null}
            <div className="search-field album-search">
              <SearchIcon size={14} />
              <input
                value={albums.search}
                onChange={(event) => albums.setSearch(event.target.value)}
                placeholder="Find an album"
                aria-label="Search albums"
              />
              {albums.search ? (
                <button
                  type="button"
                  className="icon-button subtle clear-search"
                  onClick={() => albums.setSearch('')}
                  title="Clear album search"
                  aria-label="Clear album search"
                >
                  <CloseIcon />
                </button>
              ) : null}
            </div>
            <div className="segmented album-sort" role="group" aria-label="Sort albums">
              <button
                type="button"
                className={albums.sort === 'recent' ? 'active' : undefined}
                aria-pressed={albums.sort === 'recent'}
                onClick={() => albums.setSort('recent')}
              >
                Newest
              </button>
              <button
                type="button"
                className={albums.sort === 'title' ? 'active' : undefined}
                aria-pressed={albums.sort === 'title'}
                onClick={() => albums.setSort('title')}
              >
                A–Z
              </button>
            </div>
          </div>
        </div>

        {albumError && !openAlbum ? <div className="banner error">{albumError}</div> : null}

        {albums.loading && albums.albums.length === 0 ? (
          <div className="home-shelves-loading" role="status">
            <SpinnerIcon size={18} />
            <span>Loading albums…</span>
          </div>
        ) : albums.albums.length === 0 ? (
          <div className="empty-state album-grid-empty">
            <SearchIcon size={28} />
            <h2>{albums.search || albums.artist ? 'No albums match' : 'No albums yet'}</h2>
            <p>
              {albums.search || albums.artist
                ? 'Try a shorter search, or clear the artist filter.'
                : 'Albums appear as soon as your folders have been indexed.'}
            </p>
            {albums.artist ? (
              <button type="button" onClick={() => albums.setArtist(null)}>
                Show all albums
              </button>
            ) : albums.search ? (
              <button type="button" onClick={() => albums.setSearch('')}>
                Clear search
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <div className="album-grid">
              {albums.albums.map((album) => (
                <AlbumCard
                  key={albumKeyOf(album)}
                  album={album}
                  busy={busyAlbum === albumKeyOf(album)}
                  onOpen={openAlbumDetail}
                  onPlay={(next) => void playAlbum(next)}
                />
              ))}
            </div>
            {albums.hasMore ? (
              <div className="album-grid-more">
                <button type="button" onClick={albums.loadMore} disabled={albums.loadingMore}>
                  {albums.loadingMore ? <SpinnerIcon /> : <DiscIcon />}
                  <span>
                    {albums.loadingMore
                      ? 'Loading…'
                      : `Show more (${formatCount(albums.total - albums.albums.length)} left)`}
                  </span>
                </button>
              </div>
            ) : albums.total > 60 ? (
              <p className="album-grid-end">That is all {formatCount(albums.total)} albums.</p>
            ) : null}
          </>
        )}
      </section>
    </section>
  )
}
