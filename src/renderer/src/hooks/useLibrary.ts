import { useCallback, useEffect, useRef, useState } from 'react'
import type { LibraryStats, ScanProgress, SortDirection, Track, TrackSortField } from '@shared/types'
import { api, messageOf } from '../api'

const SEARCH_DEBOUNCE_MS = 200

/**
 * Rows fetched per request.
 *
 * The list is virtualized, so it never needs the whole library at once: it asks
 * for the next page as the visible window approaches the loaded edge. 400 keeps
 * one IPC round trip well under a frame's worth of work while still filling a
 * large window in a single call.
 */
const PAGE_SIZE = 400

export interface UseLibraryResult {
  tracks: Track[]
  /** Rows matching the current search/sort, whether or not they are loaded yet. */
  total: number
  stats: LibraryStats | null
  progress: ScanProgress | null
  search: string
  setSearch: (value: string) => void
  sort: TrackSortField | null
  direction: SortDirection
  /** Cycles the given column: ascending -> descending -> back to the default order. */
  toggleSort: (field: TrackSortField) => void
  scanning: boolean
  error: string | null
  loadingMore: boolean
  /** True while more rows exist behind the loaded window. */
  hasMore: boolean
  loadMore: () => void
  scan: (folder?: string) => Promise<void>
  refresh: () => Promise<void>
  selectedIds: ReadonlySet<number>
  select: (trackId: number, mode: 'replace' | 'toggle') => void
  selectAll: () => void
  clearSelection: () => void
}

export function useLibrary(): UseLibraryResult {
  const [tracks, setTracks] = useState<Track[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<LibraryStats | null>(null)
  const [progress, setProgress] = useState<ScanProgress | null>(null)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<TrackSortField | null>(null)
  const [direction, setDirection] = useState<SortDirection>('asc')
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<number>>(() => new Set<number>())
  const [scanning, setScanning] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The query the loaded rows belong to. Kept in a ref because the event
  // subscription and loadMore must read it without re-subscribing.
  const queryRef = useRef<{ search: string; sort: TrackSortField | null; direction: SortDirection }>({
    search: '',
    sort: null,
    direction: 'asc'
  })
  // Bumped on every fresh load so a slow response cannot overwrite a newer one.
  const requestRef = useRef(0)
  const loadingMoreRef = useRef(false)
  const loadedCountRef = useRef(0)
  const totalRef = useRef(0)

  useEffect(() => {
    loadedCountRef.current = tracks.length
  }, [tracks])

  useEffect(() => {
    totalRef.current = total
  }, [total])

  const load = useCallback(
    async (term: string, nextSort: TrackSortField | null, nextDirection: SortDirection): Promise<void> => {
      const token = ++requestRef.current
      queryRef.current = { search: term, sort: nextSort, direction: nextDirection }
      try {
        const [page, nextStats] = await Promise.all([
          api.listTracks({
            search: term.trim().length > 0 ? term.trim() : undefined,
            sort: nextSort ?? undefined,
            direction: nextDirection,
            limit: PAGE_SIZE,
            offset: 0
          }),
          api.getStats()
        ])
        if (token !== requestRef.current) return
        setTracks(page.tracks)
        setTotal(page.total)
        setStats(nextStats)
        setError(null)
      } catch (cause) {
        if (token !== requestRef.current) return
        setError(messageOf(cause))
      }
    },
    []
  )

  const refresh = useCallback(
    () => load(queryRef.current.search, queryRef.current.sort, queryRef.current.direction),
    [load]
  )

  const loadMore = useCallback((): void => {
    if (loadingMoreRef.current) return
    const offset = loadedCountRef.current
    if (offset === 0 || offset >= totalRef.current) return

    const { search: term, sort: nextSort, direction: nextDirection } = queryRef.current
    const token = requestRef.current
    loadingMoreRef.current = true
    setLoadingMore(true)

    void api
      .listTracks({
        search: term.trim().length > 0 ? term.trim() : undefined,
        sort: nextSort ?? undefined,
        direction: nextDirection,
        limit: PAGE_SIZE,
        offset
      })
      .then((page) => {
        if (token !== requestRef.current) return
        // Guard against a duplicate append if two requests raced.
        setTracks((previous) => (previous.length === offset ? [...previous, ...page.tracks] : previous))
        setTotal(page.total)
      })
      .catch((cause: unknown) => setError(messageOf(cause)))
      .finally(() => {
        loadingMoreRef.current = false
        setLoadingMore(false)
      })
  }, [])

  // Debounced (re)load whenever the search term changes.
  useEffect(() => {
    const handle = setTimeout(() => {
      void load(search, queryRef.current.sort, queryRef.current.direction)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [search, load])

  useEffect(() => {
    const progressToken = api.on('scanProgress', (update) => {
      setProgress(update)
      // Track the scan from the main process rather than only from this hook's own
      // `scan()` call. A scan can also be started elsewhere (another window, the
      // test harness), and guessing wrong here means a Rescan click races the
      // running scan and the user sees "A library scan is already running."
      setScanning(update.phase !== 'done')
    })
    const changedToken = api.on('libraryChanged', () => {
      void refresh()
    })
    return () => {
      api.off(progressToken)
      api.off(changedToken)
    }
  }, [refresh])

  const scan = useCallback(
    async (folder?: string): Promise<void> => {
      setScanning(true)
      setError(null)
      try {
        await api.scanLibrary(folder)
      } catch (cause) {
        setError(messageOf(cause))
      } finally {
        setScanning(false)
        await refresh()
      }
    },
    [refresh]
  )

  const changeSearch = useCallback((value: string): void => {
    setSearch(value)
    setSelectedIds(new Set<number>())
  }, [])

  const toggleSort = useCallback((field: TrackSortField): void => {
    setSelectedIds(new Set<number>())
    setSort((current) => {
      if (current !== field) {
        setDirection('asc')
        return field
      }
      if (direction === 'asc') {
        setDirection('desc')
        return field
      }
      // Third click: back to the natural artist/album/track order.
      setDirection('asc')
      return null
    })
  }, [direction])

  // Sorting is applied by the main process, so the reload has to wait for the
  // state above to settle.
  const firstSortRender = useRef(true)
  useEffect(() => {
    if (firstSortRender.current) {
      firstSortRender.current = false
      return
    }
    void load(queryRef.current.search, sort, direction)
  }, [sort, direction, load])

  const select = useCallback((trackId: number, mode: 'replace' | 'toggle'): void => {
    setSelectedIds((previous) => {
      if (mode === 'replace') return new Set([trackId])
      const next = new Set(previous)
      if (next.has(trackId)) next.delete(trackId)
      else next.add(trackId)
      return next
    })
  }, [])

  const selectAll = useCallback((): void => {
    setSelectedIds(new Set(tracks.map((track) => track.id)))
  }, [tracks])

  const clearSelection = useCallback((): void => {
    setSelectedIds(new Set<number>())
  }, [])

  return {
    tracks,
    total,
    stats,
    progress,
    search,
    setSearch: changeSearch,
    sort,
    direction,
    toggleSort,
    scanning,
    error,
    loadingMore,
    hasMore: tracks.length < total,
    loadMore,
    scan,
    refresh,
    selectedIds,
    select,
    selectAll,
    clearSelection
  }
}
