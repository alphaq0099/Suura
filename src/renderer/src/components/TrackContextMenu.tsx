import { useEffect, useRef, useState } from 'react'
import type { AddTracksOutcome, Playlist, Track } from '@shared/types'
import { CheckIcon, PlayIcon, InfoIcon, PlaylistIcon, QueueIcon, RevealIcon } from './Icons'
import { AddToPlaylistMenu } from './AddToPlaylistMenu'

export interface TrackContextMenuProps {
  track: Track
  /** Page coordinates where the menu should open. */
  at: { x: number; y: number }
  playlists: Playlist[]
  onAddTracks: (playlistId: number, trackIds: number[]) => Promise<AddTracksOutcome>
  onCreatePlaylist: (name: string) => Promise<Playlist>
  onPlay: () => void
  onDetails: () => void
  onReveal: () => void
  isSelected: boolean
  onToggleSelection: () => void
  onPlaySelected: () => void
  onQueueSelected: () => void
  /** Rows "Add to playlist" acts on: the selection if this row is selected. */
  trackIds: number[]
  addHeading?: string
  onClose: () => void
}

const WIDTH = 240
const BASE_HEIGHT = 236
const SELECTED_ACTION_HEIGHT = 72

/**
 * The right-click menu on a library row.
 *
 * Two pages in one popover: a short list of actions, and — behind "Add to
 * playlist…" — the same picker the library's selection bar opens. Keeping them
 * in one component means the row menu has no other copy of the playlist list to
 * grow stale.
 */
export function TrackContextMenu(props: TrackContextMenuProps) {
  const {
    track,
    at,
    playlists,
    onAddTracks,
    onCreatePlaylist,
    onPlay,
    onDetails,
    onReveal,
    isSelected,
    onToggleSelection,
    onPlaySelected,
    onQueueSelected,
    trackIds,
    addHeading,
    onClose
  } = props
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [page, setPage] = useState<'root' | 'playlists'>('root')

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

  // Clamped so a right-click near the right or bottom edge stays on screen.
  const height = BASE_HEIGHT + (isSelected ? SELECTED_ACTION_HEIGHT : 0)
  const style = {
    left: Math.max(8, Math.min(at.x, window.innerWidth - WIDTH - 8)),
    top: Math.max(8, Math.min(at.y, window.innerHeight - height - 8))
  }

  return (
    <div ref={containerRef} className="context-menu" style={style} role="menu" aria-label="Track actions">
      {page === 'root' ? (
        <>
          <div className="context-head" title={track.title}>
            {track.title}
          </div>
          <button
            type="button"
            role="menuitem"
            className="context-item"
            onClick={() => {
              onPlay()
              onClose()
            }}
          >
            <PlayIcon size={14} />
            <span>Play</span>
          </button>
          {isSelected ? (
            <>
              <button
                type="button"
                role="menuitem"
                className="context-item"
                onClick={() => {
                  onPlaySelected()
                  onClose()
                }}
              >
                <PlayIcon size={14} />
                <span>Play selected</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="context-item"
                onClick={() => {
                  onQueueSelected()
                  onClose()
                }}
              >
                <QueueIcon size={14} />
                <span>Queue selected</span>
              </button>
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="context-item"
            onClick={() => {
              onToggleSelection()
              onClose()
            }}
          >
            <CheckIcon size={14} />
            <span>{isSelected ? 'Deselect' : 'Select'}</span>
          </button>
          <button type="button" role="menuitem" className="context-item" onClick={() => setPage('playlists')}>
            <PlaylistIcon size={14} />
            <span>Add to playlist…</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-item"
            onClick={() => {
              onDetails()
              onClose()
            }}
          >
            <InfoIcon size={14} />
            <span>Details…</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-item"
            onClick={() => {
              onReveal()
              onClose()
            }}
          >
            <RevealIcon size={14} />
            <span>Show in folder</span>
          </button>
        </>
      ) : (
        <AddToPlaylistMenu
          playlists={playlists}
          trackIds={trackIds}
          onAdd={onAddTracks}
          onCreate={onCreatePlaylist}
          onClose={onClose}
          heading={addHeading ?? 'Add to playlist'}
        />
      )}
    </div>
  )
}
