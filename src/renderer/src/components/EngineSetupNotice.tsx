import { useId } from 'react'
import { formatBytes } from '@shared/format'
import type { EngineStatus, SidecarProgress } from '@shared/types'
import { CogIcon, DownloadIcon, SpinnerIcon } from './Icons'

/**
 * The engine download, offered where the need appears.
 *
 * Search and YouTube both lead to playback, and playback needs yt-dlp and
 * ffmpeg. A user who only browses local files never has to act on this notice;
 * it appears only after a probe has said the engine is not ready, so an
 * existing copy is never described as missing.
 */
export interface EngineSetupNoticeProps {
  engineStatus: EngineStatus | null
  installing: boolean
  progress: SidecarProgress | null
  note: string | null
  error: string | null
  onInstall: () => void
  onCancel: () => void
  onOpenSettings: () => void
  /** A tighter layout for a view that is not primarily about the engine. */
  compact?: boolean
}

/** Bytes still to download for the required binaries, or 0 when unknown. */
export function missingEngineBytes(engineStatus: EngineStatus | null): number {
  return (engineStatus?.sidecars ?? [])
    .filter((sidecar) => !sidecar.optional && !sidecar.installed)
    .reduce((sum, sidecar) => sum + sidecar.bytes, 0)
}

/** True only once a probe has run and reported that playback cannot start. */
export function engineIsMissing(engineStatus: EngineStatus | null): boolean {
  return engineStatus !== null && engineStatus.ready !== true
}

export function EngineSetupNotice(props: EngineSetupNoticeProps) {
  const { engineStatus, installing, progress, note, error, compact } = props
  const titleId = useId()
  if (!engineIsMissing(engineStatus)) return null

  const bytes = missingEngineBytes(engineStatus)
  const size = bytes > 0 ? ` — about ${formatBytes(bytes)}` : ''

  return (
    <section
      className={compact ? 'engine-callout compact' : 'engine-callout'}
      aria-labelledby={compact ? undefined : titleId}
      aria-label={compact ? 'YouTube playback needs the download engine' : undefined}
    >
      <div className="engine-callout-copy">
        <h2 id={compact ? undefined : titleId}>YouTube playback needs the download engine</h2>
        <p>
          {compact
            ? `Download yt-dlp and ffmpeg once${size}. Search works without them; playing, queueing and saving need them.`
            : `Playback, queueing and saving go through yt-dlp and ffmpeg. Download them once${size}; a copy already on this PC is used instead.`}
        </p>
        {progress ? (
          <div className="engine-progress" role="status">
            <progress value={progress.receivedBytes} max={Math.max(1, progress.totalBytes)} />
            <span>
              {progress.id}: {formatBytes(progress.receivedBytes)} of {formatBytes(progress.totalBytes)}
            </span>
          </div>
        ) : null}
        {error ? (
          <p className="engine-callout-note error" role="status">
            {error}
          </p>
        ) : note ? (
          <p className="engine-callout-note" role="status">
            {note}
          </p>
        ) : null}
      </div>
      <div className="engine-callout-actions">
        <button type="button" className="primary" onClick={props.onInstall} disabled={installing}>
          {installing ? <SpinnerIcon /> : <DownloadIcon />}
          <span>
            {installing
              ? 'Downloading engine'
              : bytes > 0
                ? `Download engine (${formatBytes(bytes)})`
                : 'Download engine'}
          </span>
        </button>
        {installing ? (
          <button type="button" onClick={props.onCancel}>
            Cancel
          </button>
        ) : (
          <button type="button" onClick={props.onOpenSettings}>
            <CogIcon />
            <span>Engine settings</span>
          </button>
        )}
      </div>
    </section>
  )
}
