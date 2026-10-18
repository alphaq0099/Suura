import { globalShortcut } from 'electron'
import { EVENT_CHANNELS, type PlayerCommand } from '@shared/ipc'
import type { Logger } from '@core/logging/logger'
import { broadcast } from './broadcast'

/**
 * The four keys a keyboard's media row sends.
 *
 * These are registered globally on purpose: a music player is expected to keep
 * answering the play/pause key while it is in the background. Registration is
 * best-effort — another player may already hold the key, and failing to take it
 * is not an error worth interrupting startup for.
 */
const MEDIA_KEYS: Array<{ accelerator: string; command: PlayerCommand }> = [
  { accelerator: 'MediaPlayPause', command: { type: 'play-pause' } },
  { accelerator: 'MediaNextTrack', command: { type: 'next' } },
  { accelerator: 'MediaPreviousTrack', command: { type: 'prev' } },
  { accelerator: 'MediaStop', command: { type: 'stop' } }
]

/** Returns a disposer; `globalShortcut` must be released before the app quits. */
export function registerMediaKeys(log: Logger): () => void {
  const taken: string[] = []

  for (const { accelerator, command } of MEDIA_KEYS) {
    try {
      if (globalShortcut.register(accelerator, () => broadcast(EVENT_CHANNELS.playerCommand, command))) {
        taken.push(accelerator)
      } else {
        log.debug('media key already held by another app', { accelerator })
      }
    } catch (error) {
      log.warn('media key registration failed', { accelerator, error })
    }
  }

  log.info('media keys registered', { keys: taken })
  return () => {
    for (const accelerator of taken) globalShortcut.unregister(accelerator)
  }
}
