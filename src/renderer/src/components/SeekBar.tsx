import { useState, type CSSProperties } from 'react'
import { formatDuration } from '@shared/format'

export interface SeekBarProps {
  positionMs: number
  durationMs: number
  /** Duration from the tags, used until the element reports one of its own. */
  fallbackMs?: number
  disabled: boolean
  onSeek: (positionMs: number) => void
  className?: string
}

/**
 * Elapsed time, scrubber, total time.
 *
 * Extracted from the player bar so the full-screen player can show the same
 * control without a second copy of the drag logic: while the pointer is down the
 * slider follows the pointer, not the element's current time, which only updates
 * a few times a second and would otherwise fight the drag.
 */
export function SeekBar({ positionMs, durationMs, fallbackMs = 0, disabled, onSeek, className }: SeekBarProps) {
  const [dragMs, setDragMs] = useState<number | null>(null)

  const shownMs = dragMs ?? positionMs
  const maxMs = Math.max(durationMs, fallbackMs, 1)
  const clampedMs = Math.min(shownMs, maxMs)

  const commit = (): void => {
    if (dragMs === null) return
    onSeek(dragMs)
    setDragMs(null)
  }

  // Published as a custom property so a skin can paint the filled portion of the
  // track without React re-rendering anything on every timeupdate.
  const style = { '--seek-progress': `${(clampedMs / maxMs) * 100}%` } as CSSProperties

  return (
    <div className={className ? `seek-bar ${className}` : 'seek-bar'} style={style}>
      <span className="time">{formatDuration(clampedMs)}</span>
      <input
        type="range"
        min={0}
        max={maxMs}
        step={250}
        value={clampedMs}
        disabled={disabled}
        onChange={(event) => setDragMs(Number(event.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        aria-label="Seek"
        aria-valuetext={`${formatDuration(clampedMs)} of ${formatDuration(maxMs)}`}
      />
      <span className="time">{formatDuration(maxMs)}</span>
    </div>
  )
}
