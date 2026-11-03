import { UPDATE_CHANNELS } from './settings-defaults'
import type { DeepPartial, UpdateChannel, UpdateSettings } from './types'

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

/**
 * Accepts only a static-feed base URL the updater can append a channel file to.
 *
 * HTTPS is required because installers travel over this URL. Loopback HTTP is
 * allowed so a developer can serve `latest.yml` locally; that is the only
 * exception. A pasted `latest.yml`/`beta.yml` is trimmed back to its folder,
 * because the updater adds the filename itself.
 */
export function normalizeUpdateFeedUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }

  const loopback =
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return null
  if (parsed.username || parsed.password) return null

  const path = parsed.pathname.replace(/\/+$/, '').replace(/\/(latest|beta)\.yml$/i, '')
  parsed.pathname = path.length === 0 ? '/' : path
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString().replace(/\/$/, '')
}

/**
 * The keys a renderer may change in the update block.
 *
 * `lastCheckAt` is deliberately absent: it is operational state recorded by the
 * updater, and a renderer patch must not be able to reset the daily throttle.
 */
export function sanitizeUpdateSettingsPatch(input: unknown): DeepPartial<UpdateSettings> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {}
  const source = input as Record<string, unknown>
  const patch: DeepPartial<UpdateSettings> = {}

  if (typeof source.channel === 'string' && UPDATE_CHANNELS.includes(source.channel as UpdateChannel)) {
    patch.channel = source.channel as UpdateChannel
  }
  if (typeof source.feedUrl === 'string' || source.feedUrl === null) {
    patch.feedUrl = source.feedUrl === null ? null : normalizeUpdateFeedUrl(source.feedUrl)
  }
  if (typeof source.autoCheck === 'boolean') patch.autoCheck = source.autoCheck

  return patch
}
