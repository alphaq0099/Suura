import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Track, TrackTagFields } from '@shared/types'
import { TAG_POSITION_MAX, TAG_YEAR_MAX, TAG_YEAR_MIN } from '@shared/tags'
import { api, messageOf } from '../api'
import { ArtworkImage } from './ArtworkImage'
import { CloseIcon, SpinnerIcon } from './Icons'

export interface TagEditorProps {
  track: Track
  /** The row as it reads after the write, so the caller can show it at once. */
  onSaved: (track: Track) => void
  onClose: () => void
}

interface Draft {
  title: string
  artist: string
  albumArtist: string
  album: string
  year: string
  genre: string
  trackNo: string
  trackTotal: string
  discNo: string
  discTotal: string
  lyrics: string
}

function draftOf(track: Track): Draft {
  return {
    title: track.title ?? '',
    artist: track.artist ?? '',
    albumArtist: track.albumArtist ?? '',
    album: track.album ?? '',
    year: track.year ? String(track.year) : '',
    genre: track.genre ?? '',
    trackNo: track.trackNo ? String(track.trackNo) : '',
    trackTotal: track.trackTotal ? String(track.trackTotal) : '',
    discNo: track.discNo ? String(track.discNo) : '',
    discTotal: track.discTotal ? String(track.discTotal) : '',
    // Lyrics are not read back yet, so this box starts empty and is only sent
    // when the user actually types in it. Sending an untouched blank would
    // erase lyrics the editor never showed.
    lyrics: ''
  }
}

function numberField(raw: string, label: string, min: number, max: number): number | null {
  const text = raw.trim()
  if (text.length === 0) return null
  if (!/^\d+$/.test(text)) throw new Error(`${label} must be a whole number.`)
  const value = Number(text)
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`)
  }
  return value
}

/**
 * True when the input still shows the row's own value.
 *
 * A file can carry junk in a numeric tag (`year 9999`, a track number of
 * `0000`), and the editor must not refuse to save a title change because of a
 * field nobody touched. Untouched means untouched, even when it is invalid.
 */
function unchanged(raw: string, current: number | null): boolean {
  return raw.trim() === (current === null ? '' : String(current))
}

/**
 * Only what the user changed, as the main process expects it.
 *
 * Sending every input would rewrite fields nobody touched, and a tag writer
 * that guesses is how libraries get damaged: an untouched field is left out of
 * the patch entirely, and a cleared one is sent as `null`.
 */
function patchOf(track: Track, draft: Draft, removeLyrics: boolean): TrackTagFields {
  const patch: TrackTagFields = {}

  const texts: Array<['title' | 'artist' | 'albumArtist' | 'album' | 'genre', string, string | null]> = [
    ['title', draft.title, track.title],
    ['artist', draft.artist, track.artist],
    ['albumArtist', draft.albumArtist, track.albumArtist],
    ['album', draft.album, track.album],
    ['genre', draft.genre, track.genre]
  ]
  for (const [name, raw, current] of texts) {
    const next = raw.trim()
    if (next === (current ?? '').trim()) continue
    patch[name] = next.length > 0 ? next : null
  }

  if (!unchanged(draft.trackNo, track.trackNo) || !unchanged(draft.trackTotal, track.trackTotal)) {
    const trackNo = numberField(draft.trackNo, 'Track number', 1, TAG_POSITION_MAX)
    const trackTotal = numberField(draft.trackTotal, 'Track total', 1, TAG_POSITION_MAX)
    // `3/12` is one frame in every container, so both halves travel together.
    // A total with no number is not a position, so clearing the number clears
    // the total with it rather than leaving a stale half behind.
    patch.trackNo = trackNo
    patch.trackTotal = trackNo === null ? null : trackTotal
  }

  if (!unchanged(draft.discNo, track.discNo) || !unchanged(draft.discTotal, track.discTotal)) {
    const discNo = numberField(draft.discNo, 'Disc number', 1, TAG_POSITION_MAX)
    const discTotal = numberField(draft.discTotal, 'Disc total', 1, TAG_POSITION_MAX)
    patch.discNo = discNo
    patch.discTotal = discNo === null ? null : discTotal
  }

  if (!unchanged(draft.year, track.year)) {
    patch.year = numberField(draft.year, 'Year', TAG_YEAR_MIN, TAG_YEAR_MAX)
  }

  // Only a non-empty box replaces lyrics. Emptying a box the user was typing in
  // must not wipe the file's lyrics by accident; removing them is its own
  // explicit choice, made with the checkbox.
  const lyrics = draft.lyrics.trim()
  if (lyrics.length > 0) patch.lyrics = lyrics
  else if (removeLyrics) patch.lyrics = null

  return patch
}

/**
 * The manual tag editor.
 *
 * The file is the source of truth: saving rewrites it, keeps a backup of the
 * old version and then refreshes the row from what the file actually says. That
 * is why the dialog reports a failure instead of pretending: a tag the writer
 * could not keep would otherwise be shown as if it had been saved.
 */
export function TagEditor(props: TagEditorProps) {
  const { track, onSaved, onClose } = props
  const [draft, setDraft] = useState<Draft>(() => draftOf(track))
  const [removeLyrics, setRemoveLyrics] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const titleRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    titleRef.current?.focus()
    titleRef.current?.select()
  }, [])

  const { patch, problem } = useMemo(() => {
    try {
      return { patch: patchOf(track, draft, removeLyrics), problem: null as string | null }
    } catch (cause) {
      return { patch: {} as TrackTagFields, problem: messageOf(cause) }
    }
  }, [track, draft, removeLyrics])

  const dirty = Object.keys(patch).length > 0
  const canSave = dirty && !problem && !saving

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  const save = async (): Promise<void> => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      const updated = await api.updateTrackTags(track.id, patch)
      onSaved(updated)
      onClose()
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setSaving(false)
    }
  }

  return createPortal(
    <div
      className="tag-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="tag-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tag-editor-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          // The details sheet can be behind this one; Escape must close the
          // editor only.
          if (event.key === 'Escape') {
            event.stopPropagation()
            if (!saving) onClose()
            return
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void save()
          }
        }}
      >
        <header className="tag-head">
          <ArtworkImage track={track} size={48} iconSize={18} className="tag-art" />
          <div className="tag-titles">
            <h2 id="tag-editor-title">Edit tags</h2>
            <p className="subtitle" title={track.filePath ?? undefined}>
              {track.filePath?.split(/[\\/]/).pop() ?? 'Local file'}
            </p>
          </div>
          <button
            type="button"
            className="icon-button subtle"
            title="Close (Esc)"
            aria-label="Close tag editor"
            disabled={saving}
            onClick={onClose}
          >
            <CloseIcon size={16} />
          </button>
        </header>

        {error ? (
          <p className="banner error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="tag-grid">
          <label className="field wide">
            <span>Title</span>
            <input
              ref={titleRef}
              type="text"
              value={draft.title}
              maxLength={500}
              onChange={(event) => set('title', event.target.value)}
            />
          </label>
          <label className="field">
            <span>Artist</span>
            <input
              type="text"
              value={draft.artist}
              maxLength={500}
              placeholder="Unknown artist"
              onChange={(event) => set('artist', event.target.value)}
            />
          </label>
          <label className="field">
            <span>Album artist</span>
            <input
              type="text"
              value={draft.albumArtist}
              maxLength={500}
              placeholder="Same as artist"
              onChange={(event) => set('albumArtist', event.target.value)}
            />
          </label>
          <label className="field">
            <span>Album</span>
            <input
              type="text"
              value={draft.album}
              maxLength={500}
              onChange={(event) => set('album', event.target.value)}
            />
          </label>
          <label className="field">
            <span>Genre</span>
            <input
              type="text"
              value={draft.genre}
              maxLength={200}
              onChange={(event) => set('genre', event.target.value)}
            />
          </label>
          <label className="field">
            <span>Year</span>
            <input
              type="text"
              inputMode="numeric"
              value={draft.year}
              placeholder={String(TAG_YEAR_MIN)}
              onChange={(event) => set('year', event.target.value)}
            />
          </label>
          <div className="field">
            <span>Track</span>
            <div className="tag-pair">
              <input
                type="text"
                inputMode="numeric"
                aria-label="Track number"
                value={draft.trackNo}
                onChange={(event) => set('trackNo', event.target.value)}
              />
              <span className="tag-pair-of">of</span>
              <input
                type="text"
                inputMode="numeric"
                aria-label="Track total"
                value={draft.trackTotal}
                onChange={(event) => set('trackTotal', event.target.value)}
              />
            </div>
          </div>
          <div className="field">
            <span>Disc</span>
            <div className="tag-pair">
              <input
                type="text"
                inputMode="numeric"
                aria-label="Disc number"
                value={draft.discNo}
                onChange={(event) => set('discNo', event.target.value)}
              />
              <span className="tag-pair-of">of</span>
              <input
                type="text"
                inputMode="numeric"
                aria-label="Disc total"
                value={draft.discTotal}
                onChange={(event) => set('discTotal', event.target.value)}
              />
            </div>
          </div>
        </div>

        <label className="field tag-lyrics">
          <span>Lyrics</span>
          <textarea
            value={draft.lyrics}
            rows={6}
            spellCheck={false}
            placeholder="Type or paste lyrics to replace the ones in the file"
            onChange={(event) => set('lyrics', event.target.value)}
          />
        </label>
        <label className="field checkbox tag-lyrics-remove">
          <input
            type="checkbox"
            checked={removeLyrics}
            disabled={draft.lyrics.trim().length > 0}
            onChange={(event) => setRemoveLyrics(event.target.checked)}
          />
          <span>Remove the lyrics already in this file</span>
        </label>
        <p className="field-note">
          {draft.lyrics.trim().length > 0
            ? 'These lyrics replace the ones in the file.'
            : removeLyrics
              ? 'Saving removes the lyrics from the file.'
              : 'The lyrics already in the file are kept.'}
        </p>

        <p className="tag-note">
          Saving rewrites this file and keeps a copy of the old version in the app’s backups folder. Blank a
          field to remove that tag.
        </p>

        {problem ? (
          <p className="tag-problem" role="status">
            {problem}
          </p>
        ) : null}

        <footer className="tag-foot">
          <button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => void save()} disabled={!canSave}>
            {saving ? <SpinnerIcon size={14} /> : null}
            <span>{saving ? 'Saving…' : 'Save tags'}</span>
          </button>
        </footer>
      </div>
    </div>,
    document.body
  )
}
