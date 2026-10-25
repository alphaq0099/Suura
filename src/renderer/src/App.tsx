import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { APPEARANCE_CACHE_KEY, DENSITY_ROW_HEIGHT } from '@shared/appearance'
import { DEFAULT_AUDIO_SETTINGS } from '@shared/audio'
import type {
  AppPaths,
  AppSettings,
  DeepPartial,
  EngineStatus,
  PoTokenStatus,
  ReplayGainStatus,
  RepeatMode,
  RuntimeInfo,
  Track,
  YouTubeSearchResult
} from '@shared/types'
import { onlineEntryToTrack, type PlayingList } from '@shared/online'
import {
  LIBRARY_QUEUE_SOURCE,
  YOUTUBE_QUEUE_SOURCE,
  tagQueueTracks,
  type QueueTrack
} from '@shared/queue'
import { youtubeWatchUrl } from '@shared/youtube'
import { api, messageOf } from './api'
import { FolderIcon } from './components/Icons'
import { DownloadsView } from './components/DownloadsView'
import { HomeView } from './components/HomeView'
import { LibraryView } from './components/LibraryView'
import { MiniPlayer } from './components/MiniPlayer'
import { NowPlayingView } from './components/NowPlayingView'
import { OnlineView } from './components/OnlineView'
import { PlayerBar } from './components/PlayerBar'
import { PlaylistsView } from './components/PlaylistsView'
import { QueueView } from './components/QueueView'
import { SavesPanel } from './components/SavesPanel'
import { SearchView, type SearchSelectionItem } from './components/SearchView'
import { SettingsView } from './components/SettingsView'
import { Sidebar, type ViewName } from './components/Sidebar'
import { useDownloads } from './hooks/useDownloads'
import { useFileDrop } from './hooks/useFileDrop'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useLibrary } from './hooks/useLibrary'
import { useMediaSession } from './hooks/useMediaSession'
import { useOnline } from './hooks/useOnline'
import { usePlaybackPersistence } from './hooks/usePlaybackPersistence'
import { usePlayer } from './hooks/usePlayer'
import { usePlaylists } from './hooks/usePlaylists'
import { useSettings } from './hooks/useSettings'

/** Volume is written on this trailing edge so dragging the slider is not 60 writes. */
const VOLUME_PERSIST_DELAY_MS = 400

/** Long enough for the player window's exit animation to be seen. */
const NOW_PLAYING_EXIT_MS = 180

/** Settings is deliberately not a restorable "last view". */
const LAST_VIEW_KEY = 'player:last-view'
const SAVED_VIEWS: ViewName[] = ['home', 'library', 'search', 'online', 'playlists', 'queue']

function isSavedView(value: string | null): value is ViewName {
  return value !== null && SAVED_VIEWS.includes(value as ViewName)
}

/**
 * The short, support-friendly half of the diagnostics bundle. Cookies, history,
 * account details and library file paths are deliberately absent; the main
 * process adds the platform information and the recent log.
 */
function diagnosticsSummary(
  runtimeInfo: RuntimeInfo | null,
  engineStatus: EngineStatus | null,
  paths: AppPaths | null,
  settings: AppSettings | null
): string {
  return [
    `Player ${runtimeInfo?.appVersion ?? 'unknown'}`,
    `Electron ${runtimeInfo?.electron ?? 'unknown'}`,
    `Chromium ${runtimeInfo?.chromium ?? 'unknown'}`,
    `Node ${runtimeInfo?.node ?? 'unknown'}`,
    `yt-dlp ${engineStatus?.ytDlp.version ?? 'not checked'}`,
    `ffmpeg ${engineStatus?.ffmpeg.version ?? 'not checked'}`,
    `Database ${paths?.database ?? 'unknown'}`,
    `Config ${paths?.config ?? 'unknown'}`,
    `Logs ${paths?.logs ?? 'unknown'}`,
    `Library folders ${settings?.libraryFolders.length ?? 0}`,
    `User agent ${navigator.userAgent}`
  ].join('\n')
}

export function App() {
  const [view, setView] = useState<ViewName>('home')
  /** Whether the full-window player is covering the app. */
  const [nowPlaying, setNowPlaying] = useState(false)
  /** Set while the player window's exit animation plays, before it unmounts. */
  const [nowPlayingClosing, setNowPlayingClosing] = useState(false)
  /** Compact layout. The window bounds are owned by the main process. */
  const [miniPlayer, setMiniPlayer] = useState(false)
  const miniPlayerRef = useRef(false)
  const [paths, setPaths] = useState<AppPaths | null>(null)
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null)
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null)
  const [engineLoading, setEngineLoading] = useState(false)
  const [replayGainStatus, setReplayGainStatus] = useState<ReplayGainStatus | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  /**
   * The imported list whose tracks are playing, if any.
   *
   * It lives here rather than in the YouTube view because that view unmounts on a
   * view switch: a strip that vanished the moment the user looked at Playlists
   * would not be an indicator of anything.
   */
  const [playingList, setPlayingList] = useState<PlayingList | null>(null)

  const { settings, error: settingsError, update, reload } = useSettings()

  // Apply the saved startup view once settings arrive. `last` reads the view
  // stored on the previous visit; Settings itself is never a startup target.
  const startupAppliedRef = useRef(false)
  useEffect(() => {
    if (startupAppliedRef.current || !settings) return
    startupAppliedRef.current = true
    if (settings.startup.view === 'last') {
      try {
        const saved = localStorage.getItem(LAST_VIEW_KEY)
        if (isSavedView(saved)) setView(saved)
      } catch {
        // A disabled localStorage simply means no remembered view.
      }
      return
    }
    setView(settings.startup.view)
  }, [settings])

  // Remember the view for the next launch. Until settings have arrived the
  // effect sees the pre-settings 'library' frame, not a choice the user made;
  // it must not overwrite the remembered view with that frame.
  useEffect(() => {
    if (!startupAppliedRef.current) return
    if (view === 'settings') return
    try {
      localStorage.setItem(LAST_VIEW_KEY, view)
    } catch {
      // A full or disabled localStorage must not break navigation.
    }
  }, [view])

  // Theme is applied as data attributes on <html> rather than on `.app` so the
  // page background, native scrollbars and `color-scheme` change with it. The
  // OS query is live because "Follow Windows" has to react without a restart.
  const [systemTheme, setSystemTheme] = useState<'dark' | 'light'>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  )
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const updateSystemTheme = (): void => setSystemTheme(query.matches ? 'dark' : 'light')
    updateSystemTheme()
    query.addEventListener('change', updateSystemTheme)
    return () => query.removeEventListener('change', updateSystemTheme)
  }, [])

  const resolvedTheme: 'dark' | 'light' = !settings
    ? 'dark'
    : settings.theme === 'system'
      ? systemTheme
      : settings.theme

  useEffect(() => {
    const root = document.documentElement
    root.dataset.theme = resolvedTheme
    if (!settings) return
    root.dataset.accent = settings.visuals.accent
    root.dataset.density = settings.visuals.density
    root.dataset.surface = settings.visuals.surface
    root.dataset.motion = settings.visuals.motion
    root.dataset.textSize = settings.visuals.textSize
    // The settings live in the main process and arrive one IPC round-trip after
    // the first paint. Caching the resolved palette here lets main.tsx paint the
    // right background immediately next launch instead of flashing dark.
    try {
      localStorage.setItem(
        APPEARANCE_CACHE_KEY,
        JSON.stringify({
          mode: settings.theme,
          theme: resolvedTheme,
          accent: settings.visuals.accent,
          density: settings.visuals.density,
          surface: settings.visuals.surface,
          motion: settings.visuals.motion,
          textSize: settings.visuals.textSize
        })
      )
    } catch {
      // A full or disabled localStorage is not a reason to break a settings view.
    }
  }, [
    resolvedTheme,
    settings?.visuals.accent,
    settings?.visuals.density,
    settings?.visuals.surface,
    settings?.visuals.motion,
    settings?.visuals.textSize
  ])

  const library = useLibrary()
  const playlists = usePlaylists()
  const online = useOnline()
  const downloads = useDownloads()
  const {
    tracks,
    total,
    stats,
    scanning,
    scan,
    refresh,
    progress,
    search,
    setSearch,
    filter: libraryFilter,
    setFilter: setLibraryFilter,
    sort,
    direction,
    toggleSort,
    selectedIds,
    select,
    selectAll,
    selectMany,
    clearSelection,
    loadMore,
    loadingMore,
    error: libraryError
  } = library

  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const showingStreams = libraryFilter === 'streams'

  /**
   * The YouTube history as library rows.
   *
   * Filtering happens here rather than in the database because the history is
   * already fully loaded (it is a few hundred links, not a music library). The
   * same search box then means the same thing on both chips: it narrows what is
   * on screen instead of switching to a different search.
   */
  const streamTracks = useMemo(() => {
    const term = search.trim().toLowerCase()
    const entries = term
      ? online.entries.filter((entry) => {
          return (
            entry.title.toLowerCase().includes(term) ||
            (entry.artist ?? '').toLowerCase().includes(term) ||
            (entry.album ?? '').toLowerCase().includes(term) ||
            entry.videoId.toLowerCase().includes(term)
          )
        })
      : online.entries
    return entries.map(onlineEntryToTrack)
  }, [online.entries, search])

  const visibleTracks = showingStreams ? streamTracks : tracks
  const visibleTotal = showingStreams ? streamTracks.length : total

  // The YouTube history is the one list that can move without this window doing
  // anything: playing a row resolves in the main process, which lifts it. So it
  // is re-read on entry as well as on the change event, otherwise the order the
  // user left behind could still be on screen when they come back.
  useEffect(() => {
    // The YouTube chip is the same history as the YouTube view, so entering it
    // re-reads the list for the same reason the view does. Without this a link
    // resolved in the main process while another view was open would be missing.
    if (view === 'online' || (view === 'library' && libraryFilter === 'streams')) {
      void online.refresh()
    }
  }, [view, libraryFilter, online.refresh])

  // Closing is a two-step state rather than a plain toggle: the element has to
  // stay mounted for the length of the exit animation or it simply vanishes.
  const nowPlayingExitTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (nowPlayingExitTimer.current) clearTimeout(nowPlayingExitTimer.current)
    },
    []
  )

  const openNowPlaying = useCallback((): void => {
    if (nowPlayingExitTimer.current) {
      clearTimeout(nowPlayingExitTimer.current)
      nowPlayingExitTimer.current = null
    }
    setNowPlayingClosing(false)
    setNowPlaying(true)
  }, [])

  const closeNowPlaying = useCallback((): void => {
    if (!nowPlaying || nowPlayingClosing) return
    setNowPlayingClosing(true)
    nowPlayingExitTimer.current = setTimeout(() => {
      nowPlayingExitTimer.current = null
      setNowPlaying(false)
      setNowPlayingClosing(false)
    }, NOW_PLAYING_EXIT_MS)
  }, [nowPlaying, nowPlayingClosing])

  /**
   * Switches between the full UI and the compact one.
   *
   * The renderer changes immediately and asks main to resize. The native path is
   * intentionally separate: the window has to get a smaller minimum size before
   * it can shrink, and only main can do that.
   */
  const setMiniMode = useCallback(
    (enabled: boolean): void => {
      if (miniPlayerRef.current === enabled) return
      miniPlayerRef.current = enabled
      setMiniPlayer(enabled)
      if (enabled) closeNowPlaying()
      void api.setMiniPlayer(enabled).catch((cause: unknown) => {
        setActionError(messageOf(cause))
        miniPlayerRef.current = !enabled
        setMiniPlayer(!enabled)
      })
    },
    [closeNowPlaying]
  )

  const toggleMini = useCallback((): void => {
    setMiniMode(!miniPlayerRef.current)
  }, [setMiniMode])

  // A renderer reload (development, or a crash recovery) starts with false, but
  // the native window may still be compact. Only a true answer is applied: a
  // false request racing a user click must not undo it.
  useEffect(() => {
    let cancelled = false
    void api
      .isMiniPlayer()
      .then((active) => {
        if (cancelled || !active || miniPlayerRef.current) return
        miniPlayerRef.current = true
        setMiniPlayer(true)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const volumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleVolumeChange = useCallback((volume: number): void => {
    if (volumeTimerRef.current) clearTimeout(volumeTimerRef.current)
    volumeTimerRef.current = setTimeout(() => {
      void api.updateSettings({ volume }).catch(() => undefined)
    }, VOLUME_PERSIST_DELAY_MS)
  }, [])

  const handleReport = useCallback((trackId: number, playedMs: number, completed: boolean): void => {
    void api.reportPlayback(trackId, playedMs, completed).catch(() => undefined)
  }, [])

  const player = usePlayer({
    initialVolume: settings?.volume ?? 0.8,
    audioSettings: settings?.audio ?? DEFAULT_AUDIO_SETTINGS,
    repeat: settings?.repeat ?? 'off',
    shuffle: settings?.shuffle ?? false,
    prefetchNext: settings?.engine.prefetchNext ?? true,
    onVolumeChange: handleVolumeChange,
    onReport: handleReport
  })
  const { toggle, next, previous, stop } = player

  // Windows SMTC (volume flyout and media overlay) via Chromium's Media Session.
  // The separate taskbar thumbnail toolbar is rebuilt from the same two facts.
  useMediaSession({
    track: player.current,
    isPlaying: player.isPlaying,
    positionMs: player.positionMs,
    durationMs: player.durationMs,
    onPlay: toggle,
    onPause: toggle,
    onNext: next,
    onPrevious: previous,
    onSeek: player.seek,
    onStop: stop
  })

  useEffect(() => {
    void api
      .setTaskbarState({ hasTrack: Boolean(player.current), isPlaying: player.isPlaying })
      .catch(() => undefined)
  }, [player.current?.id, player.isPlaying])

  // Carries the queue across restarts. Bound to the player rather than to the
  // view, so it keeps working from any screen.
  usePlaybackPersistence(player, settings?.startup.resumePlayback)

  useEffect(() => {
    void api
      .getPaths()
      .then(setPaths)
      .catch(() => undefined)
    void api
      .getRuntimeInfo()
      .then(setRuntimeInfo)
      .catch(() => undefined)
  }, [])

  // Reserved channel from M2 (media keys, tray menu). The main process now
  // registers the Windows media keys and forwards them here, so the plumbing is
  // live rather than reserved.
  useEffect(() => {
    const token = api.on('playerCommand', (command) => {
      if (command.type === 'play-pause') toggle()
      else if (command.type === 'next') next()
      else if (command.type === 'prev') previous()
      else if (command.type === 'stop') stop()
      else if (command.type === 'mini-player') toggleMini()
    })
    return () => api.off(token)
  }, [toggle, next, previous, stop, toggleMini])

  useKeyboardShortcuts({
    toggle,
    next,
    previous,
    seekBy: (deltaMs) => player.seek(player.positionMs + deltaMs),
    setVolume: player.setVolume,
    volume: () => player.volume,
    onEscape: () => {
      if (miniPlayerRef.current) {
        setMiniMode(false)
        return
      }
      closeNowPlaying()
    },
    focusSearch: () => {
      setView('library')
      // The library view has to be mounted before its input can take focus.
      window.setTimeout(() => searchInputRef.current?.focus(), 0)
    }
  })

  // Folder changes arrive on the same broadcast as track changes, so the settings
  // snapshot has to be refreshed too. Without this, a folder added through the
  // picker would update the main process while the UI still believed the library
  // was empty, and the track table would never appear.
  useEffect(() => {
    const token = api.on('libraryChanged', () => {
      void reload()
    })
    return () => api.off(token)
  }, [reload])

  const refreshEngine = useCallback(async (): Promise<void> => {
    setEngineLoading(true)
    try {
      setEngineStatus(await api.getEngineStatus())
    } catch (cause) {
      setActionError(messageOf(cause))
    } finally {
      setEngineLoading(false)
    }
  }, [])

  const startPoToken = useCallback(async (): Promise<PoTokenStatus> => {
    setActionError(null)
    try {
      const status = await api.startPoTokenProvider()
      setEngineStatus((previous) => (previous ? { ...previous, poToken: status } : previous))
      return status
    } catch (cause) {
      setActionError(messageOf(cause))
      throw cause
    }
  }, [])

  const stopPoToken = useCallback(async (): Promise<PoTokenStatus> => {
    setActionError(null)
    try {
      const status = await api.stopPoTokenProvider()
      setEngineStatus((previous) => (previous ? { ...previous, poToken: status } : previous))
      return status
    } catch (cause) {
      setActionError(messageOf(cause))
      throw cause
    }
  }, [])

  // Probing spawns two child processes, so it only happens when the settings view
  // is actually open.
  useEffect(() => {
    if (view !== 'settings') return
    if (engineStatus || engineLoading) return
    void refreshEngine()
  }, [view, engineStatus, engineLoading, refreshEngine])

  // A loudness scan outlives the view that started it. Subscribing here, once,
  // means the progress bar is already current when Settings is reopened.
  useEffect(() => {
    const token = api.on('replayGainProgress', setReplayGainStatus)
    return () => api.off(token)
  }, [])

  useEffect(() => {
    if (view !== 'settings') return
    void api
      .getReplayGainStatus()
      .then(setReplayGainStatus)
      .catch(() => undefined)
  }, [view])

  const scanReplayGain = useCallback(async (): Promise<void> => {
    setActionError(null)
    try {
      setReplayGainStatus(await api.scanReplayGain())
    } catch (cause) {
      setActionError(messageOf(cause))
      // The service broadcasts a `failed` status, but a scan can fail before its
      // first event (for example when ffmpeg is missing); re-read so the panel
      // shows the reason instead of staying on "starting".
      void api
        .getReplayGainStatus()
        .then(setReplayGainStatus)
        .catch(() => undefined)
    }
  }, [])

  const cancelReplayGain = useCallback((): void => {
    void api.cancelReplayGain().catch(() => undefined)
  }, [])

  // First run (or after a config file reset) should not require clicking Rescan.
  // Later launches follow the General preference; the scan is incremental, so
  // unchanged files are not opened again.
  const autoScanDoneRef = useRef(false)
  useEffect(() => {
    if (autoScanDoneRef.current || !settings || scanning) return
    if (settings.libraryFolders.length === 0) return
    // Wait for the stats call before calling this a first run. Settings often
    // arrive first, and treating the missing stats as "empty library" would
    // scan on every launch even when scan-on-launch is switched off.
    if (!stats) return
    const firstRun = stats.tracks === 0
    if (!firstRun && !settings.startup.scanOnLaunch) return
    autoScanDoneRef.current = true
    void scan()
  }, [settings, scanning, stats, scan])

  const addFolder = useCallback(async (): Promise<void> => {
    setActionError(null)
    try {
      const folder = await api.pickFolder()
      if (!folder) return
      await scan(folder)
    } catch (cause) {
      setActionError(messageOf(cause))
    }
  }, [scan])

  /**
   * Handles paths from an OS drop. Switching to Library first means the scan
   * progress the main process is already broadcasting has somewhere to show;
   * waiting for the full scan before changing view would leave the window
   * looking inert for as long as the import takes.
   */
  const importDroppedPaths = useCallback(
    async (paths: string[]): Promise<void> => {
      setActionError(null)
      setView('library')
      try {
        await api.addDroppedPaths(paths)
        await Promise.all([reload(), refresh()])
      } catch (cause) {
        setActionError(messageOf(cause))
      }
    },
    [reload, refresh]
  )

  const { dragging: fileDragActive } = useFileDrop(importDroppedPaths)

  const removeFolder = useCallback(
    async (folder: string): Promise<void> => {
      setActionError(null)
      try {
        await api.removeLibraryFolder(folder)
        await reload()
        await refresh()
      } catch (cause) {
        setActionError(messageOf(cause))
      }
    },
    [reload, refresh]
  )

  const pickEngineDir = useCallback(async (): Promise<void> => {
    setActionError(null)
    try {
      const folder = await api.pickFolder()
      if (!folder) return
      await update({ engine: { binDir: folder } })
      await refreshEngine()
    } catch (cause) {
      setActionError(messageOf(cause))
    }
  }, [update, refreshEngine])

  const pickDownloadFolder = useCallback(async (): Promise<void> => {
    setActionError(null)
    try {
      const folder = await api.pickFolder()
      if (!folder) return
      await update({ retention: { downloadFolder: folder } })
    } catch (cause) {
      setActionError(messageOf(cause))
    }
  }, [update])

  const playTrack = useCallback(
    (index: number): void => {
      if (showingStreams) setPlayingList(null)
      const source = showingStreams ? YOUTUBE_QUEUE_SOURCE : LIBRARY_QUEUE_SOURCE
      player.playQueue(tagQueueTracks(visibleTracks, source), index)
    },
    [player, showingStreams, visibleTracks]
  )

  const playSelected = useCallback((): void => {
    const selected = visibleTracks.filter((track) => selectedIds.has(track.id))
    if (selected.length === 0) return
    if (showingStreams) setPlayingList(null)
    const source = showingStreams ? YOUTUBE_QUEUE_SOURCE : LIBRARY_QUEUE_SOURCE
    player.playQueue(tagQueueTracks(selected, source), 0)
  }, [player, selectedIds, showingStreams, visibleTracks])

  /** Home plays a specific local list (an album or an artist), not the library list. */
  const playLocalTracks = useCallback(
    (tracks: Track[], index: number): void => {
      if (tracks.length === 0) return
      setPlayingList(null)
      player.playQueue(tagQueueTracks(tracks, LIBRARY_QUEUE_SOURCE), index)
    },
    [player]
  )

  const queueLocalTracks = useCallback(
    (tracks: Track[]): void => {
      if (tracks.length === 0) return
      player.enqueue(tagQueueTracks(tracks, LIBRARY_QUEUE_SOURCE))
    },
    [player]
  )

  const selectAllVisible = useCallback((): void => {
    if (showingStreams) {
      selectMany(streamTracks.map((track) => track.id))
      return
    }
    selectAll()
  }, [selectAll, selectMany, showingStreams, streamTracks])

  const queueStream = useCallback(
    (track: Track): void => {
      player.enqueue(tagQueueTracks([track], YOUTUBE_QUEUE_SOURCE))
    },
    [player]
  )

  const queueSelected = useCallback((): void => {
    const selected = visibleTracks.filter((track) => selectedIds.has(track.id))
    if (selected.length === 0) return
    const source = showingStreams ? YOUTUBE_QUEUE_SOURCE : LIBRARY_QUEUE_SOURCE
    player.enqueue(tagQueueTracks(selected, source))
  }, [player, selectedIds, showingStreams, visibleTracks])

  const playQueueTracks = useCallback(
    (tracks: QueueTrack[]): void => {
      if (tracks.length === 0) return
      player.playQueue(tracks, 0)
    },
    [player]
  )

  const enqueueTracks = useCallback(
    (tracks: QueueTrack[]): void => {
      if (tracks.length === 0) return
      player.enqueue(tracks)
    },
    [player]
  )

  const removeStream = useCallback(
    async (track: Track): Promise<void> => {
      try {
        await online.remove(-track.id)
        // Keep the rest of a multi-row selection; the row that was forgotten is
        // the only thing that stopped existing.
        selectMany([...selectedIds].filter((id) => id !== track.id))
      } catch (cause) {
        setActionError(messageOf(cause))
      }
    },
    [online, selectedIds, selectMany]
  )

  /**
   * Playing a discovery result is playing a link.
   *
   * It goes through the same `online.addLink` path a pasted URL takes, so the
   * history, the fetch of the thumbnail and the resolve cache all agree with the
   * YouTube view. The resolve is what makes the user wait; the row says so by
   * staying in its busy state until this promise settles.
   */
  const playYouTubeResult = useCallback(
    async (result: YouTubeSearchResult): Promise<void> => {
      const entry = await online.addLink(youtubeWatchUrl(result.videoId))
      setPlayingList(null)
      player.playQueue(tagQueueTracks([onlineEntryToTrack(entry)], YOUTUBE_QUEUE_SOURCE), 0)
    },
    [online, player]
  )

  const queueYouTubeResult = useCallback(
    async (result: YouTubeSearchResult): Promise<void> => {
      const entry = await online.addLink(youtubeWatchUrl(result.videoId))
      player.enqueue(tagQueueTracks([onlineEntryToTrack(entry)], YOUTUBE_QUEUE_SOURCE))
    },
    [online, player]
  )

  /**
   * Search can select local rows and YouTube rows in one list. Build the queue
   * in row order, resolving each stream through the same add-link path as a
   * single click, then hand the player one queue with both sources tagged.
   */
  const playSearchSelection = useCallback(
    async (items: SearchSelectionItem[]): Promise<void> => {
      const queue: QueueTrack[] = []
      for (const item of items) {
        if (item.kind === 'local') {
          queue.push(...tagQueueTracks([item.track], LIBRARY_QUEUE_SOURCE))
          continue
        }
        const entry = await online.addLink(youtubeWatchUrl(item.result.videoId))
        queue.push(...tagQueueTracks([onlineEntryToTrack(entry)], YOUTUBE_QUEUE_SOURCE))
      }
      if (queue.length === 0) return
      setPlayingList(null)
      player.playQueue(queue, 0)
    },
    [online, player]
  )

  const queueSearchSelection = useCallback(
    async (items: SearchSelectionItem[]): Promise<void> => {
      const queue: QueueTrack[] = []
      for (const item of items) {
        if (item.kind === 'local') {
          queue.push(...tagQueueTracks([item.track], LIBRARY_QUEUE_SOURCE))
          continue
        }
        const entry = await online.addLink(youtubeWatchUrl(item.result.videoId))
        queue.push(...tagQueueTracks([onlineEntryToTrack(entry)], YOUTUBE_QUEUE_SOURCE))
      }
      if (queue.length === 0) return
      player.enqueue(queue)
    },
    [online, player]
  )

  // Repeat cycles off -> all -> one -> off, the order every player uses.
  const cycleRepeat = useCallback((): void => {
    const current = settings?.repeat ?? 'off'
    const nextMode = current === 'off' ? 'all' : current === 'all' ? 'one' : 'off'
    void update({ repeat: nextMode })
  }, [settings?.repeat, update])

  const setRepeat = useCallback(
    (mode: RepeatMode): void => {
      void update({ repeat: mode })
    },
    [update]
  )

  const toggleShuffle = useCallback((): void => {
    void update({ shuffle: !(settings?.shuffle ?? false) })
  }, [settings?.shuffle, update])

  const revealTrack = useCallback(async (trackId: number): Promise<void> => {
    try {
      await api.revealTrack(trackId)
    } catch (cause) {
      setActionError(messageOf(cause))
    }
  }, [])

  const openPath = useCallback(async (target: string): Promise<void> => {
    try {
      await api.openPath(target)
    } catch (cause) {
      setActionError(messageOf(cause))
    }
  }, [])

  const copyDiagnostics = useCallback(async (): Promise<void> => {
    try {
      await api.writeClipboardText(diagnosticsSummary(runtimeInfo, engineStatus, paths, settings))
    } catch (cause) {
      setActionError(messageOf(cause))
      throw cause
    }
  }, [runtimeInfo, engineStatus, paths, settings])

  const saveDiagnostics = useCallback(async (): Promise<string | null> => {
    try {
      return await api.saveDiagnostics(diagnosticsSummary(runtimeInfo, engineStatus, paths, settings))
    } catch (cause) {
      setActionError(messageOf(cause))
      throw cause
    }
  }, [runtimeInfo, engineStatus, paths, settings])

  // The data-care dialogs own their own error presentation. Letting the rejected
  // IPC promise reach Settings is what puts the message next to the buttons that
  // caused it, instead of in the global action banner.
  const backupData = useCallback(() => api.backupData(), [])
  const restoreData = useCallback(() => api.restoreData(), [])
  const exportLibrary = useCallback(() => api.exportLibraryCsv(), [])
  const findDuplicates = useCallback(() => api.findDuplicates(), [])
  const mergeDuplicates = useCallback(async () => {
    const outcome = await api.mergeDuplicates()
    await refresh()
    return outcome
  }, [refresh])
  const relocateMissing = useCallback(async () => {
    const report = await api.relocateMissing()
    if (report) await refresh()
    return report
  }, [refresh])
  const removeTracks = useCallback(
    async (trackIds: number[]) => {
      const removed = await api.removeTracks(trackIds)
      await refresh()
      return removed
    },
    [refresh]
  )

  const updateSettings = useCallback(
    (patch: DeepPartial<AppSettings>): void => {
      void update(patch)
    },
    [update]
  )

  const setPlaylistIndexWidth = useCallback(
    (width: number): void => updateSettings({ playlists: { indexWidth: width } }),
    [updateSettings]
  )

  if (!settings) {
    return (
      <div className="boot-screen">
        <h1>Player</h1>
        <p>{settingsError ?? 'Starting…'}</p>
      </div>
    )
  }

  const combinedError = actionError ?? libraryError
  // The YouTube history is part of Library now, so a failure to read it belongs
  // on that view rather than only in the YouTube view's own banner.
  const libraryViewError = actionError ?? (showingStreams ? online.error : null) ?? libraryError

  return (
    // The artwork preferences are published as data attributes here rather than
    // threaded through every component. The rule is "all cover art", and this is
    // the one place that can say so in a couple of lines of CSS.
    <div
      className={miniPlayer ? 'app mini-player-mode' : 'app'}
      data-artwork-shape={settings.visuals.artworkShape}
      data-artwork-size={settings.visuals.artworkSize}
      data-album-column={settings.visuals.showAlbumColumn ? 'show' : 'hide'}
      data-channel-column={settings.visuals.showChannelColumn ? 'show' : 'hide'}
      data-text-size={settings.visuals.textSize}
      data-icon-set={settings.visuals.iconSet}
      data-player-artwork={settings.visuals.playerArtwork ? 'true' : 'false'}
      data-player-ambience={settings.visuals.playerAmbience ? 'true' : 'false'}
    >
      <Sidebar
        view={view}
        stats={stats}
        queueLength={player.queue.length}
        playlistCount={playlists.playlists.length + playlists.onlinePlaylists.length}
        onlineCount={online.entries.length}
        iconSet={settings.visuals.iconSet}
        onSelect={setView}
      />

      {view === 'home' ? (
        <HomeView
          stats={stats}
          progress={progress}
          scanning={scanning}
          error={combinedError}
          playlists={playlists.playlists}
          currentTrackId={player.current?.id ?? null}
          isPlaying={player.isPlaying}
          rowHeight={DENSITY_ROW_HEIGHT[settings.visuals.density]}
          singleClick={settings.interaction.librarySingleClick}
          doubleClick={settings.interaction.libraryDoubleClick}
          onAddFolder={() => void addFolder()}
          onScan={() => void scan()}
          onCancelScan={() => void api.cancelScan()}
          onOpenLibrary={() => setView('library')}
          onOpenPlaylist={(playlistId) => {
            playlists.select(playlistId)
            setView('playlists')
          }}
          onPlayLocal={playLocalTracks}
          onQueueLocal={queueLocalTracks}
          onReveal={(trackId) => void revealTrack(trackId)}
          onAddTracksToPlaylist={playlists.addTracks}
          onCreatePlaylist={playlists.create}
        />
      ) : view === 'library' ? (
        <LibraryView
          tracks={visibleTracks}
          total={visibleTotal}
          stats={stats}
          progress={progress}
          scanning={scanning}
          loadingMore={showingStreams ? false : loadingMore}
          search={search}
          error={libraryViewError}
          folders={settings.libraryFolders}
          filter={libraryFilter}
          streamCount={online.entries.length}
          showingStreams={showingStreams}
          streamsLoading={online.loading}
          sort={showingStreams ? null : sort}
          direction={showingStreams ? 'asc' : direction}
          selectedIds={selectedIds}
          currentTrackId={player.current?.id ?? null}
          isPlaying={player.isPlaying}
          rowHeight={DENSITY_ROW_HEIGHT[settings.visuals.density]}
          searchInputRef={searchInputRef}
          onSearchChange={setSearch}
          onToggleSort={toggleSort}
          onAddFolder={() => void addFolder()}
          onScan={() => void scan()}
          onCancelScan={() => void api.cancelScan()}
          onPlay={playTrack}
          onPlaySelected={playSelected}
          onReveal={(trackId) => void revealTrack(trackId)}
          onSelect={select}
          onSelectMany={selectMany}
          onSelectAll={selectAllVisible}
          onClearSelection={clearSelection}
          onRequestMore={showingStreams ? () => undefined : loadMore}
          onFilterChange={setLibraryFilter}
          onOpenYouTube={() => setView('online')}
          onQueueStream={queueStream}
          onQueueSelected={queueSelected}
          onRemoveTracks={removeTracks}
          onRemoveStream={(track) => void removeStream(track)}
          downloads={downloads}
          showAlbumColumn={settings.visuals.showAlbumColumn}
          singleClick={settings.interaction.librarySingleClick}
          doubleClick={settings.interaction.libraryDoubleClick}
          playlists={playlists.playlists}
          onAddTracksToPlaylist={playlists.addTracks}
          onCreatePlaylist={playlists.create}
        />
      ) : view === 'search' ? null : view === 'online' ? (
        <OnlineView
          entries={online.entries}
          onlinePlaylists={playlists.onlinePlaylists}
          loading={online.loading}
          historyError={online.error}
          currentVideoId={player.current?.sourceKind === 'youtube' ? (player.current.sourceId ?? null) : null}
          isPlaying={player.isPlaying}
          playingList={playingList}
          onPlayingListChange={setPlayingList}
          onAddLink={online.addLink}
          onImportList={online.importList}
          onRemove={online.remove}
          onClear={online.clear}
          onPlay={(queue, index) => player.playQueue(queue, index)}
          onQueue={player.enqueue}
          onOpenOnlinePlaylist={(playlistId) => {
            playlists.selectOnline(playlistId)
            setView('playlists')
          }}
          downloads={downloads}
        />
      ) : view === 'playlists' ? (
        <PlaylistsView
          playlists={playlists.playlists}
          selectedId={playlists.selectedId}
          detail={playlists.detail}
          onlinePlaylists={playlists.onlinePlaylists}
          selectedOnlineId={playlists.selectedOnlineId}
          onlineDetail={playlists.onlineDetail}
          loading={playlists.loading}
          error={playlists.error}
          currentTrackId={player.current?.id ?? null}
          isPlaying={player.isPlaying}
          singleClick={settings.interaction.librarySingleClick}
          doubleClick={settings.interaction.libraryDoubleClick}
          rowHeight={DENSITY_ROW_HEIGHT[settings.visuals.density]}
          showChannelColumn={settings.visuals.showChannelColumn}
          showAlbumColumn={settings.visuals.showAlbumColumn}
          playlistArtworkSize={settings.visuals.playlistArtworkSize}
          indexWidth={settings.playlists.indexWidth}
          onIndexWidthChange={setPlaylistIndexWidth}
          onSelect={playlists.select}
          onSelectOnline={playlists.selectOnline}
          onCreate={playlists.create}
          onImportPlaylist={playlists.importPlaylist}
          onExportPlaylist={playlists.exportPlaylist}
          onRename={playlists.rename}
          onDelete={playlists.remove}
          onClear={playlists.clear}
          onRemoveItems={playlists.removeItems}
          onMoveItem={playlists.moveItem}
          onReimportOnline={playlists.reimportOnline}
          onRenameOnline={playlists.renameOnline}
          onDeleteOnline={playlists.deleteOnline}
          onRemoveOnlineItem={playlists.removeOnlineItem}
          onPlay={(queue, index) => player.playQueue(queue, index)}
          onQueue={player.enqueue}
          onPlayingListChange={setPlayingList}
          onReveal={(trackId) => void revealTrack(trackId)}
          downloads={downloads}
        />
      ) : view === 'downloads' ? (
        <DownloadsView
          downloads={downloads}
          onRevealTrack={(trackId) => void revealTrack(trackId)}
          onOpenLibrary={() => setView('library')}
          onError={setActionError}
        />
      ) : view === 'queue' ? (
        <QueueView
          queue={player.queue}
          index={player.index}
          isPlaying={player.isPlaying}
          repeat={settings.repeat}
          shuffle={settings.shuffle}
          downloads={downloads}
          playlists={playlists.playlists}
          onJump={player.jumpTo}
          onRemove={player.removeAt}
          onMove={player.move}
          onRemovePlayed={player.removePlayed}
          onClear={player.clearQueue}
          onToggleShuffle={toggleShuffle}
          onRepeatChange={setRepeat}
          onAddTracksToPlaylist={playlists.addTracks}
          onCreatePlaylist={playlists.create}
          onBrowseLibrary={() => setView('library')}
          onPlaySelected={playQueueTracks}
          onQueueSelected={enqueueTracks}
        />
      ) : (
        <SettingsView
          settings={settings}
          paths={paths}
          runtimeInfo={runtimeInfo}
          engineStatus={engineStatus}
          engineLoading={engineLoading}
          scanning={scanning}
          error={combinedError}
          onUpdate={updateSettings}
          replayGainStatus={replayGainStatus}
          onScanReplayGain={scanReplayGain}
          onCancelReplayGain={cancelReplayGain}
          onAddFolder={() => void addFolder()}
          onRemoveFolder={(folder) => void removeFolder(folder)}
          onPickEngineDir={() => void pickEngineDir()}
          onPickDownloadFolder={() => void pickDownloadFolder()}
          onRefreshEngine={() => void refreshEngine()}
          onStartPoToken={startPoToken}
          onStopPoToken={stopPoToken}
          onOpenPath={(target) => void openPath(target)}
          onCopyDiagnostics={copyDiagnostics}
          onSaveDiagnostics={saveDiagnostics}
          onBackupData={backupData}
          onRestoreData={restoreData}
          onExportLibrary={exportLibrary}
          missingTracks={stats?.missingTracks ?? 0}
          onFindDuplicates={findDuplicates}
          onMergeDuplicates={mergeDuplicates}
          onRelocateMissing={relocateMissing}
        />
      )}

      {/* Mounted for the whole session so a search survives a trip to another
          view. It is hidden rather than unmounted; a restart still starts empty. */}
      <SearchView
        active={view === 'search'}
        downloads={downloads}
        currentTrackId={player.current?.id ?? null}
        currentVideoId={player.current?.sourceKind === 'youtube' ? (player.current.sourceId ?? null) : null}
        isPlaying={player.isPlaying}
        playlists={playlists.playlists}
        onAddTracksToPlaylist={playlists.addTracks}
        onCreatePlaylist={playlists.create}
        onPlayLocal={(queue) => player.playQueue(tagQueueTracks(queue, LIBRARY_QUEUE_SOURCE), 0)}
        onQueueLocal={(queue) => player.enqueue(tagQueueTracks(queue, LIBRARY_QUEUE_SOURCE))}
        onPlayYouTube={playYouTubeResult}
        onQueueYouTube={queueYouTubeResult}
        onPlaySearchSelection={playSearchSelection}
        onQueueSearchSelection={queueSearchSelection}
      />

      <SavesPanel downloads={downloads} onReveal={(trackId) => void revealTrack(trackId)} />

      <PlayerBar
        current={player.current}
        isPlaying={player.isPlaying}
        isLoading={player.isLoading}
        buffering={player.buffering}
        reconnecting={player.reconnecting}
        positionMs={player.positionMs}
        durationMs={player.durationMs}
        volume={player.volume}
        volumeWheelStep={settings.interaction.volumeWheelStep}
        error={player.error}
        queueIndex={player.index}
        queueLength={player.queue.length}
        repeat={settings.repeat}
        shuffle={settings.shuffle}
        onToggle={toggle}
        onNext={next}
        onPrevious={previous}
        onSeek={player.seek}
        onVolume={player.setVolume}
        onCycleRepeat={cycleRepeat}
        onToggleShuffle={toggleShuffle}
        onOpenQueue={() => setView('queue')}
        onOpenNowPlaying={openNowPlaying}
        onEnterMiniPlayer={() => setMiniMode(true)}
      />

      {miniPlayer ? (
        <MiniPlayer
          current={player.current}
          isPlaying={player.isPlaying}
          isLoading={player.isLoading}
          buffering={player.buffering}
          reconnecting={player.reconnecting}
          positionMs={player.positionMs}
          durationMs={player.durationMs}
          volume={player.volume}
          error={player.error}
          queueIndex={player.index}
          queueLength={player.queue.length}
          onToggle={toggle}
          onNext={next}
          onPrevious={previous}
          onSeek={player.seek}
          onVolume={player.setVolume}
          onExpand={() => setMiniMode(false)}
        />
      ) : null}

      {/* Streamed links live in the YouTube view now, not in a dialog: a resolve
          takes seconds, and a modal is the wrong place to put a collection. */}

      {/* Rendered last so it stacks over the bar it was opened from. The views
          behind it stay mounted, which is what keeps the list scroll position
          and the audio element untouched while it is open. */}
      {nowPlaying && !miniPlayer ? (
        <NowPlayingView
          closing={nowPlayingClosing}
          current={player.current}
          isPlaying={player.isPlaying}
          isLoading={player.isLoading}
          buffering={player.buffering}
          reconnecting={player.reconnecting}
          positionMs={player.positionMs}
          durationMs={player.durationMs}
          volume={player.volume}
          volumeWheelStep={settings.interaction.volumeWheelStep}
          queueIndex={player.index}
          queue={player.queue}
          repeat={settings.repeat}
          shuffle={settings.shuffle}
          artworkFit={settings.visuals.artworkFit}
          onToggle={toggle}
          onNext={next}
          onPrevious={previous}
          onSeek={player.seek}
          onVolume={player.setVolume}
          onCycleRepeat={cycleRepeat}
          onRepeatChange={setRepeat}
          onToggleShuffle={toggleShuffle}
          onJumpQueue={player.jumpTo}
          onRemoveQueueItem={player.removeAt}
          onPlaySelected={playQueueTracks}
          onQueueSelected={enqueueTracks}
          onRemovePlayed={player.removePlayed}
          onClearQueue={player.clearQueue}
          onClose={closeNowPlaying}
          downloads={downloads}
          playlists={playlists.playlists}
          onAddTracksToPlaylist={playlists.addTracks}
          onCreatePlaylist={playlists.create}
        />
      ) : null}

      {fileDragActive ? (
        <div className="drop-overlay" role="status" aria-live="polite">
          <div className="drop-card">
            <span className="drop-icon" aria-hidden="true">
              <FolderIcon size={34} />
            </span>
            <strong>Add to your library</strong>
            <span>Drop folders or audio files here. A single file is added with its folder.</span>
          </div>
        </div>
      ) : null}
    </div>
  )
}
