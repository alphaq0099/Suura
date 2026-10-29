import { useEffect, useMemo, useRef, useState } from 'react'
import type { Track, TrackLyrics } from '@shared/types'
import {
  LYRICS_OFFSET_MAX,
  LYRICS_OFFSET_STEP,
  activeLyricIndex,
  formatLyricsOffset,
  parseLyrics,
  type LyricLine
} from '@shared/lyrics'
import { api, messageOf } from '../api'
import { SpinnerIcon } from './Icons'

export interface LyricsPanelProps {
  track: Track | null
  /** Playback position, in the same timeline as the lyric timestamps. */
  positionMs: number
  durationMs: number
  open: boolean
  onSeek: (positionMs: number) => void
}

function sourceLabel(lyrics: TrackLyrics): string {
  switch (lyrics.source) {
    case 'sidecar':
      return lyrics.origin ?? '.lrc file'
    case 'embedded':
      return 'File tags'
    case 'lrclib':
      return 'LRCLIB'
    case 'generated':
      return 'Generated'
  }
}

function emptyMessage(track: Track | null): string {
  if (!track) return 'Nothing is playing.'
  if (track.sourceKind !== 'local') {
    return 'This is a stream, so there is no file to read lyrics from.'
  }
  return 'No lyrics in this file. Add them from Edit tags, or put a .lrc file with the same name next to it.'
}

/**
 * The lyrics a local file already has, shown next to the player.
 *
 * Read-only on purpose: the panel follows the song, can jump to a line, and
 * remembers a timing correction. It never writes to the file. A `.lrc` is
 * preferred over an embedded tag by the main process, and the header says which
 * one is on screen so the user is not guessing.
 */
export function LyricsPanel(props: LyricsPanelProps) {
  const { track, positionMs, durationMs, open, onSeek } = props
  const trackId = track?.id ?? null
  const [lyrics, setLyrics] = useState<TrackLyrics | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const listRef = useRef<HTMLOListElement | null>(null)
  const activeRef = useRef<HTMLLIElement | null>(null)
  const requestRef = useRef(0)

  // A different track has different lyrics; clearing here also stops the old
  // ones flashing during the slide-in when the panel is reopened.
  useEffect(() => {
    setLyrics(null)
    setError(null)
  }, [trackId])

  useEffect(() => {
    if (!open || trackId === null) return
    const request = ++requestRef.current
    setLoading(true)
    setError(null)
    api
      .getTrackLyrics(trackId)
      .then((found) => {
        if (requestRef.current === request) setLyrics(found)
      })
      .catch((cause) => {
        if (requestRef.current === request) setError(messageOf(cause))
      })
      .finally(() => {
        if (requestRef.current === request) setLoading(false)
      })
  }, [open, trackId])

  const parsed = useMemo(() => parseLyrics(lyrics?.text ?? ''), [lyrics])
  const lines = parsed.lines
  // The file's own `[offset:]` tag and the user's correction add up. Only the
  // user's half is ever written back to the database.
  const offsetMs = (lyrics?.offsetMs ?? 0) + parsed.fileOffsetMs
  const active = activeLyricIndex(lines, positionMs, offsetMs)

  // Follow the song, but scroll only the list: `scrollIntoView` would also move
  // the page behind the player.
  useEffect(() => {
    if (!open || active < 0) return
    const list = listRef.current
    const row = activeRef.current
    if (!list || !row) return
    const top = row.offsetTop - list.clientHeight / 2 + row.offsetHeight / 2
    list.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }, [open, active])

  const shift = (delta: number): void => {
    if (!track || !lyrics || saving) return
    const next = Math.max(-LYRICS_OFFSET_MAX, Math.min(LYRICS_OFFSET_MAX, lyrics.offsetMs + delta))
    if (next === lyrics.offsetMs) return
    const previous = lyrics
    setLyrics({ ...lyrics, offsetMs: next })
    setSaving(true)
    setError(null)
    api
      .setTrackLyricsOffset(track.id, next)
      .then((updated) => {
        if (updated) setLyrics(updated)
      })
      .catch((cause) => {
        setLyrics(previous)
        setError(messageOf(cause))
      })
      .finally(() => setSaving(false))
  }

  const seekTo = (line: LyricLine): void => {
    const target = Math.max(0, line.timeMs + offsetMs)
    onSeek(durationMs > 0 ? Math.min(target, durationMs) : target)
  }

  const meta = loading
    ? 'Reading…'
    : error
      ? 'Could not read'
      : lyrics
        ? `${sourceLabel(lyrics)} · ${lines.length > 0 ? 'Synced' : 'Plain'}`
        : 'None found'

  return (
    <aside
      id="np-lyrics"
      className={open ? 'np-lyrics-panel open' : 'np-lyrics-panel'}
      aria-label="Lyrics"
    >
      <header className="np-lyrics-head">
        <h2>Lyrics</h2>
        <span className="np-lyrics-meta" title={lyrics?.origin ?? undefined}>
          {meta}
        </span>
      </header>

      <div className="np-lyrics-body">
        {loading ? (
          <p className="np-lyrics-empty" role="status">
            <SpinnerIcon size={16} />
            <span>Reading the lyrics in this file…</span>
          </p>
        ) : error ? (
          <p className="np-lyrics-error" role="alert">
            {error}
          </p>
        ) : !lyrics ? (
          <p className="np-lyrics-empty">{emptyMessage(track)}</p>
        ) : lines.length === 0 ? (
          <p className="np-lyrics-plain">{lyrics.text}</p>
        ) : (
          <ol className="np-lyrics-list" ref={listRef} title="Click a line to play from there">
            {lines.map((line, index) => (
              <li key={`${line.timeMs}-${index}`} ref={index === active ? activeRef : undefined}>
                <button
                  type="button"
                  className={index === active ? 'np-lyric-line current' : 'np-lyric-line'}
                  aria-current={index === active ? 'true' : undefined}
                  onClick={() => seekTo(line)}
                >
                  {line.text.length > 0 ? line.text : '♪'}
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>

      {lyrics && lines.length > 0 ? (
        <footer className="np-lyrics-foot">
          <button
            type="button"
            onClick={() => shift(-LYRICS_OFFSET_STEP)}
            disabled={saving || lyrics.offsetMs <= -LYRICS_OFFSET_MAX}
            title="Show the lyrics earlier by half a second"
          >
            −0.5 s
          </button>
          <span className="np-lyrics-offset" title="Timing correction for this track">
            {formatLyricsOffset(lyrics.offsetMs)}
          </span>
          <button
            type="button"
            onClick={() => shift(LYRICS_OFFSET_STEP)}
            disabled={saving || lyrics.offsetMs >= LYRICS_OFFSET_MAX}
            title="Show the lyrics later by half a second"
          >
            +0.5 s
          </button>
          <button
            type="button"
            className="np-lyrics-reset"
            onClick={() => shift(-lyrics.offsetMs)}
            disabled={saving || lyrics.offsetMs === 0}
            title="Remove the timing correction"
          >
            Reset
          </button>
        </footer>
      ) : null}
    </aside>
  )
}
