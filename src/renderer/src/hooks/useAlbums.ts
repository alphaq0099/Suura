import { useCallback, useEffect, useRef, useState } from 'react'
import type { AlbumSortField, AlbumSummary } from '@shared/types'
import { api, messageOf } from '../api'

/** Rows fetched per grid page. Large enough to fill a wide window, small enough to stay quick. */
const PAGE_SIZE = 60

const SEARCH_DEBOUNCE_MS = 220

export interface UseAlbumsResult {
  albums: AlbumSummary[]
  /** Albums matching the query, including pages not loaded yet. */
  total: number
  loading: boolean
  loadingMore: boolean
  error: string | null
  search: string
  setSearch: (value: string) => void
  sort: AlbumSortField
  setSort: (value: AlbumSortField) => void
  /** An artist picked from the Home shelf, or null for the whole library. */
  artist: string | null
  setArtist: (value: string | null) => void
  hasMore: boolean
  loadMore: () => void
  refresh: () => Promise<void>
}

/**
 * The paged, searchable album grid.
 *
 * Every new search or sort bumps a token, so a slow response for an old term can
 * never replace the results of the one the user is looking at. Loaded pages are
 * appended in place; `total` still describes the whole query.
 */
export function useAlbums(): UseAlbumsResult {
  const [albums, setAlbums] = useState<AlbumSummary[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<AlbumSortField>('recent')
  const [artist, setArtist] = useState<string | null>(null)

  const queryRef = useRef({ search: '', sort: 'recent' as AlbumSortField, artist: null as string | null })
  const albumsRef = useRef<AlbumSummary[]>([])
  const totalRef = useRef(0)
  const requestRef = useRef(0)

  const load = useCallback(
    async (term: string, nextSort: AlbumSortField, nextArtist: string | null): Promise<void> => {
      const token = ++requestRef.current
      queryRef.current = { search: term, sort: nextSort, artist: nextArtist }
      setLoading(true)
      setLoadingMore(false)
      setError(null)
      try {
        const page = await api.listAlbums({
          search: term.trim() || undefined,
          sort: nextSort,
          artist: nextArtist ?? undefined,
          limit: PAGE_SIZE,
          offset: 0
        })
        if (token !== requestRef.current) return
        albumsRef.current = page.albums
        totalRef.current = page.total
        setAlbums(page.albums)
        setTotal(page.total)
      } catch (cause) {
        if (token !== requestRef.current) return
        albumsRef.current = []
        totalRef.current = 0
        setAlbums([])
        setTotal(0)
        setError(messageOf(cause))
      } finally {
        if (token === requestRef.current) setLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load(search, sort, artist)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [search, sort, artist, load])

  const refresh = useCallback(async (): Promise<void> => {
    const current = queryRef.current
    await load(current.search, current.sort, current.artist)
  }, [load])

  // A folder scan, merge or removal changes the album set. The view stays
  // mounted across those operations, so it has to ask again rather than wait for
  // a remount.
  useEffect(() => {
    const token = api.on('libraryChanged', () => {
      void refresh()
    })
    return () => api.off(token)
  }, [refresh])

  const loadMore = useCallback((): void => {
    const offset = albumsRef.current.length
    if (loading || loadingMore || offset === 0 || offset >= totalRef.current) return
    const token = requestRef.current
    const current = queryRef.current
    setLoadingMore(true)
    void api
      .listAlbums({
        search: current.search.trim() || undefined,
        sort: current.sort,
        artist: current.artist ?? undefined,
        limit: PAGE_SIZE,
        offset
      })
      .then((page) => {
        if (token !== requestRef.current) return
        const next = [...albumsRef.current, ...page.albums]
        albumsRef.current = next
        totalRef.current = page.total
        setAlbums(next)
        setTotal(page.total)
      })
      .catch((cause: unknown) => {
        if (token === requestRef.current) setError(messageOf(cause))
      })
      .finally(() => {
        if (token === requestRef.current) setLoadingMore(false)
      })
  }, [loading, loadingMore])

  return {
    albums,
    total,
    loading,
    loadingMore,
    error,
    search,
    setSearch,
    sort,
    setSort,
    artist,
    setArtist,
    hasMore: albums.length < total,
    loadMore,
    refresh
  }
}
