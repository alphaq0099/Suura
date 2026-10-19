import { useCallback, useEffect, useRef, useState } from 'react'
import type { AddTracksOutcome, Playlist, PlaylistDetail, PlaylistItem } from '@shared/types'
import { api, messageOf } from '../api'

export interface UsePlaylistsResult {
  /** Every playlist, in sidebar order, each with its entry count. */
  playlists: Playlist[]
  selectedId: number | null
  /** The selected playlist with its tracks, or null while nothing is selected. */
  detail: PlaylistDetail | null
  loading: boolean
  error: string | null
  select: (playlistId: number) => void
  /** Throws a readable message when the name is empty or already taken. */
  create: (name: string) => Promise<Playlist>
  rename: (playlistId: number, name: string) => Promise<void>
  remove: (playlistId: number) => Promise<void>
  clear: (playlistId: number) => Promise<void>
  addTracks: (playlistId: number, trackIds: number[]) => Promise<AddTracksOutcome>
  removeItems: (itemIds: number[]) => Promise<void>
  moveItem: (itemId: number, toIndex: number) => Promise<void>
  refresh: () => Promise<void>
}

/** Moves an entry within a list, without touching the database. */
function moveWithin(items: PlaylistItem[], itemId: number, toIndex: number): PlaylistItem[] {
  const from = items.findIndex((item) => item.id === itemId)
  if (from < 0) return items
  const target = Math.max(0, Math.min(Math.trunc(toIndex), items.length - 1))
  if (target === from) return items
  const next = [...items]
  const [moved] = next.splice(from, 1)
  if (!moved) return items
  next.splice(target, 0, moved)
  return next
}

/**
 * Playlists and the selected playlist's contents.
 *
 * The main process is the only place that decides order, so this hook treats
 * every mutation's response as the truth and never invents an order of its own —
 * with one exception. A drag has to land under the pointer, and waiting for a
 * round trip to redraw the row reads as the row snapping back; `moveWithin`
 * applies the move optimistically and the answer from main replaces it a moment
 * later. If the call fails, the real list is re-read.
 */
export function usePlaylists(): UsePlaylistsResult {
  const [playlists, setPlaylists] = useState<Playlist[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<PlaylistDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Read from inside callbacks that must not be re-created when the selection
  // changes: the library-changed subscription keeps one identity for its lifetime.
  const selectedRef = useRef<number | null>(null)
  useEffect(() => {
    selectedRef.current = selectedId
  }, [selectedId])

  // Bumped per detail load so a slow response cannot overwrite a newer one.
  const detailTokenRef = useRef(0)

  const loadList = useCallback(async (): Promise<Playlist[]> => {
    const list = await api.listPlaylists()
    setPlaylists(list)
    return list
  }, [])

  const loadDetail = useCallback(async (playlistId: number): Promise<void> => {
    const token = ++detailTokenRef.current
    setLoading(true)
    try {
      const next = await api.getPlaylist(playlistId)
      if (token !== detailTokenRef.current) return
      setDetail(next)
      setError(null)
    } catch (cause) {
      if (token !== detailTokenRef.current) return
      setError(messageOf(cause))
      setDetail(null)
    } finally {
      if (token === detailTokenRef.current) setLoading(false)
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const list = await loadList()
      const current = selectedRef.current
      if (current !== null && list.some((entry) => entry.id === current)) {
        await loadDetail(current)
        return
      }
      // Nothing selected (or the selected playlist is gone): show the first one,
      // so the view is never a dead end with playlists sitting in the sidebar.
      const first = list[0]?.id ?? null
      setSelectedId(first)
      selectedRef.current = first
      if (first === null) setDetail(null)
      else await loadDetail(first)
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [loadList, loadDetail])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // A scan can prune tracks, and a pruned track takes its playlist entries with
  // it. The counts in the sidebar and the order on screen both change underneath
  // the view, so it re-reads rather than trusting what it has.
  useEffect(() => {
    const token = api.on('libraryChanged', () => {
      void refresh()
    })
    return () => api.off(token)
  }, [refresh])

  const select = useCallback(
    (playlistId: number): void => {
      setSelectedId(playlistId)
      selectedRef.current = playlistId
      void loadDetail(playlistId)
    },
    [loadDetail]
  )

  const create = useCallback(
    async (name: string): Promise<Playlist> => {
      const created = await api.createPlaylist(name)
      await loadList()
      setSelectedId(created.id)
      selectedRef.current = created.id
      setDetail({ playlist: created, items: [] })
      setError(null)
      return created
    },
    [loadList]
  )

  const rename = useCallback(
    async (playlistId: number, name: string): Promise<void> => {
      const renamed = await api.renamePlaylist(playlistId, name)
      setPlaylists((current) => current.map((entry) => (entry.id === renamed.id ? renamed : entry)))
      setDetail((current) =>
        current && current.playlist.id === renamed.id ? { ...current, playlist: renamed } : current
      )
    },
    []
  )

  const remove = useCallback(
    async (playlistId: number): Promise<void> => {
      await api.deletePlaylist(playlistId)
      const list = await loadList()
      if (selectedRef.current !== playlistId) return
      const next = list[0]?.id ?? null
      setSelectedId(next)
      selectedRef.current = next
      if (next === null) setDetail(null)
      else await loadDetail(next)
    },
    [loadList, loadDetail]
  )

  const clear = useCallback(
    async (playlistId: number): Promise<void> => {
      const next = await api.clearPlaylist(playlistId)
      if (next) setDetail(next)
      // The count in the sidebar has to follow, and so does `updatedAt`.
      await loadList()
    },
    [loadList]
  )

  const addTracks = useCallback(
    async (playlistId: number, trackIds: number[]): Promise<AddTracksOutcome> => {
      const outcome = await api.addTracksToPlaylist(playlistId, trackIds)
      if (selectedRef.current === playlistId && outcome.detail) setDetail(outcome.detail)
      await loadList()
      return outcome
    },
    [loadList]
  )

  const removeItems = useCallback(
    async (itemIds: number[]): Promise<void> => {
      const playlistId = selectedRef.current
      if (playlistId === null) return
      const next = await api.removePlaylistItems(playlistId, itemIds)
      if (next) setDetail(next)
      await loadList()
    },
    [loadList]
  )

  const moveItem = useCallback(
    async (itemId: number, toIndex: number): Promise<void> => {
      const playlistId = selectedRef.current
      if (playlistId === null) return
      setDetail((current) => (current ? { ...current, items: moveWithin(current.items, itemId, toIndex) } : current))
      try {
        const next = await api.movePlaylistItem(playlistId, itemId, toIndex)
        if (next && selectedRef.current === playlistId) setDetail(next)
      } catch (cause) {
        setError(messageOf(cause))
        await loadDetail(playlistId)
      }
    },
    [loadDetail]
  )

  return {
    playlists,
    selectedId,
    detail,
    loading,
    error,
    select,
    create,
    rename,
    remove,
    clear,
    addTracks,
    removeItems,
    moveItem,
    refresh
  }
}
