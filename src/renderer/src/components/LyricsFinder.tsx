import { useEffect, useState } from 'react'
import type { LyricsCandidate, LyricsLookupResult, Track } from '@shared/types'
import { formatDuration } from '@shared/format'
import { api, messageOf } from '../api'
import { CloseIcon, SpinnerIcon } from './Icons'

const CONFIDENCE_LABEL: Record<LyricsCandidate['confidence'], string> = {
  strong: 'Strong match',
  likely: 'Likely match',
  weak: 'Possible match'
}

export interface LyricsFinderProps {
  track: Track
  /** Stores the chosen match; the panel closes the finder when it resolves. */
  onUse: (candidate: LyricsCandidate) => Promise<void>
  onClose: () => void
}

/**
 * The review half of the lyrics finder.
 *
 * It proposes and never stores: the match the user chooses is handed back to
 * the panel, which is the only thing that writes a row. The text travels with
 * the candidate, so the list and the stored copy are the same response rather
 * than two requests that could disagree.
 */
export function LyricsFinder(props: LyricsFinderProps) {
  const { track, onUse, onClose } = props
  const [result, setResult] = useState<LyricsLookupResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(0)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    setLoading(true)
    setError(null)
    setActionError(null)
    api
      .findTrackLyrics(track.id)
      .then((found) => {
        if (!live) return
        setResult(found)
        setSelected(0)
        setError(found.message)
      })
      .catch((cause: unknown) => {
        if (live) setError(messageOf(cause))
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [track.id])

  const candidates = result?.candidates ?? []
  const candidate = candidates[selected] ?? null

  const choose = async (): Promise<void> => {
    if (!candidate || busy) return
    setBusy(true)
    setActionError(null)
    try {
      await onUse(candidate)
    } catch (cause) {
      setActionError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="lyrics-finder" aria-label="Find lyrics">
      <header className="auto-tag-head">
        <div>
          <h3>Find lyrics</h3>
          <p className="subtitle">
            {loading
              ? 'Asking LRCLIB…'
              : candidates.length === 0
                ? 'No match came back.'
                : `${candidates.length} ${candidates.length === 1 ? 'match' : 'matches'}, best first.`}
          </p>
        </div>
        <button
          type="button"
          className="icon-button subtle"
          title="Close the lyrics finder"
          aria-label="Close the lyrics finder"
          disabled={busy}
          onClick={onClose}
        >
          <CloseIcon size={14} />
        </button>
      </header>

      {loading ? (
        <p className="auto-tag-status" role="status">
          <SpinnerIcon size={14} />
          <span>Looking for lyrics that match this file’s title, artist and length…</span>
        </p>
      ) : candidates.length === 0 ? (
        <p className={error ? 'banner error' : 'auto-tag-status'} role={error ? 'alert' : 'status'}>
          {error ?? 'Nothing close enough. Try correcting the title or artist in Edit tags, then search again.'}
        </p>
      ) : (
        <ul className="auto-tag-list lyrics-finder-list" role="radiogroup" aria-label="Lyrics matches">
          {candidates.map((match, index) => (
            <li key={`${match.providerId}:${index}`}>
              <button
                type="button"
                role="radio"
                aria-checked={index === selected}
                className={`auto-tag-match lyrics-match${index === selected ? ' selected' : ''}`}
                onClick={() => setSelected(index)}
              >
                <span className="auto-tag-match-text">
                  <strong>{match.title}</strong>
                  <span className="subtitle">
                    {match.artist || 'Unknown artist'}
                    {match.album ? ` · ${match.album}` : ''}
                    {match.durationMs ? ` · ${formatDuration(match.durationMs)}` : ''}
                  </span>
                </span>
                <span className="auto-tag-score">
                  <span className={`auto-tag-badge ${match.confidence}`}>
                    {CONFIDENCE_LABEL[match.confidence]}
                  </span>
                  <span className="subtitle">
                    {match.synced ? 'Synced' : 'Plain'} · {Math.round(match.score * 100)}%
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && candidates.length > 0 ? <p className="field-note">{error}</p> : null}
      {actionError ? (
        <p className="banner error" role="alert">
          {actionError}
        </p>
      ) : null}

      <p className="field-note auto-tag-note">
        Lyrics come from LRCLIB, a public lyrics database. Choosing one keeps it with this track; writing it
        into the file is a separate step.
      </p>

      <footer className="auto-tag-foot lyrics-finder-foot">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          onClick={() => void choose()}
          disabled={!candidate || busy}
        >
          {busy ? <SpinnerIcon size={14} /> : null}
          <span>{busy ? 'Saving…' : 'Use these lyrics'}</span>
        </button>
      </footer>
    </section>
  )
}
