import { useCallback, useEffect, useRef, useState } from 'react'
import type { OnlinePlaylistDetail, OnlineTrack } from '@shared/types'
import { api, messageOf } from '../api'

export interface UseOnlineResult {
  /** Remembered links, newest activity first. */
  entries: OnlineTrack[]
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  /**
   * Resolves a pasted link and remembers it. Rejects with a readable message
   * when the link is not a YouTube video or YouTube refuses it.
   */
  addLink: (url: string) => Promise<OnlineTrack>
  /**
   * Fetches a playlist, album or mix and stores it as an Online playlist.
   *
   * Rejects with a readable message when the link is a channel page, an account
   * list, or a list YouTube will not hand over. The caller decides whether the
   * result replaces the queue or merely joins it.
   */
  importList: (url: string) => Promise<OnlinePlaylistDetail>
  remove: (id: number) => Promise<void>
  clear: () => Promise<void>
}

/**
 * The Online history.
 *
 * The main process owns the order — adding and playing both move a row up — so
 * this hook treats every answer as the truth. The one local update is the
 * optimistic removal, because a row that lingers for a round trip after its
 * delete button was clicked reads as "the button did not work".
 */
export function useOnline(): UseOnlineResult {
  const [entries, setEntries] = useState<OnlineTrack[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Bumped per load so a slow response cannot overwrite a newer one.
  const tokenRef = useRef(0)

  const refresh = useCallback(async (): Promise<void> => {
    const token = ++tokenRef.current
    setLoading(true)
    try {
      const list = await api.listOnline()
      if (token !== tokenRef.current) return
      setEntries(list)
      setError(null)
    } catch (cause) {
      if (token !== tokenRef.current) return
      setError(messageOf(cause))
    } finally {
      if (token === tokenRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Playing a row goes through `media:resolve` in the main process, which lifts
  // it. Without this the order on screen would only catch up on the next visit.
  useEffect(() => {
    const token = api.on('onlineChanged', () => {
      void refresh()
    })
    return () => api.off(token)
  }, [refresh])

  const addLink = useCallback(async (url: string): Promise<OnlineTrack> => {
    const entry = await api.addOnlineLink(url)
    // Put it in place immediately so the view can build a queue from the list it
    // is already showing; the broadcast that follows re-reads the real order.
    setEntries((current) => [entry, ...current.filter((item) => item.id !== entry.id)])
    return entry
  }, [])

  const importList = useCallback(async (url: string): Promise<OnlinePlaylistDetail> => {
    // The broadcast refreshes the history. The import itself adds no history rows:
    // a track joins the log when it is played, not when it is imported.
    return api.importOnlineList(url)
  }, [])

  const remove = useCallback(async (id: number): Promise<void> => {
    await api.removeOnline(id)
    setEntries((current) => current.filter((entry) => entry.id !== id))
  }, [])

  const clear = useCallback(async (): Promise<void> => {
    await api.clearOnline()
    setEntries([])
  }, [])

  return { entries, loading, error, refresh, addLink, importList, remove, clear }
}
