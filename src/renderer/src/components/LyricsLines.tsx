import { useCallback, useEffect, useRef, useState } from 'react'
import type { Track, TrackLyrics } from '@shared/types'
import {
  LYRICS_OFFSET_MAX,
  LYRICS_OFFSET_STEP,
  activeLyricIndex,
  formatLyricsOffset,
  type LyricLine
} from '@shared/lyrics'
import { ChevronDownIcon, MusicIcon, SpinnerIcon } from './Icons'
import { useLyricsFollow } from '../hooks/useLyricsFollow'

function emptyMessage(track: Track | null): string {
  if (!track) return 'Nothing is playing.'
  if (track.sourceKind !== 'local') {
    return 'No lyrics for this stream yet. Use Find lyrics to search LRCLIB and Genius.'
  }
  return 'No lyrics in this file yet. Use Find lyrics to search LRCLIB and Genius, add them from Edit tags, or put a .lrc file with the same name next to it.'
}

export interface LyricsLinesProps {
  lines: LyricLine[]
  /**
   * The position the player publishes: the seed before the first frame is
   * drawn, and the fallback when the media element cannot be read.
   */
  positionMs: number
  offsetMs: number
  durationMs: number
  /** Reads the playing position at frame rate, when the player can supply it. */
  readPositionMs: (() => number | null) | null
  onSeek: (line: LyricLine) => void
  /** Track id: a new song starts following again. */
  resetKey: number | null
}

/**
 * The timed lines, as a list that follows the song.
 *
 * Every line is a seek target, so it is a button that looks like a line. The
 * current one is the only bright text and it fills as it is sung; the file has
 * no word timings, so this is a line-level fill rather than a fake karaoke
 * sweep. The side panel and the full-window stage share this list.
 *
 * Which line is current and how far through it the song is both come from the
 * media element itself, sampled once a frame. The position the player publishes
 * only moves a few times a second, which is enough to know a song is playing
 * but not enough to draw a bar across a line: at that rate the fill steps, each
 * step restarts a smoothing transition so the line visibly stalls at its start,
 * and the line before it is torn down a quarter of a second short of its end.
 * The loop below writes the fill straight to the DOM and re-renders only when
 * the line itself changes, so both stay continuous without a React render per
 * frame.
 */
export function LyricsLines(props: LyricsLinesProps) {
  const { lines, positionMs, offsetMs, durationMs, readPositionMs, onSeek, resetKey } = props
  const [active, setActive] = useState(() => activeLyricIndex(lines, positionMs, offsetMs))
  const { listRef, activeRef, following, pauseFollow, resume } = useLyricsFollow(active, resetKey)

  // The loop reads the newest values without re-subscribing whenever one of them
  // changes: an offset edit or a new line set should change what it computes,
  // not tear the animation down and start again.
  const liveRef = useRef({ lines, offsetMs, durationMs, positionMs, active })
  liveRef.current = { lines, offsetMs, durationMs, positionMs, active }

  // The fill is its own layer so the browser only has to move a transform. It is
  // attached through a callback rather than a plain ref so that its very first
  // frame is empty, instead of a full-width bar showing for the one frame before
  // the loop catches up with it.
  const fillRef = useRef<HTMLSpanElement | null>(null)
  const attachFill = useCallback((node: HTMLSpanElement | null) => {
    fillRef.current = node
    if (node) node.style.transform = 'scaleX(0)'
  }, [])

  // A new sheet starts from where the song actually is, rather than carrying an
  // index that pointed into the previous one and may not exist in this list.
  useEffect(() => {
    setActive(activeLyricIndex(lines, liveRef.current.positionMs, offsetMs))
  }, [lines, offsetMs])

  useEffect(() => {
    if (lines.length === 0) return
    let frame = 0
    const tick = (): void => {
      frame = window.requestAnimationFrame(tick)
      const live = liveRef.current
      const at = readPositionMs ? (readPositionMs() ?? live.positionMs) : live.positionMs
      const current = activeLyricIndex(live.lines, at, live.offsetMs)
      if (current !== live.active) {
        live.active = current
        setActive(current)
      }
      const fill = fillRef.current
      if (!fill) return
      const line = current >= 0 ? live.lines[current] : undefined
      if (!line) {
        fill.style.transform = 'scaleX(0)'
        return
      }
      const start = line.timeMs + live.offsetMs
      const next = live.lines[current + 1]
      const end = next ? next.timeMs + live.offsetMs : Math.max(live.durationMs, start + 1)
      const span = Math.max(1, end - start)
      const progress = Math.min(1, Math.max(0, (at - start) / span))
      fill.style.transform = `scaleX(${progress.toFixed(4)})`
    }
    frame = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(frame)
  }, [lines, readPositionMs])

  return (
    <div className="lyrics-follow">
      <ol
        className="np-lyrics-list"
        ref={listRef}
        title="Click a line to play from there"
        onWheel={pauseFollow}
      >
        {lines.map((line, index) => (
          <li key={`${line.timeMs}-${index}`} ref={index === active ? activeRef : undefined}>
            <button
              type="button"
              className={index === active ? 'np-lyric-line current' : 'np-lyric-line'}
              aria-current={index === active ? 'true' : undefined}
              onClick={() => onSeek(line)}
            >
              {/* The fill has no inline style of its own: the loop above is its
                  only writer, so a re-render cannot snap it back to a stale
                  value. `scaleX` keeps the accent edge crisp at any width. */}
              {index === active ? (
                <span className="np-lyric-fill" aria-hidden="true" ref={attachFill} />
              ) : null}
              <span className="np-lyric-text">{line.text.length > 0 ? line.text : '♪'}</span>
            </button>
          </li>
        ))}
      </ol>

      {!following && active >= 0 ? (
        <button
          type="button"
          className="np-lyrics-resume"
          onClick={resume}
          title="Scroll back to the line being sung"
        >
          <ChevronDownIcon size={14} />
          <span>Jump to the current line</span>
        </button>
      ) : null}
    </div>
  )
}

export interface LyricsBodyProps {
  track: Track | null
  loading: boolean
  error: string | null
  lyrics: TrackLyrics | null
  lines: LyricLine[]
  positionMs: number
  offsetMs: number
  durationMs: number
  readPositionMs: (() => number | null) | null
  onSeek: (line: LyricLine) => void
  resetKey: number | null
}

/** Loading, error, none, plain and timed, in that order of what wins. */
export function LyricsBody(props: LyricsBodyProps) {
  const { track, loading, error, lyrics, lines, onSeek, resetKey } = props
  const { positionMs, offsetMs, durationMs, readPositionMs } = props

  if (loading) {
    return (
      <p className="np-lyrics-empty" role="status">
        <SpinnerIcon size={16} />
        <span>Reading the lyrics…</span>
      </p>
    )
  }
  if (error) {
    return (
      <p className="np-lyrics-error" role="alert">
        {error}
      </p>
    )
  }
  if (!lyrics) {
    return (
      <p className="np-lyrics-empty np-lyrics-none">
        <MusicIcon size={22} />
        <span>{emptyMessage(track)}</span>
      </p>
    )
  }
  if (lines.length === 0) {
    return <p className="np-lyrics-plain">{lyrics.text}</p>
  }
  return (
    <LyricsLines
      lines={lines}
      positionMs={positionMs}
      offsetMs={offsetMs}
      durationMs={durationMs}
      readPositionMs={readPositionMs}
      onSeek={onSeek}
      resetKey={resetKey}
    />
  )
}

export interface LyricsOffsetControlsProps {
  offsetMs: number
  saving: boolean
  onShift: (delta: number) => void
}

/**
 * The timing correction, shared by the panel and the stage so the two cannot
 * drift apart. Only the user's own correction is written back, never the file's
 * `[offset:]`.
 *
 * The readout doubles as the way back to zero. At zero there is nothing to undo,
 * so it stays a plain indicator and does not wear the pill the steps do; once
 * the timing has been nudged it takes on the shape of a control, and pressing
 * it puts the correction back to 0.0 s. That is what retires the separate Reset
 * button, which spent most of its life doing nothing.
 */
export function LyricsOffsetControls(props: LyricsOffsetControlsProps) {
  const { offsetMs, saving, onShift } = props

  return (
    <>
      <button
        type="button"
        className="np-lyrics-step"
        onClick={() => onShift(-LYRICS_OFFSET_STEP)}
        disabled={saving || offsetMs <= -LYRICS_OFFSET_MAX}
        title="Show the lyrics earlier by half a second"
      >
        −0.5
      </button>
      <button
        type="button"
        className="np-lyrics-offset"
        onClick={() => onShift(-offsetMs)}
        disabled={saving || offsetMs === 0}
        title={
          offsetMs === 0
            ? 'Timing correction for this track'
            : 'Remove the timing correction and go back to 0.0 s'
        }
      >
        {formatLyricsOffset(offsetMs)}
      </button>
      <button
        type="button"
        className="np-lyrics-step"
        onClick={() => onShift(LYRICS_OFFSET_STEP)}
        disabled={saving || offsetMs >= LYRICS_OFFSET_MAX}
        title="Show the lyrics later by half a second"
      >
        +0.5
      </button>
    </>
  )
}
