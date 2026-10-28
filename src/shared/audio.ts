import type {
  AudioSettings,
  DeepPartial,
  EqualizerPreset,
  EqualizerSettings,
  NormalizationSettings
} from './types'

/**
 * The ten fixed bands a graphic equaliser exposes.
 *
 * Frequencies are the ISO octave centres every 10-band EQ uses, so a preset
 * copied from another player means the same thing here. They are constants, not
 * settings: a band count that varies with the config would make every preset and
 * every saved curve ambiguous.
 */
export const EQ_BAND_FREQUENCIES = [31, 62, 125, 250, 500, 1_000, 2_000, 4_000, 8_000, 16_000] as const

export const EQ_BAND_COUNT = EQ_BAND_FREQUENCIES.length
export const EQ_GAIN_MIN_DB = -12
export const EQ_GAIN_MAX_DB = 12
/** Headroom before the filters, so a boosted curve does not clip on its own. */
export const EQ_PREAMP_MIN_DB = -12
export const EQ_PREAMP_MAX_DB = 12

/**
 * ReplayGain 2.0 uses -18 LUFS as the reference. It is quieter than the old
 * ReplayGain 1.0 target (-14.5 dBFS RMS) by design: the point is to leave room
 * for peaks, not to win a loudness war.
 */
export const REPLAY_GAIN_TARGET_LUFS = -18

/** Extra room around a measured gain; nothing musical needs more than this. */
export const REPLAY_GAIN_MIN_DB = -30
export const REPLAY_GAIN_MAX_DB = 30

export interface EqualizerPresetDefinition {
  id: Exclude<EqualizerPreset, 'custom'>
  label: string
  gains: readonly number[]
}

/**
 * Built-in curves. They are intentionally gentle: a preset is a starting point,
 * and a +12 dB smile at both ends is the fastest way to make someone think the
 * player sounds broken.
 */
export const EQ_PRESETS: readonly EqualizerPresetDefinition[] = [
  { id: 'flat', label: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'acoustic', label: 'Acoustic', gains: [-2, -1, 0, 2, 3, 3, 2, 1, 0, -1] },
  { id: 'bass', label: 'Bass boost', gains: [6, 5, 4, 2, 1, 0, 0, 0, 0, 0] },
  { id: 'classical', label: 'Classical', gains: [3, 2, 1, 0, -1, -1, 0, 2, 3, 4] },
  { id: 'electronic', label: 'Electronic', gains: [4, 3, 1, 0, -1, 0, 1, 2, 4, 5] },
  { id: 'hiphop', label: 'Hip-hop', gains: [5, 4, 2, 1, 0, -1, 0, 1, 2, 3] },
  { id: 'jazz', label: 'Jazz', gains: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  { id: 'pop', label: 'Pop', gains: [-1, 0, 2, 3, 2, 0, -1, -1, 1, 2] },
  { id: 'rock', label: 'Rock', gains: [4, 3, 2, 1, -1, -1, 0, 1, 3, 4] },
  { id: 'vocal', label: 'Vocal', gains: [-3, -2, -1, 0, 2, 4, 4, 3, 1, 0] }
]

const EQ_PRESET_MAP = new Map(EQ_PRESETS.map((preset) => [preset.id, preset]))

export const DEFAULT_EQ_BANDS: readonly number[] = [
  ...(EQ_PRESETS[0]?.gains ?? [0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
]

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  equalizer: {
    enabled: false,
    preset: 'flat',
    preampDb: 0,
    bands: [...DEFAULT_EQ_BANDS]
  },
  normalization: {
    enabled: false,
    // ReplayGain only raises a quiet track when there is headroom for its
    // measured peak. The switch lets someone who prefers a loud, clipped master
    // have it, but the safe choice is the default.
    preventClipping: true
  }
}

export function isEqualizerPreset(value: unknown): value is EqualizerPreset {
  return (
    typeof value === 'string' &&
    (value === 'custom' || EQ_PRESET_MAP.has(value as Exclude<EqualizerPreset, 'custom'>))
  )
}

export function presetBands(id: EqualizerPreset): number[] | null {
  if (id === 'custom') return null
  const preset = EQ_PRESET_MAP.get(id)
  return preset ? [...preset.gains] : null
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Accepts any finite number and keeps the UI and config inside the safe range. */
export function clampEqGain(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return Math.round(clamp(number, EQ_GAIN_MIN_DB, EQ_GAIN_MAX_DB) * 2) / 2
}

export function clampPreamp(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return Math.round(clamp(number, EQ_PREAMP_MIN_DB, EQ_PREAMP_MAX_DB) * 2) / 2
}

/** Converts a decibel value to the linear multiplier a GainNode expects. */
export function dbToGain(db: number): number {
  return Math.pow(10, db / 20)
}

/** The gain a track needs to reach the ReplayGain reference. */
export function replayGainForLufs(integratedLufs: number, targetLufs = REPLAY_GAIN_TARGET_LUFS): number {
  if (!Number.isFinite(integratedLufs)) return 0
  return Math.round(clamp(targetLufs - integratedLufs, REPLAY_GAIN_MIN_DB, REPLAY_GAIN_MAX_DB) * 10) / 10
}

/**
 * The linear gain for one track, optionally capped by its true peak.
 *
 * ReplayGain values are often positive for quietly mastered music. Raising the
 * gain is correct until the loudest sample crosses full scale; when a peak is
 * known, the cap is exactly the point where it would. A peak of 0 dBFS and a
 * +6 dB gain therefore become +0 dB, not a clipped +6.
 */
export function normalizationGain(
  replayGainDb: number | null,
  peakDb: number | null,
  preventClipping: boolean
): number {
  if (replayGainDb === null || !Number.isFinite(replayGainDb)) return 1
  let gain = dbToGain(replayGainDb)
  if (preventClipping && peakDb !== null && Number.isFinite(peakDb)) {
    const peak = dbToGain(peakDb)
    if (peak > 0) gain = Math.min(gain, 1 / peak)
  }
  return gain
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeBands(value: unknown, preset: EqualizerPreset): number[] {
  if (Array.isArray(value) && value.length === EQ_BAND_COUNT) {
    return value.map((band) => clampEqGain(band))
  }
  return presetBands(preset) ?? [...DEFAULT_EQ_BANDS]
}

/** Fills every field of `audio`, tolerating a config written by an older build. */
export function normalizeAudioSettings(input: unknown): AudioSettings {
  const source = isRecord(input) ? input : {}
  const equalizer = isRecord(source.equalizer) ? source.equalizer : {}
  const normalization = isRecord(source.normalization) ? source.normalization : {}
  const preset = isEqualizerPreset(equalizer.preset) ? equalizer.preset : 'flat'

  return {
    equalizer: {
      enabled: typeof equalizer.enabled === 'boolean' ? equalizer.enabled : false,
      preset,
      preampDb: clampPreamp(equalizer.preampDb),
      bands: normalizeBands(equalizer.bands, preset)
    },
    normalization: {
      enabled: typeof normalization.enabled === 'boolean' ? normalization.enabled : false,
      preventClipping:
        typeof normalization.preventClipping === 'boolean' ? normalization.preventClipping : true
    }
  }
}

/**
 * Validates an audio patch without filling in absent fields.
 *
 * The settings service deep-merges patches, so returning a complete object here
 * would make every slider move reset the rest of the section. Each field is
 * therefore only present when the caller actually sent it.
 */
export function sanitizeAudioPatch(input: unknown): DeepPartial<AudioSettings> {
  const patch: DeepPartial<AudioSettings> = {}
  if (!isRecord(input)) return patch

  if (isRecord(input.equalizer)) {
    const source = input.equalizer
    const equalizer: DeepPartial<EqualizerSettings> = {}

    if (typeof source.enabled === 'boolean') equalizer.enabled = source.enabled

    if (isEqualizerPreset(source.preset)) {
      equalizer.preset = source.preset
      const bands = presetBands(source.preset)
      if (bands) equalizer.bands = bands
    }

    if (typeof source.preampDb === 'number' && Number.isFinite(source.preampDb)) {
      equalizer.preampDb = clampPreamp(source.preampDb)
    }

    if (Array.isArray(source.bands) && source.bands.length === EQ_BAND_COUNT) {
      equalizer.bands = source.bands.map((band) => clampEqGain(band))
    }

    if (Object.keys(equalizer).length > 0) patch.equalizer = equalizer
  }

  if (isRecord(input.normalization)) {
    const normalization: DeepPartial<NormalizationSettings> = {}
    if (typeof input.normalization.enabled === 'boolean') {
      normalization.enabled = input.normalization.enabled
    }
    if (typeof input.normalization.preventClipping === 'boolean') {
      normalization.preventClipping = input.normalization.preventClipping
    }
    if (Object.keys(normalization).length > 0) patch.normalization = normalization
  }

  return patch
}
