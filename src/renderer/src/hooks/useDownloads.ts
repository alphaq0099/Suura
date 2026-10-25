import { useCallback, useEffect, useState } from 'react'
import type { DownloadStatus, SaveToLibraryRequest } from '@shared/types'
import { api, messageOf } from '../api'

export interface DownloadState {
  status: DownloadStatus
  /** 0-100 while downloading, null when there is no fraction to show. */
  percent: number | null
  error: string | null
  /** What was asked for, kept so a failed or cancelled save can be retried. */
  request: SaveToLibraryRequest | null
  /** The library row once the save finished, used by the panel's Reveal action. */
  trackId: number | null
  /** Last change, so the panel can put the newest save at the top. */
  updatedAt: number
}

export interface SaveItem extends DownloadState {
  videoId: string
}

export interface UseDownloadsResult {
  /** Per-video progress for anything saving now or recently failed. */
  states: Readonly<Record<string, DownloadState>>
  /** The same states as a newest-first list, for the saves panel. */
  items: SaveItem[]
  /** Video ids that already have a library row. */
  saved: ReadonlySet<string>
  /** Saves one track. Resolves with the library row id when it is indexed. */
  save: (request: SaveToLibraryRequest) => Promise<number>
  /** Queues several saves; each row reports its own progress. */
  saveMany: (requests: SaveToLibraryRequest[]) => void
  /** Stops a queued or running save. Its promise rejects. */
  cancel: (videoId: string) => void
  /** Runs a failed or cancelled save again with the same metadata. */
  retry: (videoId: string) => void
  /** Takes a finished or failed row out of the panel. */
  dismiss: (videoId: string) => void
  /** Asks which of these videos are already in the library. */
  refreshSaved: (videoIds: string[]) => Promise<void>
}

function isCancellation(message: string): boolean {
  return /cancel/i.test(message)
}

/**
 * Saving streams to the library.
 *
 * One hook for the whole app, because a download outlives the view that started
 * it: the YouTube history, an imported playlist and the player bar all name the
 * same video, and all of them should show the same percentage. The main process
 * owns the queue; this only mirrors its events, remembers which ids are done and
 * keeps the request so a failed save can be retried without the view.
 */
export function useDownloads(): UseDownloadsResult {
  const [states, setStates] = useState<Record<string, DownloadState>>({})
  const [saved, setSaved] = useState<ReadonlySet<string>>(() => new Set<string>())

  useEffect(() => {
    const token = api.on('downloadChanged', (progress) => {
      setStates((current) => {
        const previous = current[progress.videoId]
        return {
          ...current,
          [progress.videoId]: {
            status: progress.status,
            percent: progress.percent,
            error: progress.error,
            request: previous?.request ?? null,
            trackId: progress.trackId ?? previous?.trackId ?? null,
            updatedAt: Date.now()
          }
        }
      })
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

  // A failed save from the last session must still be retryable. Only rows that
  // need attention are hydrated: the full list belongs on the downloads screen,
  // and showing every successful save would bury the one that failed. Live
  // events win over the snapshot, so a save started while this was in flight is
  // not rolled back.
  useEffect(() => {
    let alive = true
    void api
      .listDownloadHistory()
      .then((rows) => {
        if (!alive) return
        setStates((current) => {
          let next: Record<string, DownloadState> | null = null
          for (const row of rows) {
            if (row.status === 'saved' || current[row.videoId]) continue
            next ??= { ...current }
            next[row.videoId] = {
              status: row.status,
              percent: row.percent,
              error: row.error,
              request: {
                videoId: row.videoId,
                title: row.title,
                artist: row.artist,
                album: row.album
              },
              trackId: row.trackId,
              updatedAt: row.updatedAt
            }
          }
          return next ?? current
        })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  const save = useCallback(async (request: SaveToLibraryRequest): Promise<number> => {
    setStates((current) => ({
      ...current,
      [request.videoId]: {
        status: 'queued',
        percent: null,
        error: null,
        request,
        trackId: null,
        updatedAt: Date.now()
      }
    }))
    try {
      const trackId = await api.saveToLibrary(request)
      setSaved((current) => {
        if (current.has(request.videoId)) return current
        const next = new Set(current)
        next.add(request.videoId)
        return next
      })
      setStates((current) => {
        const previous = current[request.videoId]
        if (!previous) return current
        return {
          ...current,
          [request.videoId]: { ...previous, status: 'saved', percent: 100, trackId, updatedAt: Date.now() }
        }
      })
      return trackId
    } catch (cause) {
      const message = messageOf(cause)
      setStates((current) => {
        const previous = current[request.videoId]
        // A cancel is a decision, not a failure: it keeps its own status so the
        // panel offers Retry rather than showing an error the user did not make.
        const cancelled = previous?.status === 'cancelled' || isCancellation(message)
        return {
          ...current,
          [request.videoId]: {
            status: cancelled ? 'cancelled' : 'failed',
            percent: null,
            error: cancelled ? null : message,
            request: previous?.request ?? request,
            trackId: previous?.trackId ?? null,
            updatedAt: Date.now()
          }
        }
      })
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

  const cancel = useCallback((videoId: string): void => {
    // The main process answers with a `cancelled` event; this keeps the button
    // from needing a second click while that round trip is in flight.
    setStates((current) => {
      const previous = current[videoId]
      if (!previous) return current
      return {
        ...current,
        [videoId]: { ...previous, status: 'cancelled', percent: null, error: null, updatedAt: Date.now() }
      }
    })
    void api.cancelSave(videoId).catch(() => undefined)
  }, [])

  const retry = useCallback(
    (videoId: string): void => {
      const request = states[videoId]?.request
      if (!request) return
      void save(request).catch(() => undefined)
    },
    [save, states]
  )

  const dismiss = useCallback(
    (videoId: string): void => {
      const previous = states[videoId]
      if (!previous) return
      // An active save stays in the panel; dismissing it would hide work that is
      // still writing to disk. Cancel is the action for that row.
      if (
        previous.status === 'queued' ||
        previous.status === 'downloading' ||
        previous.status === 'finishing' ||
        previous.status === 'indexing'
      ) {
        return
      }
      setStates((current) => {
        const next = { ...current }
        delete next[videoId]
        return next
      })
      // Without this the row would be hydrated again after a restart.
      void api.dismissDownload(videoId).catch(() => undefined)
    },
    [states]
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

  const items: SaveItem[] = Object.entries(states)
    .map(([videoId, state]) => ({ videoId, ...state }))
    .sort((left, right) => right.updatedAt - left.updatedAt)

  return { states, items, saved, save, saveMany, cancel, retry, dismiss, refreshSaved }
}
