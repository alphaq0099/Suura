import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  TagBatchApplyResult,
  TagBatchMode,
  TagBatchProgress,
  TagBatchSnapshot,
  TagBatchUndoResult
} from '@shared/types'
import { tagBatchActionable } from '@shared/tag-batch'
import { api, messageOf } from '../api'

export type TagBatchPhase = 'scanning' | 'review' | 'applying' | 'result'

export interface UseTagBatchResult {
  phase: TagBatchPhase
  progress: TagBatchProgress | null
  snapshot: TagBatchSnapshot | null
  selected: ReadonlySet<string>
  mode: TagBatchMode
  applying: boolean
  undoing: boolean
  result: TagBatchApplyResult | null
  undoResult: TagBatchUndoResult | null
  error: string | null
  toggle: (itemId: string) => void
  selectAll: (on: boolean) => void
  setMode: (mode: TagBatchMode) => void
  apply: () => Promise<void>
  undo: () => Promise<void>
}

/**
 * Strong and likely matches start ticked, and only when they have something to
 * write in the current mode. A weak match is shown but left for the user: a
 * wrong title is worse than a missing album.
 */
function defaultSelection(snapshot: TagBatchSnapshot, mode: TagBatchMode): Set<string> {
  const next = new Set<string>()
  for (const item of snapshot.items) {
    if (item.status !== 'match' || !item.match) continue
    if (item.match.confidence === 'weak') continue
    if (tagBatchActionable(item.match.changes, mode).length === 0) continue
    next.add(item.id)
  }
  return next
}

/**
 * Drives one tag batch from scan to review to write.
 *
 * The scan runs in the main process and can finish before `startTagBatch`
 * resolves, so the finished snapshot is fetched once the job id is known as
 * well as when the review event arrives; both paths land in `showSnapshot`,
 * which is idempotent. Closing the dialog cancels a scan that is still running.
 *
 * Switching the mode recomputes the default selection, because what is worth
 * ticking changes with it: a row with nothing blank has nothing to fill, and a
 * row that already agrees with its match has nothing to replace either. A
 * manual tick is not carried across, for the same reason the single-track
 * finder resets its ticks when another match is chosen.
 */
export function useTagBatch(trackIds: number[]): UseTagBatchResult {
  const trackIdsRef = useRef(trackIds)
  const jobRef = useRef<string | null>(null)

  const [phase, setPhase] = useState<TagBatchPhase>('scanning')
  const [progress, setProgress] = useState<TagBatchProgress | null>(null)
  const [snapshot, setSnapshot] = useState<TagBatchSnapshot | null>(null)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [mode, setModeState] = useState<TagBatchMode>('fill')
  const [applying, setApplying] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [result, setResult] = useState<TagBatchApplyResult | null>(null)
  const [undoResult, setUndoResult] = useState<TagBatchUndoResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const showSnapshot = useCallback((found: TagBatchSnapshot) => {
    setSnapshot(found)
    setSelected(defaultSelection(found, 'fill'))
    setPhase('review')
  }, [])

  useEffect(() => {
    let live = true

    const token = api.on('tagBatchProgress', (update) => {
      if (!live) return
      if (jobRef.current && update.jobId !== jobRef.current) return
      setProgress(update)
      if (update.phase !== 'review') return
      // The event can beat the `start` promise here, so it is allowed to name
      // the job. A review event is the scan's own word that it is finished.
      if (!jobRef.current) jobRef.current = update.jobId
      void api
        .getTagBatch(update.jobId)
        .then((found) => {
          if (live && found) showSnapshot(found)
        })
        .catch((cause) => {
          if (live) setError(messageOf(cause))
        })
    })

    api
      .startTagBatch(trackIdsRef.current)
      .then(({ jobId }) => {
        if (!live) {
          void api.cancelTagBatch(jobId)
          return
        }
        jobRef.current = jobId
        return api.getTagBatch(jobId).then((found) => {
          if (live && found) showSnapshot(found)
        })
      })
      .catch((cause) => {
        if (live) setError(messageOf(cause))
      })

    return () => {
      live = false
      api.off(token)
      if (jobRef.current) void api.cancelTagBatch(jobRef.current)
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
          ? new Set(
              snapshot.items
                .filter(
                  (item) =>
                    item.status === 'match' &&
                    item.match !== null &&
                    tagBatchActionable(item.match.changes, mode).length > 0
                )
                .map((item) => item.id)
            )
          : new Set<string>()
      )
    },
    [mode, snapshot]
  )

  const setMode = useCallback(
    (next: TagBatchMode) => {
      setModeState(next)
      if (snapshot) setSelected(defaultSelection(snapshot, next))
    },
    [snapshot]
  )

  const apply = useCallback(async () => {
    const jobId = jobRef.current
    if (!jobId || !snapshot || applying) return
    const itemIds = snapshot.items.filter((item) => selected.has(item.id)).map((item) => item.id)
    if (itemIds.length === 0) return

    setApplying(true)
    setPhase('applying')
    setError(null)
    try {
      setResult(await api.applyTagBatch(jobId, itemIds, mode))
      setPhase('result')
    } catch (cause) {
      setError(messageOf(cause))
      setPhase('review')
    } finally {
      setApplying(false)
    }
  }, [applying, mode, selected, snapshot])

  const undo = useCallback(async () => {
    const jobId = jobRef.current
    if (!jobId || undoing) return
    setUndoing(true)
    setError(null)
    try {
      setUndoResult(await api.undoTagBatch(jobId))
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
    mode,
    applying,
    undoing,
    result,
    undoResult,
    error,
    toggle,
    selectAll,
    setMode,
    apply,
    undo
  }
}
