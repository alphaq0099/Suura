import type { SaveItem, UseDownloadsResult } from '../hooks/useDownloads'
import { CheckIcon, CloseIcon, DownloadIcon, FolderIcon, RefreshIcon, SpinnerIcon } from './Icons'

export interface SavesPanelProps {
  downloads: UseDownloadsResult
  onReveal: (trackId: number) => void
}

function isActive(item: SaveItem): boolean {
  return (
    item.status === 'queued' ||
    item.status === 'downloading' ||
    item.status === 'finishing' ||
    item.status === 'indexing'
  )
}

function statusText(item: SaveItem): string {
  switch (item.status) {
    case 'queued':
      return 'Waiting for a slot'
    case 'downloading':
      return `${Math.round(item.percent ?? 0)}% downloaded`
    case 'finishing':
      return 'Tagging and adding cover'
    case 'indexing':
      return 'Adding to the library'
    case 'saved':
      return 'Saved to your library'
    case 'cancelled':
      return 'Cancelled'
    default:
      return item.error ?? 'Could not save this track'
  }
}

/**
 * A small dock for saves that are running, failed or just finished.
 *
 * Saving is the one job that outlives the view that started it: a link in the
 * Streaming history, an imported entry and a Save all can all be writing at the
 * same time. This panel is mounted once by the app, so those jobs stay visible
 * from every screen, and each row carries the only three actions a save needs —
 * cancel while it runs, retry when it failed, reveal once it is in the library.
 */
export function SavesPanel({ downloads, onReveal }: SavesPanelProps) {
  const { items, cancel, retry, dismiss } = downloads
  if (items.length === 0) return null

  const active = items.filter(isActive).length
  const finished = items.length - active

  return (
    <aside className="saves-panel" aria-label="Saves in progress">
      <header className="saves-head">
        <DownloadIcon size={14} />
        <strong>Saves</strong>
        <span className="saves-count">
          {active > 0 ? `${active} running` : `${finished} finished`}
        </span>
        {finished > 0 ? (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              for (const item of items) {
                if (!isActive(item)) dismiss(item.videoId)
              }
            }}
          >
            Clear finished
          </button>
        ) : null}
      </header>

      <ul className="saves-list">
        {items.map((item) => {
          const running = isActive(item)
          return (
            <li key={item.videoId} className={`saves-item ${item.status}`}>
              <span className="saves-icon" aria-hidden="true">
                {item.status === 'saved' ? (
                  <CheckIcon size={13} />
                ) : running ? (
                  <SpinnerIcon size={13} />
                ) : (
                  <DownloadIcon size={13} />
                )}
              </span>
              <span className="saves-body">
                <span className="saves-title" title={item.request?.title ?? item.videoId}>
                  {item.request?.title ?? item.videoId}
                </span>
                <span className="saves-status" title={statusText(item)}>
                  {statusText(item)}
                </span>
                {item.status === 'downloading' ? (
                  <span className="saves-progress" aria-hidden="true">
                    <span style={{ width: `${Math.max(0, Math.min(100, item.percent ?? 0))}%` }} />
                  </span>
                ) : null}
              </span>
              <span className="saves-actions">
                {running ? (
                  <button
                    type="button"
                    className="icon-button subtle"
                    title="Cancel this save"
                    aria-label={`Cancel saving ${item.request?.title ?? item.videoId}`}
                    onClick={() => cancel(item.videoId)}
                  >
                    <CloseIcon />
                  </button>
                ) : null}
                {item.status === 'saved' && item.trackId !== null ? (
                  <button
                    type="button"
                    className="icon-button subtle"
                    title="Show the file in Explorer"
                    aria-label={`Reveal ${item.request?.title ?? item.videoId}`}
                    onClick={() => item.trackId !== null && onReveal(item.trackId)}
                  >
                    <FolderIcon size={15} />
                  </button>
                ) : null}
                {item.status === 'failed' || item.status === 'cancelled' ? (
                  <button
                    type="button"
                    className="icon-button subtle"
                    title="Try this save again"
                    aria-label={`Retry saving ${item.request?.title ?? item.videoId}`}
                    onClick={() => retry(item.videoId)}
                  >
                    <RefreshIcon size={15} />
                  </button>
                ) : null}
                {!running ? (
                  <button
                    type="button"
                    className="icon-button subtle"
                    title="Dismiss"
                    aria-label={`Dismiss ${item.request?.title ?? item.videoId}`}
                    onClick={() => dismiss(item.videoId)}
                  >
                    <CloseIcon />
                  </button>
                ) : null}
              </span>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
