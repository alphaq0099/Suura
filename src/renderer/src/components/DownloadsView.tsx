import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CacheEntry, CacheStats, DownloadHistoryItem, DownloadStatus } from '@shared/types'
import { formatBytes } from '@shared/format'
import { api, messageOf } from '../api'
import type { UseDownloadsResult } from '../hooks/useDownloads'
import {
  CheckIcon,
  CloseIcon,
  DiscIcon,
  DownloadIcon,
  FolderIcon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
  SpinnerIcon,
  TrashIcon
} from './Icons'

type Tab = 'downloads' | 'cache'

export interface DownloadsViewProps {
  downloads: UseDownloadsResult
  onRevealTrack: (trackId: number) => void
  onOpenLibrary: () => void
  onError: (message: string) => void
}

interface DownloadRow {
  videoId: string
  title: string
  artist: string | null
  album: string | null
  status: DownloadStatus
  percent: number | null
  error: string | null
  trackId: number | null
  speedBytesPerSecond: number | null
  etaSeconds: number | null
  updatedAt: number
}

function isActive(status: DownloadStatus): boolean {
  return status === 'queued' || status === 'downloading' || status === 'paused' || status === 'finishing' || status === 'indexing'
}

function statusLabel(row: DownloadRow): string {
  switch (row.status) {
    case 'queued':
      return 'Waiting for a slot'
    case 'downloading': {
      const percent = Math.round(row.percent ?? 0)
      const speed = formatSpeed(row.speedBytesPerSecond)
      const eta = formatEta(row.etaSeconds)
      return [percent + '%', speed, eta].filter(Boolean).join(' · ')
    }
    case 'paused':
      return row.percent === null ? 'Paused' : `Paused at ${Math.round(row.percent)}%`
    case 'finishing':
      return 'Tagging and adding cover'
    case 'indexing':
      return 'Adding to the library'
    case 'saved':
      return 'Saved to your library'
    case 'removed':
      return 'File removed; plays from YouTube'
    case 'cancelled':
      return 'Cancelled'
    default:
      return row.error ?? 'Could not save this track'
  }
}

function formatSpeed(bytes: number | null): string | null {
  if (bytes === null || bytes <= 0) return null
  return `${formatBytes(bytes)}/s`
}

function formatEta(seconds: number | null): string | null {
  if (seconds === null || seconds < 0) return null
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s left`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return `${minutes}m ${rest}s left`
}

function rowFromHistory(row: DownloadHistoryItem): DownloadRow {
  return {
    videoId: row.videoId,
    title: row.title,
    artist: row.artist,
    album: row.album,
    status: row.status,
    percent: row.percent,
    error: row.error,
    trackId: row.trackId,
    speedBytesPerSecond: null,
    etaSeconds: null,
    updatedAt: row.updatedAt
  }
}

/**
 * The full Downloads surface.
 *
 * Two ledgers that are deliberately separate: saved files the user asked to
 * keep, and the best-effort offline cache. Merging them would make Clear cache
 * look like it deletes library tracks; showing them in one view, with explicit
 * Keep/Remove controls, is what the M12b split was for.
 */
export function DownloadsView({ downloads, onRevealTrack, onOpenLibrary, onError }: DownloadsViewProps) {
  const [tab, setTab] = useState<Tab>('downloads')

  const rows = useMemo(() => {
    const merged = new Map<string, DownloadRow>()
    for (const item of downloads.history) merged.set(item.videoId, rowFromHistory(item))
    for (const item of downloads.items) {
      const existing = merged.get(item.videoId)
      merged.set(item.videoId, {
        videoId: item.videoId,
        title: item.request?.title ?? existing?.title ?? item.videoId,
        artist: item.request?.artist ?? existing?.artist ?? null,
        album: item.request?.album ?? existing?.album ?? null,
        status: item.status,
        percent: item.percent,
        error: item.error,
        trackId: item.trackId ?? existing?.trackId ?? null,
        speedBytesPerSecond: item.speedBytesPerSecond,
        etaSeconds: item.etaSeconds,
        updatedAt: Math.max(item.updatedAt, existing?.updatedAt ?? 0)
      })
    }
    return [...merged.values()].sort((left, right) => right.updatedAt - left.updatedAt)
  }, [downloads.history, downloads.items])

  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [removing, setRemoving] = useState(false)

  const savedRows = rows.filter((row) => row.status === 'saved')
  const allSavedSelected = savedRows.length > 0 && savedRows.every((row) => selected.has(row.videoId))

  const toggleSelected = useCallback((videoId: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(videoId)) next.delete(videoId)
      else next.add(videoId)
      return next
    })
  }, [])

  const toggleAllSaved = useCallback((): void => {
    setSelected((current) => {
      if (savedRows.every((row) => current.has(row.videoId))) return new Set<string>()
      return new Set(savedRows.map((row) => row.videoId))
    })
  }, [savedRows])

  const removeRows = useCallback(
    async (targets: DownloadRow[]): Promise<void> => {
      if (targets.length === 0) return
      const names = targets.map((row) => row.title).slice(0, 3).join(', ')
      const more = targets.length > 3 ? ` and ${targets.length - 3} more` : ''
      if (!window.confirm(`Delete the saved file${targets.length === 1 ? '' : 's'} for ${names}${more}? The track stays in playlists and will stream from YouTube.`)) {
        return
      }
      setRemoving(true)
      try {
        for (const row of targets) {
          const removed = await downloads.remove(row.videoId)
          if (!removed) onError(`Could not remove ${row.title}.`)
        }
        setSelected(new Set<string>())
      } catch (cause) {
        onError(messageOf(cause))
      } finally {
        setRemoving(false)
      }
    },
    [downloads, onError]
  )

  return (
    <div className="downloads-view">
      <header className="view-header downloads-header">
        <div className="view-heading">
          <span className="downloads-kicker">Library &amp; offline</span>
          <h1>Downloads</h1>
          <p>Saved files you keep, and stream copies the player can play without a connection.</p>
        </div>
        <div className="downloads-tabs" role="tablist" aria-label="Downloads sections">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'downloads'}
            className={tab === 'downloads' ? 'downloads-tab active' : 'downloads-tab'}
            onClick={() => setTab('downloads')}
          >
            <DownloadIcon size={15} /> Saved
            {rows.length > 0 ? <span className="downloads-tab-count">{rows.length}</span> : null}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'cache'}
            className={tab === 'cache' ? 'downloads-tab active' : 'downloads-tab'}
            onClick={() => setTab('cache')}
          >
            <DiscIcon size={15} /> Offline cache
          </button>
        </div>
      </header>

      {tab === 'downloads' ? (
        <SavedDownloads
          rows={rows}
          selected={selected}
          allSavedSelected={allSavedSelected}
          removing={removing}
          onToggle={toggleSelected}
          onToggleAll={toggleAllSaved}
          onRemove={removeRows}
          onRevealTrack={onRevealTrack}
          onOpenLibrary={onOpenLibrary}
          downloads={downloads}
          onError={onError}
        />
      ) : (
        <CacheManager onError={onError} />
      )}
    </div>
  )
}

interface SavedDownloadsProps {
  rows: DownloadRow[]
  selected: ReadonlySet<string>
  allSavedSelected: boolean
  removing: boolean
  onToggle: (videoId: string) => void
  onToggleAll: () => void
  onRemove: (rows: DownloadRow[]) => void
  onRevealTrack: (trackId: number) => void
  onOpenLibrary: () => void
  downloads: UseDownloadsResult
  onError: (message: string) => void
}

function SavedDownloads({
  rows,
  selected,
  allSavedSelected,
  removing,
  onToggle,
  onToggleAll,
  onRemove,
  onRevealTrack,
  onOpenLibrary,
  downloads,
  onError
}: SavedDownloadsProps) {
  if (rows.length === 0) {
    return (
      <div className="downloads-empty">
        <DownloadIcon size={28} />
        <h2>No saved downloads yet</h2>
        <p>Use Save in YouTube, Search or the player bar. Saved files appear here and in your library.</p>
        <button type="button" className="button secondary" onClick={onOpenLibrary}>
          Open library
        </button>
      </div>
    )
  }

  const selectedSaved = rows.filter((row) => row.status === 'saved' && selected.has(row.videoId))

  return (
    <section className="downloads-panel" aria-label="Saved downloads">
      <div className="downloads-toolbar">
        <label className="downloads-check">
          <input type="checkbox" checked={allSavedSelected} onChange={onToggleAll} />
          <span>Select saved</span>
        </label>
        <span className="downloads-toolbar-note">
          {rows.length} {rows.length === 1 ? 'download' : 'downloads'} · {rows.filter((row) => row.status === 'saved').length} on disk
        </span>
        <button
          type="button"
          className="button secondary danger-quiet"
          disabled={selectedSaved.length === 0 || removing}
          onClick={() => void onRemove(selectedSaved)}
        >
          <TrashIcon size={14} /> Remove selected
        </button>
      </div>

      <ul className="downloads-list">
        {rows.map((row) => {
          const active = isActive(row.status)
          return (
            <li key={row.videoId} className={`download-item ${row.status}`}>
              <span className="download-select">
                {row.status === 'saved' ? (
                  <input
                    type="checkbox"
                    checked={selected.has(row.videoId)}
                    onChange={() => onToggle(row.videoId)}
                    aria-label={`Select ${row.title}`}
                  />
                ) : (
                  <span className="download-select-spacer" />
                )}
              </span>
              <span className="download-art" aria-hidden="true">
                {active ? <SpinnerIcon size={18} /> : row.status === 'saved' ? <CheckIcon size={18} /> : <DiscIcon size={18} />}
              </span>
              <span className="download-body">
                <span className="download-title" title={row.title}>{row.title}</span>
                <span className="download-meta">
                  {row.artist ?? 'Unknown artist'}
                  {row.album ? ` · ${row.album}` : ''}
                </span>
                <span className="download-status" title={statusLabel(row)}>
                  {statusLabel(row)}
                </span>
                {row.status === 'downloading' ? (
                  <span className="download-progress" aria-hidden="true">
                    <span style={{ width: `${Math.max(0, Math.min(100, row.percent ?? 0))}%` }} />
                  </span>
                ) : null}
              </span>
              <span className="download-actions">
                {row.status === 'downloading' ? (
                  <button type="button" className="icon-button subtle" title="Pause this download" onClick={() => downloads.pause(row.videoId)}>
                    <PauseIcon size={15} />
                  </button>
                ) : null}
                {row.status === 'paused' ? (
                  <button type="button" className="icon-button subtle" title="Resume this download" onClick={() => downloads.resume(row.videoId)}>
                    <PlayIcon size={15} />
                  </button>
                ) : null}
                {row.status === 'queued' || row.status === 'downloading' || row.status === 'paused' ? (
                  <button type="button" className="icon-button subtle" title="Cancel this download" onClick={() => downloads.cancel(row.videoId)}>
                    <CloseIcon />
                  </button>
                ) : null}
                {row.status === 'failed' || row.status === 'cancelled' || row.status === 'removed' ? (
                  <button
                    type="button"
                    className="icon-button subtle"
                    title={row.status === 'removed' ? 'Save this track again' : 'Try this save again'}
                    onClick={() => {
                      void downloads
                        .save({
                          videoId: row.videoId,
                          title: row.title,
                          artist: row.artist,
                          album: row.album
                        })
                        .catch((cause) => onError(messageOf(cause)))
                    }}
                  >
                    <RefreshIcon size={15} />
                  </button>
                ) : null}
                {row.status === 'saved' && row.trackId !== null ? (
                  <button type="button" className="icon-button subtle" title="Show the file in Explorer" onClick={() => onRevealTrack(row.trackId as number)}>
                    <FolderIcon size={15} />
                  </button>
                ) : null}
                {row.status === 'saved' ? (
                  <button
                    type="button"
                    className="icon-button subtle danger-quiet"
                    title="Delete the saved file and stream from YouTube"
                    onClick={() => void onRemove([row])}
                  >
                    <TrashIcon size={15} />
                  </button>
                ) : null}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function CacheManager({ onError }: { onError: (message: string) => void }) {
  const [stats, setStats] = useState<CacheStats | null>(null)
  const [entries, setEntries] = useState<CacheEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>())

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [nextStats, nextEntries] = await Promise.all([api.getCacheStats(), api.listCacheEntries(500)])
      setStats(nextStats)
      setEntries(nextEntries)
    } catch (cause) {
      onError(messageOf(cause))
    } finally {
      setLoading(false)
    }
  }, [onError])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggle = useCallback((videoId: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(videoId)) next.delete(videoId)
      else next.add(videoId)
      return next
    })
  }, [])

  const setPinned = useCallback(
    async (videoId: string, pinned: boolean): Promise<void> => {
      setBusy(true)
      try {
        const next = await api.setCachePinned(videoId, pinned)
        setStats(next)
        await refresh()
      } catch (cause) {
        onError(messageOf(cause))
      } finally {
        setBusy(false)
      }
    },
    [onError, refresh]
  )

  const remove = useCallback(
    async (videoIds: string[], clearAll = false): Promise<void> => {
      if (videoIds.length === 0 && !clearAll) return
      if (
        !window.confirm(
          clearAll
            ? 'Delete every cache file that is not currently in use? Saved library tracks are not affected.'
            : `Delete ${videoIds.length === 1 ? 'this cache file' : `${videoIds.length} cache files`}? Saved library tracks are not affected.`
        )
      ) {
        return
      }
      setBusy(true)
      try {
        if (clearAll) {
          setStats(await api.clearCache())
        } else {
          for (const videoId of videoIds) {
            const removed = await api.removeCacheEntry(videoId)
            if (!removed) onError('A cache file is open in the player and could not be removed.')
          }
        }
        setSelected(new Set<string>())
        await refresh()
      } catch (cause) {
        onError(messageOf(cause))
      } finally {
        setBusy(false)
      }
    },
    [onError, refresh]
  )

  const usedPercent =
    stats && stats.budgetBytes > 0 ? Math.min(100, (stats.bytes / stats.budgetBytes) * 100) : 0
  const allSelected = entries.length > 0 && entries.every((entry) => selected.has(entry.videoId))

  return (
    <section className="downloads-panel cache-panel" aria-label="Offline cache">
      <div className="cache-summary">
        <div className="cache-usage">
          <div className="cache-usage-head">
            <span>Offline cache</span>
            <strong>
              {stats ? formatBytes(stats.bytes) : '—'} <span>/ {stats ? formatBytes(stats.budgetBytes) : '—'}</span>
            </strong>
          </div>
          <div className="cache-bar" aria-hidden="true">
            <span style={{ width: `${usedPercent}%` }} />
          </div>
          <p>
            {stats ? `${stats.entries} ${stats.entries === 1 ? 'track' : 'tracks'}` : 'No cache entries'}
            {stats && stats.pinnedEntries > 0 ? ` · ${stats.pinnedEntries} kept` : ''}
          </p>
        </div>
        <div className="cache-summary-actions">
          <button type="button" className="button secondary" disabled={busy || !stats || stats.entries === 0} onClick={() => void remove([], true)}>
            Clear cache
          </button>
        </div>
      </div>

      <div className="downloads-toolbar">
        <label className="downloads-check">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => {
              setSelected(allSelected ? new Set<string>() : new Set(entries.map((entry) => entry.videoId)))
            }}
          />
          <span>Select all</span>
        </label>
        <span className="downloads-toolbar-note">
          {entries.length} cached {entries.length === 1 ? 'track' : 'tracks'}
        </span>
        <button
          type="button"
          className="button secondary danger-quiet"
          disabled={busy || selected.size === 0}
          onClick={() => void remove([...selected])}
        >
          <TrashIcon size={14} /> Remove selected
        </button>
      </div>

      {loading ? (
        <div className="downloads-empty compact" role="status">
          <SpinnerIcon size={22} />
          <p>Reading the cache…</p>
        </div>
      ) : entries.length === 0 ? (
        <div className="downloads-empty">
          <DiscIcon size={28} />
          <h2>The cache is empty</h2>
          <p>With Retain set to Cache, played YouTube tracks are copied here for offline playback.</p>
        </div>
      ) : (
        <ul className="downloads-list cache-list">
          {entries.map((entry) => (
            <li key={entry.videoId} className={`download-item ${entry.pinned ? 'pinned' : ''}`}>
              <span className="download-select">
                <input
                  type="checkbox"
                  checked={selected.has(entry.videoId)}
                  onChange={() => toggle(entry.videoId)}
                  aria-label={`Select cached video ${entry.videoId}`}
                />
              </span>
              <span className="download-art" aria-hidden="true">
                <DiscIcon size={18} />
              </span>
              <span className="download-body">
                <span className="download-title mono" title={entry.videoId}>
                  {entry.videoId}
                </span>
                <span className="download-meta">
                  {formatBytes(entry.sizeBytes)} · {entry.mimeType}
                </span>
                <span className="download-status">
                  Last used {new Date(entry.lastUsedAt).toLocaleDateString()}
                  {entry.pinned ? ' · Kept offline' : ''}
                </span>
              </span>
              <span className="download-actions">
                <button
                  type="button"
                  className={entry.pinned ? 'text-button active' : 'text-button'}
                  disabled={busy}
                  onClick={() => void setPinned(entry.videoId, !entry.pinned)}
                  title={entry.pinned ? 'Stop keeping this entry offline' : 'Keep this entry offline'}
                >
                  {entry.pinned ? 'Kept' : 'Keep'}
                </button>
                <button
                  type="button"
                  className="icon-button subtle"
                  title="Show the cache file in Explorer"
                  onClick={() => void api.revealCacheEntry(entry.videoId).catch((cause) => onError(messageOf(cause)))}
                >
                  <FolderIcon size={15} />
                </button>
                <button
                  type="button"
                  className="icon-button subtle danger-quiet"
                  title="Remove this cache entry"
                  onClick={() => void remove([entry.videoId])}
                >
                  <TrashIcon size={15} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
