import { useEffect, useRef } from 'react'
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
  EqualizerPreset
} from '@shared/types'
import { CloseIcon } from './Icons'

export interface EqualizerPanelProps {
  audio: AudioSettings
  open: boolean
  onUpdate: (patch: DeepPartial<AppSettings>) => void
  onClose: () => void
}

/**
 * The equalizer as a playback control, not a settings page.
 *
 * It is a non-modal popover anchored to the player bar: the app behind it stays
 * usable and the audio element is never remounted. Settings keeps a shortcut to
 * the same panel, so there is one implementation of the curve and one place to
 * add future playback controls.
 */
export function EqualizerPanel({ audio, open, onUpdate, onClose }: EqualizerPanelProps) {
  const equalizer = audio.equalizer
  const panelRef = useRef<HTMLDivElement>(null)

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

  // Escape closes the panel without reaching the global shortcuts, and a press
  // outside dismisses it like any other lightweight popover. The button itself
  // is excluded because its own handler toggles the panel.
  useEffect(() => {
    if (!open) return
    panelRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.eq-panel, .eq-toggle')) return
      onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="eq-panel"
      id="equalizer-panel"
      role="dialog"
      aria-label="Equalizer"
      tabIndex={-1}
      ref={panelRef}
    >
      <header className="eq-panel-head">
        <div className="eq-panel-title">
          <span>Playback</span>
          <h2>Equalizer</h2>
        </div>
        <label className="eq-enable">
          <input
            type="checkbox"
            checked={equalizer.enabled}
            onChange={(event) => updateEqualizer({ enabled: event.target.checked })}
          />
          <span>Enable</span>
        </label>
        <button
          type="button"
          className="icon-button subtle"
          onClick={onClose}
          title="Close the equalizer"
          aria-label="Close the equalizer"
        >
          <CloseIcon />
        </button>
      </header>

      <div className="eq-panel-tools">
        <label className="field eq-preset-field">
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

        <button type="button" className="button secondary eq-reset" onClick={resetCurve} disabled={!equalizer.enabled}>
          Reset curve
        </button>
      </div>

      {/* Upright faders, preamp apart from the ten bands: the curve reads as a
          row of levels at a glance, and the panel stays short enough to hang
          above the bar instead of covering the player. */}
      <div className="eq-faders">
        <label className="eq-preamp">
          <span>Preamp</span>
          <input
            className="eq-fader"
            type="range"
            min={EQ_PREAMP_MIN_DB}
            max={EQ_PREAMP_MAX_DB}
            step={0.5}
            value={equalizer.preampDb}
            disabled={!equalizer.enabled}
            aria-label="Preamp"
            onChange={(event) => updateEqualizer({ preampDb: Number(event.target.value) })}
          />
          <span className="eq-readout">{formatDb(equalizer.preampDb)}</span>
        </label>

        <span className="eq-fader-divider" aria-hidden="true" />

        <div className="eq-bands" role="group" aria-label="Equalizer bands">
          {EQ_BAND_FREQUENCIES.map((frequency, index) => {
            const gain = equalizer.bands[index] ?? 0
            return (
              <label className="eq-band" key={frequency}>
                <span>{formatFrequency(frequency)}</span>
                <input
                  className="eq-fader"
                  type="range"
                  min={EQ_GAIN_MIN_DB}
                  max={EQ_GAIN_MAX_DB}
                  step={0.5}
                  value={gain}
                  disabled={!equalizer.enabled}
                  aria-label={`${formatFrequency(frequency)} gain`}
                  onChange={(event) => setBand(index, Number(event.target.value))}
                />
                <span className="eq-readout">{formatBandDb(gain)}</span>
              </label>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function formatFrequency(frequency: number): string {
  if (frequency >= 1000) return `${frequency / 1000} kHz`
  return `${frequency} Hz`
}

function formatDb(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)} dB`
}

/** The ten bands sit in narrow columns, so their readouts omit the unit. */
function formatBandDb(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}`
}
