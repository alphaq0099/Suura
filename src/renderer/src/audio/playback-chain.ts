import type { AudioSettings } from '@shared/types'
import { dbToGain, EQ_BAND_FREQUENCIES, normalizationGain } from '@shared/audio'

/**
 * The Web Audio path between the media element and the speakers.
 *
 * An <audio> element can be attached to a MediaElementAudioSourceNode exactly
 * once, and its output then bypasses the normal media pipeline. That makes this
 * class deliberately lifetime-bound to the element: it is created once, never
 * rebuilt, and if anything goes wrong before the source is attached it leaves
 * the element playing directly. A failed equaliser must not mean a silent
 * player.
 *
 * Volume lives in the graph too. Once the source node exists, the element's own
 * volume is set to full and a GainNode takes over, so there is one authority for
 * loudness instead of two values that can disagree.
 */
export class PlaybackAudioChain {
  private context: AudioContext | null = null
  private preamp: GainNode | null = null
  private filters: BiquadFilterNode[] = []
  private trackGain: GainNode | null = null
  private volume: GainNode | null = null
  private settings: AudioSettings
  private trackGainDb: number | null = null
  private trackPeakDb: number | null = null

  constructor(
    private readonly element: HTMLAudioElement,
    initialVolume: number,
    settings: AudioSettings
  ) {
    this.settings = settings

    let context: AudioContext | null = null
    try {
      const Context = window.AudioContext
      if (!Context) return

      const audioContext = new Context({ latencyHint: 'playback' })
      context = audioContext
      const preamp = audioContext.createGain()
      const filters = EQ_BAND_FREQUENCIES.map((frequency) => {
        const filter = audioContext.createBiquadFilter()
        filter.type = 'peaking'
        filter.frequency.value = frequency
        // A little wider than one octave: adjacent bands overlap smoothly
        // instead of leaving notches between them.
        filter.Q.value = 1.4
        return filter
      })
      const trackGain = audioContext.createGain()
      const volume = audioContext.createGain()

      const firstFilter = filters[0]
      const lastFilter = filters[filters.length - 1]
      if (!firstFilter || !lastFilter) throw new Error('No equaliser bands were created.')
      preamp.connect(firstFilter)
      for (let index = 0; index < filters.length - 1; index += 1) {
        const current = filters[index]
        const next = filters[index + 1]
        if (current && next) current.connect(next)
      }
      lastFilter.connect(trackGain)
      trackGain.connect(volume)
      volume.connect(audioContext.destination)

      // Chromium only feeds a cross-origin element's samples to Web Audio when
      // both the element and the response opt in to CORS. `player-media://` and
      // `player-stream://` both send the matching header.
      this.element.crossOrigin = 'anonymous'

      // This is the irreversible step. Everything that could fail has already
      // been created and connected, so a throw here cannot leave a half-routed
      // graph behind.
      const source = audioContext.createMediaElementSource(this.element)
      source.connect(preamp)

      this.context = audioContext
      this.preamp = preamp
      this.filters = filters
      this.trackGain = trackGain
      this.volume = volume
      this.element.volume = 1
      this.volume.gain.value = clampVolume(initialVolume)
      this.applySettings()
      this.applyTrackGain()
    } catch {
      // Fall back to the element's own output. The caller keeps using
      // element.volume, because `active` stays false. If the context was
      // already created, close it so an unused graph cannot hold the audio
      // device open for the life of the window.
      this.context = null
      if (context && context.state !== 'closed') void context.close().catch(() => undefined)
    }
  }

  /** True when the graph owns the audio path and the element's volume is 1. */
  get active(): boolean {
    return this.context !== null
  }

  setSettings(settings: AudioSettings): void {
    this.settings = settings
    this.applySettings()
    this.applyTrackGain()
  }

  /** Returns false when the caller must set element.volume itself. */
  setVolume(value: number): boolean {
    if (!this.context || !this.volume) return false
    this.element.volume = 1
    this.volume.gain.setTargetAtTime(clampVolume(value), this.context.currentTime, 0.015)
    return true
  }

  /**
   * Stores the current track's measured gain.
   *
   * Null means the track has not been analysed (or is a stream). The value is
   * kept even while normalization is off, so turning the switch on mid-track
   * applies the measurement without resolving the source again.
   */
  setTrackGain(gainDb: number | null, peakDb: number | null): void {
    this.trackGainDb = gainDb
    this.trackPeakDb = peakDb
    this.applyTrackGain()
  }

  /** Browsers can start a context suspended until a user gesture. */
  resume(): void {
    if (this.context?.state === 'suspended') {
      void this.context.resume().catch(() => undefined)
    }
  }

  dispose(): void {
    const context = this.context
    this.context = null
    this.preamp = null
    this.filters = []
    this.trackGain = null
    this.volume = null
    if (context && context.state !== 'closed') {
      void context.close().catch(() => undefined)
    }
  }

  private applySettings(): void {
    if (!this.context || !this.preamp) return
    const equalizer = this.settings.equalizer
    const now = this.context.currentTime
    const preampDb = equalizer.enabled ? equalizer.preampDb : 0
    this.preamp.gain.setTargetAtTime(dbToGain(preampDb), now, 0.01)

    for (let index = 0; index < this.filters.length; index += 1) {
      const filter = this.filters[index]
      if (!filter) continue
      const gain = equalizer.enabled ? (equalizer.bands[index] ?? 0) : 0
      filter.gain.setTargetAtTime(gain, now, 0.01)
    }
  }

  private applyTrackGain(): void {
    if (!this.context || !this.trackGain) return
    const normalization = this.settings.normalization
    const gain = normalization.enabled
      ? normalizationGain(this.trackGainDb, this.trackPeakDb, normalization.preventClipping)
      : 1
    this.trackGain.gain.setTargetAtTime(gain, this.context.currentTime, 0.02)
  }
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(Math.max(value, 0), 1)
}
