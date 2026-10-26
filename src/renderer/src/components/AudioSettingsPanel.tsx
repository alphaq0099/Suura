import type { MouseEvent as ReactMouseEvent } from 'react'
import type { AppSettings, AudioSettings, DeepPartial, ReplayGainStatus } from '@shared/types'
import { SlidersIcon } from './Icons'

export interface AudioSettingsPanelProps {
  audio: AudioSettings
  replayGainStatus: ReplayGainStatus | null
  onUpdate: (patch: DeepPartial<AppSettings>) => void
  onScanReplayGain: () => Promise<void>
  onCancelReplayGain: () => void
  onOpenEqualizer: (event: ReactMouseEvent<HTMLButtonElement>) => void
}

/**
 * Equaliser shortcut and ReplayGain controls.
 *
 * The curve itself is a playback control and lives on the player bar, where it
 * can be adjusted without leaving what is playing. This card keeps the way in,
 * and the scan needs a progress state that would otherwise drown the small reset
 * switches around it.
 */
export function AudioSettingsPanel(props: AudioSettingsPanelProps) {
  const {
    audio,
    replayGainStatus,
    onUpdate,
    onScanReplayGain,
    onCancelReplayGain,
    onOpenEqualizer
  } = props
  const normalization = audio.normalization
  const scanning = replayGainStatus?.phase === 'scanning'
  const total = replayGainStatus?.libraryTotal ?? 0
  const analyzed = replayGainStatus?.libraryAnalyzed ?? 0
  const pending = Math.max(total - analyzed, 0)
  const noLibrary = replayGainStatus !== null && total === 0
  const canScan = !scanning && !noLibrary && (replayGainStatus === null || pending > 0)

  return (
    <>
      <article className="card audio-card">
        <header className="card-header">
          <h2>Equalizer</h2>
        </header>
        <p className="card-hint">Ten bands and a preamp, applied while the track is playing.</p>
        <div className="card-actions start">
          <button type="button" className="button" onClick={onOpenEqualizer}>
            <SlidersIcon size={16} /> Open equalizer
          </button>
        </div>
      </article>

      <article className="card audio-card">
        <header className="card-header">
          <h2>Volume normalization</h2>
        </header>
        <p className="card-hint">
          Plays local tracks at a consistent loudness using a ReplayGain measurement. The value is
          stored per file, so it is applied instantly after the first analysis. Streams are not
          measured yet.
        </p>

        <div className="field-grid">
          <label className="field checkbox">
            <input
              type="checkbox"
              checked={normalization.enabled}
              onChange={(event) =>
                onUpdate({ audio: { normalization: { enabled: event.target.checked } } })
              }
            />
            <span>Apply ReplayGain to local tracks</span>
          </label>

          <label className="field checkbox">
            <input
              type="checkbox"
              checked={normalization.preventClipping}
              onChange={(event) =>
                onUpdate({
                  audio: { normalization: { preventClipping: event.target.checked } }
                })
              }
            />
            <span>Prevent clipping at the measured peak</span>
          </label>
        </div>

        {scanning ? (
          <div className="replay-gain-run" role="status">
            <progress
              value={replayGainStatus?.scanned ?? 0}
              max={Math.max(replayGainStatus?.total ?? 0, 1)}
            />
            <p className="card-hint">
              Analysing <strong>{replayGainStatus?.scanned ?? 0}</strong> of{' '}
              <strong>{replayGainStatus?.total ?? 0}</strong>
              {replayGainStatus?.currentFile ? (
                <span className="scan-file" title={replayGainStatus.currentFile}>
                  {baseName(replayGainStatus.currentFile)}
                </span>
              ) : null}
            </p>
          </div>
        ) : (
          <p className={`card-hint ${replayGainStatus?.phase === 'failed' ? 'status-error' : ''}`}>
            {statusText(replayGainStatus, analyzed, total, pending)}
          </p>
        )}

        <div className="card-actions start">
          {scanning ? (
            <button type="button" onClick={onCancelReplayGain}>
              Cancel scan
            </button>
          ) : (
            <button type="button" onClick={() => void onScanReplayGain()} disabled={!canScan}>
              {noLibrary ? 'No local tracks' : pending === 0 && replayGainStatus ? 'All tracks measured' : 'Analyse missing tracks'}
            </button>
          )}
        </div>
      </article>
    </>
  )
}

function statusText(
  status: ReplayGainStatus | null,
  analyzed: number,
  total: number,
  pending: number
): string {
  if (!status || status.phase === 'idle') {
    return total === 0
      ? 'No local tracks are indexed yet.'
      : `${analyzed} of ${total} local tracks measured.`
  }
  if (status.phase === 'failed') {
    return status.error ?? 'Loudness analysis failed.'
  }
  if (status.phase === 'cancelled') {
    return `Scan stopped. ${analyzed} of ${total} tracks measured.`
  }
  if (status.phase === 'scanning') {
    return `Starting analysis of ${status.total} tracks…`
  }
  if (status.total === 0 && pending > 0) {
    return `${analyzed} of ${total} local tracks measured; ${pending} waiting.`
  }
  if (status.total === 0) {
    return `Nothing to analyse. ${analyzed} of ${total} tracks already measured.`
  }
  const failed = status.failed > 0 ? ` ${status.failed} could not be read.` : ''
  return `Finished. ${analyzed} of ${total} tracks measured.${failed}${pending > 0 ? ' Some files still have no value.' : ''}`
}

function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] ?? filePath
}
