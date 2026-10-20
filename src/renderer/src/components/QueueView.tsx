import type { Track } from '@shared/types'
import { formatCount, formatDuration } from '@shared/format'
import { CloseIcon, QueueIcon } from './Icons'

export interface QueueViewProps {
  queue: Track[]
  index: number
  isPlaying: boolean
  onJump: (position: number) => void
  onRemove: (position: number) => void
  onClear: () => void
  onBrowseLibrary: () => void
}

/**
 * The play queue.
 *
 * This is the order the player will actually follow, which is not necessarily
 * library order: shuffle rewrites it. That is the point of showing it — with
 * shuffle on, "what plays next" is otherwise invisible.
 */
export function QueueView(props: QueueViewProps) {
  const { queue, index, isPlaying, onJump, onRemove, onClear, onBrowseLibrary } = props

  const totalMs = queue.reduce((sum, track) => sum + (track.durationMs ?? 0), 0)

  return (
    <section className="main-view">
      <header className="view-header">
        <div className="view-heading">
          <h1>Queue</h1>
          <p className="subtitle">
            {queue.length > 0
              ? `${formatCount(queue.length)} tracks · ${formatDuration(totalMs)} total`
              : 'Nothing queued'}
          </p>
        </div>
        {queue.length > 0 ? (
          <div className="header-actions">
            <button type="button" onClick={onClear}>
              <CloseIcon />
              <span>Clear queue</span>
            </button>
          </div>
        ) : null}
      </header>

      {queue.length === 0 ? (
        <div className="empty-state">
          <QueueIcon size={32} />
          <h2>The queue is empty</h2>
          <p>Play something from the library and it will show up here, in the order it will play.</p>
          <button type="button" className="primary" onClick={onBrowseLibrary}>
            <span>Browse library</span>
          </button>
        </div>
      ) : (
        <div className="queue-table">
          <div className="queue-head" aria-hidden="true">
            <span className="head-cell col-index">#</span>
            <span className="head-cell col-title">Title</span>
            <span className="head-cell col-artist">Artist</span>
            <span className="head-cell col-album">Album / playlist</span>
            <span className="head-cell col-time">Duration</span>
            <span className="head-cell col-actions">Action</span>
          </div>
          <ol className="queue-list">
            {queue.map((track, position) => {
              const isCurrent = position === index
              return (
                <li
                  key={`${track.id}-${position}`}
                  className={isCurrent ? 'queue-item current' : 'queue-item'}
                >
                  <button
                    type="button"
                    className="queue-jump"
                    onClick={() => onJump(position)}
                    title={isCurrent ? 'Restart this track' : 'Play this track'}
                  >
                    <span className="queue-position">
                      {isCurrent && isPlaying ? <span className="playing-dot" /> : position + 1}
                    </span>
                    <span className="queue-title" title={track.title}>
                      {track.title}
                    </span>
                    <span className="queue-artist" title={track.artist ?? undefined}>
                      {track.artist ?? 'Unknown artist'}
                    </span>
                    <span className="queue-album" title={track.album ?? undefined}>
                      {track.album ?? '—'}
                    </span>
                    <span className="queue-time">{formatDuration(track.durationMs)}</span>
                  </button>
                  <button
                    type="button"
                    className="icon-button subtle queue-remove"
                    title="Remove from queue"
                    aria-label={`Remove ${track.title} from the queue`}
                    onClick={() => onRemove(position)}
                  >
                    <CloseIcon />
                  </button>
                </li>
              )
            })}
          </ol>
        </div>
      )}
    </section>
  )
}
