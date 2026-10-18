import type { PlayerApi } from '@shared/ipc'

/**
 * Typed access to the preload bridge.
 *
 * Fails loudly and with a useful message if the UI is ever loaded outside
 * Electron (for example by opening the built HTML directly in a browser), rather
 * than throwing "cannot read property of undefined" somewhere deep in a click
 * handler.
 */
const bridge = window.player

if (!bridge) {
  throw new Error(
    'The Player bridge is unavailable. Start the app through Electron (npm run dev) instead of opening the HTML file directly.'
  )
}

export const api: PlayerApi = bridge

/** Turns an IPC rejection into something worth showing a user. */
export function messageOf(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause)
  return cause.message
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim()
}
