import { useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { OnlineTrack, Track } from '@shared/types'
import { formatCount, formatDuration } from '@shared/format'
import { onlineEntryToTrack } from '@shared/online'
import { extractYouTubeVideoId } from '@shared/youtube'
import { api, messageOf } from '../api'
import { ArtworkImage } from './ArtworkImage'
import {
  ClipboardIcon,
  CloseIcon,
  CopyIcon,
  DownloadIcon,
  LinkIcon,
  MoreIcon,
  PlayIcon,
  QueueIcon,
  SpinnerIcon,
  TrashIcon
} from './Icons'

export interface OnlineViewProps {
  entries: OnlineTrack[]
  loading: boolean
  historyError: string | null
  /** The video id that is playing, when the current track is a stream. */
  currentVideoId: string | null
  isPlaying: boolean
  onAddLink: (url: string) => Promise<OnlineTrack>
  onRemove: (id: number) => Promise<void>
  onClear: () => Promise<void>
  onPlay: (tracks: Track[], index: number) => void
  onQueue: (tracks: Track[]) => void
}

/** A link that has been submitted but not resolved yet, or that failed. */
interface Pending {
  url: string
  videoId: string
  mode: 'play' | 'queue'
  error: string | null
}

interface Notice {
  kind: 'info' | 'error'
  text: string
}

interface MenuState {
  entry: OnlineTrack
  x: number
  y: number
}

const MENU_WIDTH = 230
const MENU_HEIGHT = 230

/**
 * The Online view.
 *
 * Links the user pastes become rows here and stay until they are removed — not
 * because they were copied, only because they were pasted. A link is resolved
 * when it is submitted (which is also what warms playback) but the entry is
 * added to the list immediately so a 7-10 s sidecar run is never a frozen
 * button: the row says "Resolving…", then fills in, then plays.
 *
 * The library is untouched. Saving a row is M4's download path and is shown
 * disabled rather than faked.
 */
export function OnlineView(props: OnlineViewProps) {
  const {
    entries,
    loading,
    historyError,
    currentVideoId,
    isPlaying,
    onAddLink,
    onRemove,
    onClear,
    onPlay,
    onQueue
  } = props

  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [menu, setMenu] = useState<MenuState | null>(null)

  const inputRef = useRef<HTMLInputElement | null>(null)
  // Bumped per submit so an answer that arrives after a newer paste is ignored.
  const submitTokenRef = useRef(0)

  // The list can be replaced by a refresh at any moment; the play queue is built
  // from whatever is on screen when the button is pressed, so a ref keeps the
  // async path from reading a stale copy.
  const entriesRef = useRef<OnlineTrack[]>(entries)
  useEffect(() => {
    entriesRef.current = entries
  }, [entries])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const run = useCallback(
    async (link: string, mode: 'play' | 'queue'): Promise<void> => {
      const videoId = extractYouTubeVideoId(link)
      if (!videoId) {
        setNotice({
          kind: 'error',
          text: 'That does not look like a YouTube video link. Paste a watch, youtu.be, shorts or music link.'
        })
        return
      }

      const token = ++submitTokenRef.current
      setNotice(null)
      setBusy(true)
      setPending({ url: link, videoId, mode, error: null })
      try {
        const entry = await onAddLink(link)
        if (token !== submitTokenRef.current) return
        setPending(null)
        setUrl('')
        const track = onlineEntryToTrack(entry)
        if (mode === 'play') {
          // Play the new row and the rows below it, so Next keeps walking the
          // history instead of dead-ending after one track.
          const rest = entriesRef.current.filter((item) => item.id !== entry.id).map(onlineEntryToTrack)
          onPlay([track, ...rest], 0)
        } else {
          onQueue([track])
          setNotice({ kind: 'info', text: `Queued “${entry.title}”.` })
        }
      } catch (cause) {
        if (token !== submitTokenRef.current) return
        setPending({ url: link, videoId, mode, error: messageOf(cause) })
      } finally {
        if (token === submitTokenRef.current) setBusy(false)
      }
    },
    [onAddLink, onPlay, onQueue]
  )

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (busy || url.trim().length === 0) return
    void run(url.trim(), 'play')
  }

  const paste = useCallback(async (): Promise<void> => {
    try {
      const text = (await api.readClipboardText()).trim()
      if (text.length === 0) {
        setNotice({ kind: 'info', text: 'The clipboard is empty.' })
        return
      }
      // The first whitespace-separated token: copying from a chat or a document
      // usually brings a trailing newline or a label with the link.
      const first = text.split(/\s+/)[0] ?? ''
      setUrl(first)
      setNotice(
        extractYouTubeVideoId(first)
          ? null
          : { kind: 'info', text: 'The clipboard text is not a YouTube link. Edit it or paste another.' }
      )
      inputRef.current?.focus()
    } catch (cause) {
      setNotice({ kind: 'error', text: messageOf(cause) })
    }
  }, [])

  const playAt = (index: number): void => {
    if (index < 0 || index >= entries.length) return
    onPlay(entries.slice(index).map(onlineEntryToTrack), 0)
  }

  const queueOne = (entry: OnlineTrack): void => {
    onQueue([onlineEntryToTrack(entry)])
    setNotice({ kind: 'info', text: `Queued “${entry.title}”.` })
  }

  const copyLink = useCallback(async (entry: OnlineTrack): Promise<void> => {
    try {
      await api.writeClipboardText(entry.sourceUrl)
      setNotice({ kind: 'info', text: 'Link copied.' })
    } catch (cause) {
      setNotice({ kind: 'error', text: messageOf(cause) })
    }
  }, [])

  const openMenu = (entry: OnlineTrack, event: ReactMouseEvent): void => {
    event.preventDefault()
    setMenu({ entry, x: event.clientX, y: event.clientY })
  }

  const menuStyle = menu
    ? {
        left: Math.max(8, Math.min(menu.x, window.innerWidth - MENU_WIDTH - 8)),
        top: Math.max(8, Math.min(menu.y, window.innerHeight - MENU_HEIGHT - 8))
      }
    : undefined

  const subtitle =
    entries.length > 0
      ? `${formatCount(entries.length)} link${entries.length === 1 ? '' : 's'} · newest first · nothing is saved until you ask`
      : 'Paste a link and it plays here; it stays in this list until you remove it'

  return (
    <section className="main-view online-view">
      <header className="view-header">
        <div className="view-heading">
          <h1>Online</h1>
          <p className="subtitle">{subtitle}</p>
        </div>
        {entries.length > 0 ? (
          <div className="header-actions">
            <button
              type="button"
              className={confirmClear ? 'link-button danger' : 'link-button'}
              onClick={() => {
                if (!confirmClear) {
                  setConfirmClear(true)
                  return
                }
                setConfirmClear(false)
                void onClear()
              }}
            >
              {confirmClear ? 'Clear history?' : 'Clear history'}
            </button>
          </div>
        ) : null}
      </header>

      <form className="online-bar" onSubmit={submit}>
        <div className="online-input">
          <LinkIcon />
          <input
            ref={inputRef}
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://www.youtube.com/watch?v=…"
            aria-label="YouTube link"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value)
              if (notice) setNotice(null)
            }}
            disabled={busy}
          />
          <button
            type="button"
            className="icon-button subtle online-paste"
            title="Paste from the clipboard"
            aria-label="Paste from the clipboard"
            onClick={() => void paste()}
            disabled={busy}
          >
            <ClipboardIcon />
          </button>
        </div>
        <div className="online-actions-bar">
          <button type="button" onClick={() => void run(url.trim(), 'queue')} disabled={busy || url.trim().length === 0}>
            <QueueIcon size={15} />
            <span>Add to queue</span>
          </button>
          <button type="submit" className="primary" disabled={busy || url.trim().length === 0}>
            {busy ? <SpinnerIcon /> : <PlayIcon size={15} />}
            <span>{busy ? 'Resolving…' : 'Play now'}</span>
          </button>
        </div>
      </form>

      {notice ? (
        <div className={notice.kind === 'error' ? 'banner error' : 'banner'} role={notice.kind === 'error' ? 'alert' : undefined}>
          {notice.text}
        </div>
      ) : null}

      {historyError ? <div className="banner error">{historyError}</div> : null}

      {entries.length === 0 && !pending && !loading ? (
        <div className="empty-state">
          <LinkIcon size={32} />
          <h2>Nothing played from a link yet</h2>
          <p>
            Paste a YouTube link above and it plays straight away. Each link is remembered here — still streamed, not
            copied — so you can play it again later without saving anything to your library.
          </p>
        </div>
      ) : (
        <ul className="online-list" aria-label="Links played from YouTube">
          {pending ? (
            <li className={pending.error ? 'online-item pending failed' : 'online-item pending'}>
              <span className="online-pending-body">
                <span className="online-art-cell">
                  <span className="artwork artwork-empty online-art" style={{ width: 30, height: 30 }} data-artwork="none" aria-hidden="true">
                    {pending.error ? <CloseIcon size={15} /> : <SpinnerIcon />}
                  </span>
                </span>
                <span className="online-pending-text">
                  <span className="online-title">
                    {pending.error ? 'Could not play this link' : 'Resolving link…'}
                  </span>
                  <span className="online-sub" title={pending.url}>
                    {pending.error ?? pending.url}
                  </span>
                </span>
              </span>
              <div className="online-actions">
                {pending.error ? (
                  <>
                    <button type="button" className="small" onClick={() => void run(pending.url, pending.mode)} disabled={busy}>
                      Retry
                    </button>
                    <button type="button" className="icon-button subtle" title="Dismiss" aria-label="Dismiss" onClick={() => setPending(null)}>
                      <CloseIcon />
                    </button>
                  </>
                ) : null}
              </div>
            </li>
          ) : null}

          {entries.map((entry, index) => {
            const current = currentVideoId !== null && entry.videoId === currentVideoId
            return (
              <li key={entry.id} className={current ? 'online-item current' : 'online-item'}>
                <button
                  type="button"
                  className="online-jump"
                  title={current ? 'Restart this link' : 'Play this link'}
                  onClick={() => playAt(index)}
                  onContextMenu={(event) => openMenu(entry, event)}
                >
                  <span className="online-art-cell">
                    {/* A row with no cached cover borrows the negative-id lookup so
                        the picture is fetched, decoded and cached on first draw. */}
                    <ArtworkImage track={onlineEntryToTrack(entry)} size={30} className="online-art" />
                  </span>
                  <span className="online-title">{entry.title}</span>
                  <span className="online-artist" title={entry.artist ?? undefined}>
                    {entry.artist ?? 'Unknown artist'}
                  </span>
                  <span className="online-album" title={entry.album ?? undefined}>
                    {entry.album ?? '—'}
                  </span>
                  <span className="online-time">{formatDuration(entry.durationMs)}</span>
                </button>
                <div className="online-actions">
                  <button
                    type="button"
                    className="icon-button subtle"
                    title="Add to queue"
                    aria-label={`Add ${entry.title} to the queue`}
                    onClick={() => queueOne(entry)}
                  >
                    <QueueIcon size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-button subtle"
                    title="More actions"
                    aria-label={`More actions for ${entry.title}`}
                    onClick={(event) => openMenu(entry, event)}
                  >
                    <MoreIcon size={15} />
                  </button>
                  <button
                    type="button"
                    className="icon-button subtle"
                    title="Remove from history"
                    aria-label={`Remove ${entry.title} from history`}
                    onClick={() => void onRemove(entry.id)}
                  >
                    <CloseIcon />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <p className="table-footnote">
        {isPlaying && currentVideoId ? 'Streaming now. ' : ''}
        Saving a link to your library arrives with downloads (M4); until then every row here is streamed, and removing
        one only forgets it.
      </p>

      {menu ? (
        <OnlineContextMenu
          state={menu}
          style={menuStyle}
          onPlay={() => playAt(entries.findIndex((entry) => entry.id === menu.entry.id))}
          onQueue={() => queueOne(menu.entry)}
          onCopy={() => void copyLink(menu.entry)}
          onRemove={() => void onRemove(menu.entry.id)}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </section>
  )
}

/**
 * The context menu for a link row.
 */
function OnlineContextMenu(props: {
  state: MenuState
  style: { left: number; top: number } | undefined
  onPlay: () => void
  onQueue: () => void
  onCopy: () => void
  onRemove: () => void
  onClose: () => void
}) {
  const { state, style, onPlay, onQueue, onCopy, onRemove, onClose } = props
  const containerRef = useRef<HTMLDivElement | null>(null)

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

  return (
    <div ref={containerRef} className="context-menu" style={style} role="menu" aria-label="Link actions">
      <div className="context-head" title={state.entry.title}>
        {state.entry.title}
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
      <button
        type="button"
        role="menuitem"
        className="context-item"
        onClick={() => {
          onQueue()
          onClose()
        }}
      >
        <QueueIcon size={14} />
        <span>Add to queue</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="context-item"
        onClick={() => {
          onCopy()
          onClose()
        }}
      >
        <CopyIcon size={14} />
        <span>Copy link</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="context-item"
        disabled
        title="Saving a link to your library arrives with downloads (M4)"
      >
        <DownloadIcon size={14} />
        <span>Save to library (M4)</span>
      </button>
      <button
        type="button"
        role="menuitem"
        className="context-item"
        onClick={() => {
          onRemove()
          onClose()
        }}
      >
        <TrashIcon size={14} />
        <span>Remove from history</span>
      </button>
    </div>
  )
}
