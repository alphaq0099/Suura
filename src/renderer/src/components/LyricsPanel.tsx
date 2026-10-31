import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LyricsCandidate, Track, TrackLyrics } from '@shared/types'
import {
  LYRICS_OFFSET_MAX,
  activeLyricIndex,
  parseLyrics,
  type LyricLine
} from '@shared/lyrics'
import { api, messageOf } from '../api'
import { DoubleChevronLeftIcon, SearchIcon } from './Icons'
import { LyricsFinder } from './LyricsFinder'
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
    case 'genius':
      return 'Genius'
    case 'generated':
      return 'Generated'
  }
}

/**
 * The lyrics a local file has, plus the finder for when it has none.
 *
 * The panel follows the song, can jump to a line, and remembers a timing
 * correction. A `.lrc` is preferred over an embedded tag by the main process,
 * and the header says which source is on screen so the user is not guessing.
 *
 * Finding lyrics is a proposal until the user chooses a match; that choice is
 * stored next to the track and labelled with the service that answered (LRCLIB
 * or Genius). Writing it into the file is a separate button, so a search can
 * never silently modify a file.
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
  const [finderOpen, setFinderOpen] = useState(false)
  const [action, setAction] = useState<'use-file' | 'write' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const requestRef = useRef(0)
  const expandRef = useRef<HTMLButtonElement | null>(null)
  const wasExpanded = useRef(false)

  // A different track has different lyrics; clearing here also stops the old
  // ones flashing during the slide-in when the panel is reopened.
  useEffect(() => {
    setLyrics(null)
    setError(null)
    setFinderOpen(false)
    setActionError(null)
  }, [trackId])

  // The finder belongs to the open panel. Closing the panel should not leave a
  // hidden search waiting behind it for the next time it slides in.
  useEffect(() => {
    if (!open) setFinderOpen(false)
  }, [open])

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

  const chooseLyrics = async (candidate: LyricsCandidate): Promise<void> => {
    if (!track) return
    const updated = await api.useTrackLyrics(track.id, candidate)
    setLyrics(updated)
    setError(null)
    setActionError(null)
    setFinderOpen(false)
  }

  const runFileAction = async (kind: 'use-file' | 'write'): Promise<void> => {
    if (!track || action) return
    setAction(kind)
    setActionError(null)
    try {
      const updated =
        kind === 'use-file'
          ? await api.useFileLyrics(track.id)
          : await api.writeTrackLyricsToFile(track.id)
      setLyrics(updated)
    } catch (cause) {
      setActionError(messageOf(cause))
    } finally {
      setAction(null)
    }
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

  // Only a fetched row has the two file actions; the file's own lyrics have
  // nothing to switch back to.
  const fetched = lyrics?.source === 'lrclib' || lyrics?.source === 'genius' ? lyrics : null

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
        <div className="np-lyrics-head-actions">
          {track?.sourceKind === 'local' ? (
            <button
              type="button"
              className="icon-button subtle np-lyrics-find"
              onClick={() => setFinderOpen(true)}
              disabled={loading || saving || finderOpen}
              title="Find lyrics on LRCLIB or Genius"
              aria-label="Find lyrics on LRCLIB or Genius"
            >
              <SearchIcon size={15} />
            </button>
          ) : null}
          <span className="np-lyrics-meta" title={lyrics?.origin ?? undefined}>
            {meta}
          </span>
        </div>
      </header>

      <div className="np-lyrics-body">
        {finderOpen && track ? (
          <LyricsFinder
            track={track}
            onUse={chooseLyrics}
            onClose={() => setFinderOpen(false)}
          />
        ) : (
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
        )}
      </div>

      {!finderOpen && fetched ? (
        <div className="np-lyrics-actions">
          <span className="np-lyrics-actions-source">
            From {fetched.source === 'genius' ? 'Genius' : 'LRCLIB'}
          </span>
          {fetched.source === 'genius' && fetched.origin ? (
            <a
              className="np-lyrics-actions-link"
              href={fetched.origin}
              target="_blank"
              rel="noreferrer"
              title="Open these lyrics on Genius"
            >
              Open on Genius
            </a>
          ) : null}
          <button
            type="button"
            className="np-lyrics-use-file"
            onClick={() => void runFileAction('use-file')}
            disabled={action !== null}
            title="Forget the fetched lyrics and show what the file has"
          >
            Use file lyrics
          </button>
          <button
            type="button"
            className="np-lyrics-write-file"
            onClick={() => void runFileAction('write')}
            disabled={action !== null}
            title="Write these lyrics into the file's tags"
          >
            {action === 'write' ? 'Writing…' : 'Write into file'}
          </button>
        </div>
      ) : null}

      {!finderOpen && actionError ? (
        <p className="banner error np-lyrics-action-error" role="alert">
          {actionError}
        </p>
      ) : null}

      {!finderOpen && lyrics && lines.length > 0 ? (
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
