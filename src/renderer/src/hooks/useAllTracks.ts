import { useCallback, useEffect, useRef, useState } from 'react'
import type { AllTracksFilter, AllTracksRow } from '@shared/types'
import { api, messageOf } from '../api'

/** Rows per page. The list is virtualized, so this is a scroll length, not a DOM cost. */
const PAGE_SIZE = 100

const SEARCH_DEBOUNCE_MS = 200

export interface UseAllTracksResult {
  rows: AllTracksRow[]
  loading: boolean
  loadingMore: boolean
  error: string | null
  search: string
  setSearch: (value: string) => void
  filter: AllTracksFilter
  setFilter: (value: AllTracksFilter) => void
  /** Another page exists behind the rows already loaded. */
  hasMore: boolean
  /** The merge stopped at its scan limit; the footer says so instead of lying. */
  truncated: boolean
  loadMore: () => void
  refresh: () => Promise<void>
}

/**
 * Home's merged All tracks feed.
 *
 * One request per search or filter, then pages appended in place. A token guards
 * each request, because typing is faster than the merge: a slow answer for an
 * old term must never replace the results of the current one.
 */
export function useAllTracks(): UseAllTracksResult {
  const [rows, setRows] = useState<AllTracksRow[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<AllTracksFilter>('all')
  const [hasMore, setHasMore] = useState(false)
  const [truncated, setTruncated] = useState(false)

  const queryRef = useRef<{ search: string; filter: AllTracksFilter }>({
    search: '',
    filter: 'all'
  })
  const rowsRef = useRef<AllTracksRow[]>([])
  const hasMoreRef = useRef(false)
  const requestRef = useRef(0)

  const load = useCallback(
    async (term: string, nextFilter: AllTracksFilter): Promise<void> => {
      const token = ++requestRef.current
      queryRef.current = { search: term, filter: nextFilter }
      setLoading(true)
      setLoadingMore(false)
      setError(null)
      try {
        const page = await api.listAllTracks({
          search: term.trim() || undefined,
          filter: nextFilter,
          limit: PAGE_SIZE,
          offset: 0
        })
        if (token !== requestRef.current) return
        rowsRef.current = page.rows
        hasMoreRef.current = page.hasMore
        setRows(page.rows)
        setHasMore(page.hasMore)
        setTruncated(page.truncated)
      } catch (cause) {
        if (token !== requestRef.current) return
        rowsRef.current = []
        hasMoreRef.current = false
        setRows([])
        setHasMore(false)
        setTruncated(false)
        setError(messageOf(cause))
      } finally {
        if (token === requestRef.current) setLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load(search, filter)
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [search, filter, load])

  const refresh = useCallback(async (): Promise<void> => {
    const current = queryRef.current
    await load(current.search, current.filter)
  }, [load])

  // A scan changes the files; a counted listen changes both the order and whether
  // a stream row belongs in the played view at all; an import adds playlist rows.
  // Home stays mounted across all three, so it has to ask again.
  useEffect(() => {
    const libraryToken = api.on('libraryChanged', () => {
      void refresh()
    })
    const playToken = api.on('playHistoryChanged', () => {
      void refresh()
    })
    const onlineToken = api.on('onlineChanged', () => {
      void refresh()
    })
    return () => {
      api.off(libraryToken)
      api.off(playToken)
      api.off(onlineToken)
    }
  }, [refresh])

  const loadMore = useCallback((): void => {
    if (loading || loadingMore || !hasMoreRef.current) return
    const token = requestRef.current
    const current = queryRef.current
    const offset = rowsRef.current.length
    setLoadingMore(true)
    void api
      .listAllTracks({
        search: current.search.trim() || undefined,
        filter: current.filter,
        limit: PAGE_SIZE,
        offset
      })
      .then((page) => {
        if (token !== requestRef.current) return
        const next = [...rowsRef.current, ...page.rows]
        rowsRef.current = next
        hasMoreRef.current = page.hasMore
        setRows(next)
        setHasMore(page.hasMore)
        setTruncated(page.truncated)
      })
      .catch((cause: unknown) => {
        if (token === requestRef.current) setError(messageOf(cause))
      })
      .finally(() => {
        if (token === requestRef.current) setLoadingMore(false)
      })
  }, [loading, loadingMore])

  return {
    rows,
    loading,
    loadingMore,
    error,
    search,
    setSearch,
    filter,
    setFilter,
    hasMore,
    truncated,
    loadMore,
    refresh
  }
}
