import { useCallback, useEffect, useState } from 'react'
import type { DownloadProgress, SaveToLibraryRequest } from '@shared/types'
import { api, messageOf } from '../api'

export interface DownloadState {
  status: DownloadProgress['status']
  /** 0-100 while downloading, null when there is no fraction to show. */
  percent: number | null
  error: string | null
}

export interface UseDownloadsResult {
  /** Per-video progress for anything saving now or recently failed. */
  states: Readonly<Record<string, DownloadState>>
  /** Video ids that already have a library row. */
  saved: ReadonlySet<string>
  /** Saves one track. Resolves with the library row id when it is indexed. */
  save: (request: SaveToLibraryRequest) => Promise<number>
  /** Queues several saves; each row reports its own progress. */
  saveMany: (requests: SaveToLibraryRequest[]) => void
  /** Asks which of these videos are already in the library. */
  refreshSaved: (videoIds: string[]) => Promise<void>
}

/**
 * Saving streams to the library.
 *
 * One hook for the whole app, because a download outlives the view that started
 * it: the Online history, an imported playlist and the player bar all name the
 * same video, and all of them should show the same percentage. The main process
 * owns the queue; this only mirrors its events and remembers which ids are done.
 */
export function useDownloads(): UseDownloadsResult {
  const [states, setStates] = useState<Record<string, DownloadState>>({})
  const [saved, setSaved] = useState<ReadonlySet<string>>(() => new Set<string>())

  useEffect(() => {
    const token = api.on('downloadChanged', (progress) => {
      setStates((current) => ({
        ...current,
        [progress.videoId]: {
          status: progress.status,
          percent: progress.percent,
          error: progress.error
        }
      }))
      if (progress.status === 'saved') {
        setSaved((current) => {
          if (current.has(progress.videoId)) return current
          const next = new Set(current)
          next.add(progress.videoId)
          return next
        })
      }
    })
    return () => api.off(token)
  }, [])

  const save = useCallback(async (request: SaveToLibraryRequest): Promise<number> => {
    setStates((current) => ({
      ...current,
      [request.videoId]: { status: 'queued', percent: null, error: null }
    }))
    try {
      const trackId = await api.saveToLibrary(request)
      setSaved((current) => {
        if (current.has(request.videoId)) return current
        const next = new Set(current)
        next.add(request.videoId)
        return next
      })
      return trackId
    } catch (cause) {
      const message = messageOf(cause)
      setStates((current) => ({
        ...current,
        [request.videoId]: { status: 'failed', percent: null, error: message }
      }))
      throw cause
    }
  }, [])

  const saveMany = useCallback(
    (requests: SaveToLibraryRequest[]): void => {
      // Deliberately not awaited as a group: a mix is up to 50 files, and the
      // queue in main is what orders them. One failure must not cancel the rest.
      for (const request of requests) {
        void save(request).catch(() => undefined)
      }
    },
    [save]
  )

  const refreshSaved = useCallback(async (videoIds: string[]): Promise<void> => {
    if (videoIds.length === 0) return
    try {
      const found = await api.savedVideoIds(videoIds)
      if (found.length === 0) return
      setSaved((current) => {
        let changed = false
        const next = new Set(current)
        for (const id of found) {
          if (!next.has(id)) {
            next.add(id)
            changed = true
          }
        }
        return changed ? next : current
      })
    } catch {
      // A failed lookup only means no "saved" badge; it must not break the view.
    }
  }, [])

  return { states, saved, save, saveMany, refreshSaved }
}
