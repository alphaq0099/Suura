import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AddTracksOutcome,
  OnlinePlaylist,
  OnlinePlaylistDetail,
  Playlist,
  PlaylistDetail,
  PlaylistItem
} from '@shared/types'
import { api, messageOf } from '../api'

export interface UsePlaylistsResult {
  /** Every hand-made playlist, in sidebar order, each with its entry count. */
  playlists: Playlist[]
  selectedId: number | null
  /** The selected playlist with its tracks, or null while nothing is selected. */
  detail: PlaylistDetail | null
  /** Every imported playlist, most recently imported first. */
  onlinePlaylists: OnlinePlaylist[]
  selectedOnlineId: number | null
  /** The selected imported playlist, or null. Exactly one selection is active. */
  onlineDetail: OnlinePlaylistDetail | null
  loading: boolean
  error: string | null
  select: (playlistId: number) => void
  selectOnline: (playlistId: number) => void
  /** Throws a readable message when the name is empty or already taken. */
  create: (name: string) => Promise<Playlist>
  rename: (playlistId: number, name: string) => Promise<void>
  remove: (playlistId: number) => Promise<void>
  clear: (playlistId: number) => Promise<void>
  addTracks: (playlistId: number, trackIds: number[]) => Promise<AddTracksOutcome>
  removeItems: (itemIds: number[]) => Promise<void>
  moveItem: (itemId: number, toIndex: number) => Promise<void>
  /** Re-reads an imported playlist's entries and stores the new snapshot. */
  reimportOnline: (playlistId: number) => Promise<OnlinePlaylistDetail>
  /** Removes an imported playlist and its entries. Nothing in the library changes. */
  deleteOnline: (playlistId: number) => Promise<void>
  /** Removes one entry and closes the gap in the imported order. */
  removeOnlineItem: (itemId: number) => Promise<void>
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
 * Two kinds share one selection because the Playlists view shows one pane: the
 * hand-made lists the user reorders, and the snapshots imported from links, which
 * keep their source order. Selecting either clears the other, so "Remove" can
 * never act on entries that are not on screen.
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
  const [onlinePlaylists, setOnlinePlaylists] = useState<OnlinePlaylist[]>([])
  const [selectedOnlineId, setSelectedOnlineId] = useState<number | null>(null)
  const [onlineDetail, setOnlineDetail] = useState<OnlinePlaylistDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Read from inside callbacks that must not be re-created when the selection
  // changes: the library-changed subscription keeps one identity for its lifetime.
  const selectedRef = useRef<number | null>(null)
  const selectedOnlineRef = useRef<number | null>(null)
  const onlinePlaylistsRef = useRef<OnlinePlaylist[]>([])
  useEffect(() => {
    selectedRef.current = selectedId
  }, [selectedId])
  useEffect(() => {
    selectedOnlineRef.current = selectedOnlineId
  }, [selectedOnlineId])
  useEffect(() => {
    onlinePlaylistsRef.current = onlinePlaylists
  }, [onlinePlaylists])

  // Bumped per detail load so a slow response cannot overwrite a newer one.
  const detailTokenRef = useRef(0)

  const loadList = useCallback(async (): Promise<Playlist[]> => {
    const list = await api.listPlaylists()
    setPlaylists(list)
    return list
  }, [])

  const loadOnlineList = useCallback(async (): Promise<OnlinePlaylist[]> => {
    const list = await api.listOnlinePlaylists()
    setOnlinePlaylists(list)
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

  const loadOnlineDetail = useCallback(async (playlistId: number): Promise<void> => {
    const token = ++detailTokenRef.current
    setLoading(true)
    try {
      const next = await api.getOnlinePlaylist(playlistId)
      if (token !== detailTokenRef.current) return
      setOnlineDetail(next)
      setError(null)
    } catch (cause) {
      if (token !== detailTokenRef.current) return
      setError(messageOf(cause))
      setOnlineDetail(null)
    } finally {
      if (token === detailTokenRef.current) setLoading(false)
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [list, imported] = await Promise.all([loadList(), loadOnlineList()])

      // Keep whatever the user was looking at, whichever kind it was.
      const current = selectedRef.current
      if (current !== null && list.some((entry) => entry.id === current)) {
        await loadDetail(current)
        return
      }
      const currentOnline = selectedOnlineRef.current
      if (currentOnline !== null && imported.some((entry) => entry.id === currentOnline)) {
        await loadOnlineDetail(currentOnline)
        return
      }

      // Nothing selected (or the selection is gone): show the first playlist, so
      // the view is never a dead end with lists sitting in the sidebar. Hand-made
      // playlists win the tie because they are the ones the user made.
      const first = list[0]?.id ?? null
      if (first !== null) {
        setSelectedId(first)
        selectedRef.current = first
        setSelectedOnlineId(null)
        selectedOnlineRef.current = null
        setOnlineDetail(null)
        await loadDetail(first)
        return
      }

      const firstOnline = imported[0]?.id ?? null
      setSelectedId(null)
      selectedRef.current = null
      setSelectedOnlineId(firstOnline)
      selectedOnlineRef.current = firstOnline
      if (firstOnline === null) {
        setDetail(null)
        setOnlineDetail(null)
      } else {
        await loadOnlineDetail(firstOnline)
      }
    } catch (cause) {
      setError(messageOf(cause))
    }
  }, [loadList, loadOnlineList, loadDetail, loadOnlineDetail])

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

  // An import or a re-import from the Online view writes a new snapshot. Refresh
  // the index and, if one is open, the entries — without changing the selection.
  useEffect(() => {
    const token = api.on('onlineChanged', () => {
      void (async () => {
        try {
          const list = await loadOnlineList()
          const current = selectedOnlineRef.current
          if (current !== null && list.some((entry) => entry.id === current)) {
            await loadOnlineDetail(current)
          } else if (current !== null) {
            setSelectedOnlineId(null)
            selectedOnlineRef.current = null
            setOnlineDetail(null)
          }
        } catch (cause) {
          setError(messageOf(cause))
        }
      })()
    })
    return () => api.off(token)
  }, [loadOnlineList, loadOnlineDetail])

  const select = useCallback(
    (playlistId: number): void => {
      setSelectedOnlineId(null)
      selectedOnlineRef.current = null
      setOnlineDetail(null)
      setSelectedId(playlistId)
      selectedRef.current = playlistId
      void loadDetail(playlistId)
    },
    [loadDetail]
  )

  const selectOnline = useCallback(
    (playlistId: number): void => {
      setSelectedId(null)
      selectedRef.current = null
      setDetail(null)
      setSelectedOnlineId(playlistId)
      selectedOnlineRef.current = playlistId
      void loadOnlineDetail(playlistId)
    },
    [loadOnlineDetail]
  )

  const create = useCallback(
    async (name: string): Promise<Playlist> => {
      const created = await api.createPlaylist(name)
      await loadList()
      setSelectedOnlineId(null)
      selectedOnlineRef.current = null
      setOnlineDetail(null)
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

  const reimportOnline = useCallback(
    async (playlistId: number): Promise<OnlinePlaylistDetail> => {
      const playlist = onlinePlaylistsRef.current.find((entry) => entry.id === playlistId)
      if (!playlist) throw new Error('That playlist is no longer in the index.')
      const next = await api.importOnlineList(playlist.sourceUrl)
      await loadOnlineList()
      if (selectedOnlineRef.current === next.playlist.id) setOnlineDetail(next)
      return next
    },
    [loadOnlineList]
  )

  const deleteOnline = useCallback(
    async (playlistId: number): Promise<void> => {
      await api.deleteOnlinePlaylist(playlistId)
      const list = await loadOnlineList()
      if (selectedOnlineRef.current !== playlistId) return

      const next = list[0]?.id ?? null
      if (next !== null) {
        setSelectedOnlineId(next)
        selectedOnlineRef.current = next
        await loadOnlineDetail(next)
        return
      }

      // The last imported playlist is gone: fall back to a hand-made one, or to
      // the empty state, rather than leaving a pane pointing at nothing.
      setSelectedOnlineId(null)
      selectedOnlineRef.current = null
      setOnlineDetail(null)
      const firstCustom = playlists[0]?.id ?? null
      if (firstCustom !== null) select(firstCustom)
    },
    [loadOnlineList, loadOnlineDetail, playlists, select]
  )

  const removeOnlineItem = useCallback(
    async (itemId: number): Promise<void> => {
      const playlistId = await api.removeOnlinePlaylistItem(itemId)
      const list = await loadOnlineList()
      if (playlistId !== null && selectedOnlineRef.current === playlistId) {
        const stillThere = list.some((entry) => entry.id === playlistId)
        if (stillThere) await loadOnlineDetail(playlistId)
      }
    },
    [loadOnlineList, loadOnlineDetail]
  )

  return {
    playlists,
    selectedId,
    detail,
    onlinePlaylists,
    selectedOnlineId,
    onlineDetail,
    loading,
    error,
    select,
    selectOnline,
    create,
    rename,
    remove,
    clear,
    addTracks,
    removeItems,
    moveItem,
    reimportOnline,
    deleteOnline,
    removeOnlineItem,
    refresh
  }
}
