import { useCallback, useEffect, useRef, useState, type DragEvent, type RefObject } from 'react'

export interface DropTarget {
  index: number
  edge: 'before' | 'after'
}

export interface RowReorder {
  /** Index of the row being dragged, or null. */
  draggingIndex: number | null
  /** Which row the pointer is over, and which half of it. */
  dropAt: DropTarget | null
  start: (event: DragEvent<HTMLElement>, index: number) => void
  over: (event: DragEvent<HTMLElement>, index: number) => void
  drop: (event: DragEvent<HTMLElement>, index: number) => void
  end: () => void
  /** Where the row at `index` lands after moving `delta` rows, or null if it cannot. */
  targetFor: (index: number, delta: number) => number | null
}

/**
 * Where a dragged row lands.
 *
 * The answer has to be an index in the list *after* the move, because that is
 * what the drop position means on screen — dropping the first of five rows onto
 * the third gap puts it at index 2. The row being dragged is absent from the
 * final list, so every index after it shifts down by one.
 */
export function dropIndex(from: number, overIndex: number, edge: 'before' | 'after'): number {
  const insertion = edge === 'before' ? overIndex : overIndex + 1
  return insertion - (from < insertion ? 1 : 0)
}

/**
 * Drag-and-drop reordering for a list of rows.
 *
 * Uses the platform's own drag events rather than a pointer-tracking
 * reimplementation: the row markup stays a plain div, the drop into another
 * window or onto the desktop cannot be triggered by accident, and the browser
 * draws the drag image for free. The cost is that `dragover` has to call
 * `preventDefault` for a drop to be allowed at all, which is the one thing every
 * such implementation forgets.
 */
export function useRowReorder(options: {
  enabled: boolean
  itemCount: number
  rowHeight: number
  scroller: RefObject<HTMLElement | null>
  onMove: (fromIndex: number, toIndex: number) => void
}): RowReorder {
  const { enabled, itemCount, rowHeight, scroller, onMove } = options
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<DropTarget | null>(null)
  // The handlers read the source index from a ref as well: `drop` can arrive
  // before React has committed the state update from `dragstart`.
  const draggingRef = useRef<number | null>(null)

  const reset = useCallback((): void => {
    draggingRef.current = null
    setDraggingIndex(null)
    setDropAt(null)
  }, [])

  const start = useCallback(
    (event: DragEvent<HTMLElement>, index: number): void => {
      if (!enabled) return
      draggingRef.current = index
      setDraggingIndex(index)
      setDropAt({ index, edge: 'before' })
      event.dataTransfer.effectAllowed = 'move'
      // Chromium will not begin a drag without something on the transfer.
      event.dataTransfer.setData('text/plain', String(index))
    },
    [enabled]
  )

  const edgeAt = (event: DragEvent<HTMLElement>): 'before' | 'after' => {
    const rect = event.currentTarget.getBoundingClientRect()
    return event.clientY - rect.top < rect.height / 2 ? 'before' : 'after'
  }

  /** Scrolls the list when the pointer is held near its top or bottom edge. */
  const autoScroll = useCallback(
    (event: DragEvent<HTMLElement>): void => {
      const element = scroller.current
      if (!element) return
      const rect = element.getBoundingClientRect()
      const margin = Math.max(rowHeight, 32)
      if (event.clientY < rect.top + margin) element.scrollTop -= rowHeight
      else if (event.clientY > rect.bottom - margin) element.scrollTop += rowHeight
    },
    [scroller, rowHeight]
  )

  const over = useCallback(
    (event: DragEvent<HTMLElement>, index: number): void => {
      if (!enabled || draggingRef.current === null) return
      // Without this the browser assumes nothing wants the drop and the drop
      // handler never runs.
      event.preventDefault()
      event.dataTransfer.dropEffect = 'move'
      const edge = edgeAt(event)
      setDropAt((current) =>
        current && current.index === index && current.edge === edge ? current : { index, edge }
      )
      autoScroll(event)
    },
    [enabled, autoScroll]
  )

  const drop = useCallback(
    (event: DragEvent<HTMLElement>, index: number): void => {
      if (!enabled) return
      event.preventDefault()
      const from = draggingRef.current
      const edge = dropAt && dropAt.index === index ? dropAt.edge : edgeAt(event)
      reset()
      if (from === null) return
      const to = dropIndex(from, index, edge)
      if (to !== from) onMove(from, to)
    },
    [enabled, dropAt, onMove, reset]
  )

  const targetFor = useCallback(
    (index: number, delta: number): number | null => {
      if (!enabled) return null
      const to = index + delta
      if (to < 0 || to >= itemCount) return null
      return to
    },
    [enabled, itemCount]
  )

  // A drag whose source row scrolls out of the window unmounts that row, and the
  // browser then fires nothing at all — no dragend, no drop. Listening on the
  // window is the only way the state cannot be left stuck mid-drag.
  useEffect(() => {
    if (draggingIndex === null) return
    const stop = (): void => reset()
    window.addEventListener('dragend', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('dragend', stop)
      window.removeEventListener('drop', stop)
    }
  }, [draggingIndex, reset])

  return { draggingIndex, dropAt, start, over, drop, end: reset, targetFor }
}
