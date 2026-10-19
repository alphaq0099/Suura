import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppPaths, AppSettings, DeepPartial, EngineStatus, Track } from '@shared/types'
import { api, messageOf } from './api'
import { LibraryView } from './components/LibraryView'
import { NowPlayingView } from './components/NowPlayingView'
import { PlayLinkDialog } from './components/PlayLinkDialog'
import { PlayerBar } from './components/PlayerBar'
import { PlaylistsView } from './components/PlaylistsView'
import { QueueView } from './components/QueueView'
import { SettingsView } from './components/SettingsView'
import { Sidebar, type ViewName } from './components/Sidebar'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useLibrary } from './hooks/useLibrary'
import { usePlaybackPersistence } from './hooks/usePlaybackPersistence'
import { usePlayer } from './hooks/usePlayer'
import { usePlaylists } from './hooks/usePlaylists'
import { useSettings } from './hooks/useSettings'

/** Volume is written on this trailing edge so dragging the slider is not 60 writes. */
const VOLUME_PERSIST_DELAY_MS = 400

/** Long enough for the player window's exit animation to be seen. */
const NOW_PLAYING_EXIT_MS = 180

export function App() {
  const [view, setView] = useState<ViewName>('library')
  /** Whether the full-window player is covering the app. */
  const [nowPlaying, setNowPlaying] = useState(false)
  /** Set while the player window's exit animation plays, before it unmounts. */
  const [nowPlayingClosing, setNowPlayingClosing] = useState(false)
  const [playLinkOpen, setPlayLinkOpen] = useState(false)
  const [paths, setPaths] = useState<AppPaths | null>(null)
  const [engineStatus, setEngineStatus] = useState<EngineStatus | null>(null)
  const [engineLoading, setEngineLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const { settings, error: settingsError, update, reload } = useSettings()
  const library = useLibrary()
  const playlists = usePlaylists()
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
    sort,
    direction,
    toggleSort,
    selectedIds,
    select,
    selectAll,
    clearSelection,
    loadMore,
    loadingMore,
    error: libraryError
  } = library

  const searchInputRef = useRef<HTMLInputElement | null>(null)

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
    repeat: settings?.repeat ?? 'off',
    shuffle: settings?.shuffle ?? false,
    onVolumeChange: handleVolumeChange,
    onReport: handleReport
  })
  const { toggle, next, previous, stop } = player

  // Carries the queue across restarts. Bound to the player rather than to the
  // view, so it keeps working from any screen.
  usePlaybackPersistence(player)

  useEffect(() => {
    void api
      .getPaths()
      .then(setPaths)
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
    })
    return () => api.off(token)
  }, [toggle, next, previous, stop])

  useKeyboardShortcuts({
    toggle,
    next,
    previous,
    seekBy: (deltaMs) => player.seek(player.positionMs + deltaMs),
    setVolume: player.setVolume,
    volume: () => player.volume,
    onEscape: closeNowPlaying,
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

  // Probing spawns two child processes, so it only happens when the settings view
  // is actually open.
  useEffect(() => {
    if (view !== 'settings') return
    if (engineStatus || engineLoading) return
    void refreshEngine()
  }, [view, engineStatus, engineLoading, refreshEngine])

  // First run (or after a config file reset) should not require clicking Rescan.
  const autoScanDoneRef = useRef(false)
  useEffect(() => {
    if (autoScanDoneRef.current || !settings || scanning) return
    if (settings.libraryFolders.length === 0) return
    if (stats === null || stats.tracks > 0) return
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
      player.playQueue(tracks, index)
    },
    [player, tracks]
  )

  const playSelected = useCallback((): void => {
    const selected = tracks.filter((track) => selectedIds.has(track.id))
    if (selected.length === 0) return
    player.playQueue(selected, 0)
  }, [player, tracks, selectedIds])

  const playLink = useCallback(
    (track: Track): void => {
      player.playQueue([track], 0)
    },
    [player]
  )

  // Repeat cycles off -> all -> one -> off, the order every player uses.
  const cycleRepeat = useCallback((): void => {
    const current = settings?.repeat ?? 'off'
    const nextMode = current === 'off' ? 'all' : current === 'all' ? 'one' : 'off'
    void update({ repeat: nextMode })
  }, [settings?.repeat, update])

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

  return (
    // The artwork preferences are published as data attributes here rather than
    // threaded through every component. The rule is "all cover art", and this is
    // the one place that can say so in a couple of lines of CSS.
    <div
      className="app"
      data-artwork-shape={settings.visuals.artworkShape}
      data-artwork-size={settings.visuals.artworkSize}
    >
      <Sidebar
        view={view}
        stats={stats}
        queueLength={player.queue.length}
        playlistCount={playlists.playlists.length}
        onSelect={setView}
      />

      {view === 'library' ? (
        <LibraryView
          tracks={tracks}
          total={total}
          stats={stats}
          progress={progress}
          scanning={scanning}
          loadingMore={loadingMore}
          search={search}
          error={combinedError}
          folders={settings.libraryFolders}
          sort={sort}
          direction={direction}
          selectedIds={selectedIds}
          currentTrackId={player.current?.id ?? null}
          isPlaying={player.isPlaying}
          searchInputRef={searchInputRef}
          onSearchChange={setSearch}
          onToggleSort={toggleSort}
          onAddFolder={() => void addFolder()}
          onScan={() => void scan()}
          onCancelScan={() => void api.cancelScan()}
          onPlayLink={() => setPlayLinkOpen(true)}
          onPlay={playTrack}
          onPlaySelected={playSelected}
          onReveal={(trackId) => void revealTrack(trackId)}
          onSelect={select}
          onSelectAll={selectAll}
          onClearSelection={clearSelection}
          onRequestMore={loadMore}
          singleClick={settings.interaction.librarySingleClick}
          doubleClick={settings.interaction.libraryDoubleClick}
          playlists={playlists.playlists}
          onAddTracksToPlaylist={playlists.addTracks}
          onCreatePlaylist={playlists.create}
        />
      ) : view === 'playlists' ? (
        <PlaylistsView
          playlists={playlists.playlists}
          selectedId={playlists.selectedId}
          detail={playlists.detail}
          loading={playlists.loading}
          error={playlists.error}
          currentTrackId={player.current?.id ?? null}
          isPlaying={player.isPlaying}
          singleClick={settings.interaction.librarySingleClick}
          doubleClick={settings.interaction.libraryDoubleClick}
          indexWidth={settings.playlists.indexWidth}
          onIndexWidthChange={setPlaylistIndexWidth}
          onSelect={playlists.select}
          onCreate={playlists.create}
          onRename={playlists.rename}
          onDelete={playlists.remove}
          onClear={playlists.clear}
          onRemoveItems={playlists.removeItems}
          onMoveItem={playlists.moveItem}
          onPlay={(queue, index) => player.playQueue(queue, index)}
          onReveal={(trackId) => void revealTrack(trackId)}
        />
      ) : view === 'queue' ? (
        <QueueView
          queue={player.queue}
          index={player.index}
          isPlaying={player.isPlaying}
          onJump={player.jumpTo}
          onRemove={player.removeAt}
          onClear={player.clearQueue}
          onBrowseLibrary={() => setView('library')}
        />
      ) : (
        <SettingsView
          settings={settings}
          paths={paths}
          engineStatus={engineStatus}
          engineLoading={engineLoading}
          scanning={scanning}
          error={combinedError}
          onUpdate={updateSettings}
          onAddFolder={() => void addFolder()}
          onRemoveFolder={(folder) => void removeFolder(folder)}
          onPickEngineDir={() => void pickEngineDir()}
          onPickDownloadFolder={() => void pickDownloadFolder()}
          onRefreshEngine={() => void refreshEngine()}
          onOpenPath={(target) => void openPath(target)}
        />
      )}

      <PlayerBar
        current={player.current}
        isPlaying={player.isPlaying}
        isLoading={player.isLoading}
        positionMs={player.positionMs}
        durationMs={player.durationMs}
        volume={player.volume}
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
      />

      {/* Stream links are a session-only queue entry; the dialog overlays the
          library rather than being a view of its own. */}
      <PlayLinkDialog
        open={playLinkOpen}
        onClose={() => setPlayLinkOpen(false)}
        onPlay={playLink}
      />

      {/* Rendered last so it stacks over the bar it was opened from. The views
          behind it stay mounted, which is what keeps the list scroll position
          and the audio element untouched while it is open. */}
      {nowPlaying ? (
        <NowPlayingView
          closing={nowPlayingClosing}
          current={player.current}
          isPlaying={player.isPlaying}
          isLoading={player.isLoading}
          positionMs={player.positionMs}
          durationMs={player.durationMs}
          volume={player.volume}
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
          onToggleShuffle={toggleShuffle}
          onJumpQueue={player.jumpTo}
          onClose={closeNowPlaying}
          playlists={playlists.playlists}
          onAddTracksToPlaylist={playlists.addTracks}
          onCreatePlaylist={playlists.create}
        />
      ) : null}
    </div>
  )
}
