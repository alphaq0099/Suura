import { useCallback, useEffect, useState } from 'react'
import type { AppSettings, DeepPartial } from '@shared/types'
import { api, messageOf } from '../api'

export interface UseSettingsResult {
  settings: AppSettings | null
  error: string | null
  update: (patch: DeepPartial<AppSettings>) => Promise<AppSettings | null>
  /** Re-reads from the main process, for changes made through another channel. */
  reload: () => Promise<AppSettings | null>
}

/**
 * Owns the settings object.
 *
 * The main process is the source of truth: every update round-trips through IPC
 * and the returned value replaces local state, so validation performed in the
 * main process is reflected in the UI immediately.
 */
export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .getSettings()
      .then((loaded) => {
        if (!cancelled) setSettings(loaded)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(messageOf(cause))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const update = useCallback(async (patch: DeepPartial<AppSettings>): Promise<AppSettings | null> => {
    try {
      const next = await api.updateSettings(patch)
      setSettings(next)
      setError(null)
      return next
    } catch (cause) {
      setError(messageOf(cause))
      return null
    }
  }, [])

  const reload = useCallback(async (): Promise<AppSettings | null> => {
    try {
      const next = await api.getSettings()
      setSettings(next)
      setError(null)
      return next
    } catch (cause) {
      setError(messageOf(cause))
      return null
    }
  }, [])

  return { settings, error, update, reload }
}
