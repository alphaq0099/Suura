import { useEffect, useMemo, useRef, useState } from 'react'
import type { TagCandidate, TagLookupResult, Track, TrackTagFields } from '@shared/types'
import { formatDuration } from '@shared/format'
import { api, messageOf } from '../api'
import { CloseIcon, SpinnerIcon } from './Icons'

/**
 * The review half of the tag finder.
 *
 * It proposes and never writes. Every field is a choice, and a field the file
 * already fills in starts unticked: the whole point of the feature is to fix
 * the tags YouTube got wrong, not to replace a library with a database's idea
 * of it. What is ticked here lands in the editor's draft, so the ordinary save
 * path (and its backup) is still the only thing that touches the file.
 */

export type AutoTagField =
  | 'title'
  | 'artist'
  | 'albumArtist'
  | 'album'
  | 'genre'
  | 'year'
  | 'trackNo'
  | 'trackTotal'
  | 'discNo'
  | 'discTotal'

export type AutoTagValues = Record<AutoTagField, string>

type GroupKey =
  | 'title'
  | 'artist'
  | 'albumArtist'
  | 'album'
  | 'genre'
  | 'year'
  | 'track'
  | 'disc'

interface FieldGroup {
  key: GroupKey
  label: string
  /** The draft fields this row writes. A position is two halves of one frame. */
  fields: readonly AutoTagField[]
}

const GROUPS: readonly FieldGroup[] = [
  { key: 'title', label: 'Title', fields: ['title'] },
  { key: 'artist', label: 'Artist', fields: ['artist'] },
  { key: 'albumArtist', label: 'Album artist', fields: ['albumArtist'] },
  { key: 'album', label: 'Album', fields: ['album'] },
  { key: 'genre', label: 'Genre', fields: ['genre'] },
  { key: 'year', label: 'Year', fields: ['year'] },
  { key: 'track', label: 'Track', fields: ['trackNo', 'trackTotal'] },
  { key: 'disc', label: 'Disc', fields: ['discNo', 'discTotal'] }
]

const PROVIDER_LABEL: Record<TagCandidate['provider'], string> = {
  itunes: 'iTunes',
  musicbrainz: 'MusicBrainz'
}

const CONFIDENCE_LABEL: Record<TagCandidate['confidence'], string> = {
  strong: 'Strong match',
  likely: 'Likely match',
  weak: 'Possible match'
}

function valuesOf(candidate: TagCandidate): AutoTagValues {
  return {
    title: candidate.title,
    artist: candidate.artist,
    albumArtist: candidate.albumArtist ?? '',
    album: candidate.album ?? '',
    genre: candidate.genre ?? '',
    year: candidate.year ? String(candidate.year) : '',
    trackNo: candidate.trackNo ? String(candidate.trackNo) : '',
    trackTotal: candidate.trackTotal ? String(candidate.trackTotal) : '',
    discNo: candidate.discNo ? String(candidate.discNo) : '',
    discTotal: candidate.discTotal ? String(candidate.discTotal) : ''
  }
}

/** `3 of 12`, `3`, or blank. */
function positionText(no: string, total: string): string {
  const left = no.trim()
  const right = total.trim()
  if (left.length === 0) return ''
  return right.length > 0 ? `${left} of ${right}` : left
}

function groupText(values: AutoTagValues, group: FieldGroup): string {
  if (group.key === 'track') return positionText(values.trackNo, values.trackTotal)
  if (group.key === 'disc') return positionText(values.discNo, values.discTotal)
  return values[group.fields[0] as AutoTagField] ?? ''
}

/** A group is "filled" when the file already says something there. */
function groupFilled(values: AutoTagValues, group: FieldGroup): boolean {
  return group.fields.some((field) => values[field].trim().length > 0)
}

/**
 * The default choice: every blank field the match can fill. A filled field is
 * never preselected, because replacing one is a decision the user makes on
 * purpose.
 */
function defaultChoice(candidate: AutoTagValues, current: AutoTagValues): Set<GroupKey> {
  const chosen = new Set<GroupKey>()
  for (const group of GROUPS) {
    if (groupFilled(current, group)) continue
    if (groupText(candidate, group).trim().length > 0) chosen.add(group.key)
  }
  return chosen
}

export interface AutoTagPanelProps {
  track: Track
  current: AutoTagValues
  onApply: (fields: TrackTagFields) => void
  onClose: () => void
}

export function AutoTagPanel(props: AutoTagPanelProps) {
  const { track, current, onApply, onClose } = props
  const [result, setResult] = useState<TagLookupResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(0)
  const [chosen, setChosen] = useState<Set<GroupKey>>(new Set())

  useEffect(() => {
    let live = true
    setLoading(true)
    api
      .findTrackTags(track.id)
      .then((found) => {
        if (!live) return
        setResult(found)
        setSelected(0)
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
  const proposed = useMemo(() => (candidate ? valuesOf(candidate) : null), [candidate])
  // The "now" column is the draft as it was when the finder opened. Freezing it
  // keeps a tick the user just made from being recomputed by an unrelated
  // keystroke in the form behind the panel.
  const currentAtOpen = useRef(current)

  // Every time the selected match changes, the ticked fields start from the
  // safe default again: carrying a choice across two different matches would
  // mean applying a field nobody looked at.
  useEffect(() => {
    setChosen(proposed ? defaultChoice(proposed, currentAtOpen.current) : new Set<GroupKey>())
  }, [proposed])

  const failedProviders = (result?.providers ?? []).filter((provider) => !provider.ok)

  const toggle = (key: GroupKey): void => {
    setChosen((existing) => {
      const next = new Set(existing)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const apply = (): void => {
    if (!proposed || chosen.size === 0) return
    const next: TrackTagFields = {}

    if (chosen.has('title')) next.title = proposed.title.trim() || null
    if (chosen.has('artist')) next.artist = proposed.artist.trim() || null
    if (chosen.has('albumArtist')) next.albumArtist = proposed.albumArtist.trim() || null
    if (chosen.has('album')) next.album = proposed.album.trim() || null
    if (chosen.has('genre')) next.genre = proposed.genre.trim() || null

    if (chosen.has('year')) {
      const year = Number(proposed.year)
      if (Number.isInteger(year) && year >= 1000 && year <= 3000) next.year = year
    }

    if (chosen.has('track')) {
      const no = Number(proposed.trackNo)
      if (Number.isInteger(no) && no >= 1) {
        next.trackNo = no
        const total = Number(proposed.trackTotal)
        next.trackTotal = Number.isInteger(total) && total >= 1 ? total : null
      }
    }

    if (chosen.has('disc')) {
      const no = Number(proposed.discNo)
      if (Number.isInteger(no) && no >= 1) {
        next.discNo = no
        const total = Number(proposed.discTotal)
        next.discTotal = Number.isInteger(total) && total >= 1 ? total : null
      }
    }

    onApply(next)
  }

  return (
    <section className="auto-tag" aria-label="Tag matches">
      <header className="auto-tag-head">
        <div>
          <h3>Find tags</h3>
          <p className="subtitle">
            {loading
              ? 'Asking iTunes and MusicBrainz…'
              : candidates.length === 0
                ? 'No match came back.'
                : `${candidates.length} ${candidates.length === 1 ? 'match' : 'matches'}, best first.`}
          </p>
        </div>
        <button
          type="button"
          className="icon-button subtle"
          title="Close the tag finder"
          aria-label="Close the tag finder"
          onClick={onClose}
        >
          <CloseIcon size={14} />
        </button>
      </header>

      {loading ? (
        <p className="auto-tag-status" role="status">
          <SpinnerIcon size={14} />
          <span>Looking up this file by its title, artist and length…</span>
        </p>
      ) : error ? (
        <p className="banner error" role="alert">
          {error}
        </p>
      ) : candidates.length === 0 ? (
        <p className="auto-tag-status" role="status">
          Nothing close enough. Try correcting the title or artist above, then find tags again.
        </p>
      ) : (
        <>
          <ul className="auto-tag-list" role="radiogroup" aria-label="Matches">
            {candidates.map((match, index) => (
              <li key={`${match.provider}:${match.providerId}:${index}`}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={index === selected}
                  className={`auto-tag-match${index === selected ? ' selected' : ''}`}
                  onClick={() => setSelected(index)}
                >
                  <span className="auto-tag-match-text">
                    <strong>{match.title}</strong>
                    <span className="subtitle">
                      {match.artist}
                      {match.album ? ` · ${match.album}` : ''}
                      {match.year ? ` · ${match.year}` : ''}
                      {match.durationMs ? ` · ${formatDuration(match.durationMs)}` : ''}
                    </span>
                  </span>
                  <span className="auto-tag-score">
                    <span className={`auto-tag-badge ${match.confidence}`}>
                      {CONFIDENCE_LABEL[match.confidence]}
                    </span>
                    <span className="subtitle">
                      {PROVIDER_LABEL[match.provider]} · {Math.round(match.score * 100)}%
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {proposed ? (
            <div className="auto-tag-fields">
              {GROUPS.map((group) => {
                const next = groupText(proposed, group)
                const now = groupText(current, group)
                const same = next.trim() === now.trim()
                return (
                  <label
                    key={group.key}
                    className={`auto-tag-field${next.trim().length === 0 ? ' empty' : ''}`}
                  >
                    <input
                      type="checkbox"
                      checked={chosen.has(group.key)}
                      disabled={next.trim().length === 0}
                      onChange={() => toggle(group.key)}
                    />
                    <span className="auto-tag-field-name">{group.label}</span>
                    <span className="auto-tag-field-value">
                      {next.trim().length === 0 ? 'not offered' : next}
                    </span>
                    <span className="auto-tag-field-current">
                      {same
                        ? 'same'
                        : now.trim().length === 0
                          ? 'new'
                          : `now: ${now}`}
                    </span>
                  </label>
                )
              })}
            </div>
          ) : null}
        </>
      )}

      {failedProviders.length > 0 ? (
        <p className="field-note">
          {failedProviders.map((provider) => provider.message).join(' ')}
        </p>
      ) : null}

      <p className="field-note auto-tag-note">
        Fields the file already fills in start unticked. Ticking one replaces what is there; the file is only
        rewritten when you save.
      </p>

      <footer className="auto-tag-foot">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          onClick={apply}
          disabled={!proposed || chosen.size === 0}
        >
          Use these tags
        </button>
      </footer>
    </section>
  )
}
