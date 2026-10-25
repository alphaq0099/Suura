import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ACCENT_CHOICES,
  DEFAULT_APPEARANCE,
  DENSITY_CHOICES,
  ICON_SET_CHOICES,
  MOTION_CHOICES,
  SURFACE_CHOICES,
  TEXT_SIZE_CHOICES,
  THEME_CHOICES
} from '@shared/appearance'
import { DEFAULT_PREFERENCE_PATCH, SECTION_PREFERENCE_PATCHES } from '@shared/settings-defaults'
import type {
  AccentName,
  AppPaths,
  AppSettings,
  ArtworkFit,
  ArtworkShape,
  ArtworkSize,
  CookieFallbackMode,
  DeepPartial,
  Density,
  DownloadFormat,
  DuplicateMergeOutcome,
  DuplicateReport,
  EngineStatus,
  ExecutableStatus,
  IconSet,
  LibraryClickAction,
  MotionPreference,
  PoTokenStatus,
  QualityTier,
  RelocateReport,
  ReplayGainStatus,
  RetentionMode,
  RuntimeInfo,
  StartupView,
  SurfaceStyle,
  TextSize,
  ThemeMode
} from '@shared/types'
import { COOKIE_BROWSERS, normalizePoTokenProviderUrl } from '@shared/youtube'
import { AudioSettingsPanel } from './AudioSettingsPanel'
import { FolderIcon, InfoIcon, RefreshIcon, SpinnerIcon, TrashIcon } from './Icons'

export interface SettingsViewProps {
  settings: AppSettings
  paths: AppPaths | null
  runtimeInfo: RuntimeInfo | null
  engineStatus: EngineStatus | null
  engineLoading: boolean
  scanning: boolean
  error: string | null
  onUpdate: (patch: DeepPartial<AppSettings>) => void
  replayGainStatus: ReplayGainStatus | null
  onScanReplayGain: () => Promise<void>
  onCancelReplayGain: () => void
  onAddFolder: () => void
  onRemoveFolder: (folder: string) => void
  onPickEngineDir: () => void
  onPickDownloadFolder: () => void
  onRefreshEngine: () => void
  onStartPoToken: () => Promise<PoTokenStatus>
  onStopPoToken: () => Promise<PoTokenStatus>
  onOpenPath: (target: string) => void
  onCopyDiagnostics: () => Promise<void>
  onBackupData: () => Promise<string | null>
  onRestoreData: () => Promise<boolean>
  onExportLibrary: () => Promise<string | null>
  missingTracks: number
  onFindDuplicates: () => Promise<DuplicateReport>
  onMergeDuplicates: () => Promise<DuplicateMergeOutcome>
  onRelocateMissing: () => Promise<RelocateReport | null>
}

const QUALITY_CHOICES: Array<{ value: QualityTier; label: string }> = [
  { value: 'best', label: 'Best available' },
  { value: 'high', label: 'High (~256 kbps)' },
  { value: 'balanced', label: 'Balanced (~128 kbps)' },
  { value: 'data-saver', label: 'Data saver (~64 kbps)' }
]

const RETENTION_CHOICES: Array<{ value: RetentionMode; label: string; hint: string }> = [
  {
    value: 'stream',
    label: 'Stream only',
    hint: 'Nothing is written while you listen. Every play uses YouTube again, and nothing is available offline.'
  },
  {
    value: 'cache',
    label: 'Cache played tracks',
    hint: 'A played track is copied into a bounded cache, so it keeps playing offline until the budget or age limit evicts it.'
  },
  {
    value: 'keep',
    label: 'Save every played track',
    hint: 'Each YouTube track you start is saved into your library like a manual Save, tagged and available offline.'
  }
]

const FORMAT_CHOICES: Array<{ value: DownloadFormat; label: string }> = [
  { value: 'opus', label: 'Opus (no re-encode)' },
  { value: 'mp3', label: 'MP3 320 (compatibility)' },
  { value: 'm4a', label: 'M4A / AAC (Apple devices)' }
]

const COOKIE_FALLBACK_CHOICES: Array<{ value: CookieFallbackMode; label: string }> = [
  { value: 'off', label: 'Off (recommended)' },
  { value: 'on-bot-check', label: 'Only after a bot check' },
  { value: 'always', label: 'Always' }
]

const COOKIE_BROWSER_CHOICES: Array<{ value: string; label: string }> = [
  { value: '', label: 'Choose a browser' },
  ...COOKIE_BROWSERS.map((browser) => ({
    value: browser,
    label: browser.charAt(0).toUpperCase() + browser.slice(1)
  }))
]

const SHAPE_CHOICES: Array<{ value: ArtworkShape; label: string }> = [
  { value: 'square', label: 'Square' },
  { value: 'circle', label: 'Circle' }
]

const FIT_CHOICES: Array<{ value: ArtworkFit; label: string }> = [
  { value: 'cover', label: 'Crop to a square' },
  { value: 'contain', label: 'Fit the whole cover' }
]

const SIZE_CHOICES: Array<{ value: ArtworkSize; label: string }> = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
  { value: 'xlarge', label: 'Extra large' }
]

const CLICK_CHOICES: Array<{ value: LibraryClickAction; label: string }> = [
  { value: 'select', label: 'Select the row' },
  { value: 'play', label: 'Play the track' },
  { value: 'select-play', label: 'Select and play' },
  { value: 'nothing', label: 'Nothing' }
]

const STARTUP_VIEW_CHOICES: Array<{ value: StartupView; label: string }> = [
  { value: 'last', label: 'Last used' },
  { value: 'home', label: 'Home' },
  { value: 'library', label: 'Library' },
  { value: 'online', label: 'YouTube' },
  { value: 'search', label: 'Search' },
  { value: 'playlists', label: 'Playlists' },
  { value: 'downloads', label: 'Downloads' },
  { value: 'queue', label: 'Queue' }
]

const VOLUME_WHEEL_CHOICES: Array<{ value: number; label: string }> = [
  { value: 1, label: '1% (fine)' },
  { value: 2, label: '2%' },
  { value: 5, label: '5% (default)' },
  { value: 10, label: '10%' },
  { value: 15, label: '15% (coarse)' }
]

const SECTION_RESET_CHOICES = [
  { id: 'general', label: 'General' },
  { id: 'playback', label: 'Playback' },
  { id: 'streaming', label: 'Streaming' },
  { id: 'appearance', label: 'Appearance' }
] as const

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'streaming', label: 'Streaming' },
  { id: 'misc', label: 'Misc' },
  { id: 'about', label: 'About' }
] as const

type TabId = (typeof TABS)[number]['id']

/**
 * A compact explanation that stays out of the way until it is needed.
 *
 * The bubble is portalled to <body> and positioned against the viewport rather
 * than the card. The settings panel clips its own overflow, so an absolutely
 * positioned bubble in the right-hand column was cut off no matter which way
 * it opened. A fixed bubble can also flip above the trigger when there is no
 * room below it.
 *
 * The trigger is focusable as well as hoverable, so the text is reachable
 * without a mouse. `aria-describedby` ties the visible bubble to the icon
 * instead of leaving it as decoration.
 */
function InfoHint(props: { label: string; children: ReactNode }) {
  const id = useId()
  const triggerRef = useRef<HTMLSpanElement | null>(null)
  const bubbleRef = useRef<HTMLSpanElement | null>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const open = hovered || focused

  useLayoutEffect(() => {
    if (!open) return

    const place = (): void => {
      const trigger = triggerRef.current
      const bubble = bubbleRef.current
      if (!trigger || !bubble) return

      const anchor = trigger.getBoundingClientRect()
      const box = bubble.getBoundingClientRect()
      const edge = 8
      const gap = 7
      const centered = anchor.left + anchor.width / 2 - box.width / 2
      const maxLeft = Math.max(edge, window.innerWidth - box.width - edge)
      const left = Math.min(Math.max(centered, edge), maxLeft)

      let top = anchor.bottom + gap
      if (top + box.height > window.innerHeight - edge) {
        top = anchor.top - box.height - gap
      }
      if (top < edge) top = edge

      setPosition((current) =>
        current.top === top && current.left === left ? current : { top, left }
      )
    }

    place()
    const observer = new ResizeObserver(place)
    if (triggerRef.current) observer.observe(triggerRef.current)
    if (bubbleRef.current) observer.observe(bubbleRef.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  return (
    <span
      className="info-hint"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <span
        ref={triggerRef}
        className="info-hint-trigger"
        tabIndex={0}
        role="img"
        aria-label={props.label}
        aria-describedby={id}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          setFocused(false)
          event.currentTarget.blur()
        }}
        onClick={(event) => {
          // A hint often sits inside a <label>; without this, reading it would
          // toggle the checkbox or open the select it explains.
          event.preventDefault()
          event.stopPropagation()
        }}
      >
        <InfoIcon size={13} />
      </span>
      {createPortal(
        <span
          ref={bubbleRef}
          id={id}
          className={open ? 'info-hint-bubble open' : 'info-hint-bubble'}
          role="tooltip"
          style={{ top: position.top, left: position.left }}
        >
          {props.children}
        </span>,
        document.body
      )}
    </span>
  )
}

function describeExecutable(status: ExecutableStatus): string {
  if (!status.found) return status.error ?? 'Not found.'
  const origin = status.source === 'configured' ? 'configured folder' : status.source === 'path' ? 'PATH' : 'known location'
  return `${status.version ?? 'version unknown'} · via ${origin}`
}

/**
 * Settings, grouped into tabs.
 *
 * The panels are all mounted and only the selected one is visible. That keeps
 * the controls' state in one place while the user moves between tabs, and the
 * hidden panels are inert rather than unmounted — switching tabs never throws
 * away a half-edited field or restarts a check.
 */
export function SettingsView(props: SettingsViewProps) {
  const {
    settings,
    paths,
    runtimeInfo,
    engineStatus,
    engineLoading,
    scanning,
    error,
    onUpdate,
    replayGainStatus,
    onScanReplayGain,
    onCancelReplayGain,
    onAddFolder,
    onRemoveFolder,
    onPickEngineDir,
    onPickDownloadFolder,
    onRefreshEngine,
    onStartPoToken,
    onStopPoToken,
    onOpenPath,
    onCopyDiagnostics,
    onBackupData,
    onRestoreData,
    onExportLibrary,
    missingTracks,
    onFindDuplicates,
    onMergeDuplicates,
    onRelocateMissing
  } = props
  const [tab, setTab] = useState<TabId>('general')
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetDone, setResetDone] = useState(false)
  const [dataBusy, setDataBusy] = useState<'backup' | 'restore' | 'export' | null>(null)
  const [dataNote, setDataNote] = useState<string | null>(null)
  const [dataError, setDataError] = useState<string | null>(null)
  const [careBusy, setCareBusy] = useState<'duplicates' | 'merge' | 'relocate' | null>(null)
  const [careNote, setCareNote] = useState<string | null>(null)
  const [careError, setCareError] = useState<string | null>(null)
  const [duplicates, setDuplicates] = useState<DuplicateReport | null>(null)
  const [providerBusy, setProviderBusy] = useState<'start' | 'stop' | null>(null)
  const [providerNote, setProviderNote] = useState<string | null>(null)
  const [providerError, setProviderError] = useState<string | null>(null)
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false)
  const [diagnosticsNote, setDiagnosticsNote] = useState<string | null>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const resetButtonRef = useRef<HTMLButtonElement | null>(null)

  // A tab strip is one tab stop, not five. Arrow keys move between tabs, Home and
  // End jump to the edges, and the newly selected tab takes focus — the pattern
  // screen-reader and keyboard users expect from role="tablist".
  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let next = index
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = TABS.length - 1
    else return
    const target = TABS[next]
    if (!target) return
    event.preventDefault()
    setTab(target.id)
    tabRefs.current[next]?.focus()
  }

  const closeReset = (): void => {
    setConfirmReset(false)
    requestAnimationFrame(() => resetButtonRef.current?.focus())
  }

  const runBackup = async (): Promise<void> => {
    setDataBusy('backup')
    setDataError(null)
    setDataNote(null)
    try {
      const directory = await onBackupData()
      setDataNote(directory ? `Backup saved to ${directory}` : 'Backup cancelled.')
    } catch (cause) {
      setDataError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDataBusy(null)
    }
  }

  const runExport = async (): Promise<void> => {
    setDataBusy('export')
    setDataError(null)
    setDataNote(null)
    try {
      const file = await onExportLibrary()
      setDataNote(file ? `Library exported to ${file}` : 'Export cancelled.')
    } catch (cause) {
      setDataError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDataBusy(null)
    }
  }

  const runFindDuplicates = async (): Promise<void> => {
    setCareBusy('duplicates')
    setCareError(null)
    setCareNote(null)
    try {
      const report = await onFindDuplicates()
      setDuplicates(report)
      setCareNote(
        report.groups === 0
          ? `No duplicate copies found. ${report.hashed} file${report.hashed === 1 ? '' : 's'} fingerprinted.`
          : `${report.groups} duplicate group${report.groups === 1 ? '' : 's'} found, ${report.extraCopies} extra cop${report.extraCopies === 1 ? 'y' : 'ies'}.`
      )
    } catch (cause) {
      setCareError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCareBusy(null)
    }
  }

  const runMergeDuplicates = async (): Promise<void> => {
    if (!duplicates || duplicates.groups === 0) return
    const confirmed = window.confirm(
      `Merge ${duplicates.groups} duplicate group${duplicates.groups === 1 ? '' : 's'}?\n\nThe oldest entry in each group is kept and the ${duplicates.extraCopies} extra file${duplicates.extraCopies === 1 ? '' : 's'} will be permanently deleted. Playlists and play counts move to the kept entry.`
    )
    if (!confirmed) return
    setCareBusy('merge')
    setCareError(null)
    setCareNote(null)
    try {
      const outcome = await onMergeDuplicates()
      setDuplicates({ groups: 0, extraCopies: 0, hashed: 0 })
      setCareNote(
        outcome.removed === 0
          ? 'There was nothing left to merge.'
          : `Merged ${outcome.removed} duplicate row${outcome.removed === 1 ? '' : 's'} into ${outcome.groups} kept row${outcome.groups === 1 ? '' : 's'} and removed ${outcome.filesRemoved} duplicate file${outcome.filesRemoved === 1 ? '' : 's'}.${outcome.fileErrors > 0 ? ` ${outcome.fileErrors} file${outcome.fileErrors === 1 ? '' : 's'} could not be deleted and will reappear on the next scan.` : ''}`
      )
    } catch (cause) {
      setCareError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCareBusy(null)
    }
  }

  const runRelocate = async (): Promise<void> => {
    setCareBusy('relocate')
    setCareError(null)
    setCareNote(null)
    try {
      const report = await onRelocateMissing()
      if (!report) {
        setCareNote('Relocation cancelled.')
        return
      }
      setCareNote(
        report.relocated === 0
          ? `Scanned ${report.scanned} audio file${report.scanned === 1 ? '' : 's'}; none matched the ${report.unmatched} missing track${report.unmatched === 1 ? '' : 's'}.`
          : `Relocated ${report.relocated} track${report.relocated === 1 ? '' : 's'}; ${report.unmatched} still missing.`
      )
    } catch (cause) {
      setCareError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCareBusy(null)
    }
  }

  const runProvider = async (action: 'start' | 'stop'): Promise<void> => {
    setProviderBusy(action)
    setProviderError(null)
    setProviderNote(null)
    try {
      const status = action === 'start' ? await onStartPoToken() : await onStopPoToken()
      if (action === 'stop') {
        setProviderNote(
          status.serverReachable
            ? 'Stopped the provider this app started; another provider is still answering at that URL.'
            : 'Provider stopped.'
        )
      } else if (status.serverReachable) {
        setProviderNote(
          status.managedRunning
            ? `Provider is ready${status.serverVersion ? ` (v${status.serverVersion})` : ''}.`
            : `A provider was already answering${status.serverVersion ? ` (v${status.serverVersion})` : ''}.`
        )
      } else {
        setProviderNote('The command started, but the provider is not answering yet. Check its log.')
      }
    } catch (cause) {
      setProviderError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setProviderBusy(null)
    }
  }

  const providerUrlInvalid =
    settings.engine.poTokenProviderUrl.trim().length > 0 &&
    !normalizePoTokenProviderUrl(settings.engine.poTokenProviderUrl)
  const providerCommand = settings.engine.poTokenProviderCommand?.trim() ?? ''
  const providerCommandMissing = providerCommand.length === 0

  const copyDiagnostics = async (): Promise<void> => {
    setDiagnosticsBusy(true)
    setDiagnosticsNote(null)
    try {
      await onCopyDiagnostics()
      setDiagnosticsNote('Diagnostics copied to the clipboard.')
    } catch (cause) {
      setDiagnosticsNote(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDiagnosticsBusy(false)
    }
  }

  const runRestore = async (): Promise<void> => {
    setDataBusy('restore')
    setDataError(null)
    setDataNote(null)
    try {
      const staged = await onRestoreData()
      setDataNote(staged ? 'Restoring — Player will restart.' : 'Restore cancelled.')
    } catch (cause) {
      setDataError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDataBusy(null)
    }
  }

  return (
    <section className="main-view settings-view">
      <header className="view-header">
        <div className="view-heading">
          <h1>Settings</h1>
          <p className="subtitle">Saved to config.json in the app data folder. Changes apply immediately.</p>
        </div>
      </header>

      {error ? (
        <div className="banner error" role="alert">
          {error}
        </div>
      ) : null}

      <nav className="settings-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map((entry, index) => (
          <button
            key={entry.id}
            ref={(node) => {
              tabRefs.current[index] = node
            }}
            type="button"
            role="tab"
            id={`settings-tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`settings-panel-${entry.id}`}
            tabIndex={tab === entry.id ? 0 : -1}
            className={tab === entry.id ? 'settings-tab active' : 'settings-tab'}
            onClick={() => setTab(entry.id)}
            onKeyDown={(event) => moveTab(event, index)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <div className="settings-body">
        <section
          className="settings-panel"
          role="tabpanel"
          id="settings-panel-general"
          aria-labelledby="settings-tab-general"
          tabIndex={0}
          hidden={tab !== 'general'}
        >
          <div className="cards">
            <article className="card">
              <header className="card-header">
                <h2>Library folders</h2>
                <button type="button" onClick={onAddFolder} disabled={scanning}>
                  <FolderIcon />
                  <span>Add folder</span>
                </button>
              </header>
              {settings.libraryFolders.length === 0 ? (
                <p className="card-hint">No folders yet. Add one to start indexing your music.</p>
              ) : (
                <ul className="folder-list">
                  {settings.libraryFolders.map((folder) => (
                    <li key={folder}>
                      <span className="folder-path" title={folder}>
                        {folder}
                      </span>
                      <button
                        type="button"
                        className="icon-button subtle"
                        title="Remove folder and forget its tracks"
                        aria-label={`Remove ${folder}`}
                        onClick={() => onRemoveFolder(folder)}
                      >
                        <TrashIcon />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="field-grid">
                <label className="field checkbox">
                  <input
                    type="checkbox"
                    checked={settings.library.watchForChanges}
                    onChange={(event) => onUpdate({ library: { watchForChanges: event.target.checked } })}
                  />
                  <span>
                    Watch folders for changes
                    <InfoHint label="About folder watching">
                      A change starts an incremental scan; only files whose size or timestamp moved are reopened. Turn
                      it off for a library on a network or removable drive, where watching can cost more than a manual
                      scan.
                    </InfoHint>
                  </span>
                </label>
              </div>
            </article>

            <article className="card">
              <header className="card-header">
                <h2>
                  Startup, window &amp; resume
                  <InfoHint label="About startup and window behaviour">
                    Last used returns to the view you left open; Settings is never restored. The first launch after
                    adding a folder always scans, even when the launch scan is off. Resuming brings back the last
                    local queue; with the option off the queue still returns, but paused. Closing to the tray keeps
                    playback alive and leaves the tray icon as the way back.
                  </InfoHint>
                </h2>
              </header>
              <p className="card-hint">
                Where Player opens, whether it checks for changes made while it was closed, what happens to the last
                queue, and whether closing the window quits or hides it.
              </p>
              <div className="field-grid">
                <label className="field">
                  <span>Open at launch</span>
                  <select
                    value={settings.startup.view}
                    onChange={(event) => onUpdate({ startup: { view: event.target.value as StartupView } })}
                  >
                    {STARTUP_VIEW_CHOICES.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field checkbox">
                  <input
                    type="checkbox"
                    checked={settings.startup.scanOnLaunch}
                    onChange={(event) => onUpdate({ startup: { scanOnLaunch: event.target.checked } })}
                  />
                  <span>
                    Scan library on launch
                    <InfoHint label="About scanning on launch">
                      An incremental scan compares size and timestamp, so unchanged files are not reopened. Turn it off
                      for a large library on a slow or network drive and scan manually instead.
                    </InfoHint>
                  </span>
                </label>
                <label className="field checkbox">
                  <input
                    type="checkbox"
                    checked={settings.startup.resumePlayback}
                    onChange={(event) => onUpdate({ startup: { resumePlayback: event.target.checked } })}
                  />
                  <span>
                    Resume playback automatically
                    <InfoHint label="About automatic resume">
                      Restores the last local queue, seeks to the saved position and starts playing. With this off the
                      queue still returns, but paused, so opening the app is quiet.
                    </InfoHint>
                  </span>
                </label>
                <label className="field checkbox">
                  <input
                    type="checkbox"
                    checked={settings.desktop.closeToTray}
                    onChange={(event) => onUpdate({ desktop: { closeToTray: event.target.checked } })}
                  />
                  <span>
                    Close to tray
                    <InfoHint label="About closing to the tray">
                      Closing the window hides it and keeps playback running. Use the tray icon to show Player again or
                      to quit. With this off, closing the last window exits the app.
                    </InfoHint>
                  </span>
                </label>
              </div>
            </article>

            <article className="card">
              <header className="card-header">
                <h2>
                  Click behaviour
                  <InfoHint label="About click behaviour">
                    Two conventions are in wide use - select on click, or play on click - and whichever one you are
                    used to, the other feels broken. A double click always arrives as two single clicks first, so
                    choosing &quot;play&quot; for both starts the track on the first click and does not restart it on
                    the second.
                  </InfoHint>
                </h2>
              </header>
              <p className="card-hint">
                Choose what one click does; double-click always receives two single clicks first.
              </p>
              <div className="field-grid">
                <label className="field">
                  <span>Single click</span>
                  <select
                    value={settings.interaction.librarySingleClick}
                    onChange={(event) =>
                      onUpdate({ interaction: { librarySingleClick: event.target.value as LibraryClickAction } })
                    }
                  >
                    {CLICK_CHOICES.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>Double click</span>
                  <select
                    value={settings.interaction.libraryDoubleClick}
                    onChange={(event) =>
                      onUpdate({ interaction: { libraryDoubleClick: event.target.value as LibraryClickAction } })
                    }
                  >
                    {CLICK_CHOICES.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </article>

            <article className="card">
              <header className="card-header">
                <h2>
                  Playback &amp; volume
                  <InfoHint label="About playback and volume">
                    The wheel step applies to the volume control in the player bar and the full-window player. Holding
                    Shift always uses one percent. Volume itself is remembered between launches.
                  </InfoHint>
                </h2>
              </header>
              <p className="card-hint">How much one wheel notch changes the volume.</p>
              <div className="field-grid">
                <label className="field">
                  <span>Volume wheel step</span>
                  <select
                    value={settings.interaction.volumeWheelStep}
                    onChange={(event) =>
                      onUpdate({ interaction: { volumeWheelStep: Number(event.target.value) } })
                    }
                  >
                    {VOLUME_WHEEL_CHOICES.map((choice) => (
                      <option key={choice.value} value={choice.value}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </article>

            <AudioSettingsPanel
              audio={settings.audio}
              replayGainStatus={replayGainStatus}
              onUpdate={onUpdate}
              onScanReplayGain={onScanReplayGain}
              onCancelReplayGain={onCancelReplayGain}
            />
          </div>
        </section>

        <section
          className="settings-panel"
          role="tabpanel"
          id="settings-panel-appearance"
          aria-labelledby="settings-tab-appearance"
          tabIndex={0}
          hidden={tab !== 'appearance'}
        >
          <div className="cards">
            <div className="cards-col">
              <article className="card">
                <header className="card-header">
                  <h2>
                    Theme
                    <InfoHint label="About themes">
                      Midnight is the deep blue-black default. Cream is a warm off-white. Follow Windows switches live
                      with the operating system.
                    </InfoHint>
                  </h2>
                </header>
                <div className="theme-choices" role="group" aria-label="Theme">
                  {THEME_CHOICES.map((choice) => (
                    <button
                      key={choice.value}
                      type="button"
                      className={settings.theme === choice.value ? 'theme-choice active' : 'theme-choice'}
                      data-theme-choice={choice.value}
                      aria-pressed={settings.theme === choice.value}
                      onClick={() => onUpdate({ theme: choice.value as ThemeMode })}
                    >
                      <span className={`theme-preview ${choice.value}`} aria-hidden="true">
                        <span className="theme-preview-sidebar" />
                        <span className="theme-preview-body">
                          <span className="theme-preview-line" />
                          <span className="theme-preview-line short" />
                          <span className="theme-preview-card" />
                        </span>
                      </span>
                      <span className="theme-choice-label">{choice.label}</span>
                      <span className="theme-choice-hint">{choice.hint}</span>
                    </button>
                  ))}
                </div>
                <div className="field">
                  <span>Accent</span>
                  <div className="accent-choices" role="group" aria-label="Accent">
                    {ACCENT_CHOICES.map((choice) => (
                      <button
                        key={choice.value}
                        type="button"
                        className={settings.visuals.accent === choice.value ? 'accent-choice active' : 'accent-choice'}
                        data-accent-choice={choice.value}
                        aria-pressed={settings.visuals.accent === choice.value}
                        onClick={() => onUpdate({ visuals: { accent: choice.value as AccentName } })}
                      >
                        <span className="accent-swatch" style={{ background: choice.swatch }} aria-hidden="true" />
                        <span>{choice.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </article>

              <article className="card">
                <header className="card-header">
                  <h2>Layout &amp; motion</h2>
                </header>
                <div className="field">
                  <span>
                    Density
                    <InfoHint label="About density">
                      Compact fits more rows on screen, Comfortable is the default balance, and Spacious gives titles
                      and artwork more air.
                    </InfoHint>
                  </span>
                  <div className="segmented" role="group" aria-label="Density">
                    {DENSITY_CHOICES.map((choice) => (
                      <button
                        key={choice.value}
                        type="button"
                        className={settings.visuals.density === choice.value ? 'active' : undefined}
                        data-density-choice={choice.value}
                        aria-pressed={settings.visuals.density === choice.value}
                        title={choice.hint}
                        onClick={() => onUpdate({ visuals: { density: choice.value as Density } })}
                      >
                        {choice.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <span>
                    Surface
                    <InfoHint label="About surfaces">
                      Solid uses flat panels. Accented adds an accent-coloured wash and a translucent blur. It is not
                      Windows acrylic, and it does not sample the current cover art.
                    </InfoHint>
                  </span>
                  <div className="segmented" role="group" aria-label="Surface">
                    {SURFACE_CHOICES.map((choice) => (
                      <button
                        key={choice.value}
                        type="button"
                        className={settings.visuals.surface === choice.value ? 'active' : undefined}
                        data-surface-choice={choice.value}
                        aria-pressed={settings.visuals.surface === choice.value}
                        title={choice.hint}
                        onClick={() => onUpdate({ visuals: { surface: choice.value as SurfaceStyle } })}
                      >
                        {choice.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <span>
                    Motion
                    <InfoHint label="About motion">
                      Follow Windows uses the system animation setting. Reduced removes most transitions but keeps a
                      slow spinner. Full always animates.
                    </InfoHint>
                  </span>
                  <div className="segmented" role="group" aria-label="Motion">
                    {MOTION_CHOICES.map((choice) => (
                      <button
                        key={choice.value}
                        type="button"
                        className={settings.visuals.motion === choice.value ? 'active' : undefined}
                        data-motion-choice={choice.value}
                        aria-pressed={settings.visuals.motion === choice.value}
                        title={choice.hint}
                        onClick={() => onUpdate({ visuals: { motion: choice.value as MotionPreference } })}
                      >
                        {choice.label}
                      </button>
                    ))}
                  </div>
                </div>
              </article>

              <div className="appearance-reset">
                <div>
                  <strong>Reset appearance</strong>
                  <p>Theme, layout, text, columns and cover art.</p>
                </div>
                <button
                  type="button"
                  aria-label="Reset appearance"
                  onClick={() => onUpdate(DEFAULT_APPEARANCE)}
                >
                  Reset
                </button>
              </div>
            </div>

            <div className="cards-col">
              <article className="card">
                <header className="card-header">
                  <h2>
                    Text &amp; icons
                    <InfoHint label="About text and icons">
                      Text size scales every label, heading and hint together. The icon choice applies to the sidebar.
                    </InfoHint>
                  </h2>
                </header>
                <div className="field">
                  <span>Text size</span>
                  <div className="segmented" role="group" aria-label="Text size">
                    {TEXT_SIZE_CHOICES.map((choice) => (
                      <button
                        key={choice.value}
                        type="button"
                        className={settings.visuals.textSize === choice.value ? 'active' : undefined}
                        data-text-size-choice={choice.value}
                        aria-pressed={settings.visuals.textSize === choice.value}
                        title={choice.hint}
                        onClick={() => onUpdate({ visuals: { textSize: choice.value as TextSize } })}
                      >
                        {choice.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="field">
                  <span>
                    Sidebar icons
                    <InfoHint label="About sidebar icons">
                      Modern uses rounder, more distinct silhouettes for Library, YouTube, Playlists, Queue and Settings.
                      Classic keeps the original outline set.
                    </InfoHint>
                  </span>
                  <div className="segmented" role="group" aria-label="Sidebar icons">
                    {ICON_SET_CHOICES.map((choice) => (
                      <button
                        key={choice.value}
                        type="button"
                        className={settings.visuals.iconSet === choice.value ? 'active' : undefined}
                        data-icon-set-choice={choice.value}
                        aria-pressed={settings.visuals.iconSet === choice.value}
                        title={choice.hint}
                        onClick={() => onUpdate({ visuals: { iconSet: choice.value as IconSet } })}
                      >
                        {choice.label}
                      </button>
                    ))}
                  </div>
                </div>
              </article>

              <article className="card">
                <header className="card-header">
                  <h2>
                    Cover art
                    <InfoHint label="About cover art">
                      Shape and fit apply to library rows, the player bar and the full-window player. A circle is always
                      cropped. Artwork size applies to the full-window player; playlist cover size applies to the
                      selected playlist&apos;s header. Ambience takes its colour from the current cover.
                    </InfoHint>
                  </h2>
                </header>
                <div className="field-grid">
                  <label className="field">
                    <span>Artwork shape</span>
                    <select
                      value={settings.visuals.artworkShape}
                      onChange={(event) => onUpdate({ visuals: { artworkShape: event.target.value as ArtworkShape } })}
                    >
                      {SHAPE_CHOICES.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>When a cover is not square</span>
                    <select
                      value={settings.visuals.artworkFit}
                      disabled={settings.visuals.artworkShape === 'circle'}
                      onChange={(event) => onUpdate({ visuals: { artworkFit: event.target.value as ArtworkFit } })}
                    >
                      {FIT_CHOICES.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Artwork size</span>
                    <select
                      value={settings.visuals.artworkSize}
                      onChange={(event) => onUpdate({ visuals: { artworkSize: event.target.value as ArtworkSize } })}
                    >
                      {SIZE_CHOICES.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Playlist cover size</span>
                    <select
                      data-playlist-artwork-size
                      value={settings.visuals.playlistArtworkSize}
                      onChange={(event) =>
                        onUpdate({ visuals: { playlistArtworkSize: event.target.value as ArtworkSize } })
                      }
                    >
                      {SIZE_CHOICES.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="field-grid">
                  <label className="field checkbox">
                    <input
                      type="checkbox"
                      checked={settings.visuals.playerArtwork}
                      onChange={(event) => onUpdate({ visuals: { playerArtwork: event.target.checked } })}
                    />
                    <span>Show the cover in the full-window player</span>
                  </label>
                  <label className="field checkbox">
                    <input
                      type="checkbox"
                      checked={settings.visuals.playerAmbience}
                      onChange={(event) => onUpdate({ visuals: { playerAmbience: event.target.checked } })}
                    />
                    <span>Tint the player with the cover&apos;s colour</span>
                  </label>
                </div>
              </article>

              <article className="card">
                <header className="card-header">
                  <h2>
                    List columns
                    <InfoHint label="About list columns">
                      The Album and Channel checkboxes hide those columns where they exist; a very narrow pane still
                      drops them automatically. Channel applies to YouTube links and imported lists; local rows keep
                      Artist.
                    </InfoHint>
                  </h2>
                </header>
                <p className="card-hint">Choose which optional columns appear in each kind of list.</p>
                <div className="column-toggle-groups">
                  <div className="column-toggle-group">
                    <h3>Local lists</h3>
                    <label className="field checkbox">
                      <input
                        type="checkbox"
                        data-album-column-toggle
                        checked={settings.visuals.showAlbumColumn}
                        onChange={(event) => onUpdate({ visuals: { showAlbumColumn: event.target.checked } })}
                      />
                      <span>Show the Album column</span>
                    </label>
                  </div>
                  <div className="column-toggle-group">
                    <h3>YouTube lists</h3>
                    <label className="field checkbox">
                      <input
                        type="checkbox"
                        data-channel-column-toggle
                        checked={settings.visuals.showChannelColumn}
                        onChange={(event) => onUpdate({ visuals: { showChannelColumn: event.target.checked } })}
                      />
                      <span>Show the Channel column in imported playlists</span>
                    </label>
                  </div>
                </div>
              </article>
            </div>
          </div>
        </section>

        <section
          className="settings-panel"
          role="tabpanel"
          id="settings-panel-streaming"
          aria-labelledby="settings-tab-streaming"
          tabIndex={0}
          hidden={tab !== 'streaming'}
        >
          <div className="cards">
            <div className="cards-col">
              <article className="card">
                <header className="card-header">
                  <h2>
                    YouTube engine <span className="badge">yt-dlp</span>
                    <InfoHint label="About the YouTube engine">
                      Playback, importing lists and saving tracks all shell out to yt-dlp. ffmpeg handles transcoding,
                      tags and covers.
                    </InfoHint>
                  </h2>
                  <button type="button" onClick={onRefreshEngine} disabled={engineLoading}>
                    {engineLoading ? <SpinnerIcon /> : <RefreshIcon />}
                    <span>Check</span>
                  </button>
                </header>
                <p className="card-hint">Checks the two binaries playback and saving need.</p>

                {engineStatus ? (
                  <ul className="status-list">
                    <li className={engineStatus.ytDlp.found ? 'ok' : 'bad'}>
                      <span className="status-name">yt-dlp</span>
                      <span className="status-value">{describeExecutable(engineStatus.ytDlp)}</span>
                    </li>
                    <li className={engineStatus.ffmpeg.found ? 'ok' : 'bad'}>
                      <span className="status-name">ffmpeg</span>
                      <span className="status-value">{describeExecutable(engineStatus.ffmpeg)}</span>
                    </li>
                  </ul>
                ) : (
                  <p className="card-hint">{engineLoading ? 'Checking…' : 'Not checked yet.'}</p>
                )}

                <div className="field-grid">
                  <label className="field wide">
                    <span>
                      Engine folder (optional)
                      <InfoHint label="About the engine folder">
                        A folder containing yt-dlp.exe and ffmpeg.exe. Leave it empty to search PATH and the usual
                        install locations.
                      </InfoHint>
                    </span>
                    <div className="field-row">
                      <input type="text" readOnly value={settings.engine.binDir ?? '(search PATH)'} />
                      <button type="button" onClick={onPickEngineDir}>
                        Change
                      </button>
                      {settings.engine.binDir ? (
                        <button type="button" onClick={() => onUpdate({ engine: { binDir: null } })}>
                          Clear
                        </button>
                      ) : null}
                    </div>
                  </label>
                  <label className="field checkbox">
                    <input
                      type="checkbox"
                      checked={settings.engine.autoUpdate}
                      onChange={(event) => onUpdate({ engine: { autoUpdate: event.target.checked } })}
                    />
                    <span>
                      Keep yt-dlp up to date automatically
                      <InfoHint label="About automatic updates">
                        Checks at most once a day, after the window settles. A failed update is only logged, because
                        installs managed by winget or pip may not allow self-updates.
                      </InfoHint>
                    </span>
                  </label>
                </div>
              </article>

              <article className="card">
                <header className="card-header">
                  <h2>
                    PO Token provider
                    <InfoHint label="About the PO Token provider">
                      YouTube sometimes asks for proof that a request comes from a real browser. This optional
                      external server and its yt-dlp plugin are third-party pieces; neither is bundled or required for
                      normal playback.
                    </InfoHint>
                  </h2>
                  <button type="button" onClick={onRefreshEngine} disabled={engineLoading}>
                    {engineLoading ? <SpinnerIcon /> : <RefreshIcon />}
                    <span>Check status</span>
                  </button>
                </header>
                <p className="card-hint">
                  Optional external server. Install the third-party{' '}
                  <a
                    href="https://github.com/Brainicism/bgutil-ytdlp-pot-provider"
                    target="_blank"
                    rel="noreferrer"
                  >
                    provider and plugin
                  </a>{' '}
                  separately.
                </p>

                <div className="field-grid">
                  <label className="field checkbox">
                    <input
                      type="checkbox"
                      checked={settings.engine.poTokenEnabled}
                      onChange={(event) => onUpdate({ engine: { poTokenEnabled: event.target.checked } })}
                    />
                    <span>
                      Use a PO Token provider
                      <InfoHint label="About PO Tokens">
                        PO Tokens are short-lived proofs attached to a YouTube request. This app does not bundle a
                        provider or the yt-dlp plugin; point this at the HTTP server you installed separately.
                      </InfoHint>
                    </span>
                  </label>
                  <label className="field">
                    <span>
                      Provider URL
                      <InfoHint label="About the provider URL">
                        The base URL yt-dlp's bgutil plugin calls. The standard local server listens on
                        127.0.0.1:4416. A remote provider sees every token request, so keep this on your machine
                        unless you trust the network.
                      </InfoHint>
                    </span>
                    <input
                      type="url"
                      value={settings.engine.poTokenProviderUrl}
                      placeholder="http://127.0.0.1:4416"
                      onChange={(event) => onUpdate({ engine: { poTokenProviderUrl: event.target.value } })}
                    />
                  </label>
                  <label className="field wide">
                    <span>
                      Provider command (optional; needed for Start and auto-start)
                      <InfoHint label="About the provider command">
                        A command this app can start and stop for you, for example{' '}
                        <code>node &quot;C:\path\to\bgutil\server\build\main.js&quot;</code>. It is split into
                        arguments without a shell, so quoted paths work but pipes and variables do not. Leave it blank
                        if you run the server yourself.
                      </InfoHint>
                    </span>
                    <input
                      type="text"
                      value={settings.engine.poTokenProviderCommand ?? ''}
                      placeholder="No command set"
                      onChange={(event) =>
                        onUpdate({ engine: { poTokenProviderCommand: event.target.value || null } })
                      }
                    />
                  </label>
                  <label className="field checkbox">
                    <input
                      type="checkbox"
                      checked={settings.engine.poTokenAutoStart}
                      title={
                        providerCommandMissing
                          ? 'Add a provider command above before auto-start can start a provider.'
                          : undefined
                      }
                      onChange={(event) => onUpdate({ engine: { poTokenAutoStart: event.target.checked } })}
                    />
                    <span>
                      Start the provider automatically
                      <InfoHint label="About automatic provider start">
                        Runs the command above on launch and when the switch is turned on. The app stops only the
                        process it started, never a server you launched yourself. Auto-start stays idle until a command
                        is set.
                      </InfoHint>
                    </span>
                  </label>
                </div>

                {settings.engine.poTokenEnabled && providerCommandMissing ? (
                  <p className="card-hint">
                    No provider command is set. Run the provider yourself, or add one above to use Start and
                    auto-start.
                  </p>
                ) : null}

                {providerUrlInvalid ? (
                  <p className="card-hint status-error">
                    That provider URL is not a plain http(s) URL. The default local address will be used until it is
                    fixed.
                  </p>
                ) : null}

                <div className="field-row provider-actions">
                  <button
                    type="button"
                    onClick={() => void runProvider('start')}
                    title={
                      !settings.engine.poTokenEnabled
                        ? 'Turn on Use a PO Token provider first.'
                        : providerCommandMissing
                          ? 'Add a provider command, or run the server yourself and leave this button alone.'
                          : undefined
                    }
                    disabled={!settings.engine.poTokenEnabled || providerCommandMissing || providerBusy !== null}
                  >
                    {providerBusy === 'start' ? <SpinnerIcon /> : null}
                    <span>Start provider</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void runProvider('stop')}
                    disabled={!engineStatus?.poToken?.managedRunning || providerBusy !== null}
                  >
                    {providerBusy === 'stop' ? <SpinnerIcon /> : null}
                    <span>Stop provider</span>
                  </button>
                </div>

                {engineStatus?.poToken ? (
                  <ul className="status-list">
                    <li className={engineStatus.poToken.enabled ? 'ok' : ''}>
                      <span className="status-name">App switch</span>
                      <span className="status-value">
                        {engineStatus.poToken.enabled ? 'enabled' : 'off'}
                      </span>
                    </li>
                    <li className={engineStatus.poToken.serverReachable ? 'ok' : 'bad'}>
                      <span className="status-name">Server</span>
                      <span className="status-value" title={engineStatus.poToken.providerUrl}>
                        {engineStatus.poToken.serverReachable
                          ? `reachable at ${engineStatus.poToken.providerUrl.replace(/^https?:\/\//, '')}${engineStatus.poToken.serverVersion ? `, v${engineStatus.poToken.serverVersion}` : ''}`
                          : `no answer at ${engineStatus.poToken.providerUrl.replace(/^https?:\/\//, '')}`}
                      </span>
                    </li>
                    <li className={engineStatus.poToken.managedRunning ? 'ok' : ''}>
                      <span className="status-name">Managed process</span>
                      <span className="status-value">
                        {engineStatus.poToken.managedRunning ? 'running' : 'not running'}
                      </span>
                    </li>
                    <li className={engineStatus.poToken.commandConfigured ? 'ok' : ''}>
                      <span className="status-name">Start command</span>
                      <span className="status-value">
                        {engineStatus.poToken.commandConfigured ? 'set' : 'not set'}
                      </span>
                    </li>
                  </ul>
                ) : (
                  <p className="card-hint">Provider status is checked with the engine.</p>
                )}
                {engineStatus?.poToken?.error ? (
                  <p className="card-hint status-error">{engineStatus.poToken.error}</p>
                ) : null}
                {providerError ? <p className="card-hint status-error">{providerError}</p> : null}
                {providerNote ? <p className="card-hint">{providerNote}</p> : null}
              </article>
            </div>

            <div className="cards-col">
              <article className="card">
                <header className="card-header">
                  <h2>
                    Cookie fallback
                    <InfoHint label="About cookie fallback">
                      Off never reads cookies. Only after a bot check tries once with cookies when YouTube challenges
                      the request, before pausing new requests. Always sends cookies on every yt-dlp call.
                    </InfoHint>
                  </h2>
                </header>
                <p className="card-hint">Off by default. A targeted retry, not an account login.</p>
                <div className="field-grid">
                  <label className="field">
                    <span>When to use cookies</span>
                    <select
                      value={settings.engine.cookieFallback}
                      onChange={(event) =>
                        onUpdate({ engine: { cookieFallback: event.target.value as CookieFallbackMode } })
                      }
                    >
                      {COOKIE_FALLBACK_CHOICES.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>
                      Browser
                      <InfoHint label="About browser cookies">
                        yt-dlp reads YouTube cookies from this browser on this PC. The app never signs in. Cookies can
                        grant access to the account, so this stays off unless you choose it.
                      </InfoHint>
                    </span>
                    <select
                      value={settings.engine.cookiesFromBrowser ?? ''}
                      disabled={settings.engine.cookieFallback === 'off'}
                      onChange={(event) =>
                        onUpdate({ engine: { cookiesFromBrowser: event.target.value || null } })
                      }
                    >
                      {COOKIE_BROWSER_CHOICES.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field wide">
                    <span>
                      Browser profile (optional)
                      <InfoHint label="About the browser profile">
                        A Chrome, Edge or Firefox profile name or path. Leave it blank for the browser's default
                        profile. Profiles with a separate sign-in keep their own cookies.
                      </InfoHint>
                    </span>
                    <input
                      type="text"
                      value={settings.engine.cookieBrowserProfile ?? ''}
                      disabled={settings.engine.cookieFallback === 'off'}
                      placeholder="Default profile"
                      onChange={(event) =>
                        onUpdate({ engine: { cookieBrowserProfile: event.target.value || null } })
                      }
                    />
                  </label>
                </div>
                {settings.engine.cookieFallback !== 'off' && !settings.engine.cookiesFromBrowser ? (
                  <p className="card-hint status-error">
                    Choose a browser, or the fallback will be skipped.
                  </p>
                ) : null}
                <p className="card-hint">The app never signs in; account playlists are unsupported.</p>
              </article>

              <article className="card">
                <header className="card-header">
                  <h2>
                    Playback &amp; imports
                    <InfoHint label="About playback and imports">
                      Both caps are applied while listing, so the rest of the list is never fetched or queued.
                      Download concurrency is separate from resolver concurrency, which stays low so playback remains
                      responsive.
                    </InfoHint>
                  </h2>
                </header>
                <p className="card-hint">Caps keep a large playlist from becoming a large queue.</p>
                <div className="field-grid">
                  <label className="field">
                    <span>
                      Concurrent downloads
                      <InfoHint label="About concurrent downloads">
                        How many saved tracks may download at once. Resolver concurrency is capped separately so
                        playback stays responsive.
                      </InfoHint>
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={8}
                      value={settings.engine.downloadConcurrency}
                      onChange={(event) => onUpdate({ engine: { downloadConcurrency: Number(event.target.value) } })}
                    />
                  </label>
                  <label className="field">
                    <span>
                      Playlist / album import limit
                      <InfoHint label="About the import limit">
                        How many tracks an imported playlist or album keeps. The view says “first N of M” when the
                        cap bites.
                      </InfoHint>
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      value={settings.engine.importLimit}
                      onChange={(event) => onUpdate({ engine: { importLimit: Number(event.target.value) } })}
                    />
                  </label>
                  <label className="field">
                    <span>
                      Mix length
                      <InfoHint label="About mix length">
                        A mix never ends, so this is its whole definition: the number of tracks a mix import keeps.
                      </InfoHint>
                    </span>
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={settings.engine.mixLimit}
                      onChange={(event) => onUpdate({ engine: { mixLimit: Number(event.target.value) } })}
                    />
                  </label>
                  <label className="field checkbox">
                    <input
                      type="checkbox"
                      checked={settings.engine.prefetchNext}
                      onChange={(event) => onUpdate({ engine: { prefetchNext: event.target.checked } })}
                    />
                    <span>
                      Prefetch the next track
                      <InfoHint label="About prefetching">
                        Resolves the next queued YouTube track while the current one plays. It removes the gap
                        between songs at the cost of one extra request per track.
                      </InfoHint>
                    </span>
                  </label>
                </div>
              </article>

              <article className="card">
                <header className="card-header">
                  <h2>
                    How streams are kept
                    <InfoHint label="About offline streaming">
                      The player never changes this for you. Stream only writes nothing, Cache keeps a copy that
                      offline playback can use, and Keep saves the track into your library. Cached tracks are copies,
                      not library rows: clearing the cache never deletes a file you saved.
                    </InfoHint>
                  </h2>
                </header>
                <p className="card-hint">
                  {RETENTION_CHOICES.find((choice) => choice.value === settings.retention.mode)?.hint}
                </p>

                <div className="field-grid">
                  <label className="field wide">
                    <span>When a YouTube track plays</span>
                    <select
                      value={settings.retention.mode}
                      onChange={(event) =>
                        onUpdate({ retention: { mode: event.target.value as RetentionMode } })
                      }
                    >
                      {RETENTION_CHOICES.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {settings.retention.mode === 'cache' ? (
                    <>
                      <label className="field">
                        <span>
                          Cache budget (MB)
                          <InfoHint label="About the cache budget">
                            The cache deletes its least recently used copy once it passes this size. Pinned tracks
                            still count but are never chosen for deletion. 5 GB is the default.
                          </InfoHint>
                        </span>
                        <input
                          type="number"
                          min={128}
                          max={1000000}
                          step={128}
                          value={settings.retention.cacheBudgetMb}
                          onChange={(event) =>
                            onUpdate({ retention: { cacheBudgetMb: Number(event.target.value) } })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>
                          Keep cached tracks for (days)
                          <InfoHint label="About cache age">
                            A cached track that has not been played for this many days is deleted, even when the
                            budget has room. Pinned tracks are exempt.
                          </InfoHint>
                        </span>
                        <input
                          type="number"
                          min={1}
                          max={3650}
                          value={settings.retention.cacheMaxAgeDays}
                          onChange={(event) =>
                            onUpdate({ retention: { cacheMaxAgeDays: Number(event.target.value) } })
                          }
                        />
                      </label>
                    </>
                  ) : null}
                </div>
              </article>

              <article className="card">
                <header className="card-header">
                  <h2>
                    Saving to your library
                    <InfoHint label="About saving streams">
                      Save to library downloads once, writes its tags and cover, and moves the file into your music
                      folder. Keep mode uses the same path automatically for each track you play.
                    </InfoHint>
                  </h2>
                </header>
                <p className="card-hint">
                  These settings apply to a manual Save and to Keep mode. A saved file plays offline and survives a
                  cache wipe.
                </p>

                <div className="field-grid">
                  <label className="field">
                    <span>Download quality</span>
                    <select
                      value={settings.retention.qualityTier}
                      onChange={(event) => onUpdate({ retention: { qualityTier: event.target.value as QualityTier } })}
                    >
                      {QUALITY_CHOICES.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Saved file format</span>
                    <select
                      value={settings.retention.downloadFormat}
                      onChange={(event) =>
                        onUpdate({ retention: { downloadFormat: event.target.value as DownloadFormat } })
                      }
                    >
                      {FORMAT_CHOICES.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field wide">
                    <span>Download folder</span>
                    <div className="field-row">
                      <input
                        type="text"
                        readOnly
                        value={settings.retention.downloadFolder ?? '(default: Music\\Player)'}
                      />
                      <button type="button" onClick={onPickDownloadFolder}>
                        Change
                      </button>
                      {settings.retention.downloadFolder ? (
                        <button type="button" onClick={() => onUpdate({ retention: { downloadFolder: null } })}>
                          Clear
                        </button>
                      ) : null}
                    </div>
                  </label>
                </div>
              </article>
            </div>
          </div>
        </section>

        <section
          className="settings-panel"
          role="tabpanel"
          id="settings-panel-misc"
          aria-labelledby="settings-tab-misc"
          tabIndex={0}
          hidden={tab !== 'misc'}
        >
          <div className="cards">
            <div className="cards-col">
              <article className="card">
                <header className="card-header">
                  <h2>
                    Storage &amp; diagnostics
                  <InfoHint label="About app data">
                    Everything the app writes lives here. The log file is the first place to look when something goes
                    wrong; the database and config are the two files not to edit while Player is running.
                  </InfoHint>
                </h2>
              </header>
              <p className="card-hint">App data, logs and caches. Open a folder to inspect it.</p>
              {paths ? (
                <ul className="path-list">
                  {(
                    [
                      ['Database', paths.database],
                      ['Config', paths.config],
                      ['Logs', paths.logs],
                      ['Artwork cache', paths.cache],
                      ['Downloads', paths.downloads],
                      ['Backups', paths.backups]
                    ] as const
                  ).map(([label, target]) => (
                    <li key={label}>
                      <span className="path-label">{label}</span>
                      <span className="path-value" title={target}>
                        {target}
                      </span>
                      <button type="button" onClick={() => onOpenPath(target)}>
                        Open
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="card-hint">Loading…</p>
              )}
              </article>
            </div>

            <div className="cards-col">
              <article className="card">
                <header className="card-header">
                  <h2>
                    Backup &amp; restore
                  <InfoHint label="About backups">
                    Automatic copies are taken at startup and before a library upgrade; only the newest count you
                    choose stay in the backups folder. Restore validates the chosen folder, moves current data aside,
                    then restarts. Export includes paths and play counts.
                  </InfoHint>
                </h2>
              </header>
              <p className="card-hint">Automatic copies at startup and before upgrades; export a CSV for spreadsheets.</p>
              <div className="field-grid">
                <label className="field">
                  <span>
                    Automatic backups to keep
                    <InfoHint label="About backup retention">
                      The newest automatic and pre-upgrade copies are kept; older ones are deleted. Manual backups you
                      created are never touched. Lowering this prunes the folder immediately.
                    </InfoHint>
                  </span>
                  <input
                    type="number"
                    min={3}
                    max={50}
                    value={settings.backups.retentionCount}
                    onChange={(event) =>
                      onUpdate({ backups: { retentionCount: Number(event.target.value) } })
                    }
                  />
                </label>
              </div>
              <div className="field-row">
                <button type="button" onClick={() => void runBackup()} disabled={dataBusy !== null}>
                  {dataBusy === 'backup' ? <SpinnerIcon /> : null}
                  <span>Back up now…</span>
                </button>
                <button type="button" onClick={() => void runRestore()} disabled={dataBusy !== null}>
                  {dataBusy === 'restore' ? <SpinnerIcon /> : null}
                  <span>Restore from backup…</span>
                </button>
                <button type="button" onClick={() => void runExport()} disabled={dataBusy !== null}>
                  {dataBusy === 'export' ? <SpinnerIcon /> : null}
                  <span>Export library as CSV.</span>
                </button>
                {paths ? (
                  <button type="button" onClick={() => onOpenPath(paths.backups)}>
                    Open backups folder
                  </button>
                ) : null}
              </div>
              {dataError ? (
                <div className="banner error" role="alert">
                  {dataError}
                </div>
              ) : null}
              {dataNote ? (
                <p className="data-note" role="status">
                  {dataNote}
                </p>
              ) : null}
            </article>

            <article className="card">
              <header className="card-header">
                <h2>
                  Library health
                  <InfoHint label="About library health">
                    Duplicate detection compares whole files, not tags, so only byte-identical copies are grouped.
                    Merging keeps the oldest entry, combines playlists and play counts, and deletes the redundant
                    file. Missing tracks keep their history until they are matched again.
                  </InfoHint>
                </h2>
              </header>
              <p className="card-hint">
                Find byte-identical duplicates, merge them, or reconnect files after a folder move.
              </p>
              <div className="field-row">
                <button
                  type="button"
                  onClick={() => void runFindDuplicates()}
                  disabled={careBusy !== null}
                >
                  {careBusy === 'duplicates' ? <SpinnerIcon /> : null}
                  <span>Find duplicates.</span>
                </button>
                <button
                  type="button"
                  onClick={() => void runMergeDuplicates()}
                  disabled={careBusy !== null || !duplicates || duplicates.groups === 0}
                >
                  {careBusy === 'merge' ? <SpinnerIcon /> : null}
                  <span>Merge duplicates.</span>
                </button>
                <button
                  type="button"
                  onClick={() => void runRelocate()}
                  disabled={careBusy !== null || missingTracks === 0}
                >
                  {careBusy === 'relocate' ? <SpinnerIcon /> : null}
                  <span>Find moved files.</span>
                </button>
              </div>
              <p className="data-note">
                {missingTracks === 0
                  ? 'No files are missing from the library.'
                  : `${missingTracks} missing track${missingTracks === 1 ? '' : 's'} kept with history and playlist entries.`}
              </p>
              {careError ? (
                <div className="banner error" role="alert">
                  {careError}
                </div>
              ) : null}
              {careNote ? (
                <p className="data-note" role="status">
                  {careNote}
                </p>
              ) : null}
            </article>

            </div>
          </div>

          <footer className="settings-footer">
            <div className="settings-footer-head">
              <h2>
                Reset preferences
                <InfoHint label="About resetting preferences">
                  Resets playback, appearance, click behaviour, import limits, saving quality and request budgets.
                  Library folders and the engine and download folders you chose are kept: forgetting a folder is not a
                  preference change. A preference reset is not a data reset.
                </InfoHint>
              </h2>
              <p className="card-hint">Puts preferences back to defaults; library folders and data stay.</p>
            </div>
            <div className="settings-section-resets">
              <span>Reset one section</span>
              <div className="field-row">
                {SECTION_RESET_CHOICES.map((choice) => (
                  <button
                    key={choice.id}
                    type="button"
                    onClick={() => {
                      onUpdate(SECTION_PREFERENCE_PATCHES[choice.id])
                      setConfirmReset(false)
                      setResetDone(true)
                    }}
                  >
                    Reset {choice.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="card-hint">The other sections and your folders stay as they are.</p>
              <div className="settings-reset">
                {confirmReset ? (
                  <div className="reset-confirm" role="alert">
                    <p>Reset these preferences now?</p>
                    <div className="field-row">
                      <button
                        type="button"
                        className="primary"
                        autoFocus
                        onClick={() => {
                          onUpdate(DEFAULT_PREFERENCE_PATCH)
                          setConfirmReset(false)
                          setResetDone(true)
                        }}
                      >
                        Reset preferences
                      </button>
                      <button type="button" onClick={closeReset}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="field-row">
                    <button
                      ref={resetButtonRef}
                      type="button"
                      onClick={() => {
                        setConfirmReset(true)
                        setResetDone(false)
                      }}
                    >
                      Reset preferences…
                    </button>
                    {resetDone ? <span role="status">Preferences reset.</span> : null}
                  </div>
                )}
            </div>
          </footer>
        </section>

        <section
          className="settings-panel"
          role="tabpanel"
          id="settings-panel-about"
          aria-labelledby="settings-tab-about"
          tabIndex={0}
          hidden={tab !== 'about'}
        >
          <div className="cards">
            <article className="card about-card">
              <header className="card-header">
                <h2>
                  About
                  <InfoHint label="About this build">
                    Unified search, channel pages, metadata cleanup and the five-tab Settings page are in, including the
                    bounded Appearance choices and a preference reset. Offline caching and the full Downloads screen
                    are deferred to M12. The roadmap in ROADMAP.md is the source of truth for what comes next.
                  </InfoHint>
                </h2>
                <span className="badge">M6 · settings</span>
              </header>
              <p className="card-hint">
                Local library, playlists, queue and YouTube playback. Streams can be saved with tags and cover.
              </p>
              <ul className="status-list">
                <li>
                  <span className="status-name">Player</span>
                  <span className="status-value">{runtimeInfo?.appVersion ?? 'loading…'}</span>
                </li>
                <li>
                  <span className="status-name">Electron</span>
                  <span className="status-value">{runtimeInfo?.electron ?? 'loading…'}</span>
                </li>
                <li>
                  <span className="status-name">Chromium</span>
                  <span className="status-value">{runtimeInfo?.chromium ?? 'loading…'}</span>
                </li>
                <li>
                  <span className="status-name">Node</span>
                  <span className="status-value">{runtimeInfo?.node ?? 'loading…'}</span>
                </li>
                <li className={engineStatus?.ytDlp.found ? 'ok' : ''}>
                  <span className="status-name">yt-dlp</span>
                  <span className="status-value">
                    {engineStatus ? (engineStatus.ytDlp.version ?? 'not found') : 'not checked'}
                  </span>
                </li>
                <li className={engineStatus?.ffmpeg.found ? 'ok' : ''}>
                  <span className="status-name">ffmpeg</span>
                  <span className="status-value">
                    {engineStatus ? (engineStatus.ffmpeg.version ?? 'not found') : 'not checked'}
                  </span>
                </li>
              </ul>
              <div className="field-row">
                <button type="button" onClick={() => void copyDiagnostics()} disabled={diagnosticsBusy}>
                  {diagnosticsBusy ? <SpinnerIcon /> : null}
                  <span>Copy diagnostics</span>
                </button>
                {paths ? (
                  <button type="button" onClick={() => onOpenPath(paths.logs)}>
                    Open logs
                  </button>
                ) : null}
              </div>
              {diagnosticsNote ? (
                <p className="card-hint" role="status">
                  {diagnosticsNote}
                </p>
              ) : null}
            </article>
          </div>
        </section>
      </div>
    </section>
  )
}
