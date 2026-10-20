import { useCallback, useRef, useState, type FormEvent } from 'react'
import type { Track, YouTubeChannel, YouTubeSearchResult } from '@shared/types'
import { formatCount, formatDuration } from '@shared/format'
import { api, messageOf } from '../api'
import type { UseDownloadsResult } from '../hooks/useDownloads'
import { ArtworkImage } from './ArtworkImage'
import {
  CheckIcon,
  CloseIcon,
  DownloadIcon,
  LinkIcon,
  MusicIcon,
  PlayIcon,
  QueueIcon,
  SearchIcon,
  SpinnerIcon
} from './Icons'

export interface SearchViewProps {
  downloads: UseDownloadsResult
  onPlayLocal: (tracks: Track[]) => void
  onQueueLocal: (tracks: Track[]) => void
  /** Adds the result to the history, resolves it, and starts it. */
  onPlayYouTube: (result: YouTubeSearchResult) => Promise<void>
  onQueueYouTube: (result: YouTubeSearchResult) => Promise<void>
}

/** A track-shaped stub, only so the row can borrow the shared artwork lookup. */
function artworkTrack(result: YouTubeSearchResult): Track {
  return {
    id: 0,
    sourceKind: 'youtube',
    sourceId: result.videoId,
    originKind: null,
    originId: null,
    title: result.title,
    artist: result.artist,
    albumArtist: result.artist,
    album: null,
    trackNo: null,
    discNo: null,
    year: null,
    genre: null,
    durationMs: result.durationMs,
    codec: null,
    bitrateKbps: null,
    sampleRate: null,
    channels: null,
    fileSize: null,
    filePath: null,
    artworkKey: null,
    addedAt: 0,
    playCount: 0,
    lastPlayedAt: null
  }
}

/**
 * One search for two catalogues.
 *
 * The local library and YouTube are queried together and shown in one list, with
 * a badge on every row saying where it would play from. Choosing a local row
 * plays a file; choosing a YouTube row runs the same add-link path a pasted URL
 * takes, so the history keeps one rule about what a stream is and the user never
 * has to know which side of the app a song lives on.
 *
 * A channel is opened from any YouTube row and listed in place, so "more from
 * this channel" does not need a second window or an import.
 */
export function SearchView(props: SearchViewProps) {
  const { downloads, onPlayLocal, onQueueLocal, onPlayYouTube, onQueueYouTube } = props
  const { saved, states, save } = downloads

  const [query, setQuery] = useState('')
  const [submitted, setSubmitted] = useState('')
  const [local, setLocal] = useState<Track[]>([])
  const [youtube, setYoutube] = useState<YouTubeSearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [youtubeError, setYoutubeError] = useState<string | null>(null)
  const [busyVideoId, setBusyVideoId] = useState<string | null>(null)
  const [channel, setChannel] = useState<YouTubeChannel | null>(null)
  const [channelLoading, setChannelLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const openChannel = useCallback(async (target: string, name: string): Promise<void> => {
    setChannelLoading(true)
    setError(null)
    try {
      setChannel(await api.getYouTubeChannel(target, 30))
    } catch (cause) {
      setError(`Could not open ${name}: ${messageOf(cause)}`)
    } finally {
      setChannelLoading(false)
    }
  }, [])

  const run = useCallback(async (): Promise<void> => {
    const text = query.trim()
    if (text.length === 0) return
    setLoading(true)
    setError(null)
    setYoutubeError(null)
    setChannel(null)
    setSubmitted(text)
    // Clear the previous answer before waiting: a slow search that leaves the
    // old rows on screen under the new query is worse than an empty list.
    setLocal([])
    setYoutube([])

    const [localAnswer, youtubeAnswer] = await Promise.allSettled([
      api.listTracks({ search: text, limit: 25 }),
      api.searchYouTube(text, 20)
    ])

    if (localAnswer.status === 'fulfilled') {
      setLocal(localAnswer.value.tracks)
    } else {
      setLocal([])
      setError(messageOf(localAnswer.reason))
    }

    if (youtubeAnswer.status === 'fulfilled') {
      setYoutube(youtubeAnswer.value)
    } else {
      setYoutube([])
      setYoutubeError(messageOf(youtubeAnswer.reason))
    }
    setLoading(false)
  }, [query])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    void run()
  }

  const playYouTube = useCallback(
    async (result: YouTubeSearchResult): Promise<void> => {
      setBusyVideoId(result.videoId)
      setError(null)
      try {
        await onPlayYouTube(result)
      } catch (cause) {
        setError(messageOf(cause))
      } finally {
        setBusyVideoId(null)
      }
    },
    [onPlayYouTube]
  )

  const queueYouTube = useCallback(
    async (result: YouTubeSearchResult): Promise<void> => {
      setBusyVideoId(result.videoId)
      setError(null)
      try {
        await onQueueYouTube(result)
      } catch (cause) {
        setError(messageOf(cause))
      } finally {
        setBusyVideoId(null)
      }
    },
    [onQueueYouTube]
  )

  const saveYouTube = useCallback(
    async (result: YouTubeSearchResult): Promise<void> => {
      setError(null)
      try {
        await save({ videoId: result.videoId, title: result.title, artist: result.artist, album: null })
      } catch (cause) {
        setError(messageOf(cause))
      }
    },
    [save]
  )

  const rows = [...local, ...youtube]
  const hasResults = submitted.length > 0 && (local.length > 0 || youtube.length > 0)

  return (
    <section className="main-view discover-view">
      <header className="view-header">
        <div className="view-heading">
          <h1>{channel ? channel.name : 'Search'}</h1>
          <p className="subtitle">
            {channel
              ? 'Recent videos from this channel. Nothing is downloaded until you ask.'
              : 'Your library and YouTube in one list — each row says where it would play from.'}
          </p>
        </div>
        {channel ? (
          <div className="header-actions">
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setChannel(null)
                setError(null)
              }}
            >
              <CloseIcon />
              <span>Back to results</span>
            </button>
          </div>
        ) : null}
      </header>

      {channel ? (
        <>
          {channelLoading ? <div className="banner">Loading the channel…</div> : null}
          {channel.entries.length === 0 ? (
            <div className="empty-state">
              <MusicIcon size={32} />
              <h2>No videos in this channel</h2>
              <p>YouTube returned no public videos that this app can list.</p>
            </div>
          ) : (
            <ul className="discover-list" aria-label={`${channel.name} videos`}>
              {channel.entries.map((result) => (
                <YouTubeRow
                  key={result.videoId}
                  result={result}
                  busy={busyVideoId === result.videoId}
                  isSaved={saved.has(result.videoId)}
                  savingState={states[result.videoId]}
                  onPlay={() => void playYouTube(result)}
                  onQueue={() => void queueYouTube(result)}
                  onSave={() => void saveYouTube(result)}
                  onChannel={null}
                />
              ))}
            </ul>
          )}
          {error ? <div className="banner error">{error}</div> : null}
        </>
      ) : (
        <>
          <form className="discover-bar" onSubmit={submit}>
            <div className="discover-input">
              <SearchIcon />
              <input
                ref={inputRef}
                type="search"
                autoComplete="off"
                spellCheck={false}
                placeholder="Search your library and YouTube"
                aria-label="Search your library and YouTube"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                disabled={loading}
              />
            </div>
            <button type="submit" className="primary" disabled={loading || query.trim().length === 0}>
              {loading ? <SpinnerIcon /> : <SearchIcon />}
              <span>{loading ? 'Searching…' : 'Search'}</span>
            </button>
          </form>

          {loading ? <div className="banner">Searching your library and YouTube…</div> : null}
          {channelLoading ? <div className="banner">Opening the channel…</div> : null}
          {error ? <div className="banner error">{error}</div> : null}
          {youtubeError ? (
            <div className="banner">
              YouTube search is unavailable right now: {youtubeError} Your library results are still shown.
            </div>
          ) : null}

          {!hasResults && !loading ? (
            <div className="empty-state">
              <SearchIcon size={32} />
              <h2>{submitted ? 'Nothing matched' : 'Find something to play'}</h2>
              <p>
                {submitted
                  ? 'No local tracks or YouTube videos matched that search. Try a shorter query, or check the spelling.'
                  : 'Search by song, artist, album or channel. Local rows play from disk; YouTube rows stream, and can be queued or saved into your library.'}
              </p>
            </div>
          ) : null}

          {hasResults ? (
            <>
              <div className="discover-summary">
                <span>
                  Results for <strong>“{submitted}”</strong>
                </span>
                <span className="discover-count">{formatCount(rows.length)}</span>
              </div>
              <ul className="discover-list" aria-label="Search results">
                {local.length > 0 ? (
                  <li className="discover-divider">
                    <span className="source-badge local">Local</span>
                    <span>In your library</span>
                    <span className="discover-count">{local.length}</span>
                  </li>
                ) : null}
                {local.map((track) => (
                  <li key={`local-${track.id}`} className="discover-item">
                    <button
                      type="button"
                      className="discover-jump"
                      title={`Play ${track.title}`}
                      onClick={() => onPlayLocal([track])}
                    >
                      <ArtworkImage track={track} size={34} className="discover-art" />
                      <span className="discover-title">{track.title}</span>
                      <span className="discover-artist">{track.artist ?? 'Unknown artist'}</span>
                      <span className="discover-album">{track.album ?? '—'}</span>
                      <span className="discover-time">{formatDuration(track.durationMs)}</span>
                    </button>
                    <div className="discover-actions">
                      <span className="source-badge local">Local</span>
                      <button
                        type="button"
                        className="icon-button subtle"
                        title="Add to queue"
                        aria-label={`Add ${track.title} to the queue`}
                        onClick={() => onQueueLocal([track])}
                      >
                        <QueueIcon size={15} />
                      </button>
                      <button
                        type="button"
                        className="icon-button subtle"
                        title="Play"
                        aria-label={`Play ${track.title}`}
                        onClick={() => onPlayLocal([track])}
                      >
                        <PlayIcon size={15} />
                      </button>
                    </div>
                  </li>
                ))}

                {youtube.length > 0 ? (
                  <li className="discover-divider">
                    <span className="source-badge youtube">YouTube</span>
                    <span>Not in your library</span>
                    <span className="discover-count">{youtube.length}</span>
                  </li>
                ) : null}
                {youtube.map((result) => (
                  <YouTubeRow
                    key={result.videoId}
                    result={result}
                    busy={busyVideoId === result.videoId}
                    isSaved={saved.has(result.videoId)}
                    savingState={states[result.videoId]}
                    onPlay={() => void playYouTube(result)}
                    onQueue={() => void queueYouTube(result)}
                    onSave={() => void saveYouTube(result)}
                    onChannel={
                      result.channelId || result.channelName
                        ? () =>
                            void openChannel(
                              result.channelId ?? result.channelName ?? result.videoId,
                              result.channelName ?? 'this channel'
                            )
                        : null
                    }
                  />
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </section>
  )
}

function YouTubeRow(props: {
  result: YouTubeSearchResult
  busy: boolean
  isSaved: boolean
  savingState: { status: string; percent: number | null; error: string | null } | undefined
  onPlay: () => void
  onQueue: () => void
  onSave: () => void
  onChannel: (() => void) | null
}) {
  const { result, busy, isSaved, savingState, onPlay, onQueue, onSave, onChannel } = props
  const savingActive =
    savingState !== undefined &&
    savingState.status !== 'saved' &&
    savingState.status !== 'failed' &&
    savingState.status !== 'cancelled'

  return (
    <li className="discover-item">
      <button
        type="button"
        className="discover-jump"
        title={busy ? 'Resolving this video…' : `Play ${result.title}`}
        onClick={onPlay}
        disabled={busy}
      >
        <ArtworkImage track={artworkTrack(result)} size={34} className="discover-art" />
        <span className="discover-title">{result.title}</span>
        <span className="discover-artist">
          {result.channelName ?? result.artist ?? 'Unknown channel'}
        </span>
        <span className="discover-album">YouTube</span>
        <span className="discover-time">{busy ? 'Resolving…' : formatDuration(result.durationMs)}</span>
      </button>
      <div className="discover-actions">
        <span className="source-badge youtube">
          <LinkIcon size={11} />
          YouTube
        </span>
        {onChannel ? (
          <button
            type="button"
            className="link-button discover-channel"
            title={`More from ${result.channelName ?? 'this channel'}`}
            onClick={onChannel}
          >
            Channel
          </button>
        ) : null}
        <button
          type="button"
          className={isSaved ? 'icon-button subtle saved' : 'icon-button subtle'}
          title={isSaved ? 'Already in your library' : savingActive ? 'Saving…' : 'Save to library'}
          aria-label={isSaved ? `${result.title} is in your library` : `Save ${result.title} to your library`}
          disabled={isSaved || savingActive}
          onClick={onSave}
        >
          {isSaved ? <CheckIcon /> : savingActive ? <SpinnerIcon /> : <DownloadIcon />}
        </button>
        <button
          type="button"
          className="icon-button subtle"
          title="Add to queue"
          aria-label={`Add ${result.title} to the queue`}
          onClick={onQueue}
        >
          <QueueIcon size={15} />
        </button>
        <button
          type="button"
          className="icon-button subtle"
          title="Play"
          aria-label={`Play ${result.title}`}
          disabled={busy}
          onClick={onPlay}
        >
          {busy ? <SpinnerIcon /> : <PlayIcon size={15} />}
        </button>
      </div>
    </li>
  )
}
