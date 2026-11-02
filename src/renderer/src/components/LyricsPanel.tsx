import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LyricsCandidate, Track, TrackLyrics } from '@shared/types'
import { LYRICS_OFFSET_MAX, lyricsTargetOf, parseLyrics, type LyricLine } from '@shared/lyrics'
import { api, messageOf } from '../api'
import { DoubleChevronLeftIcon, PencilIcon, SearchIcon, SpinnerIcon, TrashIcon } from './Icons'
import { LyricsFinder } from './LyricsFinder'
import { LyricsBody, LyricsOffsetControls } from './LyricsLines'
import { LyricsStage } from './LyricsStage'

export interface LyricsPanelProps {
  track: Track | null
  /** Playback position, in the same timeline as the lyric timestamps. */
  positionMs: number
  durationMs: number
  /**
   * The same position read at frame rate off the media element. The lines use
   * it for the fill, which has to move continuously; `positionMs` remains the
   * value everything else is happy to see a few times a second.
   */
  readPositionMs: () => number | null
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
 * A fetched copy shadows the file's own lyrics, so the footer under it offers a
 * way back — labelled by what is actually underneath. Over a file that has
 * lyrics it is "Use file lyrics"; over a file that has none the same click can
 * only drop the fetch, and the button says "Forget these lyrics" instead of
 * promising a copy that does not exist. Both are icons rather than words: the
 * footer shares its one row with the timing controls, and the source is already
 * named in the header.
 *
 * The panel owns the data for both views. The full-window stage is a portal
 * rendered from here, so expanding is not a second fetch and the timing
 * correction is the same number in both places.
 */
export function LyricsPanel(props: LyricsPanelProps) {
  const { track, positionMs, durationMs, readPositionMs, open, onSeek, artworkKey = null } = props
  const trackId = track?.id ?? null
  // What a request names: a library row's id, or a streaming link's video and
  // the values to search with. Memoised on the row so the effects below do not
  // see a new object on every render.
  const target = useMemo(() => (track ? lyricsTargetOf(track) : null), [track])
  const isStream = track?.sourceKind === 'youtube'
  // A stream can be looked up as readily as a file: the finder needs a title,
  // an artist and a length, all of which the row carries.
  const canFind = Boolean(track && (track.sourceKind === 'local' || track.sourceId))
  const [lyrics, setLyrics] = useState<TrackLyrics | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [finderOpen, setFinderOpen] = useState(false)
  const [action, setAction] = useState<'use-file' | 'write' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  /**
   * A write that was queued because this track is open for playback. It is not
   * an error: the fetched copy is still shown, and the file will receive it when
   * the track is no longer the one playing.
   */
  const [actionNotice, setActionNotice] = useState<string | null>(null)
  // What the file itself holds, asked only while a fetched copy is on screen.
  // It decides whether the switch-back button is a way back or a discard.
  const [fileLyrics, setFileLyrics] = useState<TrackLyrics | null>(null)
  const [fileChecked, setFileChecked] = useState(false)
  const requestRef = useRef(0)
  const fileRequestRef = useRef(0)
  const expandRef = useRef<HTMLButtonElement | null>(null)
  const wasExpanded = useRef(false)

  // A different track has different lyrics; clearing here also stops the old
  // ones flashing during the slide-in when the panel is reopened.
  useEffect(() => {
    setLyrics(null)
    setError(null)
    setFinderOpen(false)
    setActionError(null)
    setActionNotice(null)
    setFileLyrics(null)
    setFileChecked(false)
  }, [trackId])

  // The finder belongs to the open panel. Closing the panel should not leave a
  // hidden search waiting behind it for the next time it slides in.
  useEffect(() => {
    if (!open) setFinderOpen(false)
  }, [open])

  useEffect(() => {
    // Bumped first so a response for a previous row cannot land on this one.
    const request = ++requestRef.current
    if (!open || !target) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    api
      .getTrackLyrics(target)
      .then((found) => {
        if (requestRef.current === request) setLyrics(found)
      })
      .catch((cause) => {
        if (requestRef.current === request) setError(messageOf(cause))
      })
      .finally(() => {
        if (requestRef.current === request) setLoading(false)
      })
  }, [open, target])

  // A deferred write finishes in the main process after playback, possibly
  // while this panel is still open on the same track. Re-read the row then: the
  // fetched copy has been cleared and the file's own lyrics are what is left.
  useEffect(() => {
    if (!open || trackId === null || !target) return
    const token = api.on('pendingWriteChanged', (notice) => {
      if (notice.kind !== 'lyrics' || notice.trackId !== trackId) return
      if (!notice.ok) {
        setActionError(notice.message ?? 'The lyrics could not be written to the file.')
        return
      }
      setActionError(null)
      setActionNotice('Lyrics were added to the file.')
      void api
        .getTrackLyrics(target)
        .then((found) => setLyrics(found))
        .catch(() => undefined)
    })
    return () => api.off(token)
  }, [open, target, trackId])

  // Only a fetched row has the two file actions; the file's own lyrics have
  // nothing to switch back to. This is the same test the actions row uses,
  // named for the effect below that depends on it.
  const fetchedShown =
    lyrics?.source === 'lrclib' || lyrics?.source === 'genius' ? lyrics : null

  // The switch-back button promises to go back to the file, so it has to know
  // what the file actually has. Over a file with no lyrics of its own there is
  // nothing to go back to, and the same click is a discard — which is worth
  // offering (a match can be a bad pick) but must not be labelled a switch.
  // A read failure counts as "nothing to go back to": the discard is the
  // promise that still holds either way.
  useEffect(() => {
    // Bumped first so a request started for a previous row can never land on
    // this one, whichever branch below we take.
    const request = ++fileRequestRef.current
    if (!open || !target || !fetchedShown) {
      setFileLyrics(null)
      setFileChecked(false)
      return
    }
    // A stream has no file behind the fetch, so there is nothing to check and
    // the forget button is only ever a discard.
    if (isStream) {
      setFileLyrics(null)
      setFileChecked(true)
      return
    }
    setFileChecked(false)
    api
      .getFileLyrics(target)
      .then((found) => {
        if (fileRequestRef.current === request) {
          setFileLyrics(found)
          setFileChecked(true)
        }
      })
      .catch(() => {
        if (fileRequestRef.current === request) {
          setFileLyrics(null)
          setFileChecked(true)
        }
      })
  }, [open, target, fetchedShown, isStream])

  const parsed = useMemo(() => parseLyrics(lyrics?.text ?? ''), [lyrics])
  const lines = parsed.lines
  // The file's own `[offset:]` tag and the user's correction add up. Only the
  // user's half is ever written back to the database. Which line is current and
  // how far through it the song is belong to the lines themselves, which read
  // the media element at frame rate; this panel only hands them the numbers.
  const offsetMs = (lyrics?.offsetMs ?? 0) + parsed.fileOffsetMs

  // Focus goes back to the button that opened the stage, not to the top of the
  // window, so a keyboard user lands where they left.
  useEffect(() => {
    if (expanded || !wasExpanded.current) return
    wasExpanded.current = false
    expandRef.current?.focus()
  }, [expanded])

  const shift = (delta: number): void => {
    if (!target || !lyrics || saving) return
    const next = Math.max(-LYRICS_OFFSET_MAX, Math.min(LYRICS_OFFSET_MAX, lyrics.offsetMs + delta))
    if (next === lyrics.offsetMs) return
    const previous = lyrics
    setLyrics({ ...lyrics, offsetMs: next })
    setSaving(true)
    setError(null)
    api
      .setTrackLyricsOffset(target, next)
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
    if (!target) return
    const updated = await api.useTrackLyrics(target, candidate)
    setLyrics(updated)
    setError(null)
    setActionError(null)
    setActionNotice(null)
    setFinderOpen(false)
  }

  const runFileAction = async (kind: 'use-file' | 'write'): Promise<void> => {
    if (!target || action) return
    setAction(kind)
    setActionError(null)
    setActionNotice(null)
    try {
      if (kind === 'use-file') {
        setLyrics(await api.useFileLyrics(target))
      } else {
        const result = await api.writeTrackLyricsToFile(target)
        setLyrics(result.lyrics)
        if (result.deferred) {
          setActionNotice(
            result.message ??
              'These lyrics will be written to the file after this track finishes playing.'
          )
        }
      }
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
  const fetched = fetchedShown

  // The two file actions are icons now, so what used to be their labels lives
  // in the tooltips. The forget one stays honest about which promise holds:
  // over a file with lyrics of its own it is a way back, and over one without
  // it can only be a discard.
  const forgetLabel = !fileChecked
    ? 'Checking what the file has…'
    : isStream
      ? 'Forget these lyrics and stop showing them for this video'
      : fileLyrics
        ? 'Forget the fetched lyrics and show what the file has'
        : 'This file has no lyrics of its own, so this only drops the fetched copy'

  if (expanded) {
    return createPortal(
      <LyricsStage
        track={track}
        artworkKey={artworkKey}
        loading={loading}
        error={error}
        lyrics={lyrics}
        lines={lines}
        positionMs={positionMs}
        offsetMs={offsetMs}
        durationMs={durationMs}
        readPositionMs={readPositionMs}
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
          {canFind ? (
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
          {/* The source is named once, in this pill. When the words came from a
              provider that has a page, the pill is also the way back to it —
              that is the attribution LRCLIB and Genius ask for, and it needs no
              second copy of the same name further down. */}
          {fetched?.origin ? (
            <a
              className="np-lyrics-meta np-lyrics-meta-link"
              href={fetched.origin}
              target="_blank"
              rel="noreferrer"
              title={`Open these lyrics on ${fetched.source === 'genius' ? 'Genius' : 'LRCLIB'}`}
            >
              {meta}
            </a>
          ) : (
            <span className="np-lyrics-meta" title={lyrics?.origin ?? undefined}>
              {meta}
            </span>
          )}
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
            positionMs={positionMs}
            offsetMs={offsetMs}
            durationMs={durationMs}
            readPositionMs={readPositionMs}
            onSeek={seekTo}
            resetKey={trackId}
          />
        )}
      </div>

      {!finderOpen && actionError ? (
        <p className="banner error np-lyrics-action-error" role="alert">
          {actionError}
        </p>
      ) : null}

      {!finderOpen && actionNotice ? (
        <p className="banner np-lyrics-action-notice" role="status">
          {actionNotice}
        </p>
      ) : null}

      {/* The footer carries every action on the row the sheet already has: the
          expand affordance at the left, the two file actions beside it as
          icons, and the timing controls on the right. It is shown whenever
          there are lyrics or a fetch to act on, so plain-text lyrics keep
          their actions even though they have no timing to correct. */}
      {!finderOpen && (lyrics || fetched) ? (
        <footer className="np-lyrics-foot">
          {lines.length > 0 ? (
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
          ) : null}

          {fetched ? (
            <>
              <button
                type="button"
                className="icon-button np-lyrics-file-action np-lyrics-use-file danger"
                onClick={() => void runFileAction('use-file')}
                disabled={action !== null || !fileChecked}
                title={action === 'use-file' ? 'Forgetting…' : forgetLabel}
                aria-label={action === 'use-file' ? 'Forgetting…' : forgetLabel}
              >
                {action === 'use-file' ? <SpinnerIcon size={15} /> : <TrashIcon size={15} />}
              </button>
              {/* A stream has no file, so there is nothing to write the words
                  into: only the discard is offered for one. */}
              {!isStream ? (
                <button
                  type="button"
                  className="icon-button np-lyrics-file-action np-lyrics-write-file"
                  onClick={() => void runFileAction('write')}
                  disabled={action !== null}
                  title="Write these lyrics into the file's tags"
                  aria-label="Write these lyrics into the file's tags"
                >
                  {action === 'write' ? <SpinnerIcon size={15} /> : <PencilIcon size={15} />}
                </button>
              ) : null}
            </>
          ) : null}

          {lines.length > 0 ? (
            <div className="np-lyrics-offset-group">
              <LyricsOffsetControls offsetMs={offsetMs} saving={saving} onShift={shift} />
            </div>
          ) : null}
        </footer>
      ) : null}
    </aside>
  )
}
