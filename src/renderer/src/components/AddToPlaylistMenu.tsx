import { useCallback, useEffect, useRef, useState } from 'react'
import type { AddTracksOutcome, Playlist } from '@shared/types'
import { messageOf } from '../api'
import { PlusIcon } from './Icons'

/** Long enough to read the confirmation, short enough not to sit in the way. */
const CLOSE_AFTER_ADD_MS = 1400

export interface AddToPlaylistMenuProps {
  playlists: Playlist[]
  /** The tracks this menu is for. */
  trackIds: number[]
  onAdd: (playlistId: number, trackIds: number[]) => Promise<AddTracksOutcome>
  onCreate: (name: string) => Promise<Playlist>
  onClose: () => void
  /** Page coordinates, for a menu opened at the pointer. Omit to place it in the host. */
  at?: { x: number; y: number }
  /** What is being added, e.g. "3 tracks". Shown as the menu's heading. */
  heading?: string
}

function describeOutcome(outcome: AddTracksOutcome): string {
  if (outcome.added === 0) return 'Already in this playlist'
  const added = outcome.added === 1 ? '1 track added' : `${outcome.added} tracks added`
  return outcome.skipped > 0 ? `${added} · ${outcome.skipped} already there` : added
}

/**
 * The one menu behind every "Add to playlist" affordance.
 *
 * It is deliberately not a modal: adding three tracks to a playlist from the
 * library should not take over the window, and the answer — how many landed, how
 * many were already there — belongs next to the list you clicked, not on a toast
 * on the other side of the screen. It closes itself shortly after a successful
 * add so it does not linger over the rows it was opened from, and stays open on
 * an error so the message can be read.
 */
export function AddToPlaylistMenu(props: AddToPlaylistMenuProps) {
  const { playlists, trackIds, onAdd, onCreate, onClose, at, heading } = props
  const containerRef = useRef<HTMLDivElement | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    []
  )

  // Clicking anywhere else closes it. `pointerdown` rather than `click` so the
  // menu is gone before the thing underneath reacts to the press.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const node = event.target as Node | null
      if (node && containerRef.current?.contains(node)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  const add = useCallback(
    async (playlistId: number): Promise<void> => {
      setBusy(true)
      setError(null)
      try {
        const outcome = await onAdd(playlistId, trackIds)
        setStatus(describeOutcome(outcome))
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(onClose, CLOSE_AFTER_ADD_MS)
      } catch (cause) {
        setError(messageOf(cause))
      } finally {
        setBusy(false)
      }
    },
    [onAdd, onClose, trackIds]
  )

  const submitNew = useCallback(async (): Promise<void> => {
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      setError('A playlist needs a name.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const created = await onCreate(trimmed)
      await add(created.id)
    } catch (cause) {
      setError(messageOf(cause))
    } finally {
      setBusy(false)
    }
  }, [add, name, onCreate])

  const style = at
    ? {
        // Clamped so a right-click near an edge does not open half off-screen.
        left: Math.max(8, Math.min(at.x, window.innerWidth - 268)),
        top: Math.max(8, Math.min(at.y, window.innerHeight - 320))
      }
    : undefined

  return (
    <div
      ref={containerRef}
      className={at ? 'add-to-playlist fixed' : 'add-to-playlist'}
      style={style}
      role="menu"
      aria-label="Add to playlist"
    >
      <div className="atp-head">{heading ?? 'Add to playlist'}</div>

      <div className="atp-list">
        {playlists.length === 0 ? <div className="atp-empty">No playlists yet</div> : null}
        {playlists.map((playlist) => (
          <button
            key={playlist.id}
            type="button"
            role="menuitem"
            className="atp-item"
            disabled={busy}
            onClick={() => void add(playlist.id)}
          >
            <span className="atp-name" title={playlist.name}>
              {playlist.name}
            </span>
            <span className="atp-count">{playlist.trackCount}</span>
          </button>
        ))}
      </div>

      <div className="atp-foot">
        {creating ? (
          <form
            className="atp-new-form"
            onSubmit={(event) => {
              event.preventDefault()
              void submitNew()
            }}
          >
            <input
              className="atp-new-input"
              value={name}
              autoFocus
              placeholder="New playlist name"
              aria-label="New playlist name"
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return
                event.stopPropagation()
                setCreating(false)
                setError(null)
              }}
            />
            <button type="submit" className="small" disabled={busy}>
              Add
            </button>
          </form>
        ) : (
          <button
            type="button"
            role="menuitem"
            className="atp-item new"
            onClick={() => {
              setCreating(true)
              setError(null)
            }}
          >
            <PlusIcon size={14} />
            <span className="atp-name">New playlist…</span>
          </button>
        )}
      </div>

      {status ? <div className="atp-status">{status}</div> : null}
      {error ? <div className="atp-error">{error}</div> : null}
    </div>
  )
}
