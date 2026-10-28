import { useEffect, useRef } from 'react'
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
import { CloseIcon, FolderIcon } from './Icons'

export interface TrackDetailsProps {
  track: Track
  /** Reveals a local file in Explorer. Omitted for entries with no file. */
  onReveal?: (trackId: number) => void
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
  const { track, onReveal, onClose } = props
  const dialogRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  const youtubeId = youtubeIdOf(track)
  const local = track.filePath !== null

  const rows: Array<{ label: string; value: string; wide?: boolean }> = [
    { label: 'Artist', value: track.artist ?? '—' },
    { label: 'Album', value: track.album ?? '—' },
    { label: 'Album artist', value: track.albumArtist ?? '—' },
    { label: 'Duration', value: formatDuration(track.durationMs) },
    { label: 'Year', value: track.year ? String(track.year) : '—' },
    { label: 'Genre', value: track.genre ?? '—' },
    {
      label: 'Track',
      value:
        track.trackNo || track.discNo
          ? `${track.trackNo ?? '—'}${track.discNo ? ` · disc ${track.discNo}` : ''}`
          : '—'
    },
    { label: 'Format', value: local ? formatAudioSummary(track.codec, track.bitrateKbps) : 'Stream only' }
  ]

  if (local) {
    rows.push(
      { label: 'Codec', value: formatCodec(track.codec) },
      { label: 'Bitrate', value: formatBitrate(track.bitrateKbps) },
      { label: 'Sample rate', value: formatSampleRate(track.sampleRate) },
      { label: 'Channels', value: formatChannels(track.channels) },
      { label: 'File size', value: formatBytes(track.fileSize) },
      { label: 'Added', value: formatTimestamp(track.addedAt) },
      { label: 'Play count', value: formatCount(track.playCount) },
      { label: 'Last played', value: formatTimestamp(track.lastPlayedAt) },
      { label: 'Path', value: track.filePath ?? '—', wide: true }
    )
  } else {
    rows.push(
      { label: 'Added', value: formatTimestamp(track.addedAt) },
      { label: 'Play count', value: formatCount(track.playCount) },
      { label: 'Last played', value: formatTimestamp(track.lastPlayedAt) }
    )
  }

  if (youtubeId) {
    rows.push({
      label: 'YouTube',
      value: `https://www.youtube.com/watch?v=${youtubeId}`,
      wide: true
    })
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
          <ArtworkImage track={track} size={64} iconSize={22} className="details-art" />
          <div className="details-titles">
            <h2 id="track-details-title">{track.title}</h2>
            <p className="subtitle">
              {track.artist ?? 'Unknown artist'}
              {track.album ? ` · ${track.album}` : ''}
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
          {local && onReveal ? (
            <button
              type="button"
              onClick={() => {
                onReveal(track.id)
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
