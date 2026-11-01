import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  LyricsBatchApplyResult,
  LyricsBatchProgress,
  LyricsBatchSnapshot,
  LyricsBatchUndoResult
} from '@shared/types'
import { api, messageOf } from '../api'

export type LyricsBatchPhase = 'scanning' | 'review' | 'applying' | 'result'

export interface UseLyricsBatchResult {
  phase: LyricsBatchPhase
  progress: LyricsBatchProgress | null
  snapshot: LyricsBatchSnapshot | null
  selected: ReadonlySet<string>
  writeToFile: boolean
  applying: boolean
  undoing: boolean
  result: LyricsBatchApplyResult | null
  undoResult: LyricsBatchUndoResult | null
  error: string | null
  toggle: (itemId: string) => void
  selectAll: (on: boolean) => void
  setWriteToFile: (on: boolean) => void
  apply: () => Promise<void>
  undo: () => Promise<void>
}

/**
 * Strong and likely matches start ticked; a weak one is shown but left for the
 * user to choose, because a wrong lyric is worse than a missing one.
 */
function defaultSelection(snapshot: LyricsBatchSnapshot): Set<string> {
  const next = new Set<string>()
  for (const item of snapshot.items) {
    if (item.status === 'match' && item.match && item.match.confidence !== 'weak') {
      next.add(item.id)
    }
  }
  return next
}

/**
 * Drives one batch from scan to review to apply.
 *
 * The scan runs in the main process and can finish before `startLyricsBatch`
 * resolves, so the finished snapshot is fetched once the job id is known as
 * well as when the review event arrives; both paths land in `showSnapshot`,
 * which is idempotent. Closing the dialog cancels a scan that is still running
 * and leaves a finished job in main for the next few dialogs, but the undo
 * button only exists while this hook is mounted — that is what in-session means.
 */
export function useLyricsBatch(trackIds: number[]): UseLyricsBatchResult {
  const trackIdsRef = useRef(trackIds)
  const jobRef = useRef<string | null>(null)

  const [phase, setPhase] = useState<LyricsBatchPhase>('scanning')
  const [progress, setProgress] = useState<LyricsBatchProgress | null>(null)
  const [snapshot, setSnapshot] = useState<LyricsBatchSnapshot | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [writeToFile, setWriteToFileState] = useState(false)
  const [applying, setApplying] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [result, setResult] = useState<LyricsBatchApplyResult | null>(null)
  const [undoResult, setUndoResult] = useState<LyricsBatchUndoResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const showSnapshot = useCallback((found: LyricsBatchSnapshot) => {
    setSnapshot(found)
    setSelected(defaultSelection(found))
    setPhase('review')
  }, [])

  useEffect(() => {
    let live = true

    const token = api.on('lyricsBatchProgress', (update) => {
      if (!live) return
      if (jobRef.current && update.jobId !== jobRef.current) return
      setProgress(update)
      if (update.phase !== 'review') return
      // The event can beat the `start` promise here, so it is allowed to name
      // the job. A review event is the scan's own word that it is finished.
      if (!jobRef.current) jobRef.current = update.jobId
      void api
        .getLyricsBatch(update.jobId)
        .then((found) => {
          if (live && found) showSnapshot(found)
        })
        .catch((cause) => {
          if (live) setError(messageOf(cause))
        })
    })

    api
      .startLyricsBatch(trackIdsRef.current)
      .then(({ jobId }) => {
        if (!live) {
          void api.cancelLyricsBatch(jobId)
          return
        }
        jobRef.current = jobId
        return api.getLyricsBatch(jobId).then((found) => {
          if (live && found) showSnapshot(found)
        })
      })
      .catch((cause) => {
        if (live) setError(messageOf(cause))
      })

    return () => {
      live = false
      api.off(token)
      if (jobRef.current) void api.cancelLyricsBatch(jobRef.current)
    }
  }, [showSnapshot])

  const toggle = useCallback((itemId: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }, [])

  const selectAll = useCallback(
    (on: boolean) => {
      if (!snapshot) return
      setSelected(
        on
          ? new Set(snapshot.items.filter((item) => item.status === 'match').map((item) => item.id))
          : new Set<string>()
      )
    },
    [snapshot]
  )

  const setWriteToFile = useCallback((on: boolean) => setWriteToFileState(on), [])

  const apply = useCallback(async () => {
    const jobId = jobRef.current
    if (!jobId || !snapshot || applying) return
    const itemIds = snapshot.items.filter((item) => selected.has(item.id)).map((item) => item.id)
    if (itemIds.length === 0) return

    setApplying(true)
    setPhase('applying')
    setError(null)
    try {
      setResult(await api.applyLyricsBatch(jobId, itemIds, writeToFile))
      setPhase('result')
    } catch (cause) {
      setError(messageOf(cause))
      setPhase('review')
    } finally {
      setApplying(false)
    }
  }, [applying, selected, snapshot, writeToFile])

  const undo = useCallback(async () => {
    const jobId = jobRef.current
    if (!jobId || undoing) return
    setUndoing(true)
    setError(null)
    try {
      setUndoResult(await api.undoLyricsBatch(jobId))
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setUndoing(false)
    }
  }, [undoing])

  return {
    phase,
    progress,
    snapshot,
    selected,
    writeToFile,
    applying,
    undoing,
    result,
    undoResult,
    error,
    toggle,
    selectAll,
    setWriteToFile,
    apply,
    undo
  }
}
