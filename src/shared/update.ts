import type { UpdateChannel } from './types'

/**
 * The channel file each feed serves.
 *
 * electron-builder writes `latest.yml` for a stable release and `beta.yml` for
 * a pre-release. Keeping the mapping here means Settings, the updater and the
 * release docs agree on the one filename that matters.
 */
export const UPDATE_CHANNEL_FILES: Readonly<Record<UpdateChannel, string>> = {
  stable: 'latest.yml',
  beta: 'beta.yml'
}

/**
 * The exact URL the updater requests for a feed base and channel.
 *
 * Returns null when the base is empty or not an absolute http(s) URL, so a
 * hand-edited config cannot make the app ask for `undefined/latest.yml`.
 */
export function resolveUpdateFeedUrl(base: string | null | undefined, channel: UpdateChannel): string | null {
  if (typeof base !== 'string') return null
  const trimmed = base.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) return null
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    return `${trimmed}/${UPDATE_CHANNEL_FILES[channel]}`
  } catch {
    return null
  }
}

/** A quiet, human label for the channel select. */
export function updateChannelLabel(channel: UpdateChannel): string {
  return channel === 'beta' ? 'Beta' : 'Stable'
}
