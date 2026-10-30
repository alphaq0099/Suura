import { useEffect, useRef, useState } from 'react'
import type { ArtworkChoice, Track } from '@shared/types'
import { api, messageOf } from '../api'
import { ArtworkImage } from './ArtworkImage'
import { CloseIcon, SearchIcon, SpinnerIcon, TrashIcon } from './Icons'

/**
 * The cover picker.
 *
 * It offers the pictures already on this machine first — the file's own art, a
 * `cover.jpg` beside it, the video the track came from — and asks the tag
 * providers only when the user presses the button. Every choice is a cached
 * artwork key, so the square-crop preview below is literally the image that
 * will be written; Save in the editor is still the only thing that touches the
 * file.
 */

export interface ArtworkPickerProps {
  track: Track
  /**
   * The editor's current intent: a cache key, `null` for "remove it", or
   * `undefined` while the file's own picture is still the answer.
   */
  selected: string | null | undefined
  onChoose: (key: string | null) => void
  onClose: () => void
}

export function ArtworkPicker(props: ArtworkPickerProps) {
  const { track, selected, onChoose, onClose } = props
  const [choices, setChoices] = useState<ArtworkChoice[]>([])
  const [loading, setLoading] = useState(true)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<string | null | undefined>(selected)
  /**
   * What the editor would save if the picker were closed right now. Picking the
   * same picture again is not a change, so the button stays disabled rather
   * than rewriting a cover that is already there.
   */
  const [baseline, setBaseline] = useState<string | null | undefined>(undefined)
  const selectionTouched = useRef(false)

  useEffect(() => {
    let live = true
    setLoading(true)
    api
      .getArtworkChoices(track.id)
      .then((found) => {
        if (!live) return
        setChoices(found)
        const current = found.find((choice) => choice.current)?.key ?? null
        setBaseline(current)
        // Until the user picks, the highlighted card is the picture on screen.
        if (!selectionTouched.current) setSelection(current)
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

  const findMore = async (): Promise<void> => {
    setSearching(true)
    setError(null)
    try {
      const found = await api.findArtworkCovers(track.id)
      setChoices((existing) => {
        const merged = [...existing]
        for (const choice of found) {
          if (!merged.some((one) => one.key === choice.key)) merged.push(choice)
        }
        return merged
      })
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setSearching(false)
    }
  }

  const choose = (key: string | null): void => {
    selectionTouched.current = true
    setSelection(key)
  }

  const canApply = selection !== undefined && selection !== baseline

  return (
    <section className="artwork-picker" aria-label="Cover art">
      <header className="auto-tag-head">
        <div>
          <h3>Cover art</h3>
          <p className="subtitle">
            {loading
              ? 'Looking for covers already on this machine…'
              : choices.length === 0
                ? 'No cover found yet.'
                : `${choices.length} ${choices.length === 1 ? 'cover' : 'covers'}, square-cropped for display.`}
          </p>
        </div>
        <button
          type="button"
          className="tag-find"
          disabled={searching || loading}
          title="Ask iTunes and MusicBrainz for a cover"
          onClick={() => void findMore()}
        >
          {searching ? <SpinnerIcon size={14} /> : <SearchIcon size={14} />}
          <span>{searching ? 'Searching…' : 'Search online'}</span>
        </button>
        <button
          type="button"
          className="icon-button subtle"
          title="Close the cover picker"
          aria-label="Close the cover picker"
          onClick={onClose}
        >
          <CloseIcon size={14} />
        </button>
      </header>

      {error ? (
        <p className="banner error" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="auto-tag-status" role="status">
          <SpinnerIcon size={14} />
          <span>Reading the file and its folder…</span>
        </p>
      ) : choices.length === 0 ? (
        <p className="auto-tag-status" role="status">
          Nothing on disk and nothing from the providers. Search online, or keep the current cover.
        </p>
      ) : (
        <ul className="artwork-grid" role="radiogroup" aria-label="Covers">
          {choices.map((choice) => (
            <li key={choice.key}>
              <button
                type="button"
                role="radio"
                aria-checked={selection === choice.key}
                className={`artwork-choice${selection === choice.key ? ' selected' : ''}`}
                onClick={() => choose(choice.key)}
              >
                <ArtworkImage
                  track={null}
                  artworkKey={choice.key}
                  size={96}
                  iconSize={24}
                  className="artwork-choice-image"
                />
                <span className="artwork-choice-text">
                  <span className="artwork-choice-label">{choice.label}</span>
                  <span className="subtitle">
                    {choice.current
                      ? 'In use'
                      : choice.kind === 'folder'
                        ? 'In this folder'
                        : choice.kind === 'video'
                          ? 'From the video'
                          : choice.kind === 'provider'
                            ? 'From a provider'
                            : 'In the file'}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        className={`artwork-remove${selection === null ? ' selected' : ''}`}
        disabled={baseline === null}
        onClick={() => choose(null)}
      >
        <TrashIcon size={14} />
        <span>{baseline === null ? 'This file has no cover' : 'Remove the cover'}</span>
      </button>

      <p className="field-note auto-tag-note">
        The file is only rewritten when you save the tags. Removing the cover keeps the audio untouched.
      </p>

      <footer className="auto-tag-foot">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={!canApply}
          onClick={() => onChoose(selection ?? null)}
        >
          Use this cover
        </button>
      </footer>
    </section>
  )
}
