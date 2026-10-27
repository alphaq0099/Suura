import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import type {
  AddTracksOutcome,
  ImportedSearchResult,
  Playlist,
  Track,
  YouTubeChannel,
  YouTubeSearchResult
} from '@shared/types'
import { youtubeWatchUrl } from '@shared/youtube'
import { canPrefetchSearchMatch } from '@shared/search'
import { formatCount, formatDuration } from '@shared/format'
import { api, messageOf } from '../api'
import type { DownloadState, UseDownloadsResult } from '../hooks/useDownloads'
import { AddToPlaylistMenu } from './AddToPlaylistMenu'
import { ArtworkImage } from './ArtworkImage'
import { FieldContextMenu, useFieldContextMenu } from './FieldContextMenu'
import { RowMenu, type RowMenuItem } from './RowMenu'
import { TrackDetails } from './TrackDetails'
import {
  CheckIcon,
  CloseIcon,
  CopyIcon,
  DownloadIcon,
  InfoIcon,
  MoreIcon,
  MusicIcon,
  PlayIcon,
  PlaylistIcon,
  QueueIcon,
  SearchIcon,
  SpinnerIcon
} from './Icons'

/** One item in a multi-row Search action, in the order the rows appear. */
export type SearchSelectionItem =
  | { kind: 'local'; track: Track }
  | { kind: 'imported'; track: Track }
  | { kind: 'youtube'; result: YouTubeSearchResult }

type LocalSearchRow = { kind: 'local'; key: string; track: Track }
type ImportedSearchRow = {
  kind: 'imported'
  key: string
  track: Track
  source: string
}
type YouTubeSearchRow = { kind: 'youtube'; key: string; result: YouTubeSearchResult }
type SearchRow = LocalSearchRow | ImportedSearchRow | YouTubeSearchRow

export interface SearchViewProps {
  /**
   * Keeps the view mounted while another view is active. The search state is
   * deliberately session-only: navigating away and back must not lose results,
   * but a restart should start clean.
   */
  active: boolean
  downloads: UseDownloadsResult
  /** The local track that is on the player, if any. */
  currentTrackId: number | null
  /** The YouTube video that is on the player, if any. */
  currentVideoId: string | null
  isPlaying: boolean
  playlists: Playlist[]
  onAddTracksToPlaylist: (playlistId: number, trackIds: number[]) => Promise<AddTracksOutcome>
  onCreatePlaylist: (name: string) => Promise<Playlist>
  onPlayLocal: (tracks: Track[]) => void
  onQueueLocal: (tracks: Track[]) => void
  /** Adds the result to the history, resolves it, and starts it. */
  onPlayYouTube: (result: YouTubeSearchResult) => Promise<void>
  onQueueYouTube: (result: YouTubeSearchResult) => Promise<void>
  /** Plays every selected row in order, resolving streams as it goes. */
  onPlaySearchSelection: (items: SearchSelectionItem[]) => Promise<void>
  onQueueSearchSelection: (items: SearchSelectionItem[]) => Promise<void>
  /** The same "prefetch the next track" setting the player uses. */
  prefetchEnabled: boolean
}

/**
 * The first YouTube answer is five cards: one best match and four alternatives.
 * A second page of five can be asked for on the shelf, and ten is the ceiling:
 * past the top ten a text match is a guess, not a miss.
 */
const YOUTUBE_PAGE_SIZE = 5
const YOUTUBE_MAX_RESULTS = 10
const CHANNEL_PAGE_SIZE = 10

/**
 * How many rows each local shelf may fetch. The page shows eight and offers
 * Show all, so a live search stays cheap without hiding a reasonable result set.
 */
const LIVE_SEARCH_LIMIT = 30

/** Cards shown per database shelf before Show all. */
const SHELF_CARD_LIMIT = 8

/** How long typing has to pause before the local/imported shelves update. */
const LIVE_SEARCH_DELAY_MS = 180

/**
 * How long the best match waits before it is warmed, and how long Search stays
 * quiet afterwards. A prefetch is a guess: it must never compete with reading
 * the result list or with the next, different query.
 */
const PREFETCH_DELAY_MS = 1800
const PREFETCH_COOLDOWN_MS = 45_000
/** A bot check is not retried for five minutes, matching the sidecar gate. */
const PREFETCH_BLOCKED_MS = 5 * 60_000

/** A track-shaped stub, only so the row can borrow the shared artwork lookup. */
function artworkTrack(result: YouTubeSearchResult): Track {
  return {
    id: 0,
    sourceKind: 'youtube',
    sourceId: result.videoId,
    originKind: null,
    originId: null,
    title: result.title,
    artist: result.artist,
    albumArtist: result.artist,
    album: null,
    trackNo: null,
    discNo: null,
    year: null,
    genre: null,
    durationMs: result.durationMs,
    codec: null,
    bitrateKbps: null,
    sampleRate: null,
    channels: null,
    fileSize: null,
    missingAt: null,
    filePath: null,
    artworkKey: null,
    replayGainDb: null,
    replayGainPeak: null,
    addedAt: 0,
    playCount: 0,
    lastPlayedAt: null
  }
}

function channelNameOf(result: YouTubeSearchResult): string {
  return result.channelName ?? result.artist ?? 'Unknown channel'
}

function selectionItem(row: SearchRow): SearchSelectionItem {
  if (row.kind === 'local') return { kind: 'local', track: row.track }
  if (row.kind === 'imported') return { kind: 'imported', track: row.track }
  return { kind: 'youtube', result: row.result }
}

/**
 * One search for two catalogues.
 *
 * The local library and YouTube are queried together and grouped by source.
 * Choosing a local row plays a file; choosing a YouTube row runs the same
 * add-link path a pasted URL takes, so the history keeps one rule about what a
 * stream is and the user never has to know which side of the app a song lives
 * on. The rows use the same Ctrl/Shift selection and right-click menu as the
 * library, including adding selected tracks to a playlist.
 *
 * A channel is opened from any YouTube row and listed in place, so "more from
 * this channel" does not need a second window or an import.
 */
export function SearchView(props: SearchViewProps) {
  const {
    active,
    downloads,
    currentTrackId,
    currentVideoId,
    isPlaying,
    playlists,
    onAddTracksToPlaylist,
    onCreatePlaylist,
    onPlayLocal,
    onQueueLocal,
    onPlayYouTube,
    onQueueYouTube,
    onPlaySearchSelection,
    onQueueSearchSelection,
    prefetchEnabled
  } = props
  const { saved, states, save } = downloads

  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [local, setLocal] = useState<Track[]>([])
  const [imported, setImported] = useState<ImportedSearchResult[]>([])
  const [youtube, setYoutube] = useState<YouTubeSearchResult[]>([])
  const [liveLoading, setLiveLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [youtubeError, setYoutubeError] = useState<string | null>(null)
  const [youtubeHasMore, setYoutubeHasMore] = useState(false)
  const [youtubeMoreBusy, setYoutubeMoreBusy] = useState(false)
  const [busyVideoId, setBusyVideoId] = useState<string | null>(null)
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkSaving, setBulkSaving] = useState(false)
  const [showAllLocal, setShowAllLocal] = useState(false)
  const [showAllImported, setShowAllImported] = useState(false)
  const [channel, setChannel] = useState<YouTubeChannel | null>(null)
  const [channelTarget, setChannelTarget] = useState<string | null>(null)
  const [channelPage, setChannelPage] = useState(1)
  const [channelHasMore, setChannelHasMore] = useState(false)
  const [channelLoading, setChannelLoading] = useState(false)
  const [channelPageLoading, setChannelPageLoading] = useState(false)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set())
  const [detailsTrack, setDetailsTrack] = useState<Track | null>(null)
  const [rowMenu, setRowMenu] = useState<{
    row: SearchRow
    index: number
    at: { x: number; y: number }
  } | null>(null)
  const [playlistMenu, setPlaylistMenu] = useState<{
    at: { x: number; y: number }
    trackIds: number[]
    heading: string
  } | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const anchorKeyRef = useRef<string | null>(null)
  /** The newest live-search request; older answers are ignored. */
  const liveTokenRef = useRef(0)
  /** The newest YouTube request; a query edit invalidates paging too. */
  const youtubeTokenRef = useRef(0)
  /** Bumped whenever the query or an activation makes a warm-up stale. */
  const prefetchEpochRef = useRef(0)
  const prefetchInFlightRef = useRef(false)
  const prefetchLastAtRef = useRef<number | null>(null)
  const prefetchBlockedUntilRef = useRef(0)
  /** The shelves as they are *now*, for a timer set a moment earlier. */
  const prefetchShelfRef = useRef({ local: 0, imported: 0, query: '', submitted: '' })
  const fieldMenu = useFieldContextMenu(inputRef)

  const localRows = useMemo<LocalSearchRow[]>(
    () => local.map((track) => ({ kind: 'local', key: `local:${track.id}`, track })),
    [local]
  )
  const importedRows = useMemo<ImportedSearchRow[]>(
    () =>
      imported.map((match) => ({
        kind: 'imported',
        key: `imported:${match.track.id}`,
        track: match.track,
        source: match.source
      })),
    [imported]
  )
  const youtubeRows = useMemo<YouTubeSearchRow[]>(
    () => youtube.map((result) => ({ kind: 'youtube', key: `youtube:${result.videoId}`, result })),
    [youtube]
  )
  const channelRows = useMemo<YouTubeSearchRow[]>(
    () =>
      (channel?.entries ?? []).map((result) => ({
        kind: 'youtube',
        key: `youtube:${result.videoId}`,
        result
      })),
    [channel]
  )
  const resultRows = useMemo<SearchRow[]>(
    () => [...localRows, ...importedRows, ...youtubeRows],
    [localRows, importedRows, youtubeRows]
  )
  const activeRows = channel ? channelRows : resultRows
  const activeRowsKey = activeRows.map((row) => row.key).join('|')
  const selectedRows = useMemo(
    () => activeRows.filter((row) => selectedKeys.has(row.key)),
    [activeRows, selectedKeys]
  )
  const selecting = selectedRows.length > 0
  const allSelected = activeRows.length > 0 && activeRows.every((row) => selectedKeys.has(row.key))
  const selectedYouTube = selectedRows.filter(
    (row): row is YouTubeSearchRow => row.kind === 'youtube'
  )
  const unsavedSelected = selectedYouTube.filter((row) => !saved.has(row.result.videoId))
  const selectedPlaylistIds = useMemo(() => {
    const ids = new Set<number>()
    for (const row of selectedRows) {
      if (row.kind === 'local') {
        ids.add(row.track.id)
        continue
      }
      // An imported row has no library row until it is downloaded, so there is
      // nothing a custom playlist could point at yet.
      if (row.kind === 'imported') continue
      const trackId = states[row.result.videoId]?.trackId
      if (trackId == null) return null
      ids.add(trackId)
    }
    return ids.size > 0 ? [...ids] : null
  }, [selectedRows, states])

  useEffect(() => {
    setSelectedKeys(new Set())
    anchorKeyRef.current = null
    setRowMenu(null)
    setPlaylistMenu(null)
  }, [activeRowsKey])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 1800)
    return () => clearTimeout(timer)
  }, [notice])

  /**
   * Live local search. Typing never calls YouTube: the two database catalogues
   * are cheap enough to filter as the query settles, while the network search
   * stays behind the explicit button. A query edit also drops the old YouTube
   * answer, so results can never sit under a query they were not asked for.
   */
  useEffect(() => {
    const text = query.trim()
    liveTokenRef.current += 1
    youtubeTokenRef.current += 1
    const token = liveTokenRef.current
    prefetchEpochRef.current += 1
    setSubmitted('')
    setYoutube([])
    setYoutubeError(null)
    setYoutubeHasMore(false)
    setYoutubeMoreBusy(false)
    setLocal([])
    setImported([])
    setShowAllLocal(false)
    setShowAllImported(false)
    setError(null)
    // A request from the previous query can no longer clear these itself: its
    // token is stale, so its `finally` bails out. Clearing them here is what
    // keeps the field usable after typing during a slow search.
    setLoading(false)
    if (text.length === 0) {
      setLiveLoading(false)
      return
    }

    setLiveLoading(true)
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await api.searchLibrary(text, LIVE_SEARCH_LIMIT)
          if (token !== liveTokenRef.current) return
          setLocal(result.local)
          setImported(result.imported)
        } catch (cause) {
          if (token !== liveTokenRef.current) return
          setLocal([])
          setImported([])
          setError(messageOf(cause))
        } finally {
          if (token === liveTokenRef.current) setLiveLoading(false)
        }
      })()
    }, LIVE_SEARCH_DELAY_MS)

    return () => clearTimeout(timer)
  }, [query])

  // A timer set below fires later, when the live search may already have found
  // something. Keep the newest shelf counts where the timer can read them.
  useEffect(() => {
    prefetchShelfRef.current = {
      local: local.length,
      imported: imported.length,
      query,
      submitted
    }
  })

  /**
   * Warms the best match only when it is the last hope for this query.
   *
   * With nothing on the device or in the imported lists, a YouTube match is
   * what the user is about to play, and resolving it now makes that play feel
   * instant. The timer and the cooldown keep the guess from spending resolves
   * on queries the user is still reading or typing.
   */
  useEffect(() => {
    const best = youtube[0] ?? null
    if (
      !best ||
      !canPrefetchSearchMatch({
        enabled: prefetchEnabled,
        submitted: submitted.length > 0,
        localCount: local.length,
        importedCount: imported.length,
        bestVideoId: best.videoId,
        inFlight: prefetchInFlightRef.current,
        now: Date.now(),
        lastAttemptAt: prefetchLastAtRef.current,
        blockedUntil: prefetchBlockedUntilRef.current,
        cooldownMs: PREFETCH_COOLDOWN_MS
      })
    ) {
      return
    }

    const epoch = prefetchEpochRef.current
    const timer = window.setTimeout(() => {
      const shelves = prefetchShelfRef.current
      const now = Date.now()
      if (
        epoch !== prefetchEpochRef.current ||
        shelves.query.trim() !== shelves.submitted ||
        !canPrefetchSearchMatch({
          enabled: prefetchEnabled,
          submitted: shelves.submitted.length > 0,
          localCount: shelves.local,
          importedCount: shelves.imported,
          bestVideoId: best.videoId,
          inFlight: prefetchInFlightRef.current,
          now,
          lastAttemptAt: prefetchLastAtRef.current,
          blockedUntil: prefetchBlockedUntilRef.current,
          cooldownMs: PREFETCH_COOLDOWN_MS
        })
      ) {
        return
      }

      prefetchInFlightRef.current = true
      prefetchLastAtRef.current = now
      void api
        .prefetchSource({
          id: 0,
          sourceKind: 'youtube',
          sourceId: best.videoId,
          filePath: null
        })
        .catch((cause) => {
          // A bot check or sign-in challenge is not retried: the next guess
          // would only make it more likely, so this pauses with the engine.
          if (/bot|sign-in check|verify|rate limit|paused for about/i.test(messageOf(cause))) {
            prefetchBlockedUntilRef.current = Date.now() + PREFETCH_BLOCKED_MS
          }
        })
        .finally(() => {
          prefetchInFlightRef.current = false
        })
    }, PREFETCH_DELAY_MS)

    return () => window.clearTimeout(timer)
  }, [prefetchEnabled, youtube, local.length, imported.length, submitted, query])

  const pasteQuery = useCallback(async (): Promise<void> => {
    try {
      const text = (await api.readClipboardText()).trim()
      if (text.length > 0) setQuery(text)
    } catch {
      // The clipboard is best-effort; a denied read should not interrupt search.
    } finally {
      inputRef.current?.focus()
    }
  }, [])

  const copyQuery = useCallback(async (): Promise<void> => {
    try {
      await api.writeClipboardText(query)
    } catch {
      // As above: Copy failing is not worth a page-level error banner.
    }
    inputRef.current?.focus()
  }, [query])

  const clearQuery = useCallback((): void => {
    setQuery('')
    inputRef.current?.focus()
  }, [])

  const loadChannel = useCallback(
    async (target: string, name: string, page: number, opening: boolean): Promise<void> => {
      if (opening) setChannelLoading(true)
      else setChannelPageLoading(true)
      setError(null)
      try {
        const info = await api.getYouTubeChannel(
          target,
          CHANNEL_PAGE_SIZE,
          (page - 1) * CHANNEL_PAGE_SIZE
        )
        if (info.entries.length === 0) {
          // End of the channel, not a failure: stay on the page that is shown.
          setChannelHasMore(false)
          return
        }
        setChannel(info)
        setChannelPage(page)
        setChannelHasMore(info.entries.length === CHANNEL_PAGE_SIZE)
      } catch (cause) {
        setError(
          opening
            ? `Could not open ${name}: ${messageOf(cause)}`
            : `Could not load more from ${name}: ${messageOf(cause)}`
        )
      } finally {
        if (opening) setChannelLoading(false)
        else setChannelPageLoading(false)
      }
    },
    []
  )

  const openChannel = useCallback(
    async (target: string, name: string): Promise<void> => {
      setChannelTarget(target)
      setChannelPage(1)
      setChannelHasMore(false)
      setNotice(null)
      await loadChannel(target, name, 1, true)
    },
    [loadChannel]
  )

  const goToChannelPage = useCallback(
    async (page: number): Promise<void> => {
      if (!channelTarget || page < 1 || page === channelPage) return
      await loadChannel(channelTarget, channel?.name ?? 'this channel', page, false)
    },
    [channel?.name, channelPage, channelTarget, loadChannel]
  )

  const closeChannel = useCallback((): void => {
    setChannel(null)
    setChannelTarget(null)
    setChannelPage(1)
    setChannelHasMore(false)
    setError(null)
  }, [])

  const run = useCallback(async (): Promise<void> => {
    const text = query.trim()
    if (text.length === 0) return
    setLoading(true)
    setError(null)
    setNotice(null)
    setYoutubeError(null)
    setChannel(null)
    setChannelTarget(null)
    setChannelPage(1)
    setChannelHasMore(false)
    setSubmitted(text)
    setYoutube([])
    setYoutubeHasMore(false)
    setYoutubeMoreBusy(false)
    // A new question makes any warm-up for the old one pointless.
    prefetchEpochRef.current += 1

    youtubeTokenRef.current += 1
    const token = youtubeTokenRef.current
    try {
      const results = await api.searchYouTube(text, YOUTUBE_PAGE_SIZE, 0)
      // A newer query owns the shelf now; its own request will fill it.
      if (token !== youtubeTokenRef.current) return
      // The first answer is one best match and four alternatives. The provider
      // is asked for exactly that many, and a provider that ignores the limit
      // must not grow the shelf or displace the empty-CTA layout.
      setYoutube(results.slice(0, YOUTUBE_PAGE_SIZE))
      setYoutubeHasMore(results.length === YOUTUBE_PAGE_SIZE)
    } catch (cause) {
      if (token !== youtubeTokenRef.current) return
      setYoutube([])
      setYoutubeHasMore(false)
      setYoutubeError(messageOf(cause))
    } finally {
      if (token === youtubeTokenRef.current) setLoading(false)
    }
  }, [query])

  /**
   * Fetches the one extra page the YouTube shelf offers.
   *
   * The first five fill the shelf; a song the user cannot find among them is
   * often just below, but past ten a text match stops being a near miss. New
   * rows are appended, never replace the best match, and a query edit bumps the
   * token so a slow second page cannot land under a different search.
   */
  const loadMoreYouTube = useCallback(async (): Promise<void> => {
    const text = submitted
    if (
      text.length === 0 ||
      loading ||
      youtubeMoreBusy ||
      youtube.length === 0 ||
      youtube.length >= YOUTUBE_MAX_RESULTS ||
      !youtubeHasMore
    ) {
      return
    }
    setYoutubeMoreBusy(true)
    setError(null)
    const token = youtubeTokenRef.current
    try {
      const results = await api.searchYouTube(text, YOUTUBE_PAGE_SIZE, youtube.length)
      if (token !== youtubeTokenRef.current) return
      setYoutube((current) => {
        const seen = new Set(current.map((row) => row.videoId))
        const next = [...current, ...results.filter((row) => !seen.has(row.videoId))]
        return next.slice(0, YOUTUBE_MAX_RESULTS)
      })
      setYoutubeHasMore(results.length === YOUTUBE_PAGE_SIZE)
    } catch (cause) {
      if (token === youtubeTokenRef.current) setError(messageOf(cause))
    } finally {
      if (token === youtubeTokenRef.current) setYoutubeMoreBusy(false)
    }
  }, [loading, submitted, youtube.length, youtubeHasMore, youtubeMoreBusy])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void run()
  }

  const playYouTube = useCallback(
    async (result: YouTubeSearchResult): Promise<void> => {
      setBusyVideoId(result.videoId)
      setError(null)
      try {
        await onPlayYouTube(result)
      } catch (cause) {
        setError(messageOf(cause))
      } finally {
        setBusyVideoId(null)
      }
    },
    [onPlayYouTube]
  )

  const queueYouTube = useCallback(
    async (result: YouTubeSearchResult): Promise<void> => {
      setBusyVideoId(result.videoId)
      setError(null)
      try {
        await onQueueYouTube(result)
      } catch (cause) {
        setError(messageOf(cause))
      } finally {
        setBusyVideoId(null)
      }
    },
    [onQueueYouTube]
  )

  const saveYouTubeResults = useCallback(
    async (results: YouTubeSearchResult[]): Promise<void> => {
      const pending = results.filter((result) => !saved.has(result.videoId))
      if (pending.length === 0) return
      setError(null)
      for (const result of pending) {
        try {
          await save({ videoId: result.videoId, title: result.title, artist: result.artist, album: null })
        } catch (cause) {
          setError(messageOf(cause))
          return
        }
      }
    },
    [save, saved]
  )

  const copyLink = useCallback(async (result: YouTubeSearchResult): Promise<void> => {
    try {
      await api.writeClipboardText(youtubeWatchUrl(result.videoId))
      setNotice('Link copied.')
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [])

  const playImported = useCallback(
    async (track: Track): Promise<void> => {
      setBulkBusy(true)
      setError(null)
      try {
        await onPlaySearchSelection([{ kind: 'imported', track }])
      } catch (cause) {
        setError(messageOf(cause))
      } finally {
        setBulkBusy(false)
      }
    },
    [onPlaySearchSelection]
  )

  const queueImported = useCallback(
    async (track: Track): Promise<void> => {
      setError(null)
      try {
        await onQueueSearchSelection([{ kind: 'imported', track }])
      } catch (cause) {
        setError(messageOf(cause))
      }
    },
    [onQueueSearchSelection]
  )

  const activateRow = useCallback(
    (row: SearchRow): void => {
      // Acting on this page ends the guess: a pending warm-up must not spend a
      // resolve for a result the user is no longer considering.
      prefetchEpochRef.current += 1
      if (row.kind === 'local') {
        onPlayLocal([row.track])
        return
      }
      if (row.kind === 'imported') {
        if (bulkBusy) return
        void playImported(row.track)
        return
      }
      if (busyVideoId === row.result.videoId) return
      void playYouTube(row.result)
    },
    [bulkBusy, busyVideoId, onPlayLocal, playImported, playYouTube]
  )

  const toggleRow = useCallback((row: SearchRow, additive: boolean): void => {
    setSelectedKeys((current) => {
      const next = additive ? new Set(current) : new Set<string>()
      if (next.has(row.key)) next.delete(row.key)
      else next.add(row.key)
      return next
    })
    anchorKeyRef.current = row.key
  }, [])

  const selectRange = useCallback(
    (row: SearchRow, index: number): void => {
      const anchorKey = anchorKeyRef.current
      const anchorIndex = anchorKey ? activeRows.findIndex((candidate) => candidate.key === anchorKey) : -1
      const from = anchorIndex >= 0 ? anchorIndex : index
      const start = Math.min(from, index)
      const end = Math.max(from, index)
      setSelectedKeys(new Set(activeRows.slice(start, end + 1).map((candidate) => candidate.key)))
      anchorKeyRef.current = anchorKey ?? row.key
    },
    [activeRows]
  )

  const onRowClick = useCallback(
    (event: ReactMouseEvent<HTMLLIElement>, row: SearchRow, index: number): void => {
      if (event.shiftKey) {
        event.preventDefault()
        selectRange(row, index)
        return
      }
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        toggleRow(row, true)
        return
      }
      activateRow(row)
    },
    [activateRow, selectRange, toggleRow]
  )

  const onRowKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLLIElement>, row: SearchRow, index: number): void => {
      if (event.target !== event.currentTarget) return
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        activateRow(row)
        return
      }
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault()
        const rect = event.currentTarget.getBoundingClientRect()
        setRowMenu({ row, index, at: { x: rect.left + 24, y: rect.top + 24 } })
        return
      }
      if (event.key === 'Escape' && selecting) {
        setSelectedKeys(new Set())
        anchorKeyRef.current = null
      }
    },
    [activateRow, selecting]
  )

  const openRowMenuAt = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>, row: SearchRow, index: number): void => {
      event.stopPropagation()
      const rect = event.currentTarget.getBoundingClientRect()
      setRowMenu({ row, index, at: { x: rect.right - 8, y: rect.bottom + 4 } })
    },
    []
  )

  const openContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLLIElement>, row: SearchRow, index: number): void => {
      event.preventDefault()
      setRowMenu({ row, index, at: { x: event.clientX, y: event.clientY } })
    },
    []
  )

  const openPlaylistMenu = useCallback(
    (at: { x: number; y: number }, trackIds: number[], heading: string): void => {
      setPlaylistMenu({ at, trackIds, heading })
    },
    []
  )

  const playRows = useCallback(
    async (rows: SearchRow[]): Promise<void> => {
      if (rows.length === 0) return
      setBulkBusy(true)
      setError(null)
      try {
        await onPlaySearchSelection(rows.map(selectionItem))
      } catch (cause) {
        setError(messageOf(cause))
      } finally {
        setBulkBusy(false)
      }
    },
    [onPlaySearchSelection]
  )

  const queueRows = useCallback(
    async (rows: SearchRow[]): Promise<void> => {
      if (rows.length === 0) return
      setBulkBusy(true)
      setError(null)
      try {
        await onQueueSearchSelection(rows.map(selectionItem))
      } catch (cause) {
        setError(messageOf(cause))
      } finally {
        setBulkBusy(false)
      }
    },
    [onQueueSearchSelection]
  )

  const playSelected = useCallback((): void => {
    void playRows(selectedRows)
  }, [playRows, selectedRows])

  const queueSelected = useCallback((): void => {
    void queueRows(selectedRows)
  }, [queueRows, selectedRows])

  const saveSelected = useCallback(async (): Promise<void> => {
    if (unsavedSelected.length === 0) return
    setBulkBusy(true)
    setBulkSaving(true)
    try {
      await saveYouTubeResults(unsavedSelected.map((row) => row.result))
    } finally {
      setBulkSaving(false)
      setBulkBusy(false)
    }
  }, [saveYouTubeResults, unsavedSelected])

  const typed = query.trim()
  const showYoutubeCta = typed.length > 0 && submitted.length === 0 && !loading
  const visibleLocal = showAllLocal ? localRows : localRows.slice(0, SHELF_CARD_LIMIT)
  const visibleImported = showAllImported ? importedRows : importedRows.slice(0, SHELF_CARD_LIMIT)

  const selectionBar = selecting ? (
    <div className="banner selection-bar discover-selection-bar">
      <span>
        <strong>{formatCount(selectedRows.length)}</strong> selected
      </span>
      <button type="button" onClick={playSelected} disabled={bulkBusy}>
        <PlayIcon size={14} />
        <span>Play selected</span>
      </button>
      <button type="button" onClick={queueSelected} disabled={bulkBusy}>
        <QueueIcon size={14} />
        <span>Add to queue</span>
      </button>
      {unsavedSelected.length > 0 ? (
        <button type="button" onClick={() => void saveSelected()} disabled={bulkBusy}>
          <DownloadIcon size={14} />
          <span>{bulkSaving ? 'Saving…' : 'Save to library'}</span>
        </button>
      ) : null}
      {selectedPlaylistIds ? (
        <button
          type="button"
          disabled={bulkBusy}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            openPlaylistMenu(
              { x: rect.left, y: rect.bottom + 4 },
              selectedPlaylistIds,
              `${formatCount(selectedRows.length)} selected`
            )
          }}
        >
          <PlaylistIcon size={14} />
          <span>Add to playlist</span>
        </button>
      ) : null}
      <button type="button" onClick={() => setSelectedKeys(new Set(activeRows.map((row) => row.key)))} disabled={allSelected || bulkBusy}>
        Select all
      </button>
      <button
        type="button"
        className="selection-clear"
        onClick={() => {
          setSelectedKeys(new Set())
          anchorKeyRef.current = null
        }}
      >
        Clear
      </button>
    </div>
  ) : null

  const rowMenuRow = rowMenu?.row ?? null
  const rowMenuIsSelected = rowMenuRow ? selectedKeys.has(rowMenuRow.key) : false
  const rowMenuRows = rowMenuRow ? (rowMenuIsSelected ? selectedRows : [rowMenuRow]) : []
  const rowMenuYouTube = rowMenuRows.filter(
    (row): row is YouTubeSearchRow => row.kind === 'youtube'
  )
  const rowMenuPlaylistIds = useMemo(() => {
    const ids = new Set<number>()
    for (const row of rowMenuRows) {
      if (row.kind === 'local') {
        ids.add(row.track.id)
        continue
      }
      if (row.kind === 'imported') continue
      const trackId = states[row.result.videoId]?.trackId
      if (trackId == null) return null
      ids.add(trackId)
    }
    return ids.size > 0 ? [...ids] : null
  }, [rowMenuRows, states])
  const rowMenuItems: RowMenuItem[] = []

  if (rowMenuRow) {
    const rowTitle =
      rowMenuRow.kind === 'youtube' ? rowMenuRow.result.title : rowMenuRow.track.title
    rowMenuItems.push({
      id: 'select',
      label: rowMenuIsSelected ? 'Deselect' : 'Select',
      icon: <CheckIcon />,
      onSelect: () => toggleRow(rowMenuRow, true)
    })
    rowMenuItems.push({
      id: 'play',
      label: 'Play',
      icon: <PlayIcon />,
      onSelect: () => {
        if (rowMenuRow.kind === 'local') onPlayLocal([rowMenuRow.track])
        else if (rowMenuRow.kind === 'imported') void playImported(rowMenuRow.track)
        else void playYouTube(rowMenuRow.result)
      }
    })
    // The card has no room for a queue button of its own, so the action lives
    // beside Play here, where the row menu already handles every source.
    rowMenuItems.push({
      id: 'queue',
      label: 'Add to queue',
      icon: <QueueIcon />,
      onSelect: () => {
        if (rowMenuRow.kind === 'local') onQueueLocal([rowMenuRow.track])
        else if (rowMenuRow.kind === 'imported') void queueImported(rowMenuRow.track)
        else void queueYouTube(rowMenuRow.result)
      }
    })
    if (rowMenuIsSelected && rowMenuRows.length > 0) {
      rowMenuItems.push({
        id: 'play-selected',
        label: `Play selected (${formatCount(rowMenuRows.length)})`,
        icon: <PlayIcon />,
        onSelect: () => void playRows(rowMenuRows)
      })
      rowMenuItems.push({
        id: 'queue-selected',
        label: `Queue selected (${formatCount(rowMenuRows.length)})`,
        icon: <QueueIcon />,
        onSelect: () => void queueRows(rowMenuRows)
      })
    }
    if (rowMenuYouTube.length > 0) {
      const pending = rowMenuYouTube.filter((row) => !saved.has(row.result.videoId))
      if (pending.length > 0) {
        rowMenuItems.push({
          id: 'save',
          label: pending.length === 1 ? 'Save to library' : `Save ${formatCount(pending.length)} to library`,
          icon: <DownloadIcon />,
          onSelect: () => void saveYouTubeResults(pending.map((row) => row.result))
        })
      }
    }
    if (rowMenuPlaylistIds) {
      rowMenuItems.push({
        id: 'playlist',
        label: 'Add to playlist…',
        icon: <PlaylistIcon />,
        onSelect: () => {
          if (!rowMenu) return
          openPlaylistMenu(
            rowMenu.at,
            rowMenuPlaylistIds,
            rowMenuRows.length === 1 ? rowTitle : `${formatCount(rowMenuRows.length)} selected`
          )
        }
      })
    }
    rowMenuItems.push({
      id: 'details',
      label: 'Details',
      icon: <InfoIcon />,
      onSelect: () =>
        setDetailsTrack(
          rowMenuRow.kind === 'youtube' ? artworkTrack(rowMenuRow.result) : rowMenuRow.track
        )
    })
    if (rowMenuRow.kind === 'youtube') {
      if (rowMenuRow.result.channelId || rowMenuRow.result.channelName) {
        rowMenuItems.push({
          id: 'channel',
          label: 'Go to channel',
          icon: <MusicIcon />,
          onSelect: () =>
            void openChannel(
              rowMenuRow.result.channelId ?? rowMenuRow.result.channelName ?? rowMenuRow.result.videoId,
              channelNameOf(rowMenuRow.result)
            )
        })
      }
      rowMenuItems.push({
        id: 'copy-link',
        label: 'Copy link',
        icon: <CopyIcon />,
        onSelect: () => void copyLink(rowMenuRow.result)
      })
    }
    if (!allSelected) {
      rowMenuItems.push({
        id: 'select-all',
        label: 'Select all results',
        icon: <CheckIcon />,
        onSelect: () => {
          setSelectedKeys(new Set(activeRows.map((row) => row.key)))
          anchorKeyRef.current = rowMenuRow.key
        }
      })
    }
    if (selecting) {
      rowMenuItems.push({
        id: 'clear-selection',
        label: 'Clear selection',
        icon: <CloseIcon />,
        onSelect: () => {
          setSelectedKeys(new Set())
          anchorKeyRef.current = null
        }
      })
    }
  }

  return (
    <section className="main-view discover-view" hidden={!active}>
      <header className="view-header">
        <div className="view-heading">
          <h1>{channel ? channel.name : 'Search'}</h1>
          <p className="subtitle">
            {channel
              ? 'Recent videos from this channel. Nothing is downloaded until you ask.'
              : 'Search this device and imported tracks as you type; YouTube is searched when you ask.'}
          </p>
        </div>
        {channel ? (
          <div className="header-actions">
            <button type="button" className="link-button" onClick={closeChannel}>
              <CloseIcon />
              <span>Back to results</span>
            </button>
          </div>
        ) : null}
      </header>

      {channel ? (
        <>
          {channelLoading ? <div className="banner">Loading the channel…</div> : null}
          {error ? <div className="banner error">{error}</div> : null}
          {notice ? <div className="banner">{notice}</div> : null}
          {channel.entries.length === 0 ? (
            <div className="empty-state">
              <MusicIcon size={32} />
              <h2>No videos in this channel</h2>
              <p>YouTube returned no public videos that this app can list.</p>
            </div>
          ) : (
            <div className="discover-results">
              {selectionBar}
              <div className="discover-list discover-shelves">
                <section className="discover-shelf" aria-label={`${channel.name} videos`}>
                  <div className="discover-shelf-head">
                    <span className="source-badge youtube">YouTube</span>
                    <span className="discover-shelf-note">Recent videos from this channel</span>
                    <span className="discover-count">{formatCount(channelRows.length)}</span>
                  </div>
                  <ul className="discover-grid">
                    {channelRows.map((row, index) => (
                      <DiscoverRow
                        key={row.key}
                        row={row}
                        selected={selectedKeys.has(row.key)}
                        selecting={selecting}
                        busy={busyVideoId === row.result.videoId}
                        isSaved={saved.has(row.result.videoId)}
                        savingState={states[row.result.videoId]}
                        isCurrent={row.result.videoId === currentVideoId}
                        isPlaying={isPlaying}
                        onClick={(event) => onRowClick(event, row, index)}
                        onContextMenu={(event) => openContextMenu(event, row, index)}
                        onKeyDown={(event) => onRowKeyDown(event, row, index)}
                        onToggleSelected={() => toggleRow(row, true)}
                        onMore={(event) => openRowMenuAt(event, row, index)}
                        onChannel={null}
                      />
                    ))}
                  </ul>
                </section>
              </div>
              {channelPage > 1 || channelHasMore ? (
                <ResultPager
                  page={channelPage}
                  hasMore={channelHasMore}
                  loading={channelPageLoading}
                  noun="channel videos"
                  onPage={(page) => void goToChannelPage(page)}
                />
              ) : null}
            </div>
          )}
        </>
      ) : (
        <>
          <form className="discover-bar" onSubmit={submit}>
            <div className="discover-input" onContextMenu={fieldMenu.open}>
              <SearchIcon />
              <input
                ref={inputRef}
                type="search"
                autoComplete="off"
                spellCheck={false}
                placeholder="Search your device, imported tracks and YouTube"
                aria-label="Search your device, imported tracks and YouTube"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={fieldMenu.onKeyDown}
                disabled={loading || channelLoading}
              />
            </div>
            <button
              type="submit"
              className="primary"
              disabled={loading || channelLoading || query.trim().length === 0}
            >
              {loading ? <SpinnerIcon /> : <SearchIcon />}
              <span>{loading ? 'Searching YouTube…' : 'Search YouTube'}</span>
            </button>
          </form>

          {loading ? <div className="banner">Searching YouTube…</div> : null}
          {channelLoading ? <div className="banner">Opening the channel…</div> : null}
          {error ? <div className="banner error">{error}</div> : null}
          {notice ? <div className="banner">{notice}</div> : null}
          {youtubeError ? (
            <div className="banner">
              YouTube search is unavailable right now: {youtubeError} Your device and imported
              results are still shown.
            </div>
          ) : null}

          {typed.length === 0 ? (
            <div className="empty-state">
              <SearchIcon size={32} />
              <h2>Find something to play</h2>
              <p>
                Search by song, artist, album or channel. Files play from disk; imported and
                YouTube tracks stream, and YouTube is only searched when you ask.
              </p>
            </div>
          ) : (
            <>
              <div className="discover-summary">
                <span>
                  Results for <strong>“{typed}”</strong>
                  {liveLoading ? <span className="discover-live"> · searching this device…</span> : null}
                </span>
              </div>
              <div className="discover-results">
                {selectionBar}
                <div className="discover-list discover-shelves" aria-label="Search results">
                  <section className="discover-shelf" aria-label="On this device">
                    <div className="discover-shelf-head">
                      <span className="source-badge local">On this device</span>
                      <span className="discover-shelf-note">Files in your library</span>
                      <span className="discover-count">{formatCount(local.length)}</span>
                    </div>
                    {visibleLocal.length > 0 ? (
                      <ul className="discover-grid">
                        {visibleLocal.map((row, index) => {
                          const isCurrent = row.track.id === currentTrackId
                          return (
                            <DiscoverRow
                              key={row.key}
                              row={row}
                              selected={selectedKeys.has(row.key)}
                              selecting={selecting}
                              busy={false}
                              isSaved
                              savingState={undefined}
                              isCurrent={isCurrent}
                              isPlaying={isPlaying}
                              onClick={(event) => onRowClick(event, row, index)}
                              onContextMenu={(event) => openContextMenu(event, row, index)}
                              onKeyDown={(event) => onRowKeyDown(event, row, index)}
                              onToggleSelected={() => toggleRow(row, true)}
                              onMore={(event) => openRowMenuAt(event, row, index)}
                              onChannel={null}
                            />
                          )
                        })}
                      </ul>
                    ) : (
                      <p className="discover-empty-shelf">
                        {liveLoading ? 'Searching this device…' : 'No files on this device matched.'}
                      </p>
                    )}
                    {local.length > SHELF_CARD_LIMIT ? (
                      <button
                        type="button"
                        className="discover-show-all"
                        onClick={() => setShowAllLocal((current) => !current)}
                      >
                        {showAllLocal ? 'Show fewer' : `Show all ${formatCount(local.length)}`}
                      </button>
                    ) : null}
                  </section>

                  <section className="discover-shelf" aria-label="Imported">
                    <div className="discover-shelf-head">
                      <span className="source-badge imported">Imported</span>
                      <span className="discover-shelf-note">Remembered YouTube tracks, not downloaded</span>
                      <span className="discover-count">{formatCount(imported.length)}</span>
                    </div>
                    {visibleImported.length > 0 ? (
                      <ul className="discover-grid">
                        {visibleImported.map((row, index) => (
                          <DiscoverRow
                            key={row.key}
                            row={row}
                            selected={selectedKeys.has(row.key)}
                            selecting={selecting}
                            busy={false}
                            isSaved={false}
                            savingState={undefined}
                            isCurrent={false}
                            isPlaying={isPlaying}
                            onClick={(event) => onRowClick(event, row, localRows.length + index)}
                            onContextMenu={(event) =>
                              openContextMenu(event, row, localRows.length + index)
                            }
                            onKeyDown={(event) => onRowKeyDown(event, row, localRows.length + index)}
                            onToggleSelected={() => toggleRow(row, true)}
                            onMore={(event) => openRowMenuAt(event, row, localRows.length + index)}
                            onChannel={null}
                          />
                        ))}
                      </ul>
                    ) : (
                      <p className="discover-empty-shelf">
                        {liveLoading ? 'Searching imported tracks…' : 'No imported tracks matched.'}
                      </p>
                    )}
                    {imported.length > SHELF_CARD_LIMIT ? (
                      <button
                        type="button"
                        className="discover-show-all"
                        onClick={() => setShowAllImported((current) => !current)}
                      >
                        {showAllImported ? 'Show fewer' : `Show all ${formatCount(imported.length)}`}
                      </button>
                    ) : null}
                  </section>

                  <section className="discover-shelf" aria-label="YouTube">
                    <div className="discover-shelf-head">
                      <span className="source-badge youtube">YouTube</span>
                      <span className="discover-shelf-note">
                        {submitted.length === 0
                          ? 'Not searched yet'
                          : youtube.length > 1
                            ? `Best match and ${formatCount(youtube.length - 1)} more`
                            : 'Best match'}
                      </span>
                      <span className="discover-count">{formatCount(youtube.length)}</span>
                    </div>
                    {showYoutubeCta ? (
                      <button
                        type="button"
                        className="search-youtube-cta"
                        onClick={() => void run()}
                        disabled={loading}
                      >
                        <SearchIcon size={16} />
                        <span>
                          Search YouTube for <strong>“{typed}”</strong>
                        </span>
                      </button>
                    ) : null}
                    {loading ? <p className="discover-empty-shelf">Searching YouTube…</p> : null}
                    {youtube.length > 0 ? (
                      <ul className="discover-grid">
                        {youtubeRows.map((row, index) => (
                          <DiscoverRow
                            key={row.key}
                            row={row}
                            selected={selectedKeys.has(row.key)}
                            selecting={selecting}
                            busy={busyVideoId === row.result.videoId}
                            isSaved={saved.has(row.result.videoId)}
                            savingState={states[row.result.videoId]}
                            isCurrent={row.result.videoId === currentVideoId}
                            isPlaying={isPlaying}
                            isBest={index === 0}
                            onClick={(event) =>
                              onRowClick(event, row, localRows.length + importedRows.length + index)
                            }
                            onContextMenu={(event) =>
                              openContextMenu(
                                event,
                                row,
                                localRows.length + importedRows.length + index
                              )
                            }
                            onKeyDown={(event) =>
                              onRowKeyDown(
                                event,
                                row,
                                localRows.length + importedRows.length + index
                              )
                            }
                            onToggleSelected={() => toggleRow(row, true)}
                            onMore={(event) =>
                              openRowMenuAt(
                                event,
                                row,
                                localRows.length + importedRows.length + index
                              )
                            }
                            onChannel={
                              row.result.channelId || row.result.channelName
                                ? () =>
                                    void openChannel(
                                      row.result.channelId ??
                                        row.result.channelName ??
                                        row.result.videoId,
                                      channelNameOf(row.result)
                                    )
                                : null
                            }
                          />
                        ))}
                      </ul>
                    ) : null}
                    {submitted.length > 0 &&
                    youtubeHasMore &&
                    youtube.length >= YOUTUBE_PAGE_SIZE &&
                    youtube.length < YOUTUBE_MAX_RESULTS &&
                    !loading ? (
                      <button
                        type="button"
                        className="discover-more"
                        title="Show 5 more YouTube results"
                        aria-label="Show 5 more YouTube results"
                        onClick={() => void loadMoreYouTube()}
                        disabled={youtubeMoreBusy}
                      >
                        {youtubeMoreBusy ? <SpinnerIcon size={14} /> : null}
                        <span>{youtubeMoreBusy ? 'Loading 5 more…' : '+5 more'}</span>
                      </button>
                    ) : null}
                    {submitted.length > 0 && !loading && youtube.length === 0 ? (
                      <p className="discover-empty-shelf">No YouTube results for this search.</p>
                    ) : null}
                  </section>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {fieldMenu.at ? (
        <FieldContextMenu
          at={fieldMenu.at}
          hasValue={query.length > 0}
          onPaste={() => void pasteQuery()}
          onCopy={() => void copyQuery()}
          onClear={clearQuery}
          onClose={fieldMenu.close}
        />
      ) : null}

      {rowMenu && rowMenuRow ? (
        <RowMenu
          at={rowMenu.at}
          title={rowMenuRow.kind === 'youtube' ? rowMenuRow.result.title : rowMenuRow.track.title}
          items={rowMenuItems}
          onClose={() => setRowMenu(null)}
          portal
        />
      ) : null}

      {playlistMenu ? (
        <AddToPlaylistMenu
          playlists={playlists}
          trackIds={playlistMenu.trackIds}
          heading={playlistMenu.heading}
          at={playlistMenu.at}
          onAdd={onAddTracksToPlaylist}
          onCreate={onCreatePlaylist}
          onClose={() => setPlaylistMenu(null)}
        />
      ) : null}

      {detailsTrack ? (
        <TrackDetails track={detailsTrack} onClose={() => setDetailsTrack(null)} />
      ) : null}
    </section>
  )
}

/**
 * One result as a card, in the same visual language as Home.
 *
 * The card itself is the row: Ctrl/Shift-click and the keyboard still work as
 * they do in a list, and the checkbox appears once a selection starts. The `…`
 * button is the mouse route to the same menu a right-click opens, where queue,
 * save and playlist actions live.
 */
function DiscoverRow(props: {
  row: SearchRow
  selected: boolean
  selecting: boolean
  busy: boolean
  isSaved: boolean
  savingState: DownloadState | undefined
  isCurrent: boolean
  isPlaying: boolean
  /** The first YouTube result, when the query was actually searched. */
  isBest?: boolean
  onClick: (event: ReactMouseEvent<HTMLLIElement>) => void
  onContextMenu: (event: ReactMouseEvent<HTMLLIElement>) => void
  onKeyDown: (event: ReactKeyboardEvent<HTMLLIElement>) => void
  onToggleSelected: () => void
  onMore: (event: ReactMouseEvent<HTMLButtonElement>) => void
  onChannel: (() => void) | null
}) {
  const {
    row,
    selected,
    selecting,
    busy,
    isSaved,
    savingState,
    isCurrent,
    isPlaying,
    isBest = false,
    onClick,
    onContextMenu,
    onKeyDown,
    onToggleSelected,
    onMore,
    onChannel
  } = props
  const isYouTube = row.kind === 'youtube'
  const title = row.kind === 'youtube' ? row.result.title : row.track.title
  const channelName = row.kind === 'youtube' ? channelNameOf(row.result) : null
  const artist = row.kind === 'youtube' ? channelName : (row.track.artist ?? 'Unknown artist')
  const duration = row.kind === 'youtube' ? row.result.durationMs : row.track.durationMs
  const savingActive =
    savingState !== undefined &&
    savingState.status !== 'saved' &&
    savingState.status !== 'failed' &&
    savingState.status !== 'cancelled'
  const artTrack = row.kind === 'youtube' ? artworkTrack(row.result) : row.track
  const meta = [artist, duration !== null ? formatDuration(duration) : null]
    .filter(Boolean)
    .join(' · ')
  const rowClass = [
    'album-card',
    'discover-item',
    selecting ? 'selecting' : '',
    isCurrent ? 'current' : '',
    selected ? 'selected' : '',
    isBest ? 'best-match' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <li
      className={rowClass}
      aria-current={isCurrent ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      tabIndex={0}
      title={
        busy
          ? 'Resolving this video…'
          : selecting
            ? 'Click to play; use the checkbox to change the selection'
            : 'Click to play; Ctrl/Shift-click to select'
      }
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
    >
      {selecting ? (
        <label
          className="discover-select"
          title={selected ? 'Deselect' : 'Select'}
          onClick={(event) => event.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelected}
            aria-label={`${selected ? 'Deselect' : 'Select'} ${title}`}
          />
        </label>
      ) : null}
      <span className="album-card-art">
        <ArtworkImage track={artTrack} size="100%" className="album-cover" />
        <span className="album-card-shade" aria-hidden="true" />
        {isBest ? <span className="discover-best-pill">Best match</span> : null}
        {row.kind === 'imported' ? (
          <span className="discover-import-source" title={`Imported from ${row.source}`}>
            {row.source}
          </span>
        ) : null}
        <span className="album-card-play discover-play" aria-hidden="true">
          {busy ? <SpinnerIcon size={16} /> : <PlayIcon size={16} />}
        </span>
      </span>
      <span className="album-card-title discover-title" title={title}>
        {isCurrent ? <span className={isPlaying ? 'playing-dot' : 'playing-dot paused'} /> : null}
        {title}
      </span>
      <span className="album-card-meta discover-artist" title={meta}>
        {isYouTube && onChannel && channelName ? (
          <button
            type="button"
            className="discover-channel-link"
            title={`More from ${channelName}`}
            onClick={(event) => {
              event.stopPropagation()
              onChannel()
            }}
          >
            {channelName}
          </button>
        ) : (
          artist
        )}
        {duration !== null ? <span className="discover-time"> · {formatDuration(duration)}</span> : null}
      </span>
      <button
        type="button"
        className="discover-menu icon-button subtle"
        title={savingActive ? 'Saving…' : isSaved ? 'More actions · saved to library' : 'More actions'}
        aria-label={`More actions for ${title}`}
        onClick={onMore}
      >
        {savingActive ? <SpinnerIcon size={15} /> : <MoreIcon size={15} />}
      </button>
    </li>
  )
}
function ResultPager(props: {
  page: number
  hasMore: boolean
  loading: boolean
  noun: string
  onPage: (page: number) => void
}) {
  const { page, hasMore, loading, noun, onPage } = props
  return (
    <div className="discover-pager" aria-label={`${noun} pages`}>
      <button
        type="button"
        className="pager-button"
        title={`Previous ${noun}`}
        aria-label={`Previous ${noun}`}
        disabled={page <= 1 || loading}
        onClick={() => onPage(page - 1)}
      >
        ‹
      </button>
      <span className="discover-page" aria-label={`Page ${page}`}>
        {page}
      </span>
      <button
        type="button"
        className="pager-button"
        title={`More ${noun}`}
        aria-label={`More ${noun}`}
        disabled={!hasMore || loading}
        onClick={() => onPage(page + 1)}
      >
        ›
      </button>
      {loading ? <SpinnerIcon /> : null}
    </div>
  )
}
