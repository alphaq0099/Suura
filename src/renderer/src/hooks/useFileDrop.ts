import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

export interface FileDropState {
  /** True while an OS file drag is over the window, not an internal row drag. */
  dragging: boolean
  /** True while the dropped paths are being added and scanned. */
  busy: boolean
}

/**
 * Accepts files and folders dropped anywhere on the window.
 *
 * Electron no longer exposes `File.path`, so the path lookup lives in preload
 * (`webUtils.getPathForFile`). Internal drags, such as reordering the queue, do
 * not carry the `Files` type and are left entirely alone.
 */
export function useFileDrop(onPaths: (paths: string[]) => Promise<void>): FileDropState {
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const depthRef = useRef(0)
  const busyRef = useRef(false)
  const callbackRef = useRef(onPaths)

  useEffect(() => {
    callbackRef.current = onPaths
  }, [onPaths])

  useEffect(() => {
    const hasFiles = (event: DragEvent): boolean => {
      return Array.from(event.dataTransfer?.types ?? []).includes('Files')
    }

    const reset = (): void => {
      depthRef.current = 0
      setDragging(false)
    }

    const onDragEnter = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depthRef.current += 1
      setDragging(true)
    }

    const onDragOver = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      setDragging(true)
    }

    const onDragLeave = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      // Chromium reports a null relatedTarget when the pointer leaves the whole
      // window. Remembering a depth count alone can leave the overlay stuck when
      // that happens without a matching leave for a child element.
      if (!event.relatedTarget) {
        reset()
        return
      }
      depthRef.current = Math.max(0, depthRef.current - 1)
      if (depthRef.current === 0) setDragging(false)
    }

    const onDrop = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      reset()
      if (busyRef.current) return

      const paths: string[] = []
      for (const file of Array.from(event.dataTransfer?.files ?? [])) {
        try {
          const path = api.getPathForFile(file)
          if (path) paths.push(path)
        } catch {
          // A file without a native path (a dragged image from a browser, for
          // example) is simply not a library candidate.
        }
      }
      if (paths.length === 0) return

      busyRef.current = true
      setBusy(true)
      void callbackRef
        .current(paths)
        .catch(() => undefined)
        .finally(() => {
          busyRef.current = false
          setBusy(false)
        })
    }

    const onDragEnd = (): void => reset()

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    window.addEventListener('dragend', onDragEnd)
    window.addEventListener('blur', onDragEnd)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', onDragEnd)
      window.removeEventListener('blur', onDragEnd)
    }
  }, [])

  return { dragging, busy }
}
