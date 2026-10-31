import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Track, TrackLyrics } from '@shared/types'
import {
  LYRICS_OFFSET_MAX,
  activeLyricIndex,
  parseLyrics,
  type LyricLine
} from '@shared/lyrics'
import { api, messageOf } from '../api'
import { DoubleChevronLeftIcon } from './Icons'
import { LyricsBody, LyricsOffsetControls } from './LyricsLines'
import { LyricsStage } from './LyricsStage'

export interface LyricsPanelProps {
  track: Track | null
  /** Playback position, in the same timeline as the lyric timestamps. */
  positionMs: number
  durationMs: number
  open: boolean
  onSeek: (positionMs: number) => void
  /** The cover behind the full-window stage, already resolved by the player. */
  artworkKey?: string | null
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

/**
 * The lyrics a local file already has, shown next to the player.
 *
 * Read-only on purpose: the panel follows the song, can jump to a line, and
 * remembers a timing correction. It never writes to the file. A `.lrc` is
 * preferred over an embedded tag by the main process, and the header says which
 * one is on screen so the user is not guessing.
 *
 * The panel owns the data for both views. The full-window stage is a portal
 * rendered from here, so expanding is not a second fetch and the timing
 * correction is the same number in both places.
 */
export function LyricsPanel(props: LyricsPanelProps) {
  const { track, positionMs, durationMs, open, onSeek, artworkKey = null } = props
  const trackId = track?.id ?? null
  const [lyrics, setLyrics] = useState<TrackLyrics | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const requestRef = useRef(0)
  const expandRef = useRef<HTMLButtonElement | null>(null)
  const wasExpanded = useRef(false)

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

  // A line stays highlighted until the next one starts, so it can show how far
  // through it the song is. The file has no word timings, and pretending
  // otherwise with an invented curve would be a lie; a line-level fill is the
  // honest version of the same idea.
  const lineProgress = useMemo(() => {
    const line = active >= 0 ? lines[active] : undefined
    if (!line) return 0
    const start = line.timeMs + offsetMs
    const next = lines[active + 1]
    const end = next ? next.timeMs + offsetMs : Math.max(durationMs, start + 1)
    const span = Math.max(1, end - start)
    return Math.min(1, Math.max(0, (positionMs - start) / span))
  }, [active, lines, offsetMs, positionMs, durationMs])

  // Focus goes back to the button that opened the stage, not to the top of the
  // window, so a keyboard user lands where they left.
  useEffect(() => {
    if (expanded || !wasExpanded.current) return
    wasExpanded.current = false
    expandRef.current?.focus()
  }, [expanded])

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

  if (expanded) {
    return createPortal(
      <LyricsStage
        track={track}
        artworkKey={artworkKey}
        loading={loading}
        error={error}
        lyrics={lyrics}
        lines={lines}
        active={active}
        lineProgress={lineProgress}
        onSeek={seekTo}
        onClose={() => setExpanded(false)}
      />,
      document.body
    )
  }

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
        <LyricsBody
          track={track}
          loading={loading}
          error={error}
          lyrics={lyrics}
          lines={lines}
          active={active}
          lineProgress={lineProgress}
          onSeek={seekTo}
          resetKey={trackId}
        />
      </div>

      {lyrics && lines.length > 0 ? (
        <footer className="np-lyrics-foot">
          <button
            ref={expandRef}
            type="button"
            className="icon-button np-lyrics-expand"
            onClick={() => {
              wasExpanded.current = true
              setExpanded(true)
            }}
            title="Open the lyrics full-window"
            aria-label="Open the lyrics full-window"
          >
            <DoubleChevronLeftIcon size={16} />
          </button>
          <div className="np-lyrics-offset-group">
            <LyricsOffsetControls offsetMs={offsetMs} saving={saving} onShift={shift} />
          </div>
        </footer>
      ) : null}
    </aside>
  )
}
