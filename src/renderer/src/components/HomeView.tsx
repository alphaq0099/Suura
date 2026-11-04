import { Children, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import type {
  AddTracksOutcome,
  AlbumSummary,
  AllTracksFilter,
  AllTracksSource,
  ArtistSummary,
  LibraryClickAction,
  LibraryStats,
  OnlinePlaylist,
  Playlist,
  ScanProgress,
  Track
} from '@shared/types'
import { buildArtworkUrl } from '@shared/artwork-url'
import { formatBytes, formatCount, formatDuration } from '@shared/format'
import { onlinePlaylistArtworkTrack, onlinePlaylistItemToTrack, streamPlayToTrack } from '@shared/online'
import { mergeAddedShelf, mergePlayedShelf, type ShelfEntry } from '@shared/played-shelf'
import { api, messageOf } from '../api'
import { useAllTracks } from '../hooks/useAllTracks'
import { resolveArtwork, useArtwork } from '../hooks/useArtwork'
import type { UseDownloadsResult } from '../hooks/useDownloads'
import { ArtworkImage } from './ArtworkImage'
import {
  ArrowLeftIcon,
  ArtistIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CloseIcon,
  DiscIcon,
  FolderIcon,
  HistoryIcon,
  InfoIcon,
  LibraryIcon,
  ListMusicIcon,
  MoreIcon,
  MusicIcon,
  NewMusicIcon,
  PlayIcon,
  QueueIcon,
  RefreshIcon,
  SearchIcon,
  SpinnerIcon
} from './Icons'
import { RowMenu } from './RowMenu'
import { TrackContextMenu } from './TrackContextMenu'
import { TrackDetails } from './TrackDetails'
import { TrackList } from './TrackList'

export interface HomeViewProps {
  stats: LibraryStats | null
  progress: ScanProgress | null
  scanning: boolean
  error: string | null
  playlists: Playlist[]
  /** Playlists, albums and mixes imported from a link, newest first. */
  onlinePlaylists: OnlinePlaylist[]
  currentTrackId: number | null
  isPlaying: boolean
  rowHeight: number
  /** Seconds between Home hero covers, from Settings → Appearance. */
  heroSlideSeconds: number
  /** Shared save queue, so a stream row here reports the same progress as YouTube. */
  downloads: UseDownloadsResult
  singleClick: LibraryClickAction
  doubleClick: LibraryClickAction
  onAddFolder: () => void
  onScan: () => void
  onCancelScan: () => void
  onOpenLibrary: () => void
  onOpenPlaylist: (playlistId: number) => void
  /** Opens an imported list in the Playlists view, where it can be edited. */
  onOpenOnlinePlaylist: (playlistId: number) => void
  onPlayLocal: (tracks: Track[], index: number) => void
  /** Plays one shelf card. A stream card needs the YouTube queue, not the library. */
  onPlayTrack: (track: Track) => void
  onQueueLocal: (tracks: Track[]) => void
  /** Plays an imported list, keeping its name on the queue. */
  onPlayImported: (tracks: Track[], index: number, playlist: OnlinePlaylist) => void
  onQueueImported: (tracks: Track[], playlist: OnlinePlaylist) => void
  onReveal: (trackId: number) => void
  onAddTracksToPlaylist: (playlistId: number, trackIds: number[]) => Promise<AddTracksOutcome>
  onCreatePlaylist: (name: string) => Promise<Playlist>
}

const LOCAL_REQUEST = (trackId: number) => ({ id: trackId, sourceKind: 'local' as const, sourceId: null })

/** The All tracks list has no selection; TrackList still takes the props. */
const NO_SELECTION: ReadonlySet<number> = new Set()

/** How a source reads in the row badge, and which existing badge colour it uses. */
const SOURCE_BADGE: Record<AllTracksSource, { label: string; tone: string }> = {
  library: { label: 'Library', tone: 'local' },
  youtube: { label: 'YouTube', tone: 'youtube' },
  stream: { label: 'YouTube', tone: 'youtube' },
  playlist: { label: 'Playlist', tone: 'imported' }
}

/** True unless the user asked for reduced motion in Settings or the OS. */
function allowsMotion(): boolean {
  const mode = document.documentElement.dataset.motion ?? 'system'
  if (mode === 'full') return true
  if (mode === 'reduced') return false
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * Brings a horizontal shelf back to its first card when a new one appears.
 *
 * New listens and new files are prepended, so a shelf the user had scrolled to
 * the right rendered the new card off-screen. Only a change of the first card
 * scrolls; an ordinary re-render of the same list leaves the position alone.
 */
function useRevealNewest(
  scrollRef: RefObject<HTMLDivElement | null>,
  firstKey: string | null
): void {
  const previous = useRef<string | null>(null)
  useEffect(() => {
    if (!firstKey) return
    if (previous.current === null) {
      previous.current = firstKey
      return
    }
    if (previous.current === firstKey) return
    previous.current = firstKey
    scrollRef.current?.scrollTo({ left: 0, behavior: allowsMotion() ? 'smooth' : 'auto' })
  }, [firstKey, scrollRef])
}

function shelfEntryKey(entry: ShelfEntry): string {
  return entry.kind === 'album'
    ? `album-${entry.album.album}\u001f${entry.album.albumArtist}`
    : `track-${entry.track.id}`
}

function firstShelfKey(entries: readonly ShelfEntry[]): string | null {
  const first = entries[0]
  return first ? shelfEntryKey(first) : null
}

/** How many covers the hero cycles through; the interval is a setting. */
const HERO_SLIDE_LIMIT = 8

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

/**
 * A slow crossfade of recent cover art behind the hero.
 *
 * The slideshow is decoration, so it has to stay out of the way: it freezes
 * when the user asks for reduced motion, and it stops advancing while the
 * window is hidden instead of burning timers in the background. The motion
 * preference is read from the root data attribute (with the OS setting as the
 * `system` fallback) so changing it in Settings takes effect immediately.
 */
function useHeroSlides(count: number, intervalMs: number): { index: number; running: boolean } {
  const [index, setIndex] = useState(0)
  const [motionAllowed, setMotionAllowed] = useState(() => allowsMotion())
  const [pageVisible, setPageVisible] = useState(() => !document.hidden)

  useEffect(() => {
    const root = document.documentElement
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const read = (): void => setMotionAllowed(allowsMotion())
    read()
    const observer = new MutationObserver(read)
    observer.observe(root, { attributes: true, attributeFilter: ['data-motion'] })
    query.addEventListener('change', read)
    return () => {
      observer.disconnect()
      query.removeEventListener('change', read)
    }
  }, [])

  useEffect(() => {
    const onVisibility = (): void => setPageVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  // Keep the state index in range if albums disappear; the render also clamps,
  // so a shrinking list never briefly shows no backdrop at all.
  useEffect(() => {
    setIndex((current) => (count === 0 ? 0 : current % count))
  }, [count])

  const running = motionAllowed && pageVisible && count > 1

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => {
      setIndex((current) => (current + 1) % count)
    }, intervalMs)
    return () => window.clearInterval(timer)
  }, [count, intervalMs, running])

  return { index: count === 0 ? 0 : index % count, running }
}

function AlbumCard({
  album,
  busy,
  onOpen,
  onPlay,
  onMenu
}: {
  album: AlbumSummary
  busy: boolean
  onOpen: (album: AlbumSummary) => void
  onPlay: (album: AlbumSummary) => void
  onMenu?: (album: AlbumSummary, at: { x: number; y: number }) => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const visible = useNearViewport(ref)
  const meta = [
    album.year ? String(album.year) : null,
    `${formatCount(album.trackCount)} ${album.trackCount === 1 ? 'track' : 'tracks'}`
  ]
    .filter(Boolean)
    .join(' · ')
  // A one-track album is a single: the user added a song and expects the card
  // to play it, not to open a release page with one row. A real album still
  // opens its detail, where Play/Queue and the running order live.
  const isSingle = album.trackCount <= 1

  return (
    <div
      className="album-card"
      ref={ref}
      onContextMenu={
        onMenu
          ? (event) => {
              event.preventDefault()
              onMenu(album, { x: event.clientX, y: event.clientY })
            }
          : undefined
      }
    >
      <button
        type="button"
        className="album-card-main"
        onClick={() => (isSingle ? onPlay(album) : onOpen(album))}
        aria-label={isSingle ? `Play ${album.album}` : `Open ${album.album}`}
        title={isSingle ? `Play ${album.album}` : `Open ${album.album}`}
      >
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

/**
 * A played file with no album tag.
 *
 * It uses the album-card shell so the shelf stays one row of covers, but its
 * main action plays the track instead of opening a release that does not
 * exist. The meta line carries the duration, which is what tells it apart from
 * the album cards around it.
 */
function TrackCard({
  track,
  onPlay,
  onMenu
}: {
  track: Track
  onPlay: (track: Track) => void
  onMenu?: (track: Track, at: { x: number; y: number }) => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const visible = useNearViewport(ref)
  const meta = [
    track.artist || 'Unknown artist',
    formatDuration(track.durationMs),
    track.sourceKind === 'youtube' ? 'YouTube' : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div
      className="album-card track-card"
      ref={ref}
      onContextMenu={
        onMenu
          ? (event) => {
              event.preventDefault()
              onMenu(track, { x: event.clientX, y: event.clientY })
            }
          : undefined
      }
    >
      <button
        type="button"
        className="album-card-main"
        onClick={() => onPlay(track)}
        aria-label={`Play ${track.title}`}
        title={`Play ${track.title}`}
      >
        <span className="album-card-art">
          <ArtworkImage
            track={visible ? track : null}
            size="100%"
            artworkKey={track.artworkKey ?? undefined}
            request={visible && track.sourceKind !== 'youtube' ? LOCAL_REQUEST(track.id) : null}
            className="album-cover"
          />
          <span className="album-card-shade" aria-hidden="true" />
        </span>
        <span className="album-card-title" title={track.title}>
          {track.title}
        </span>
        <span className="album-card-meta" title={meta}>
          {meta}
        </span>
      </button>
      <button
        type="button"
        className="album-card-play"
        onClick={() => onPlay(track)}
        aria-label={`Play ${track.title}`}
        title={`Play ${track.title}`}
      >
        <PlayIcon size={16} />
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

/**
 * A hand-made playlist on Home.
 *
 * It used to be a letter tile that opened Playlists. Home is for listening, so
 * the whole card now starts the list; the first track's cover stands in for art
 * the playlist does not own. Open and Queue stay one click away behind the
 * overflow button, which is where a card's less common actions belong.
 */
function PlaylistCard({
  playlist,
  busy,
  onPlay,
  onMenu
}: {
  playlist: Playlist
  busy: boolean
  onPlay: (playlist: Playlist) => void
  onMenu: (playlist: Playlist, at: { x: number; y: number }) => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const visible = useNearViewport(ref)
  const resolvedKey = useArtwork(
    null,
    visible && playlist.artworkTrackId !== null ? LOCAL_REQUEST(playlist.artworkTrackId) : null
  )
  const coverKey = playlist.artworkKey ?? resolvedKey
  const meta = `${formatCount(playlist.trackCount)} ${
    playlist.trackCount === 1 ? 'track' : 'tracks'
  }`

  return (
    <div className="album-card playlist-card" ref={ref}>
      <button
        type="button"
        className="album-card-main"
        onClick={() => onPlay(playlist)}
        title={`Play ${playlist.name}`}
        aria-label={`Play ${playlist.name}`}
      >
        <span className="playlist-card-cover" data-tone={toneOf(playlist.name)}>
          {coverKey ? (
            <img className="artwork album-cover" src={buildArtworkUrl(coverKey)} alt="" draggable={false} />
          ) : (
            <span className="playlist-card-initial">{initialOf(playlist.name)}</span>
          )}
          <span className="album-card-shade" aria-hidden="true" />
        </span>
        <span className="album-card-title" title={playlist.name}>
          {playlist.name}
        </span>
        <span className="album-card-meta" title={meta}>
          {meta}
        </span>
      </button>
      <button
        type="button"
        className="card-overflow"
        onClick={(event) => onMenu(playlist, { x: event.clientX, y: event.clientY })}
        aria-label={`More actions for ${playlist.name}`}
        title={`More actions for ${playlist.name}`}
      >
        {busy ? <SpinnerIcon size={14} /> : <MoreIcon size={16} />}
      </button>
    </div>
  )
}

/**
 * A playlist imported from a link, on Home.
 *
 * Like a hand-made list, the card plays the list instead of navigating; its
 * cover is the list's own sleeve or its first video's still. Opening it in
 * Playlists, where it can be played, saved or edited, is the menu's first item.
 */
function OnlinePlaylistCard({
  playlist,
  busy,
  onPlay,
  onMenu
}: {
  playlist: OnlinePlaylist
  busy: boolean
  onPlay: (playlist: OnlinePlaylist) => void
  onMenu: (playlist: OnlinePlaylist, at: { x: number; y: number }) => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const visible = useNearViewport(ref)
  const art = onlinePlaylistArtworkTrack(playlist)
  const resolvedKey = useArtwork(visible ? art : null)
  const coverKey = playlist.coverKey ?? resolvedKey
  const kind = playlist.kind === 'album' ? 'Album' : playlist.kind === 'mix' ? 'Mix' : 'Playlist'
  const meta = [
    `YouTube ${kind.toLowerCase()}`,
    `${formatCount(playlist.trackCount)} ${playlist.trackCount === 1 ? 'track' : 'tracks'}`
  ].join(' · ')

  return (
    <div className="album-card playlist-card online-playlist-card" ref={ref}>
      <button
        type="button"
        className="album-card-main"
        onClick={() => onPlay(playlist)}
        title={`Play ${playlist.title}`}
        aria-label={`Play ${playlist.title}`}
      >
        <span className="playlist-card-cover" data-tone={toneOf(playlist.title)}>
          {coverKey ? (
            <img className="artwork album-cover" src={buildArtworkUrl(coverKey)} alt="" draggable={false} />
          ) : (
            <span className="playlist-card-initial">{initialOf(playlist.title)}</span>
          )}
          <span className="album-card-shade" aria-hidden="true" />
        </span>
        <span className="album-card-title" title={playlist.title}>
          {playlist.title}
        </span>
        <span className="album-card-meta" title={meta}>
          {meta}
        </span>
      </button>
      <button
        type="button"
        className="card-overflow"
        onClick={(event) => onMenu(playlist, { x: event.clientX, y: event.clientY })}
        aria-label={`More actions for ${playlist.title}`}
        title={`More actions for ${playlist.title}`}
      >
        {busy ? <SpinnerIcon size={14} /> : <MoreIcon size={16} />}
      </button>
    </div>
  )
}

function Shelf({
  title,
  icon,
  action,
  scrollRef,
  children
}: {
  title: string
  icon?: ReactNode
  action?: ReactNode
  scrollRef?: RefObject<HTMLDivElement | null>
  children: ReactNode
}) {
  const nodeRef = useRef<HTMLDivElement | null>(null)
  const [atStart, setAtStart] = useState(true)
  const [atEnd, setAtEnd] = useState(true)
  const cardCount = Children.count(children)

  // The caller may already own the node (it scrolls the shelf back to a newly
  // prepended card), so the same element is written to both refs.
  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      nodeRef.current = node
      if (scrollRef) scrollRef.current = node
    },
    [scrollRef]
  )

  const measure = useCallback(() => {
    const node = nodeRef.current
    if (!node) return
    const max = node.scrollWidth - node.clientWidth
    // The shelf is padded 2px and every card snaps to start, so a shelf that
    // looks untouched can report a couple of pixels of scroll. Treat that as
    // the edge, or the back arrow is offered at the beginning of the row and
    // does nothing visible.
    const edge = 8
    setAtStart(node.scrollLeft <= edge)
    // A shelf that fits its pane has no direction to offer; both arrows stay
    // disabled instead of one of them promising a scroll that cannot happen.
    setAtEnd(max <= edge || node.scrollLeft >= max - edge)
  }, [])

  useEffect(() => {
    const node = nodeRef.current
    measure()
    if (!node) return
    node.addEventListener('scroll', measure, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => {
      node.removeEventListener('scroll', measure)
      observer.disconnect()
    }
  }, [measure, cardCount])

  const step = (direction: -1 | 1): void => {
    const node = nodeRef.current
    if (!node) return
    node.scrollBy({
      left: direction * Math.max(180, node.clientWidth * 0.8),
      behavior: allowsMotion() ? 'smooth' : 'auto'
    })
  }

  return (
    <section className="home-section">
      <div className="home-section-head">
        <h2>
          {icon}
          {title}
        </h2>
        <div className="home-section-tools">
          <button
            type="button"
            className="shelf-arrow"
            onClick={() => step(-1)}
            disabled={atStart}
            aria-label={`Scroll ${title} back`}
            title={`Scroll ${title} back`}
          >
            <ChevronLeftIcon size={15} />
          </button>
          <button
            type="button"
            className="shelf-arrow"
            onClick={() => step(1)}
            disabled={atEnd}
            aria-label={`Scroll ${title} forward`}
            title={`Scroll ${title} forward`}
          >
            <ChevronRightIcon size={15} />
          </button>
          {action}
        </div>
      </div>
      <div className="home-shelf" ref={attach}>
        {children}
      </div>
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
    onlinePlaylists,
    currentTrackId,
    isPlaying,
    rowHeight,
    heroSlideSeconds,
    downloads,
    singleClick,
    doubleClick,
    onAddFolder,
    onScan,
    onCancelScan,
    onOpenLibrary,
    onOpenPlaylist,
    onOpenOnlinePlaylist,
    onPlayLocal,
    onPlayTrack,
    onQueueLocal,
    onPlayImported,
    onQueueImported,
    onReveal,
    onAddTracksToPlaylist,
    onCreatePlaylist
  } = props

  const allTracks = useAllTracks()
  const [recentAlbums, setRecentAlbums] = useState<AlbumSummary[]>([])
  const [addedSingles, setAddedSingles] = useState<Track[]>([])
  // Tracks behind one-file releases. They are shown as track cards rather than
  // album cards, so Home fetches the row itself once per shelf load.
  const [addedSingleAlbumTracks, setAddedSingleAlbumTracks] = useState<Track[]>([])
  const [playedAlbums, setPlayedAlbums] = useState<AlbumSummary[]>([])
  const [playedSingles, setPlayedSingles] = useState<Track[]>([])
  const [playedSingleAlbumTracks, setPlayedSingleAlbumTracks] = useState<Track[]>([])
  const [playedStreams, setPlayedStreams] = useState<Track[]>([])
  const [artists, setArtists] = useState<ArtistSummary[]>([])
  const [shelvesLoading, setShelvesLoading] = useState(true)
  const [shelvesError, setShelvesError] = useState<string | null>(null)
  const [busyAlbum, setBusyAlbum] = useState<string | null>(null)
  const [busyArtist, setBusyArtist] = useState<string | null>(null)
  /** The card whose menu is open, and the custom list it belongs to. */
  const [playlistMenu, setPlaylistMenu] = useState<
    | { kind: 'custom'; playlist: Playlist; at: { x: number; y: number } }
    | { kind: 'online'; playlist: OnlinePlaylist; at: { x: number; y: number } }
    | null
  >(null)
  /** The card whose tracks are being fetched for play or queue. */
  const [busyPlaylist, setBusyPlaylist] = useState<string | null>(null)
  const [heroArtKeys, setHeroArtKeys] = useState<string[]>([])

  const [openAlbum, setOpenAlbum] = useState<AlbumSummary | null>(null)
  /** An artist opened from the shelf. Albums use the same detail shell. */
  const [openArtist, setOpenArtist] = useState<ArtistSummary | null>(null)
  const [albumTracks, setAlbumTracks] = useState<Track[]>([])
  const [albumLoading, setAlbumLoading] = useState(false)
  const [albumError, setAlbumError] = useState<string | null>(null)
  const [albumSelection, setAlbumSelection] = useState<ReadonlySet<number>>(() => new Set())
  const [albumMenu, setAlbumMenu] = useState<{ track: Track; at: { x: number; y: number } } | null>(null)
  const [albumDetails, setAlbumDetails] = useState<Track | null>(null)
  // The row menu can ask for the editor instead of the sheet.
  const [albumEditing, setAlbumEditing] = useState(false)
  /**
   * A right-click on a Home shelf card or an All tracks row. The shelf cards and
   * the list have no selection, so the menu offers row actions only; `from`
   * decides whether Play starts just this track or the list around it.
   */
  const [trackMenu, setTrackMenu] = useState<
    { track: Track; at: { x: number; y: number }; from: 'shelf' | 'all' } | null
  >(null)
  /** A stream has no file, so its menu is the smaller RowMenu. */
  const [streamMenu, setStreamMenu] = useState<{ track: Track; at: { x: number; y: number } } | null>(
    null
  )
  const [trackDetails, setTrackDetails] = useState<Track | null>(null)
  const [trackEditing, setTrackEditing] = useState(false)
  /** A right-click on an album card: the shelf groups tracks, so the menu is album-level. */
  const [albumCardMenu, setAlbumCardMenu] = useState<
    { album: AlbumSummary; at: { x: number; y: number } } | null
  >(null)

  const scrollRef = useRef<HTMLElement | null>(null)
  const gridRef = useRef<HTMLElement | null>(null)
  const gridHeadingRef = useRef<HTMLHeadingElement | null>(null)
  const gridScrollRef = useRef(0)
  const playedShelfRef = useRef<HTMLDivElement | null>(null)
  const addedShelfRef = useRef<HTMLDivElement | null>(null)
  /** Bumped per shelf load so a slow scan refresh cannot overwrite a newer one. */
  const shelvesTokenRef = useRef(0)

  const loadShelves = useCallback(async (): Promise<void> => {
    const token = ++shelvesTokenRef.current
    setShelvesLoading(true)
    try {
      const [recent, added, played, singles, streams, artistRows] = await Promise.all([
        api.listAlbums({ sort: 'recent', direction: 'desc', limit: 12 }),
        // A file with no album tag has no album card, so Recently added would
        // omit every new single. Ask for the same recent window of those files.
        api.listTracks({ sort: 'added', direction: 'desc', albumless: true, limit: 12 }),
        api.listAlbums({ sort: 'played', direction: 'desc', limit: 24 }),
        // A played file without album tags has no album card to appear on, so
        // ask for it separately and let the shelf merge both kinds.
        api.listTracks({
          sort: 'played',
          direction: 'desc',
          filter: 'most-played',
          albumless: true,
          limit: 12
        }),
        // YouTube listens have no library row at all; the play log is the only
        // place a song played from a link or an imported list can come from.
        api.listStreamPlays(24),
        api.listArtists(12)
      ])
      // A release with one file is a track, not an album. The merge turns it
      // into a track card, so its row has to be here: the album summary only
      // names a representative id.
      const playedRecent = played.albums
        .filter((album) => album.lastPlayedAt !== null)
        .slice(0, 12)
      const recentSingleIds = recent.albums
        .filter((album) => album.trackCount === 1)
        .map((album) => album.trackId)
      const playedSingleIds = playedRecent
        .filter((album) => album.trackCount === 1)
        .map((album) => album.trackId)
      const [recentSingleTracks, playedSingleTracks] = await Promise.all([
        recentSingleIds.length > 0 ? api.getTracks(recentSingleIds) : Promise.resolve([]),
        playedSingleIds.length > 0 ? api.getTracks(playedSingleIds) : Promise.resolve([])
      ])
      if (token !== shelvesTokenRef.current) return
      setRecentAlbums(recent.albums)
      setAddedSingles(added.tracks)
      setAddedSingleAlbumTracks(recentSingleTracks)
      setPlayedAlbums(playedRecent)
      setPlayedSingles(singles.tracks)
      setPlayedSingleAlbumTracks(playedSingleTracks)
      setPlayedStreams(streams.map(streamPlayToTrack))
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
    const libraryToken = api.on('libraryChanged', () => {
      void loadShelves()
    })
    const playToken = api.on('playHistoryChanged', () => {
      void loadShelves()
    })
    return () => {
      api.off(libraryToken)
      api.off(playToken)
    }
  }, [loadShelves])

  const playedShelf = useMemo(
    () =>
      mergePlayedShelf(
        playedAlbums,
        [...playedSingles, ...playedSingleAlbumTracks],
        playedStreams,
        12
      ),
    [playedAlbums, playedSingleAlbumTracks, playedSingles, playedStreams]
  )
  const addedShelf = useMemo(
    () => mergeAddedShelf(recentAlbums, [...addedSingles, ...addedSingleAlbumTracks], 12),
    [addedSingleAlbumTracks, addedSingles, recentAlbums]
  )
  useRevealNewest(playedShelfRef, firstShelfKey(playedShelf))
  useRevealNewest(addedShelfRef, firstShelfKey(addedShelf))

  /**
   * The covers the hero cycles are the cards on Recently played, not a separate
   * album query. That is the difference between "the art of what I last heard"
   * and "the art of the last albums that happen to have a sleeve": a YouTube
   * listen, a single, or a track from a playlist now reaches the hero by the same
   * path as an album. A row with no stored key is resolved through the shared
   * artwork cache, so the band does not wait on eight IPC calls to appear.
   */
  const heroCandidates = useMemo(() => {
    const shelf = playedShelf.length > 0 ? playedShelf : addedShelf
    const seen = new Set<string>()
    const candidates: Array<{
      key: string | null
      request: Pick<Track, 'id' | 'sourceKind' | 'sourceId'>
    }> = []
    for (const entry of shelf) {
      let key: string | null
      let request: Pick<Track, 'id' | 'sourceKind' | 'sourceId'>
      if (entry.kind === 'album') {
        key = entry.album.artworkKey
        request = LOCAL_REQUEST(entry.album.trackId)
      } else {
        const track = entry.track
        key = track.artworkKey
        request =
          track.sourceKind === 'youtube' && track.sourceId
            ? { id: track.id, sourceKind: 'youtube', sourceId: track.sourceId }
            : LOCAL_REQUEST(track.id)
      }
      const identity = `${
        request.sourceKind === 'youtube' ? `youtube:${request.sourceId}` : `local:${request.id}`
      }`
      if (seen.has(identity)) continue
      seen.add(identity)
      candidates.push({ key, request })
      if (candidates.length >= HERO_SLIDE_LIMIT) break
    }
    return candidates
  }, [addedShelf, playedShelf])

  useEffect(() => {
    let cancelled = false
    void Promise.all(
      heroCandidates.map(async (candidate) => candidate.key ?? (await resolveArtwork(candidate.request)))
    ).then((resolvedKeys) => {
      if (cancelled) return
      const seen = new Set<string>()
      const slides: string[] = []
      for (const key of resolvedKeys) {
        if (!key || seen.has(key)) continue
        seen.add(key)
        slides.push(key)
      }
      setHeroArtKeys(slides)
    })
    return () => {
      cancelled = true
    }
  }, [heroCandidates])

  const heroSlide = useHeroSlides(heroArtKeys.length, heroSlideSeconds * 1000)

  const hasLibrary = (stats?.tracks ?? 0) > 0
  const combinedError = error ?? shelvesError

  const openAlbumDetail = useCallback((album: AlbumSummary): void => {
    gridScrollRef.current = scrollRef.current?.scrollTop ?? 0
    setAlbumSelection(new Set())
    setAlbumMenu(null)
    setAlbumDetails(null)
    setOpenArtist(null)
    setOpenAlbum(album)
  }, [])

  /**
   * Opens an artist's tracks in the same shell an album uses.
   *
   * The Artists shelf is built from track credits, so an artist can have tracks
   * while owning no album card (a single, a compilation credit). Filtering the
   * album grid for that artist produced an empty page; the honest view is the
   * tracks themselves.
   */
  const openArtistDetail = useCallback((artist: ArtistSummary): void => {
    gridScrollRef.current = scrollRef.current?.scrollTop ?? 0
    setAlbumSelection(new Set())
    setAlbumMenu(null)
    setAlbumDetails(null)
    setOpenAlbum(null)
    setOpenArtist(artist)
  }, [])

  const closeAlbumDetail = useCallback((): void => {
    setOpenAlbum(null)
    setOpenArtist(null)
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
  }, [openAlbum, openArtist])

  useEffect(() => {
    if (!openAlbum && !openArtist) return
    let cancelled = false
    setAlbumLoading(true)
    setAlbumError(null)
    setAlbumTracks([])
    setAlbumSelection(new Set())
    void api
      .listTracks(
        openAlbum
          ? {
              album: openAlbum.album,
              albumArtist: openAlbum.albumArtist,
              limit: 5000,
              sort: 'album',
              direction: 'asc'
            }
          : {
              artist: openArtist!.artist,
              limit: 5000,
              // Album order groups an artist's singles and album tracks
              // instead of scattering them by title.
              sort: 'album',
              direction: 'asc'
            }
      )
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
  }, [openAlbum, openArtist])

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

  /**
   * Adds an album to the queue instead of replacing what is playing.
   *
   * The shelf card plays on a click, so the menu's queue action is the one way
   * to add a whole release without stopping the current track.
   */
  const queueAlbum = useCallback(
    async (album: AlbumSummary): Promise<void> => {
      try {
        const page = await api.listTracks({
          album: album.album,
          albumArtist: album.albumArtist,
          limit: 5000,
          sort: 'album',
          direction: 'asc'
        })
        if (page.tracks.length > 0) onQueueLocal(page.tracks)
      } catch (cause) {
        setShelvesError(messageOf(cause))
      }
    },
    [onQueueLocal]
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

  /**
   * Plays one row from All tracks.
   *
   * The list mixes files and streams. A stream row is still one video played by
   * the YouTube queue, exactly as a stream row elsewhere. A file row plays the
   * files around it, so the rest of the visible list becomes the queue; the
   * streams in between are skipped rather than handed to a queue that cannot
   * resolve them.
   */
  const playAllTracksRow = useCallback(
    (index: number): void => {
      const row = allTracks.rows[index]
      if (!row) return
      if (row.track.sourceKind === 'youtube') {
        onPlayTrack(row.track)
        return
      }
      const localRows = allTracks.rows.filter((entry) => entry.track.sourceKind !== 'youtube')
      const start = localRows.findIndex((entry) => entry.track.id === row.track.id)
      onPlayLocal(
        localRows.map((entry) => entry.track),
        start >= 0 ? start : 0
      )
    },
    [allTracks.rows, onPlayLocal, onPlayTrack]
  )

  /**
   * Right-click on a Home track. A local file gets the full row menu; a stream
   * has no file to tag or reveal, so it gets the smaller one.
   */
  const openTrackMenu = useCallback(
    (track: Track, at: { x: number; y: number }, from: 'shelf' | 'all') => {
      if (track.sourceKind === 'youtube') setStreamMenu({ track, at })
      else setTrackMenu({ track, at, from })
    },
    []
  )

  /** Play from the row menu: a shelf card plays itself, a list row plays its list. */
  const playMenuTrack = useCallback((): void => {
    if (!trackMenu) return
    const track = trackMenu.track
    if (trackMenu.from === 'all') {
      const index = allTracks.rows.findIndex((row) => row.track.id === track.id)
      if (index >= 0) playAllTracksRow(index)
      else onPlayTrack(track)
    } else {
      onPlayTrack(track)
    }
    setTrackMenu(null)
  }, [trackMenu, allTracks.rows, playAllTracksRow, onPlayTrack])

  /**
   * A shelf's More opens the full version of that shelf in the list below.
   *
   * It is not a second view: the list scrolls into place, takes the shelf's
   * filter and shows a chip naming it. Clearing the chip is the way back to All
   * tracks, which is why the chip has to be the same control that set it.
   */
  const showAllTracks = useCallback(
    (filter: AllTracksFilter): void => {
      allTracks.setFilter(filter)
      // The scroll is a frame concern; the focus is not. A frame callback can be
      // paused while the window is in the background, which would leave the
      // scroll with nothing focused, so the focus is queued as its own task
      // after React has committed the filtered heading.
      requestAnimationFrame(() => {
        gridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
      window.setTimeout(() => {
        gridHeadingRef.current?.focus({ preventScroll: true })
      }, 0)
    },
    [allTracks]
  )

  /**
   * Plays a hand-made list from Home.
   *
   * A card carries only a summary; the entries live behind one detail call, the
   * same call the Playlists pane makes. Nothing navigates here: the card is a
   * play control first, and Open is in its menu.
   */
  const playCustomPlaylist = useCallback(
    async (playlist: Playlist): Promise<void> => {
      if (busyPlaylist !== null) return
      setBusyPlaylist(`custom-${playlist.id}`)
      try {
        const detail = await api.getPlaylist(playlist.id)
        const tracks = detail?.items.map((item) => item.track) ?? []
        if (tracks.length > 0) onPlayLocal(tracks, 0)
      } catch (cause) {
        setShelvesError(messageOf(cause))
      } finally {
        setBusyPlaylist(null)
      }
    },
    [busyPlaylist, onPlayLocal]
  )

  const queueCustomPlaylist = useCallback(
    async (playlist: Playlist): Promise<void> => {
      if (busyPlaylist !== null) return
      setBusyPlaylist(`custom-${playlist.id}`)
      try {
        const detail = await api.getPlaylist(playlist.id)
        const tracks = detail?.items.map((item) => item.track) ?? []
        if (tracks.length > 0) onQueueLocal(tracks)
      } catch (cause) {
        setShelvesError(messageOf(cause))
      } finally {
        setBusyPlaylist(null)
      }
    },
    [busyPlaylist, onQueueLocal]
  )

  /** The imported counterpart: its rows are YouTube entries, not library files. */
  const playOnlinePlaylist = useCallback(
    async (playlist: OnlinePlaylist): Promise<void> => {
      if (busyPlaylist !== null) return
      setBusyPlaylist(`online-${playlist.id}`)
      try {
        const detail = await api.getOnlinePlaylist(playlist.id)
        const tracks = detail
          ? detail.items.map((item) => onlinePlaylistItemToTrack(item, detail.playlist))
          : []
        if (tracks.length > 0) onPlayImported(tracks, 0, playlist)
      } catch (cause) {
        setShelvesError(messageOf(cause))
      } finally {
        setBusyPlaylist(null)
      }
    },
    [busyPlaylist, onPlayImported]
  )

  const queueOnlinePlaylist = useCallback(
    async (playlist: OnlinePlaylist): Promise<void> => {
      if (busyPlaylist !== null) return
      setBusyPlaylist(`online-${playlist.id}`)
      try {
        const detail = await api.getOnlinePlaylist(playlist.id)
        const tracks = detail
          ? detail.items.map((item) => onlinePlaylistItemToTrack(item, detail.playlist))
          : []
        if (tracks.length > 0) onQueueImported(tracks, playlist)
      } catch (cause) {
        setShelvesError(messageOf(cause))
      } finally {
        setBusyPlaylist(null)
      }
    },
    [busyPlaylist, onQueueImported]
  )

  const selectedTracks = useMemo(
    () => albumTracks.filter((track) => albumSelection.has(track.id)),
    [albumTracks, albumSelection]
  )

  /** TrackList wants tracks; the source badge reaches them by the row's index. */
  const allTrackRows = useMemo(() => allTracks.rows.map((row) => row.track), [allTracks.rows])

  const {
    saved: savedStreams,
    states: saveStates,
    save: saveStreamToLibrary,
    refreshSaved
  } = downloads

  // A merged list can surface the same video as a listen and as a playlist
  // entry; asking once per distinct id keeps that from becoming one IPC call
  // for every row.
  const allTrackStreamIds = useMemo(
    () =>
      [
        ...new Set(
          allTracks.rows.flatMap((row) =>
            row.track.sourceKind === 'youtube' && row.track.sourceId ? [row.track.sourceId] : []
          )
        )
      ],
    [allTracks.rows]
  )

  useEffect(() => {
    void refreshSaved(allTrackStreamIds)
  }, [allTrackStreamIds, refreshSaved])

  const saveAllTracksStream = useCallback(
    (track: Track): void => {
      if (track.sourceKind !== 'youtube' || !track.sourceId) return
      // The row shows its own progress and error; the Saves dock keeps a retry.
      void saveStreamToLibrary({
        videoId: track.sourceId,
        title: track.title,
        artist: track.artist,
        album: track.album
      }).catch(() => undefined)
    },
    [saveStreamToLibrary]
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

  if (openAlbum || openArtist) {
    const isArtistView = openArtist !== null
    const detailTitle = openArtist ? openArtist.artist : openAlbum!.album
    const detailSubtitle = openArtist
      ? null
      : openAlbum!.albumArtist || 'Unknown artist'
    const detailMeta = openArtist
      ? [
          `${formatCount(openArtist.trackCount)} ${openArtist.trackCount === 1 ? 'track' : 'tracks'}`,
          // Zero albums is the reason this view exists; saying it adds nothing.
          openArtist.albumCount > 0
            ? `${formatCount(openArtist.albumCount)} ${openArtist.albumCount === 1 ? 'album' : 'albums'}`
            : null
        ]
          .filter(Boolean)
          .join(' · ')
      : [
          openAlbum!.year ? String(openAlbum!.year) : null,
          `${formatCount(openAlbum!.trackCount)} ${openAlbum!.trackCount === 1 ? 'track' : 'tracks'}`,
          formatDuration(openAlbum!.durationMs)
        ]
          .filter(Boolean)
          .join(' · ')
    const detailArtworkKey = openArtist ? openArtist.artworkKey : openAlbum!.artworkKey
    const detailArtworkTrackId = openArtist ? openArtist.trackId : openAlbum!.trackId
    const detailListKey = openArtist ? `artist:${openArtist.artist}` : albumKeyOf(openAlbum!)

    return (
      <main className="main-view home-view" ref={scrollRef}>
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
                artworkKey={detailArtworkKey ?? undefined}
                request={detailArtworkKey ? null : LOCAL_REQUEST(detailArtworkTrackId)}
                className="album-detail-cover"
              />
            </span>
            <div className="album-detail-copy">
              <span className="home-kicker">{isArtistView ? 'Artist' : 'Album'}</span>
              <h2>{detailTitle}</h2>
              {detailSubtitle ? (
                <p className="album-detail-artist">{detailSubtitle}</p>
              ) : null}
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
                <span>{isArtistView ? 'Loading tracks…' : 'Loading album…'}</span>
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
                listKey={detailListKey}
                // An artist's tracks can span albums, so the album column is
                // the one column that tells them apart.
                showAlbumColumn={isArtistView}
                onRowContextMenu={(track, _index, at) => setAlbumMenu({ track, at })}
              />
            ) : (
              <div className="empty-state album-detail-empty">
                <DiscIcon size={28} />
                <h2>{isArtistView ? 'No tracks by this artist' : 'No tracks in this album'}</h2>
                <p>
                  {isArtistView
                    ? 'The files may have moved or been removed since the artist was indexed.'
                    : 'The files may have moved or been removed since the album was indexed.'}
                </p>
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
              setAlbumEditing(false)
              setAlbumDetails(albumMenu.track)
              setAlbumMenu(null)
            }}
            onEditTags={
              albumMenu.track.filePath
                ? () => {
                    setAlbumEditing(true)
                    setAlbumDetails(albumMenu.track)
                    setAlbumMenu(null)
                  }
                : undefined
            }
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
          <TrackDetails
            track={albumDetails}
            initialEditing={albumEditing}
            onReveal={onReveal}
            onClose={() => {
              setAlbumDetails(null)
              setAlbumEditing(false)
            }}
          />
        ) : null}
      </main>
    )
  }

  return (
    <main className="main-view home-view" ref={scrollRef}>
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

      <section
        className="home-hero"
        data-slide-state={heroSlide.running ? 'running' : 'still'}
        data-slide-count={heroArtKeys.length}
      >
        {heroArtKeys.map((key, index) => (
          <img
            key={key}
            className={index === heroSlide.index ? 'home-hero-backdrop active' : 'home-hero-backdrop'}
            src={buildArtworkUrl(key)}
            alt=""
            aria-hidden="true"
            decoding="async"
            draggable={false}
          />
        ))}
        <div className="home-hero-copy">
          <span className="home-kicker">{hasLibrary ? 'Your collection' : 'Welcome to Suura'}</span>
          <h2>
            {hasLibrary ? 'Your music, at a glance.' : 'A quiet home for your music.'}
          </h2>
          {!hasLibrary ? (
            <p>
              Add a folder of audio files and Suura will index everything inside it. Nothing is
              uploaded or moved.
            </p>
          ) : null}
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
          {!hasLibrary || scanning ? (
            <div className="home-hero-actions">
              {!hasLibrary ? (
                <button type="button" className="primary" onClick={onAddFolder}>
                  <FolderIcon />
                  <span>Add music folder</span>
                </button>
              ) : null}
              {scanning ? (
                <button type="button" className="link-button" onClick={onCancelScan}>
                  Cancel scan
                </button>
              ) : null}
            </div>
          ) : null}
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
          ) : null}
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
          {playedShelf.length > 0 ? (
            <Shelf
              title="Recently played"
              icon={<HistoryIcon size={15} />}
              scrollRef={playedShelfRef}
              action={
                <button
                  type="button"
                  className="home-more"
                  onClick={() => showAllTracks('played')}
                  title="Show every track you have played, newest listen first"
                  aria-label="More recently played tracks"
                >
                  More
                </button>
              }
            >
              {playedShelf.map((entry) =>
                entry.kind === 'album' ? (
                  <AlbumCard
                    key={shelfEntryKey(entry)}
                    album={entry.album}
                    busy={busyAlbum === albumKeyOf(entry.album)}
                    onOpen={openAlbumDetail}
                    onPlay={(next) => void playAlbum(next)}
                    onMenu={(next, at) => setAlbumCardMenu({ album: next, at })}
                  />
                ) : (
                  <TrackCard
                    key={shelfEntryKey(entry)}
                    track={entry.track}
                    onPlay={onPlayTrack}
                    onMenu={(next, at) => openTrackMenu(next, at, 'shelf')}
                  />
                )
              )}
            </Shelf>
          ) : null}

          {addedShelf.length > 0 ? (
            <Shelf
              title="Recently added"
              icon={<NewMusicIcon size={15} />}
              scrollRef={addedShelfRef}
              action={
                <button
                  type="button"
                  className="home-more"
                  onClick={() => showAllTracks('library')}
                  title="Show every file in your library, newest first"
                  aria-label="More recently added tracks"
                >
                  More
                </button>
              }
            >
              {addedShelf.map((entry) =>
                entry.kind === 'album' ? (
                  <AlbumCard
                    key={shelfEntryKey(entry)}
                    album={entry.album}
                    busy={busyAlbum === albumKeyOf(entry.album)}
                    onOpen={openAlbumDetail}
                    onPlay={(next) => void playAlbum(next)}
                    onMenu={(next, at) => setAlbumCardMenu({ album: next, at })}
                  />
                ) : (
                  <TrackCard
                    key={shelfEntryKey(entry)}
                    track={entry.track}
                    onPlay={onPlayTrack}
                    onMenu={(next, at) => openTrackMenu(next, at, 'shelf')}
                  />
                )
              )}
            </Shelf>
          ) : null}

          {artists.length > 0 ? (
            <Shelf title="Artists" icon={<ArtistIcon size={15} />}>
              {artists.map((artist) => (
                <ArtistCard
                  key={artist.artist}
                  artist={artist}
                  busy={busyArtist === artist.artist}
                  onFilter={openArtistDetail}
                  onPlay={(next) => void playArtist(next)}
                />
              ))}
            </Shelf>
          ) : null}

          {playlists.length + onlinePlaylists.length > 0 ? (
            <Shelf title="Playlists" icon={<ListMusicIcon size={15} />}>
              {playlists.map((playlist) => (
                <PlaylistCard
                  key={`custom-${playlist.id}`}
                  playlist={playlist}
                  busy={busyPlaylist === `custom-${playlist.id}`}
                  onPlay={(next) => void playCustomPlaylist(next)}
                  onMenu={(next, at) => setPlaylistMenu({ kind: 'custom', playlist: next, at })}
                />
              ))}
              {onlinePlaylists.map((playlist) => (
                <OnlinePlaylistCard
                  key={`online-${playlist.id}`}
                  playlist={playlist}
                  busy={busyPlaylist === `online-${playlist.id}`}
                  onPlay={(next) => void playOnlinePlaylist(next)}
                  onMenu={(next, at) => setPlaylistMenu({ kind: 'online', playlist: next, at })}
                />
              ))}
            </Shelf>
          ) : null}
        </>
      )}

      <section className="home-section all-tracks-section" ref={gridRef} hidden={!hasLibrary}>
        <div className="album-grid-head all-tracks-head">
          <div>
            <h2 ref={gridHeadingRef} tabIndex={-1}>
              {allTracks.filter === 'played' ? (
                <HistoryIcon size={16} />
              ) : allTracks.filter === 'library' ? (
                <NewMusicIcon size={16} />
              ) : (
                <MusicIcon size={16} />
              )}
              {allTracks.filter === 'played'
                ? 'Recently played'
                : allTracks.filter === 'library'
                  ? 'Recently added'
                  : 'All tracks'}
            </h2>
            <p>
              {allTracks.loading
                ? 'Loading tracks…'
                : allTracks.truncated
                  ? `Newest ${formatCount(allTracks.rows.length)} tracks`
                  : `${formatCount(allTracks.rows.length)} ${
                      allTracks.rows.length === 1 ? 'track' : 'tracks'
                    }`}
              {allTracks.search ? ` matching “${allTracks.search}”` : ''}
            </p>
          </div>
          <div className="all-tracks-tools">
            {allTracks.filter !== 'all' ? (
              <button
                type="button"
                className="filter-chip all-tracks-chip"
                onClick={() => allTracks.setFilter('all')}
                title="Show every track again"
              >
                <span>{allTracks.filter === 'played' ? 'Recently played' : 'Recently added'}</span>
                <CloseIcon size={12} />
              </button>
            ) : null}
            <div className="search-field tracks-search">
              <SearchIcon size={14} />
              <input
                value={allTracks.search}
                onChange={(event) => allTracks.setSearch(event.target.value)}
                placeholder="Find a track"
                aria-label="Search all tracks"
              />
              {allTracks.search ? (
                <button
                  type="button"
                  className="icon-button subtle clear-search"
                  onClick={() => allTracks.setSearch('')}
                  title="Clear track search"
                  aria-label="Clear track search"
                >
                  <CloseIcon />
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {allTracks.error ? <div className="banner error">{allTracks.error}</div> : null}

        {allTracks.loading && allTracks.rows.length === 0 ? (
          <div className="home-shelves-loading" role="status">
            <SpinnerIcon size={18} />
            <span>Loading tracks…</span>
          </div>
        ) : allTracks.rows.length === 0 ? (
          <div className="empty-state all-tracks-empty">
            <SearchIcon size={28} />
            <h2>
              {allTracks.search || allTracks.filter !== 'all' ? 'No tracks match' : 'No tracks yet'}
            </h2>
            <p>
              {allTracks.search || allTracks.filter !== 'all'
                ? 'Try a shorter search, or clear the filter.'
                : 'Tracks appear as soon as your folders have been indexed or a link has been played.'}
            </p>
            {allTracks.filter !== 'all' ? (
              <button type="button" onClick={() => allTracks.setFilter('all')}>
                Show all tracks
              </button>
            ) : allTracks.search ? (
              <button type="button" onClick={() => allTracks.setSearch('')}>
                Clear search
              </button>
            ) : null}
          </div>
        ) : (
          <>
            <div className="all-tracks-list">
              <TrackList
                tracks={allTrackRows}
                // The feed reports whether another page exists rather than a
                // total, so the virtualizer's one extra row is what asks for it.
                total={allTracks.rows.length + (allTracks.hasMore ? 1 : 0)}
                sort={null}
                direction="desc"
                currentTrackId={currentTrackId}
                isPlaying={isPlaying}
                selectedIds={NO_SELECTION}
                loadingMore={allTracks.loadingMore}
                onToggleSort={() => undefined}
                onActivate={playAllTracksRow}
                onSelect={() => undefined}
                onSelectAll={() => undefined}
                onClearSelection={() => undefined}
                onRowContextMenu={(track, _index, at) => openTrackMenu(track, at, 'all')}
                onReveal={onReveal}
                onRequestMore={allTracks.hasMore ? allTracks.loadMore : undefined}
                // Home is a launch surface: a row starts playing on a click,
                // exactly like a shelf card. Selection settings still govern
                // the Library, playlists and queue, where selection has a job.
                singleClick="play"
                doubleClick="play"
                sortable={false}
                rowHeight={rowHeight}
                listKey={`all-tracks:${allTracks.filter}:${allTracks.search}`}
                // The fourth column names where the row came from rather than
                // repeating an album: half this list has no album at all, and
                // the source is what a merged feed has to explain.
                sourceBadge={(_track, index) => {
                  const source = allTracks.rows[index]?.source ?? 'library'
                  const badge = SOURCE_BADGE[source]
                  return (
                    <span className={`row-badge source-badge ${badge.tone}`}>{badge.label}</span>
                  )
                }}
                onSave={saveAllTracksStream}
                isSaved={(track) =>
                  track.sourceId ? savedStreams.has(track.sourceId) : false
                }
                saveState={(track) => (track.sourceId ? saveStates[track.sourceId] : undefined)}
              />
            </div>
            {allTracks.truncated ? (
              <p className="album-grid-end">
                Showing the newest {formatCount(allTracks.rows.length)} tracks. Search to narrow the
                list.
              </p>
            ) : null}
          </>
        )}
      </section>

      {albumCardMenu ? (
        <RowMenu
          at={albumCardMenu.at}
          title={albumCardMenu.album.album}
          portal
          onClose={() => setAlbumCardMenu(null)}
          items={[
            {
              id: 'play',
              label: 'Play',
              icon: <PlayIcon size={15} />,
              onSelect: () => {
                void playAlbum(albumCardMenu.album)
                setAlbumCardMenu(null)
              }
            },
            {
              id: 'open',
              label: 'Open album',
              icon: <DiscIcon size={15} />,
              onSelect: () => {
                openAlbumDetail(albumCardMenu.album)
                setAlbumCardMenu(null)
              }
            },
            {
              id: 'queue',
              label: 'Add to queue',
              icon: <QueueIcon size={15} />,
              onSelect: () => {
                void queueAlbum(albumCardMenu.album)
                setAlbumCardMenu(null)
              }
            }
          ]}
        />
      ) : null}

      {playlistMenu ? (
        <RowMenu
          at={playlistMenu.at}
          title={
            playlistMenu.kind === 'custom'
              ? playlistMenu.playlist.name
              : playlistMenu.playlist.title
          }
          portal
          onClose={() => setPlaylistMenu(null)}
          items={
            playlistMenu.kind === 'custom'
              ? [
                  {
                    id: 'open',
                    label: 'Open in Playlists',
                    icon: <ListMusicIcon size={15} />,
                    onSelect: () => {
                      onOpenPlaylist(playlistMenu.playlist.id)
                      setPlaylistMenu(null)
                    }
                  },
                  {
                    id: 'queue',
                    label: 'Add to queue',
                    icon: <QueueIcon size={15} />,
                    onSelect: () => {
                      void queueCustomPlaylist(playlistMenu.playlist)
                      setPlaylistMenu(null)
                    }
                  }
                ]
              : [
                  {
                    id: 'open',
                    label: 'Open in Playlists',
                    icon: <ListMusicIcon size={15} />,
                    onSelect: () => {
                      onOpenOnlinePlaylist(playlistMenu.playlist.id)
                      setPlaylistMenu(null)
                    }
                  },
                  {
                    id: 'queue',
                    label: 'Add to queue',
                    icon: <QueueIcon size={15} />,
                    onSelect: () => {
                      void queueOnlinePlaylist(playlistMenu.playlist)
                      setPlaylistMenu(null)
                    }
                  }
                ]
          }
        />
      ) : null}

      {trackMenu ? (
        <TrackContextMenu
          track={trackMenu.track}
          at={trackMenu.at}
          playlists={playlists}
          onAddTracks={onAddTracksToPlaylist}
          onCreatePlaylist={onCreatePlaylist}
          onPlay={playMenuTrack}
          onDetails={() => {
            setTrackEditing(false)
            setTrackDetails(trackMenu.track)
            setTrackMenu(null)
          }}
          onEditTags={
            trackMenu.track.filePath
              ? () => {
                  setTrackEditing(true)
                  setTrackDetails(trackMenu.track)
                  setTrackMenu(null)
                }
              : undefined
          }
          onReveal={
            trackMenu.track.filePath
              ? () => {
                  onReveal(trackMenu.track.id)
                  setTrackMenu(null)
                }
              : undefined
          }
          showSelection={false}
          isSelected={false}
          onToggleSelection={() => undefined}
          onPlaySelected={() => undefined}
          onQueueSelected={() => undefined}
          trackIds={[trackMenu.track.id]}
          onClose={() => setTrackMenu(null)}
        />
      ) : null}

      {streamMenu ? (
        <RowMenu
          at={streamMenu.at}
          title={streamMenu.track.title}
          onClose={() => setStreamMenu(null)}
          items={[
            {
              id: 'play',
              label: 'Play',
              icon: <PlayIcon />,
              onSelect: () => onPlayTrack(streamMenu.track)
            },
            {
              id: 'details',
              label: 'Details',
              icon: <InfoIcon />,
              onSelect: () => {
                setTrackEditing(false)
                setTrackDetails(streamMenu.track)
              }
            }
          ]}
        />
      ) : null}

      {trackDetails ? (
        <TrackDetails
          track={trackDetails}
          initialEditing={trackEditing}
          onReveal={trackDetails.sourceKind === 'local' ? onReveal : undefined}
          onClose={() => {
            setTrackDetails(null)
            setTrackEditing(false)
          }}
        />
      ) : null}
    </main>
  )
}
