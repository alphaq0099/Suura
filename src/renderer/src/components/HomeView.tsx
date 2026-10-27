import { Children, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import type {
  AddTracksOutcome,
  AlbumSortField,
  AlbumSummary,
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
import { onlinePlaylistArtworkTrack, streamPlayToTrack } from '@shared/online'
import { mergeAddedShelf, mergePlayedShelf, type ShelfEntry } from '@shared/played-shelf'
import { api, messageOf } from '../api'
import { useAlbums } from '../hooks/useAlbums'
import { useArtwork } from '../hooks/useArtwork'
import { ArtworkImage } from './ArtworkImage'
import {
  ArrowLeftIcon,
  ArtistIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
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
  /** Playlists, albums and mixes imported from a link, newest first. */
  onlinePlaylists: OnlinePlaylist[]
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
  /** Opens an imported list in the Playlists view, where it can be edited. */
  onOpenOnlinePlaylist: (playlistId: number) => void
  onPlayLocal: (tracks: Track[], index: number) => void
  /** Plays one shelf card. A stream card needs the YouTube queue, not the library. */
  onPlayTrack: (track: Track) => void
  onQueueLocal: (tracks: Track[]) => void
  onReveal: (trackId: number) => void
  onAddTracksToPlaylist: (playlistId: number, trackIds: number[]) => Promise<AddTracksOutcome>
  onCreatePlaylist: (name: string) => Promise<Playlist>
}

const LOCAL_REQUEST = (trackId: number) => ({ id: trackId, sourceKind: 'local' as const, sourceId: null })

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

/** Slow enough to read the page: the backdrop is atmosphere, not a carousel. */
const HERO_SLIDE_INTERVAL_MS = 12_000
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
function useHeroSlides(count: number): { index: number; running: boolean } {
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
    }, HERO_SLIDE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [count, running])

  return { index: count === 0 ? 0 : index % count, running }
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

/**
 * A played file with no album tag.
 *
 * It uses the album-card shell so the shelf stays one row of covers, but its
 * main action plays the track instead of opening a release that does not
 * exist. The meta line carries the duration, which is what tells it apart from
 * the album cards around it.
 */
function TrackCard({ track, onPlay }: { track: Track; onPlay: (track: Track) => void }) {
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
    <div className="album-card track-card" ref={ref}>
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

/**
 * A playlist imported from a link, on Home.
 *
 * It keeps the playlist-card shell so the shelf stays one row of covers, but
 * shows the list's own cover (or its first video's still) instead of an initial.
 * Opening it lands in Playlists, where the imported pane can play, save or edit
 * it; the YouTube view is not the only doorway any more.
 */
function OnlinePlaylistCard({
  playlist,
  onOpen
}: {
  playlist: OnlinePlaylist
  onOpen: (playlist: OnlinePlaylist) => void
}) {
  const ref = useRef<HTMLButtonElement | null>(null)
  const visible = useNearViewport(ref)
  const art = onlinePlaylistArtworkTrack(playlist)
  const kind = playlist.kind === 'album' ? 'Album' : playlist.kind === 'mix' ? 'Mix' : 'Playlist'
  const meta = [
    `YouTube ${kind.toLowerCase()}`,
    `${formatCount(playlist.trackCount)} ${playlist.trackCount === 1 ? 'track' : 'tracks'}`
  ].join(' · ')

  return (
    <button
      type="button"
      className="playlist-card online-playlist-card"
      ref={ref}
      onClick={() => onOpen(playlist)}
      title={`Open ${playlist.title} in Playlists`}
    >
      <span className="playlist-card-cover">
        <ArtworkImage
          track={visible ? art : null}
          size="100%"
          artworkKey={playlist.coverKey ?? undefined}
          className="album-cover"
        />
      </span>
      <span className="album-card-title" title={playlist.title}>
        {playlist.title}
      </span>
      <span className="album-card-meta" title={meta}>
        {meta}
      </span>
    </button>
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
    onReveal,
    onAddTracksToPlaylist,
    onCreatePlaylist
  } = props

  const albums = useAlbums()
  const [recentAlbums, setRecentAlbums] = useState<AlbumSummary[]>([])
  const [addedSingles, setAddedSingles] = useState<Track[]>([])
  const [playedAlbums, setPlayedAlbums] = useState<AlbumSummary[]>([])
  const [playedSingles, setPlayedSingles] = useState<Track[]>([])
  const [playedStreams, setPlayedStreams] = useState<Track[]>([])
  const [artists, setArtists] = useState<ArtistSummary[]>([])
  const [shelvesLoading, setShelvesLoading] = useState(true)
  const [shelvesError, setShelvesError] = useState<string | null>(null)
  const [busyAlbum, setBusyAlbum] = useState<string | null>(null)
  const [busyArtist, setBusyArtist] = useState<string | null>(null)

  const [openAlbum, setOpenAlbum] = useState<AlbumSummary | null>(null)
  /** An artist opened from the shelf. Albums use the same detail shell. */
  const [openArtist, setOpenArtist] = useState<ArtistSummary | null>(null)
  const [albumTracks, setAlbumTracks] = useState<Track[]>([])
  const [albumLoading, setAlbumLoading] = useState(false)
  const [albumError, setAlbumError] = useState<string | null>(null)
  const [albumSelection, setAlbumSelection] = useState<ReadonlySet<number>>(() => new Set())
  const [albumMenu, setAlbumMenu] = useState<{ track: Track; at: { x: number; y: number } } | null>(null)
  const [albumDetails, setAlbumDetails] = useState<Track | null>(null)

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
      if (token !== shelvesTokenRef.current) return
      setRecentAlbums(recent.albums)
      setAddedSingles(added.tracks)
      setPlayedAlbums(played.albums.filter((album) => album.lastPlayedAt !== null).slice(0, 12))
      setPlayedSingles(singles.tracks)
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
    () => mergePlayedShelf(playedAlbums, playedSingles, playedStreams, 12),
    [playedAlbums, playedSingles, playedStreams]
  )
  const addedShelf = useMemo(
    () => mergeAddedShelf(recentAlbums, addedSingles, 12),
    [addedSingles, recentAlbums]
  )
  useRevealNewest(playedShelfRef, firstShelfKey(playedShelf))
  useRevealNewest(addedShelfRef, firstShelfKey(addedShelf))

  const heroAlbum = playedAlbums[0] ?? recentAlbums[0] ?? null
  const heroFallback = heroAlbum && !heroAlbum.artworkKey ? LOCAL_REQUEST(heroAlbum.trackId) : null
  const heroResolved = useArtwork(null, heroFallback)

  // Recent covers, newest first, without repeating an album that appears in
  // both shelves. The hero falls back to the resolved art of its album when no
  // shelf row has embedded art yet.
  const heroSlides = useMemo(() => {
    const seen = new Set<string>()
    const slides: string[] = []
    for (const album of [...playedAlbums, ...recentAlbums]) {
      if (!album.artworkKey || seen.has(album.artworkKey)) continue
      seen.add(album.artworkKey)
      slides.push(album.artworkKey)
    }
    if (slides.length === 0 && heroResolved) slides.push(heroResolved)
    return slides.slice(0, HERO_SLIDE_LIMIT)
  }, [heroResolved, playedAlbums, recentAlbums])
  const heroSlide = useHeroSlides(heroSlides.length)

  const hasLibrary = (stats?.tracks ?? 0) > 0
  const combinedError = error ?? shelvesError ?? albums.error

  /**
   * The hero's one action follows the last listen, not a fixed album.
   *
   * "Play <latest album>" duplicated the first card of a shelf and never moved
   * when the user played something else. Resuming the newest entry on Recently
   * played is the thing a music home can offer that the cards below cannot: it
   * is the same control as the cards, but named after what the user just heard.
   * With nothing played yet there is no action, because the albums are one
   * glance away and the header already links the library.
   */
  const heroResume = playedShelf[0] ?? null
  const heroResumeLabel = heroResume
    ? heroResume.kind === 'album'
      ? heroResume.album.album
      : heroResume.track.title
    : null

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

  /** Plays whatever the hero names: the newest played album or track. */
  const resumeHero = useCallback((): void => {
    const entry = heroResume
    if (!entry) return
    if (entry.kind === 'album') void playAlbum(entry.album)
    else onPlayTrack(entry.track)
  }, [heroResume, playAlbum, onPlayTrack])

  const filterByArtist = useCallback((artist: ArtistSummary): void => {
    // An artist can own tracks without owning an album card: a single, or a
    // credit on someone else's album. Filtering the grid for them would show an
    // empty page, so those artists open their tracks instead.
    if (artist.albumCount === 0) {
      openArtistDetail(artist)
      return
    }
    albums.setArtist(artist.artist)
    requestAnimationFrame(() => {
      gridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }, [albums, openArtistDetail])

  /**
   * A shelf's **More** turns the album grid below into the full version of that
   * shelf instead of opening a second list: the same albums, sorted the same
   * way, with the paging and search the grid already has. Focus moves to the
   * grid heading so a keyboard user lands where the page just scrolled.
   */
  const showAlbumShelf = useCallback((sort: AlbumSortField): void => {
    albums.setArtist(null)
    albums.setSort(sort)
    requestAnimationFrame(() => {
      gridRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      gridHeadingRef.current?.focus({ preventScroll: true })
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

      <section
        className="home-hero"
        data-slide-state={heroSlide.running ? 'running' : 'still'}
        data-slide-count={heroSlides.length}
      >
        {heroSlides.map((key, index) => (
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
            {!hasLibrary ? (
              <button type="button" className="primary" onClick={onAddFolder}>
                <FolderIcon />
                <span>Add music folder</span>
              </button>
            ) : heroResume && heroResumeLabel ? (
              // Resume names what the user heard last. It only appears once
              // something has been played, so it can never be a stale guess.
              <button
                type="button"
                className="primary"
                onClick={resumeHero}
                disabled={
                  heroResume.kind === 'album' && busyAlbum === albumKeyOf(heroResume.album)
                }
                title={`Resume ${heroResumeLabel}`}
              >
                {heroResume.kind === 'album' && busyAlbum === albumKeyOf(heroResume.album) ? (
                  <SpinnerIcon />
                ) : (
                  <PlayIcon size={16} />
                )}
                <span className="home-hero-action-label">Resume {heroResumeLabel}</span>
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
          {playedShelf.length > 0 ? (
            <Shelf
              title="Recently played"
              icon={<PlayIcon size={15} />}
              scrollRef={playedShelfRef}
              action={
                playedAlbums.length > 0 ? (
                  <button
                    type="button"
                    className="home-more"
                    onClick={() => showAlbumShelf('played')}
                    title="Show every album, most recently played first"
                    aria-label="More recently played albums"
                  >
                    More
                  </button>
                ) : undefined
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
                  />
                ) : (
                  <TrackCard
                    key={shelfEntryKey(entry)}
                    track={entry.track}
                    onPlay={onPlayTrack}
                  />
                )
              )}
            </Shelf>
          ) : null}

          {addedShelf.length > 0 ? (
            <Shelf
              title="Recently added"
              icon={<DiscIcon size={15} />}
              scrollRef={addedShelfRef}
              action={
                recentAlbums.length > 0 ? (
                  <button
                    type="button"
                    className="home-more"
                    onClick={() => showAlbumShelf('recent')}
                    title="Show every album, newest first"
                    aria-label="More recently added albums"
                  >
                    More
                  </button>
                ) : undefined
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
                  />
                ) : (
                  <TrackCard
                    key={shelfEntryKey(entry)}
                    track={entry.track}
                    onPlay={onPlayTrack}
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
                  onFilter={filterByArtist}
                  onPlay={(next) => void playArtist(next)}
                />
              ))}
            </Shelf>
          ) : null}

          {playlists.length + onlinePlaylists.length > 0 ? (
            <Shelf title="Playlists" icon={<PlayIcon size={15} />}>
              {playlists.map((playlist) => (
                <PlaylistCard
                  key={`custom-${playlist.id}`}
                  playlist={playlist}
                  onOpen={(next) => onOpenPlaylist(next.id)}
                />
              ))}
              {onlinePlaylists.map((playlist) => (
                <OnlinePlaylistCard
                  key={`online-${playlist.id}`}
                  playlist={playlist}
                  onOpen={(next) => onOpenOnlinePlaylist(next.id)}
                />
              ))}
            </Shelf>
          ) : null}
        </>
      )}

      <section className="home-section album-grid-section" ref={gridRef} hidden={!hasLibrary}>
        <div className="album-grid-head">
          <div>
            <h2 ref={gridHeadingRef} tabIndex={-1}>
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
                className={albums.sort === 'played' ? 'active' : undefined}
                aria-pressed={albums.sort === 'played'}
                onClick={() => albums.setSort('played')}
              >
                Played
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
