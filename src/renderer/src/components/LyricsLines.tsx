import type { Track, TrackLyrics } from '@shared/types'
import {
  LYRICS_OFFSET_MAX,
  LYRICS_OFFSET_STEP,
  formatLyricsOffset,
  type LyricLine
} from '@shared/lyrics'
import { ChevronDownIcon, MusicIcon, SpinnerIcon } from './Icons'
import { useLyricsFollow } from '../hooks/useLyricsFollow'

function emptyMessage(track: Track | null): string {
  if (!track) return 'Nothing is playing.'
  if (track.sourceKind !== 'local') {
    return 'This is a stream, so there is no file to read lyrics from.'
  }
  return 'No lyrics in this file yet. Use Find lyrics to search LRCLIB, add them from Edit tags, or put a .lrc file with the same name next to it.'
}

export interface LyricsLinesProps {
  lines: LyricLine[]
  active: number
  /** 0–1 through the line being sung. */
  lineProgress: number
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
 */
export function LyricsLines(props: LyricsLinesProps) {
  const { lines, active, lineProgress, onSeek, resetKey } = props
  const { listRef, activeRef, following, pauseFollow, resume } = useLyricsFollow(active, resetKey)

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
              {/* The fill is its own layer so the browser can interpolate a
                  transform instead of repainting a gradient stop four times a
                  second. `scaleX` also keeps the accent edge crisp at any width. */}
              {index === active ? (
                <span
                  className="np-lyric-fill"
                  aria-hidden="true"
                  style={{ transform: `scaleX(${lineProgress.toFixed(4)})` }}
                />
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
  active: number
  lineProgress: number
  onSeek: (line: LyricLine) => void
  resetKey: number | null
}

/** Loading, error, none, plain and timed, in that order of what wins. */
export function LyricsBody(props: LyricsBodyProps) {
  const { track, loading, error, lyrics, lines, active, lineProgress, onSeek, resetKey } = props

  if (loading) {
    return (
      <p className="np-lyrics-empty" role="status">
        <SpinnerIcon size={16} />
        <span>Reading the lyrics in this file…</span>
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
      active={active}
      lineProgress={lineProgress}
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
 */
export function LyricsOffsetControls(props: LyricsOffsetControlsProps) {
  const { offsetMs, saving, onShift } = props

  return (
    <>
      <button
        type="button"
        onClick={() => onShift(-LYRICS_OFFSET_STEP)}
        disabled={saving || offsetMs <= -LYRICS_OFFSET_MAX}
        title="Show the lyrics earlier by half a second"
      >
        −0.5 s
      </button>
      <span className="np-lyrics-offset" title="Timing correction for this track">
        {formatLyricsOffset(offsetMs)}
      </span>
      <button
        type="button"
        onClick={() => onShift(LYRICS_OFFSET_STEP)}
        disabled={saving || offsetMs >= LYRICS_OFFSET_MAX}
        title="Show the lyrics later by half a second"
      >
        +0.5 s
      </button>
      <button
        type="button"
        className="np-lyrics-reset"
        onClick={() => onShift(-offsetMs)}
        disabled={saving || offsetMs === 0}
        title="Remove the timing correction"
      >
        Reset
      </button>
    </>
  )
}
