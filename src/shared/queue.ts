/**
 * Queue ordering rules.
 *
 * Deliberately free of React and Electron: repeat and shuffle are the kind of
 * logic that is easy to get subtly wrong (an off-by-one at the end of the queue,
 * a shuffle that drops the track you are listening to) and awkward to prove
 * through the UI. Kept pure so `npm run smoke` can pin the rules down.
 */
import type { RepeatMode } from './types'

/** What should happen when the current entry ends or Next is pressed. */
export type AdvanceDecision =
  | { kind: 'play'; position: number }
  /** Repeat-one: start the same track again. */
  | { kind: 'replay' }
  /** Nothing left to play and repeat is off. */
  | { kind: 'stop' }

/**
 * @param position  Index of the current entry, or -1 when nothing is playing.
 * @param length    Number of entries in the queue.
 * @param repeat    The user's repeat setting.
 * @param completed True when the track reached its end, false for a manual Next.
 *
 * The `completed` flag is the whole point: repeat-one replays a finished track,
 * but pressing Next should still move on rather than restart it.
 */
export function nextDecision(position: number, length: number, repeat: RepeatMode, completed: boolean): AdvanceDecision {
  if (length <= 0) return { kind: 'stop' }
  if (completed && repeat === 'one') return { kind: 'replay' }
  if (position >= 0 && position < length - 1) return { kind: 'play', position: position + 1 }
  if (repeat === 'all') return { kind: 'play', position: 0 }
  return { kind: 'stop' }
}

/** Fisher-Yates shuffle of a copy, so the caller's array is never mutated. */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const copy = [...items]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    const a = copy[i] as T
    const b = copy[j] as T
    copy[i] = b
    copy[j] = a
  }
  return copy
}

/**
 * Shuffles a queue while keeping one entry at the front.
 *
 * Turning shuffle on mid-track must not interrupt what is playing, so the
 * current entry stays at position 0 and only the rest is randomised.
 */
export function shuffleFrom<T>(items: readonly T[], keepIndex: number, random: () => number = Math.random): T[] {
  const kept = items[keepIndex]
  const rest = shuffled(
    items.filter((_, index) => index !== keepIndex),
    random
  )
  return kept === undefined ? rest : [kept, ...rest]
}
