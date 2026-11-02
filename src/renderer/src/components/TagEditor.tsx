import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Track, TrackLyrics, TrackTagFields } from '@shared/types'
import { lyricsTargetOf } from '@shared/lyrics'
import { TAG_POSITION_MAX, TAG_YEAR_MAX, TAG_YEAR_MIN } from '@shared/tags'
import { api, messageOf } from '../api'
import { ArtworkImage } from './ArtworkImage'
import { ArtworkPicker } from './ArtworkPicker'
import { AutoTagPanel, type AutoTagValues } from './AutoTagPanel'
import { CloseIcon, DiscIcon, SearchIcon, SpinnerIcon } from './Icons'

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
    // Filled in when the file's lyrics arrive. An empty box until then is not
    // a statement about the file: `patchOf` compares against what was loaded,
    // so an untouched box never erases the lyrics it is showing.
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
 *
 * `loadedLyrics` is what the file already holds. Comparing against it is what
 * lets the box start full without turning "I changed the artist" into "I
 * rewrote the lyrics too".
 */
function patchOf(
  track: Track,
  draft: Draft,
  removeLyrics: boolean,
  loadedLyrics: TrackLyrics | null
): TrackTagFields {
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

  // An empty box does not clear the file's lyrics: emptying a box the user was
  // typing in must not wipe them by accident. Removing them is its own explicit
  // choice, made with the checkbox. A box that still shows what was loaded is
  // not a change either.
  //
  // A `.lrc` beside the file is what the player shows, so writing lyrics into
  // the tag would be invisible. The editor locks the box in that case; this
  // guard also stops a keystroke that arrived before the read finished from
  // writing a tag nothing will ever show.
  if (loadedLyrics?.source !== 'sidecar') {
    const lyrics = draft.lyrics.replace(/\r\n?/g, '\n').trim()
    if (removeLyrics) patch.lyrics = null
    else if (lyrics.length > 0 && lyrics !== (loadedLyrics?.text ?? '').replace(/\r\n?/g, '\n').trim()) {
      patch.lyrics = lyrics
    }
  }

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
  const [loadedLyrics, setLoadedLyrics] = useState<TrackLyrics | null>(null)
  const [lyricsLoading, setLyricsLoading] = useState(true)
  const [removeLyrics, setRemoveLyrics] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * Set when the save was queued because this file is open for playback. The
   * row has not changed yet, so the dialog stays open with the sentence that
   * says when the write will happen.
   */
  const [notice, setNotice] = useState<string | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  /**
   * The cover the user chose: a cache key, `null` to remove it, or `undefined`
   * while the file's own picture is untouched. Save sends it as it stands.
   */
  const [artwork, setArtwork] = useState<string | null | undefined>(undefined)
  const [artworkOpen, setArtworkOpen] = useState(false)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const titleRef = useRef<HTMLInputElement | null>(null)
  // Once the user has typed in the box, a slow read must not overwrite it.
  const lyricsTouchedRef = useRef(false)

  useEffect(() => {
    titleRef.current?.focus()
    titleRef.current?.select()
  }, [])

  // The file is the source of truth, so the box shows what is actually in it
  // rather than a blank that looks like "no lyrics" and invites a needless
  // rewrite. A read failure is not worth an error banner: the rest of the
  // editor works, and saving simply leaves the lyrics alone.
  useEffect(() => {
    let live = true
    setLyricsLoading(true)
    api
      .getFileLyrics(lyricsTargetOf(track))
      .then((found) => {
        if (!live) return
        setLoadedLyrics(found)
        if (found && !lyricsTouchedRef.current) {
          setDraft((current) => ({ ...current, lyrics: found.text }))
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLyricsLoading(false)
      })
    return () => {
      live = false
    }
  }, [track.id])

  const { patch, problem } = useMemo(() => {
    try {
      return {
        patch: patchOf(track, draft, removeLyrics, loadedLyrics),
        problem: null as string | null
      }
    } catch (cause) {
      return { patch: {} as TrackTagFields, problem: messageOf(cause) }
    }
  }, [track, draft, removeLyrics, loadedLyrics])

  // A fresh edit after a deferred save is a new write, so the notice goes away
  // and Save becomes available again.
  useEffect(() => {
    setNotice(null)
  }, [draft, artwork])

  const dirty = Object.keys(patch).length > 0 || artwork !== undefined
  const canSave = dirty && !problem && !saving && !notice

  // A `.lrc` beside the file is what the player shows, so the box is a preview
  // there rather than a tag editor: writing the tag would change nothing the
  // user can see, and removing it would not remove the lyrics on screen.
  const lyricsFromSidecar = loadedLyrics?.source === 'sidecar'

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }))
  }

  // What the finder compares against: the form as it stands, so a title the
  // user just corrected is what the search is built from.
  const currentValues: AutoTagValues = {
    title: draft.title,
    artist: draft.artist,
    albumArtist: draft.albumArtist,
    album: draft.album,
    genre: draft.genre,
    year: draft.year,
    trackNo: draft.trackNo,
    trackTotal: draft.trackTotal,
    discNo: draft.discNo,
    discTotal: draft.discTotal
  }

  /**
   * A match fills the draft; it does not write the file. The patch is still
   * computed against the row, so only fields that ended up different are sent,
   * and saving remains the one moment the file changes.
   */
  const applyFoundTags = (fields: TrackTagFields): void => {
    setDraft((current) => {
      const next = { ...current }
      for (const [name, value] of Object.entries(fields)) {
        if (!(name in next)) continue
        next[name as keyof Draft] = value === null ? '' : String(value)
      }
      return next
    })
    setFindOpen(false)
  }

  const save = async (): Promise<void> => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      const result = await api.updateTrackTags(track.id, patch, artwork)
      if (result.deferred) {
        // The row is unchanged until the file can be replaced. Keep the editor
        // open so the sentence is read where the user pressed Save.
        setNotice(
          result.message ?? 'Tags will be written to this file after this track finishes playing.'
        )
        return
      }
      onSaved(result.track)
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
            // Each layer inside this dialog closes before the editor itself.
            if (artworkOpen) {
              setArtworkOpen(false)
              return
            }
            if (findOpen) {
              setFindOpen(false)
              return
            }
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
          <ArtworkImage
            track={artwork === null ? null : track}
            artworkKey={typeof artwork === 'string' ? artwork : undefined}
            size={48}
            iconSize={18}
            className="tag-art"
          />
          <div className="tag-titles">
            <h2 id="tag-editor-title">Edit tags</h2>
            <p className="subtitle" title={track.filePath ?? undefined}>
              {track.filePath?.split(/[\\/]/).pop() ?? 'Local file'}
            </p>
          </div>
          <div className="tag-head-actions">
            <button
              type="button"
              className="tag-find"
              disabled={saving || artworkOpen}
              title="Choose a different cover"
              onClick={() => setArtworkOpen(true)}
            >
              <DiscIcon size={14} />
              <span>Cover</span>
            </button>
            <button
              type="button"
              className="tag-find"
              disabled={saving || findOpen || artworkOpen}
              title="Ask iTunes and MusicBrainz what this file is"
              onClick={() => setFindOpen(true)}
            >
              <SearchIcon size={14} />
              <span>Find tags</span>
            </button>
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
          </div>
        </header>

        {error ? (
          <p className="banner error" role="alert">
            {error}
          </p>
        ) : null}

        {notice ? (
          <p className="banner tag-deferred" role="status">
            {notice}
          </p>
        ) : null}

        {findOpen ? (
          <AutoTagPanel
            track={track}
            current={currentValues}
            onApply={applyFoundTags}
            onClose={() => setFindOpen(false)}
          />
        ) : null}

        {artworkOpen ? (
          <ArtworkPicker
            track={track}
            selected={artwork}
            onChoose={(key) => {
              setArtwork(key)
              setArtworkOpen(false)
            }}
            onClose={() => setArtworkOpen(false)}
          />
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
            disabled={lyricsLoading || removeLyrics || lyricsFromSidecar}
            placeholder={
              lyricsLoading
                ? 'Reading the lyrics already in this file…'
                : lyricsFromSidecar
                  ? 'These lyrics live in the .lrc file beside this track'
                  : loadedLyrics
                    ? 'Edit these lyrics to replace them'
                    : 'Type or paste lyrics to add them to this file'
            }
            onChange={(event) => {
              lyricsTouchedRef.current = true
              set('lyrics', event.target.value)
            }}
          />
        </label>
        <label className="field checkbox tag-lyrics-remove">
          <input
            type="checkbox"
            checked={removeLyrics}
            disabled={lyricsLoading || !loadedLyrics || lyricsFromSidecar}
            onChange={(event) => setRemoveLyrics(event.target.checked)}
          />
          <span>Remove the lyrics already in this file</span>
        </label>
        <p className="field-note">
          {lyricsLoading
            ? 'Reading the lyrics already in this file…'
            : lyricsFromSidecar
              ? `Loaded from ${loadedLyrics?.origin ?? 'the .lrc file'}. A .lrc beside the track wins over its tags, so the player shows that file: edit or remove it to change these lyrics.`
              : removeLyrics
                ? 'Saving removes the lyrics from the file.'
                : loadedLyrics
                  ? 'Loaded from the file’s tags. Editing them replaces them; leaving them alone keeps them.'
                  : draft.lyrics.trim().length > 0
                    ? 'These lyrics will be added to the file.'
                    : 'This file has no lyrics yet.'}
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
