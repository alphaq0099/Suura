import type { AudioSettings, ResolvedSource } from '@shared/types'
import { PlaybackAudioChain } from './playback-chain'

export interface DeckSlot {
  element: HTMLAudioElement
  chain: PlaybackAudioChain
}

function createSlot(initialVolume: number, settings: AudioSettings): DeckSlot {
  const element = new Audio()
  element.preload = 'auto'
  element.volume = initialVolume
  // Each element needs its own chain: a MediaElementAudioSourceNode can be
  // attached to exactly one element, and both slots have to keep their EQ and
  // ReplayGain settings while one of them is buffering the next track.
  const chain = new PlaybackAudioChain(element, initialVolume, settings)
  return { element, chain }
}

/**
 * Two media elements behind one transport.
 *
 * Gapless playback needs the next track already decoded and attached before the
 * current one ends. A single <audio> element cannot do that: changing `src`
 * tears down the decoder, and the new track then waits for metadata and data.
 * The deck keeps the playing element alone while a second one is prepared, then
 * swaps which element is "active" at the boundary.
 *
 * The rest of the player talks to `active` only. Event handlers for both
 * elements are registered once, and the caller filters out the inactive one, so
 * a preload finishing in the background cannot move the progress bar or report
 * a second track as playing.
 */
export class PlaybackDeck {
  private readonly slots: [DeckSlot, DeckSlot]
  private activeIndex = 0

  constructor(initialVolume: number, settings: AudioSettings) {
    this.slots = [createSlot(initialVolume, settings), createSlot(initialVolume, settings)]
  }

  /** Both elements, in a stable order, for one listener effect. */
  get elements(): readonly HTMLAudioElement[] {
    return this.slots.map((slot) => slot.element)
  }

  get active(): DeckSlot {
    return this.slots[this.activeIndex] as DeckSlot
  }

  get inactive(): DeckSlot {
    return this.slots[this.activeIndex === 0 ? 1 : 0] as DeckSlot
  }

  isActive(element: HTMLAudioElement): boolean {
    return element === this.active.element
  }

  setSettings(settings: AudioSettings): void {
    for (const slot of this.slots) slot.chain.setSettings(settings)
  }

  /**
   * Applies one volume to both slots, so the next track cannot arrive at a
   * different loudness from the one before it. If a chain failed to build, its
   * element keeps the value instead.
   */
  setVolume(value: number): void {
    for (const slot of this.slots) {
      if (!slot.chain.setVolume(value)) slot.element.volume = value
    }
  }

  setActiveTrackGain(gainDb: number | null, peakDb: number | null): void {
    this.active.chain.setTrackGain(gainDb, peakDb)
  }

  /** Attaches a source to the element that is already playing. */
  prepareActive(source: ResolvedSource): HTMLAudioElement {
    const slot = this.active
    slot.chain.setTrackGain(source.replayGainDb ?? null, source.replayGainPeak ?? null)
    slot.element.src = source.url
    slot.element.load()
    return slot.element
  }

  /** Attaches the next source to the idle element without starting it. */
  prepareInactive(source: ResolvedSource): HTMLAudioElement {
    const slot = this.inactive
    slot.chain.setTrackGain(source.replayGainDb ?? null, source.replayGainPeak ?? null)
    slot.element.src = source.url
    slot.element.load()
    return slot.element
  }

  /** False when the idle slot never got a source or its request already failed. */
  canPromoteInactive(): boolean {
    const element = this.inactive.element
    return !element.error && Boolean(element.currentSrc || element.src)
  }

  /** Makes the prepared slot the playing one and returns it. */
  promoteInactive(): DeckSlot {
    // A manual Next can promote while the old track is still playing. Pausing it
    // before the swap is what stops both elements from reaching the speakers at
    // once; on a natural end it is already stopped, so this is a no-op.
    this.active.element.pause()
    this.activeIndex = this.activeIndex === 0 ? 1 : 0
    this.active.chain.resume()
    return this.active
  }

  resume(): void {
    for (const slot of this.slots) slot.chain.resume()
  }

  pause(): void {
    for (const slot of this.slots) slot.element.pause()
  }

  /** Stops and releases the idle element. Used when the next track changes. */
  clearInactive(): void {
    const { element } = this.inactive
    element.pause()
    element.removeAttribute('src')
    element.load()
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot.element.pause()
      slot.element.removeAttribute('src')
      slot.element.load()
      slot.chain.dispose()
    }
  }
}
