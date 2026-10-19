import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { DownloadProgress, OnlinePlaylistDetail, OnlineTrack, Track } from '@shared/types'
import { formatCount, formatDuration } from '@shared/format'
import { onlineEntryToTrack, onlinePlaylistItemToTrack } from '@shared/online'
import { describeYouTubeRefusal, parseYouTubeLink, youtubeListUrl } from '@shared/youtube'
import { api, messageOf } from '../api'
import type { UseDownloadsResult } from '../hooks/useDownloads'
import { ArtworkImage } from './ArtworkImage'
import {
  CheckIcon,
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
  /** Fetches and stores a playlist, album or mix. */
  onImportList: (url: string) => Promise<OnlinePlaylistDetail>
  onRemove: (id: number) => Promise<void>
  onClear: () => Promise<void>
  onPlay: (tracks: Track[], index: number) => void
  onQueue: (tracks: Track[]) => void
  /** Saving streams into the library, shared with the Playlists view. */
  downloads: UseDownloadsResult
}

/** A link that has been submitted but not resolved yet, or that failed. */
interface Pending {
  url: string
  kind: 'video' | 'list'
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

/** A video that sits in a list: the video plays, and the list is offered separately. */
interface ListOffer {
  listId: string
  kind: 'playlist' | 'album'
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
 * The library is untouched until a row is saved: saving downloads the file,
 * tags it and indexes it as a normal local track.
 */
export function OnlineView(props: OnlineViewProps) {
  const {
    entries,
    loading,
    historyError,
    currentVideoId,
    isPlaying,
    onAddLink,
    onImportList,
    onRemove,
    onClear,
    onPlay,
    onQueue,
    downloads
  } = props

  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [offer, setOffer] = useState<ListOffer | null>(null)
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

  // Which rows are already in the library. One query per history page rather
  // than one per row; a saved row's button becomes a check instead of a download.
  const { saved, states, save: saveToLibrary, refreshSaved } = downloads
  const historyVideoIds = useMemo(() => entries.map((entry) => entry.videoId), [entries])
  useEffect(() => {
    void refreshSaved(historyVideoIds)
  }, [historyVideoIds, refreshSaved])

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const run = useCallback(
    async (linkText: string, mode: 'play' | 'queue'): Promise<void> => {
      const link = parseYouTubeLink(linkText)
      if (link.kind === 'refused') {
        setPending(null)
        setNotice({ kind: 'error', text: describeYouTubeRefusal(link.reason) })
        return
      }

      const token = ++submitTokenRef.current
      setNotice(null)
      setBusy(true)

      // A list is imported whole. "Play now" replaces the queue with exactly its
      // tracks, which is what "play this album" means; the rest of the history is
      // not appended, or the album would keep going after its last track.
      if (link.kind === 'list') {
        setPending({ url: linkText, kind: 'list', mode, error: null })
        try {
          const detail = await onImportList(youtubeListUrl(link.listId))
          if (token !== submitTokenRef.current) return
          setPending(null)
          setUrl('')
          setOffer(null)
          const tracks = detail.items.map((item) => onlinePlaylistItemToTrack(item, detail.playlist))
          if (mode === 'play') onPlay(tracks, 0)
          else onQueue(tracks)
          const noun =
            detail.playlist.kind === 'album' ? 'album' : detail.playlist.kind === 'mix' ? 'mix' : 'playlist'
          setNotice({
            kind: 'info',
            text: `${detail.playlist.title} · ${formatCount(tracks.length)} tracks from that ${noun} ${
              mode === 'play' ? 'are playing' : 'were added to the queue'
            }.`
          })
        } catch (cause) {
          if (token !== submitTokenRef.current) return
          setPending({ url: linkText, kind: 'list', mode, error: messageOf(cause) })
        } finally {
          if (token === submitTokenRef.current) setBusy(false)
        }
        return
      }

      setPending({ url: linkText, kind: 'video', mode, error: null })
      try {
        const entry = await onAddLink(linkText)
        if (token !== submitTokenRef.current) return
        setPending(null)
        setUrl('')
        // Playing the video does not import the list it belongs to. The offer is
        // how the user says yes, and it stays until they answer or paste another.
        setOffer(link.kind === 'video-in-list' ? { listId: link.listId, kind: link.listKind } : null)
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
        setPending({ url: linkText, kind: 'video', mode, error: messageOf(cause) })
      } finally {
        if (token === submitTokenRef.current) setBusy(false)
      }
    },
    [onAddLink, onImportList, onPlay, onQueue]
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
      const link = parseYouTubeLink(first)
      setUrl(first)
      setNotice(
        link.kind === 'refused'
          ? { kind: 'info', text: describeYouTubeRefusal(link.reason) }
          : null
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

  const saveEntry = useCallback(
    async (entry: OnlineTrack): Promise<void> => {
      try {
        await saveToLibrary({
          videoId: entry.videoId,
          title: entry.title,
          artist: entry.artist,
          album: entry.album
        })
        setNotice({ kind: 'info', text: `Saved “${entry.title}” to your library.` })
      } catch (cause) {
        setNotice({ kind: 'error', text: messageOf(cause) })
      }
    },
    [saveToLibrary]
  )

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
      : 'Paste a video, playlist, album or mix link — playlists stay in the Playlists view and stream like the rest'

  const parsed = url.trim().length > 0 ? parseYouTubeLink(url.trim()) : null
  const listInput = parsed?.kind === 'list'
  const busyLabel = pending?.kind === 'list' ? 'Importing…' : 'Resolving…'

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
            placeholder="https://www.youtube.com/watch?v=… or a playlist link"
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
            <span>{listInput ? 'Add all to queue' : 'Add to queue'}</span>
          </button>
          <button type="submit" className="primary" disabled={busy || url.trim().length === 0}>
            {busy ? <SpinnerIcon /> : <PlayIcon size={15} />}
            <span>{busy ? busyLabel : listInput ? 'Import & play' : 'Play now'}</span>
          </button>
        </div>
      </form>

      {offer ? (
        <div className="banner import-offer">
          <span>
            That video is part of {offer.kind === 'album' ? 'an album' : 'a playlist'}. Import all of it?
          </span>
          <button
            type="button"
            className="small primary"
            disabled={busy}
            onClick={() => void run(youtubeListUrl(offer.listId), 'play')}
          >
            <PlayIcon size={14} />
            <span>Import & play</span>
          </button>
          <button
            type="button"
            className="small"
            disabled={busy}
            onClick={() => void run(youtubeListUrl(offer.listId), 'queue')}
          >
            <QueueIcon size={14} />
            <span>Import to queue</span>
          </button>
          <button type="button" className="link-button" onClick={() => setOffer(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

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
            Paste a YouTube link above and it plays straight away. A playlist, album or mix is imported as a whole and
            appears in Playlists under Online. Streams stay here as links; save one to keep a copy in your library.
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
                    {pending.error
                      ? pending.kind === 'list'
                        ? 'Could not import this playlist'
                        : 'Could not play this link'
                      : pending.kind === 'list'
                        ? 'Importing playlist…'
                        : 'Resolving link…'}
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
            const saving = states[entry.videoId]
            const isSaved = saved.has(entry.videoId)
            const savingActive =
              saving !== undefined && saving.status !== 'saved' && saving.status !== 'failed'
            const savingLabel =
              saving?.status === 'queued'
                ? 'Queued'
                : saving?.status === 'indexing'
                  ? 'Indexing'
                  : saving?.status === 'finishing'
                    ? 'Finishing'
                    : `${Math.round(saving?.percent ?? 0)}%`
            return (
              <li
                key={entry.id}
                className={['online-item', current ? 'current' : '', isSaved ? 'saved' : ''].filter(Boolean).join(' ')}
              >
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
                  {savingActive ? (
                    <span className="online-time saving-time" title="Saving to your library">
                      {savingLabel}
                    </span>
                  ) : (
                    <span className="online-time">{formatDuration(entry.durationMs)}</span>
                  )}
                </button>
                <div className="online-actions">
                  <button
                    type="button"
                    className={isSaved ? 'icon-button subtle saved' : 'icon-button subtle'}
                    title={
                      isSaved
                        ? 'Already in your library'
                        : savingActive
                          ? 'Saving to your library…'
                          : saving?.status === 'failed'
                            ? (saving.error ?? 'Could not save this track. Try again.')
                            : 'Save to your library'
                    }
                    aria-label={isSaved ? `${entry.title} is in your library` : `Save ${entry.title} to your library`}
                    disabled={isSaved || savingActive}
                    onClick={() => void saveEntry(entry)}
                  >
                    {isSaved ? (
                      <CheckIcon />
                    ) : savingActive ? (
                      <SpinnerIcon />
                    ) : (
                      <DownloadIcon />
                    )}
                  </button>
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
        Saving downloads one file into your music folder, tags it with its cover and adds it to the library; the row
        then shows a tick. Nothing is cached while you stream.
      </p>

      {menu ? (
        <OnlineContextMenu
          state={menu}
          style={menuStyle}
          saved={saved.has(menu.entry.videoId)}
          saving={states[menu.entry.videoId]?.status}
          onPlay={() => playAt(entries.findIndex((entry) => entry.id === menu.entry.id))}
          onQueue={() => queueOne(menu.entry)}
          onSave={() => void saveEntry(menu.entry)}
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
  saved: boolean
  saving: DownloadProgress['status'] | undefined
  onPlay: () => void
  onQueue: () => void
  onSave: () => void
  onCopy: () => void
  onRemove: () => void
  onClose: () => void
}) {
  const { state, style, saved, saving, onPlay, onQueue, onSave, onCopy, onRemove, onClose } = props
  const containerRef = useRef<HTMLDivElement | null>(null)
  const savingActive = saving !== undefined && saving !== 'saved' && saving !== 'failed'

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
        disabled={saved || savingActive}
        title={saved ? 'Already in your library' : 'Download it, tag it and add it to the library'}
        onClick={() => {
          onSave()
          onClose()
        }}
      >
        {saved ? <CheckIcon /> : savingActive ? <SpinnerIcon /> : <DownloadIcon />}
        <span>{saved ? 'In your library' : savingActive ? 'Saving…' : 'Save to library'}</span>
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
