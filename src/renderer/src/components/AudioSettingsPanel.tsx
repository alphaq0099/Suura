import {
  EQ_BAND_FREQUENCIES,
  EQ_GAIN_MAX_DB,
  EQ_GAIN_MIN_DB,
  EQ_PREAMP_MAX_DB,
  EQ_PREAMP_MIN_DB,
  EQ_PRESETS,
  presetBands
} from '@shared/audio'
import type {
  AppSettings,
  AudioSettings,
  DeepPartial,
  EqualizerPreset,
  ReplayGainStatus
} from '@shared/types'

export interface AudioSettingsPanelProps {
  audio: AudioSettings
  replayGainStatus: ReplayGainStatus | null
  onUpdate: (patch: DeepPartial<AppSettings>) => void
  onScanReplayGain: () => Promise<void>
  onCancelReplayGain: () => void
}

/**
 * Equaliser and ReplayGain controls.
 *
 * Kept in its own file because both controls are dense and neither belongs in
 * the general settings card: the curves need ten labelled sliders, and the scan
 * needs a progress state that would otherwise drown the small reset switches
 * around it.
 */
export function AudioSettingsPanel(props: AudioSettingsPanelProps) {
  const { audio, replayGainStatus, onUpdate, onScanReplayGain, onCancelReplayGain } = props
  const equalizer = audio.equalizer
  const normalization = audio.normalization
  const scanning = replayGainStatus?.phase === 'scanning'
  const total = replayGainStatus?.libraryTotal ?? 0
  const analyzed = replayGainStatus?.libraryAnalyzed ?? 0
  const pending = Math.max(total - analyzed, 0)
  const noLibrary = replayGainStatus !== null && total === 0
  const canScan = !scanning && !noLibrary && (replayGainStatus === null || pending > 0)

  const updateEqualizer = (patch: DeepPartial<AudioSettings['equalizer']>): void => {
    onUpdate({ audio: { equalizer: patch } })
  }

  const choosePreset = (preset: EqualizerPreset): void => {
    const bands = presetBands(preset)
    updateEqualizer(bands ? { preset, bands } : { preset })
  }

  const setBand = (index: number, value: number): void => {
    const bands = [...equalizer.bands]
    bands[index] = value
    // Moving any slider makes the curve custom; keeping the old preset name
    // would make the next visit lie about what is applied.
    updateEqualizer({ bands, preset: 'custom' })
  }

  const resetCurve = (): void => {
    updateEqualizer({ preset: 'flat', bands: [...(presetBands('flat') ?? [])] })
  }

  return (
    <>
      <article className="card audio-card">
        <header className="card-header">
          <h2>Equalizer</h2>
        </header>
        <p className="card-hint">
          Ten bands from 31 Hz to 16 kHz. Preamp is applied before the filters; lower it if a boosted
          curve starts to distort. Changes apply while the track is playing.
        </p>

        <div className="field-grid">
          <label className="field checkbox">
            <input
              type="checkbox"
              checked={equalizer.enabled}
              onChange={(event) => updateEqualizer({ enabled: event.target.checked })}
            />
            <span>Enable equalizer</span>
          </label>

          <label className="field">
            <span>Preset</span>
            <select
              value={equalizer.preset}
              onChange={(event) => choosePreset(event.target.value as EqualizerPreset)}
            >
              {EQ_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.label}
                </option>
              ))}
              {equalizer.preset === 'custom' ? <option value="custom">Custom</option> : null}
            </select>
          </label>

          <label className="field">
            <span>Preamp</span>
            <input
              type="range"
              min={EQ_PREAMP_MIN_DB}
              max={EQ_PREAMP_MAX_DB}
              step={0.5}
              value={equalizer.preampDb}
              disabled={!equalizer.enabled}
              onChange={(event) => updateEqualizer({ preampDb: Number(event.target.value) })}
            />
            <span className="eq-readout">{formatDb(equalizer.preampDb)}</span>
          </label>
        </div>

        <div className="eq-bands" role="group" aria-label="Equalizer bands">
          {EQ_BAND_FREQUENCIES.map((frequency, index) => {
            const gain = equalizer.bands[index] ?? 0
            return (
              <label className="eq-band" key={frequency}>
                <span>{formatFrequency(frequency)}</span>
                <input
                  type="range"
                  min={EQ_GAIN_MIN_DB}
                  max={EQ_GAIN_MAX_DB}
                  step={0.5}
                  value={gain}
                  disabled={!equalizer.enabled}
                  aria-label={`${formatFrequency(frequency)} gain`}
                  onChange={(event) => setBand(index, Number(event.target.value))}
                />
                <span className="eq-readout">{formatDb(gain)}</span>
              </label>
            )
          })}
        </div>

        <div className="card-actions">
          <button type="button" onClick={resetCurve} disabled={!equalizer.enabled}>
            Reset curve
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

        <div className="card-actions">
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
        <p className="card-hint">
          Analysis decodes each file once with ffmpeg. It runs in the background and can be stopped;
          files that already have a measurement are skipped.
        </p>
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

function formatFrequency(frequency: number): string {
  if (frequency >= 1000) return `${frequency / 1000} kHz`
  return `${frequency} Hz`
}

function formatDb(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} dB`
}
