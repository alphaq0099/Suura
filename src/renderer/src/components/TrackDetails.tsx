import { useEffect, useRef, useState } from 'react'
import type { Track } from '@shared/types'
import {
  formatAudioSummary,
  formatBitrate,
  formatBytes,
  formatCodec,
  formatCount,
  formatDuration,
  formatTimestamp
} from '@shared/format'
import { ArtworkImage } from './ArtworkImage'
import { CloseIcon, FolderIcon, PencilIcon } from './Icons'
import { TagEditor } from './TagEditor'

export interface TrackDetailsProps {
  track: Track
  /** Reveals a local file in Explorer. Omitted for entries with no file. */
  onReveal?: (trackId: number) => void
  /** Opens the editor straight away, for the row menu's "Edit tags" item. */
  initialEditing?: boolean
  onClose: () => void
}

/** 44100 -> "44.1 kHz". */
function formatSampleRate(hz: number | null): string {
  if (!hz) return '—'
  const kHz = hz / 1000
  return `${Number.isInteger(kHz) ? kHz : kHz.toFixed(1)} kHz`
}

function formatChannels(channels: number | null): string {
  if (!channels) return '—'
  if (channels === 1) return 'Mono'
  if (channels === 2) return 'Stereo'
  if (channels === 6) return '5.1'
  if (channels === 8) return '7.1'
  return `${channels} channels`
}

function youtubeIdOf(track: Track): string | null {
  if (track.originKind === 'youtube' && track.originId) return track.originId
  if (track.sourceKind === 'youtube' && track.sourceId) return track.sourceId
  return null
}

/**
 * Everything the library knows about one track.
 *
 * The table stopped showing Format when the column was worth more to the title;
 * this is where that fact, and the rest of the technical sheet, still lives.
 */
export function TrackDetails(props: TrackDetailsProps) {
  const { track, onReveal, initialEditing = false, onClose } = props
  const dialogRef = useRef<HTMLDivElement | null>(null)
  // A tag edit replaces the row, and the sheet has to show the new one without
  // waiting for the parent's list to refresh.
  const [current, setCurrent] = useState(track)
  const [editing, setEditing] = useState(initialEditing)

  useEffect(() => {
    if (!editing) dialogRef.current?.focus()
  }, [editing])

  useEffect(() => {
    setCurrent(track)
  }, [track])

  useEffect(() => {
    if (initialEditing) setEditing(true)
  }, [initialEditing])

  const youtubeId = youtubeIdOf(current)
  const local = current.filePath !== null

  const rows: Array<{ label: string; value: string; wide?: boolean }> = [
    { label: 'Artist', value: current.artist ?? '—' },
    { label: 'Album', value: current.album ?? '—' },
    { label: 'Album artist', value: current.albumArtist ?? '—' },
    { label: 'Duration', value: formatDuration(current.durationMs) },
    { label: 'Year', value: current.year ? String(current.year) : '—' },
    { label: 'Genre', value: current.genre ?? '—' },
    {
      label: 'Track',
      value:
        current.trackNo || current.discNo
          ? `${current.trackNo ?? '—'}${current.trackTotal ? `/${current.trackTotal}` : ''}${
              current.discNo
                ? ` · disc ${current.discNo}${current.discTotal ? `/${current.discTotal}` : ''}`
                : ''
            }`
          : '—'
    },
    { label: 'Format', value: local ? formatAudioSummary(current.codec, current.bitrateKbps) : 'Stream only' }
  ]

  if (local) {
    rows.push(
      { label: 'Codec', value: formatCodec(current.codec) },
      { label: 'Bitrate', value: formatBitrate(current.bitrateKbps) },
      { label: 'Sample rate', value: formatSampleRate(current.sampleRate) },
      { label: 'Channels', value: formatChannels(current.channels) },
      { label: 'File size', value: formatBytes(current.fileSize) },
      { label: 'Added', value: formatTimestamp(current.addedAt) },
      { label: 'Play count', value: formatCount(current.playCount) },
      { label: 'Last played', value: formatTimestamp(current.lastPlayedAt) },
      { label: 'Path', value: current.filePath ?? '—', wide: true }
    )
  } else {
    rows.push(
      { label: 'Added', value: formatTimestamp(current.addedAt) },
      { label: 'Play count', value: formatCount(current.playCount) },
      { label: 'Last played', value: formatTimestamp(current.lastPlayedAt) }
    )
  }

  if (youtubeId) {
    rows.push({
      label: 'YouTube',
      value: `https://www.youtube.com/watch?v=${youtubeId}`,
      wide: true
    })
  }

  // The editor is its own dialog with its own backdrop. Leaving this sheet
  // mounted behind it would stack two overlays — 72% plus 78% — and turn the
  // whole window almost black. The sheet steps aside while the editor is open.
  if (editing) {
    return (
      <TagEditor
        track={current}
        onSaved={setCurrent}
        onClose={() => {
          setEditing(false)
          if (initialEditing) onClose()
        }}
      />
    )
  }

  return (
    <div
      className="details-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        className="details-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="track-details-title"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          onClose()
        }}
      >
        <header className="details-head">
          <ArtworkImage track={current} size={64} iconSize={22} className="details-art" />
          <div className="details-titles">
            <h2 id="track-details-title">{current.title}</h2>
            <p className="subtitle">
              {current.artist ?? 'Unknown artist'}
              {current.album ? ` · ${current.album}` : ''}
            </p>
          </div>
          <button
            type="button"
            className="icon-button subtle details-close"
            title="Close details (Esc)"
            aria-label="Close details"
            onClick={onClose}
          >
            <CloseIcon size={16} />
          </button>
        </header>

        <dl className="details-grid">
          {rows.map((row) => (
            <div key={row.label} className={row.wide ? 'details-field wide' : 'details-field'}>
              <dt>{row.label}</dt>
              <dd className={row.label === 'Path' || row.label === 'YouTube' ? 'details-tech' : undefined}>
                {row.value}
              </dd>
            </div>
          ))}
        </dl>

        {local ? null : (
          <p className="details-note">
            This is a stream, not a file. Nothing is written to disk while it plays; saving it from the list
            downloads a copy into your music folder.
          </p>
        )}

        <footer className="details-foot">
          {local ? (
            <button type="button" onClick={() => setEditing(true)}>
              <PencilIcon />
              <span>Edit tags</span>
            </button>
          ) : null}
          {local && onReveal ? (
            <button
              type="button"
              onClick={() => {
                onReveal(current.id)
                onClose()
              }}
            >
              <FolderIcon />
              <span>Show in folder</span>
            </button>
          ) : null}
          <button type="button" className="primary" onClick={onClose}>
            <span>Close</span>
          </button>
        </footer>
      </div>
    </div>
  )
}
