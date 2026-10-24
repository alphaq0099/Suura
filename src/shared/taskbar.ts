import type { PlayerCommand, TaskbarState } from './ipc'

export type TaskbarControlId = 'previous' | 'play-pause' | 'next'

export interface TaskbarControl {
  id: TaskbarControlId
  tooltip: string
  command: PlayerCommand
}

/**
 * The thumbnail toolbar for the Windows taskbar.
 *
 * Kept pure so the button set and the play/pause label can be pinned down in
 * `npm run smoke`. The main process only maps each entry to an icon and a click
 * handler.
 */
export function taskbarControls(hasTrack: boolean, isPlaying: boolean): TaskbarControl[] {
  if (!hasTrack) return []
  return [
    { id: 'previous', tooltip: 'Previous', command: { type: 'prev' } },
    { id: 'play-pause', tooltip: isPlaying ? 'Pause' : 'Play', command: { type: 'play-pause' } },
    { id: 'next', tooltip: 'Next', command: { type: 'next' } }
  ]
}

/** The renderer sends this over IPC; anything else is ignored. */
export function sanitizeTaskbarState(value: unknown): TaskbarState | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.hasTrack !== 'boolean' || typeof candidate.isPlaying !== 'boolean') return null
  return { hasTrack: candidate.hasTrack, isPlaying: candidate.isPlaying }
}
