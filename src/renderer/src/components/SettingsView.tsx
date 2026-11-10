import { useId, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ACCENT_CHOICES,
  DEFAULT_APPEARANCE,
  DENSITY_CHOICES,
  HERO_SLIDE_SECONDS_MAX,
  HERO_SLIDE_SECONDS_MIN,
  ICON_SET_CHOICES,
  LYRICS_ALIGN_CHOICES,
  MOTION_CHOICES,
  SURFACE_CHOICES,
  TEXT_SIZE_CHOICES,
  THEME_CHOICES
} from '@shared/appearance'
import { DEFAULT_PREFERENCE_PATCH, SECTION_PREFERENCE_PATCHES } from '@shared/settings-defaults'
import { formatBytes, formatCount, formatTimestamp } from '@shared/format'
import type {
  AccentName,
  AppPaths,
  AppSettings,
  ArtworkFit,
  ArtworkShape,
  ArtworkSize,
  CookieFallbackMode,
  CrashReportsStatus,
  DeepPartial,
  Density,
  DownloadFormat,
  DuplicateMergeOutcome,
  DuplicateReport,
  EngineStatus,
  ExecutableStatus,
  IconSet,
  LibraryClickAction,
  LyricsAlign,
  MotionPreference,
  PoTokenStatus,
  QualityTier,
  RelocateReport,
  ReplayGainStatus,
  RetentionMode,
  RuntimeInfo,
  SidecarProgress,
  StartupView,
  SurfaceStyle,
  TextSize,
  ThemeMode,
  UpdateStatus
} from '@shared/types'
import { COOKIE_BROWSERS, normalizePoTokenProviderUrl, usesAppBoundEncryption } from '@shared/youtube'
import { normalizeAcoustidKey } from '@shared/acoustid'
import { normalizeUpdateFeedUrl } from '@shared/update'
import { AudioSettingsPanel } from './AudioSettingsPanel'
import { DownloadIcon, FolderIcon, InfoIcon, RefreshIcon, SpinnerIcon, TrashIcon } from './Icons'

export interface SettingsViewProps {
  settings: AppSettings
  paths: AppPaths | null
  runtimeInfo: RuntimeInfo | null
  engineStatus: EngineStatus | null
  engineLoading: boolean
  sidecarProgress: SidecarProgress | null
  sidecarInstalling: boolean
  sidecarNote: string | null
  sidecarError: string | null
  onInstallSidecars: () => Promise<void>
  onCancelSidecarInstall: () => Promise<void>
  updateStatus: UpdateStatus | null
  onCheckForUpdates: () => Promise<void>
  onDownloadUpdate: () => Promise<void>
  onInstallUpdate: () => Promise<void>
  onRestoreYtDlp: () => Promise<void>
  scanning: boolean
  error: string | null
  onUpdate: (patch: DeepPartial<AppSettings>) => void
  replayGainStatus: ReplayGainStatus | null
  onScanReplayGain: () => Promise<void>
  onCancelReplayGain: () => void
  onOpenEqualizer: (event: ReactMouseEvent<HTMLButtonElement>) => void
  onAddFolder: () => void
  onRemoveFolder: (folder: string) => void
  onPickEngineDir: () => void
  onPickDownloadFolder: () => void
  onPickCookiesFile: () => void
  onRefreshEngine: () => void
  onStartPoToken: () => Promise<PoTokenStatus>
  onStopPoToken: () => Promise<PoTokenStatus>
  onOpenPath: (target: string) => void
  onCopyDiagnostics: () => Promise<void>
  onSaveDiagnostics: () => Promise<string | null>
  crashReports: CrashReportsStatus | null
  onRefreshCrashReports: () => Promise<CrashReportsStatus>
  onClearCrashReports: () => Promise<number>
  onExportCrashReports: () => Promise<string | null>
  onBackupData: () => Promise<string | null>
  onRestoreData: () => Promise<boolean>
  onExportLibrary: () => Promise<string | null>
  missingTracks: number
  onFindDuplicates: () => Promise<DuplicateReport>
  onMergeDuplicates: () => Promise<DuplicateMergeOutcome>
  onRelocateMissing: () => Promise<RelocateReport | null>
  /**
   * Opens on this tab instead of General. Used when another view sends the user
   * here for a specific control, such as the engine download on YouTube. Only
   * read on mount, so a later visit from the sidebar still starts at General.
   */
  initialTab?: SettingsTabId
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

export type SettingsTabId = (typeof TABS)[number]['id']
type TabId = SettingsTabId

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

function sourceLabel(source: 'configured' | 'managed' | 'path' | 'well-known' | null): string {
  if (source === 'configured') return 'configured folder'
  if (source === 'managed') return 'engine folder'
  if (source === 'path') return 'PATH'
  if (source === 'well-known') return 'known location'
  return 'unknown location'
}

function describeExecutable(status: ExecutableStatus): string {
  if (!status.found) return status.error ?? 'Not found.'
  return `${status.version ?? 'version unknown'} · via ${sourceLabel(status.source)}`
}

/** One sentence for the update state, so About never shows a bare code. */
function describeUpdateStatus(status: UpdateStatus | null): string {
  if (!status) return 'loading…'
  switch (status.state) {
    case 'disabled':
      return status.feedUrl ? 'Not available in this build' : 'Not configured'
    case 'idle':
      return `Ready · ${status.currentVersion}`
    case 'checking':
      return 'Checking…'
    case 'available':
      return `Available · ${status.availableVersion ?? 'newer version'}`
    case 'downloading':
      return `Downloading · ${status.percent ?? 0}%`
    case 'ready':
      return `Ready to install · ${status.availableVersion ?? 'newer version'}`
    case 'up-to-date':
      return `Up to date · ${status.currentVersion}`
    case 'error':
      return 'Check failed'
  }
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
    sidecarProgress,
    sidecarInstalling,
    sidecarNote,
    sidecarError,
    onInstallSidecars,
    onCancelSidecarInstall,
    updateStatus,
    onCheckForUpdates,
    onDownloadUpdate,
    onInstallUpdate,
    onRestoreYtDlp,
    scanning,
    error,
    onUpdate,
    replayGainStatus,
    onScanReplayGain,
    onCancelReplayGain,
    onOpenEqualizer,
    onAddFolder,
    onRemoveFolder,
    onPickEngineDir,
    onPickDownloadFolder,
    onPickCookiesFile,
    onRefreshEngine,
    onStartPoToken,
    onStopPoToken,
    onOpenPath,
    onCopyDiagnostics,
    onSaveDiagnostics,
    crashReports,
    onRefreshCrashReports,
    onClearCrashReports,
    onExportCrashReports,
    onBackupData,
    onRestoreData,
    onExportLibrary,
    missingTracks,
    onFindDuplicates,
    onMergeDuplicates,
    onRelocateMissing,
    initialTab
  } = props
  const [tab, setTab] = useState<TabId>(initialTab ?? 'general')
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
  const [diagnosticsBusy, setDiagnosticsBusy] = useState<'copy' | 'save' | null>(null)
  const [diagnosticsNote, setDiagnosticsNote] = useState<string | null>(null)
  const [crashBusy, setCrashBusy] = useState<'clear' | 'export' | null>(null)
  const [crashNote, setCrashNote] = useState<string | null>(null)
  const [crashError, setCrashError] = useState<string | null>(null)
  const [confirmClearCrashes, setConfirmClearCrashes] = useState(false)

  // The count changes outside this panel (a renderer crash, or clearing from
  // another run), so read the folder again when Settings opens.
  useEffect(() => {
    void onRefreshCrashReports().catch(() => undefined)
  }, [onRefreshCrashReports])

  const runExportCrashReports = async (): Promise<void> => {
    setCrashBusy('export')
    setCrashError(null)
    setCrashNote(null)
    try {
      const file = await onExportCrashReports()
      setCrashNote(file ? `Crash reports saved to ${file}` : 'No crash reports to save.')
    } catch (cause) {
      setCrashError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCrashBusy(null)
    }
  }

  const runClearCrashReports = async (): Promise<void> => {
    setCrashBusy('clear')
    setCrashError(null)
    setCrashNote(null)
    try {
      const removed = await onClearCrashReports()
      setConfirmClearCrashes(false)
      setCrashNote(
        removed > 0
          ? `Cleared ${removed} crash report${removed === 1 ? '' : 's'}.`
          : 'There were no crash reports to clear.'
      )
    } catch (cause) {
      setCrashError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCrashBusy(null)
    }
  }

  const [updateFeedDraft, setUpdateFeedDraft] = useState(settings.update.feedUrl ?? '')
  useEffect(() => {
    setUpdateFeedDraft(settings.update.feedUrl ?? '')
  }, [settings.update.feedUrl])
  const updateFeedDraftValid =
    updateFeedDraft.trim().length === 0 || normalizeUpdateFeedUrl(updateFeedDraft.trim()) !== null
  const commitUpdateFeed = (): void => {
    const trimmed = updateFeedDraft.trim()
    if (!updateFeedDraftValid || trimmed === (settings.update.feedUrl ?? '')) return
    onUpdate({ update: { feedUrl: trimmed.length > 0 ? trimmed : null } })
  }
  const [acoustidKeyDraft, setAcoustidKeyDraft] = useState(settings.metadata.acoustidKey ?? '')
  useEffect(() => {
    setAcoustidKeyDraft(settings.metadata.acoustidKey ?? '')
  }, [settings.metadata.acoustidKey])
  const acoustidKeyValid =
    acoustidKeyDraft.trim().length === 0 || normalizeAcoustidKey(acoustidKeyDraft) !== null
  const commitAcoustidKey = (): void => {
    if (!acoustidKeyValid) return
    const key = normalizeAcoustidKey(acoustidKeyDraft)
    if (key === settings.metadata.acoustidKey) return
    onUpdate({ metadata: { acoustidKey: key } })
  }
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const resetButtonRef = useRef<HTMLButtonElement | null>(null)
  const sidecars = engineStatus?.sidecars ?? []
  const fpcalcState = sidecars.find((sidecar) => sidecar.id === 'fpcalc') ?? null
  const missingSidecars = sidecars.filter((sidecar) => !sidecar.installed)
  const requiredSidecars = sidecars.filter((sidecar) => !sidecar.optional)
  const requiredMissing = requiredSidecars.filter((sidecar) => !sidecar.installed)
  const requiredUnavailable = requiredSidecars.filter((sidecar) => !sidecar.available)
  const requiredMissingBytes = requiredMissing.reduce((sum, sidecar) => sum + sidecar.bytes, 0)
  const requiredUnavailableBytes = requiredUnavailable.reduce((sum, sidecar) => sum + sidecar.bytes, 0)
  const optionalMissing = sidecars.filter((sidecar) => sidecar.optional && !sidecar.available).length
  const playbackReady = engineStatus?.ready === true

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
        setProviderNote('The command started; the provider is still loading and will be used as soon as it answers.')
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
    setDiagnosticsBusy('copy')
    setDiagnosticsNote(null)
    try {
      await onCopyDiagnostics()
      setDiagnosticsNote('Diagnostics copied to the clipboard.')
    } catch (cause) {
      setDiagnosticsNote(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDiagnosticsBusy(null)
    }
  }

  const saveDiagnostics = async (): Promise<void> => {
    setDiagnosticsBusy('save')
    setDiagnosticsNote(null)
    try {
      const file = await onSaveDiagnostics()
      setDiagnosticsNote(file ? `Diagnostics saved to ${file}` : 'Save cancelled.')
    } catch (cause) {
      setDiagnosticsNote(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDiagnosticsBusy(null)
    }
  }

  const runRestore = async (): Promise<void> => {
    setDataBusy('restore')
    setDataError(null)
    setDataNote(null)
    try {
      const staged = await onRestoreData()
      setDataNote(staged ? 'Restoring - Suura will restart.' : 'Restore cancelled.')
    } catch (cause) {
      setDataError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDataBusy(null)
    }
  }

  return (
    <main className="main-view settings-view">
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
                      Rescans files that change. Turn it off for network or removable drives.
                    </InfoHint>
                  </span>
                </label>
              </div>
            </article>

            <article className="card">
              <header className="card-header">
                <h2>
                  Startup, window &amp; resume
                </h2>
              </header>
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
                      Only new or changed files are read.
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
                      Starts the last queue where it stopped; off restores it paused.
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
                      Hides the window; the tray icon brings it back.
                    </InfoHint>
                  </span>
                </label>
                <label className="field checkbox">
                  <input
                    type="checkbox"
                    checked={settings.startup.startOnLogin}
                    onChange={(event) => onUpdate({ startup: { startOnLogin: event.target.checked } })}
                  />
                  <span>
                    Start Suura when I sign in
                    <InfoHint label="About starting when I sign in">
                      Adds Suura to your desktop's sign-in items. Playback still follows the resume setting.
                    </InfoHint>
                  </span>
                </label>
              </div>
            </article>

            <article className="card">
              <header className="card-header">
                <h2>Mouse behaviour</h2>
              </header>
              <p className="card-hint">
                What one click does in a list, and how far one wheel notch moves the volume. A double
                click always receives two single clicks first; Shift always moves one volume percent.
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
              onOpenEqualizer={onOpenEqualizer}
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
                      Midnight is dark; Cream is light.
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
                      How much space each row uses.
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
                      Solid is flat; Accented adds an accent-tinted blur.
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
                      Skip most motion, or animate always.
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

              <article className="card">
                <header className="card-header">
                  <h2>
                    Home hero
                    <InfoHint label="About the Home hero">
                      How long each cover stays before the next one.
                    </InfoHint>
                  </h2>
                </header>
                <label className="field">
                  <span>
                    Seconds per cover <output>{settings.visuals.heroSlideSeconds}s</output>
                  </span>
                  <input
                    type="range"
                    min={HERO_SLIDE_SECONDS_MIN}
                    max={HERO_SLIDE_SECONDS_MAX}
                    step={1}
                    value={settings.visuals.heroSlideSeconds}
                    aria-label="Seconds per Home hero cover"
                    data-hero-slide-slider
                    onChange={(event) =>
                      onUpdate({ visuals: { heroSlideSeconds: Number(event.target.value) } })
                    }
                  />
                </label>
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
                      Text size scales everything; icons change the sidebar.
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
                <div className="field">
                  <span>Lyric alignment</span>
                  <div className="segmented" role="group" aria-label="Lyric alignment">
                    {LYRICS_ALIGN_CHOICES.map((choice) => (
                      <button
                        key={choice.value}
                        type="button"
                        className={settings.visuals.lyricsAlign === choice.value ? 'active' : undefined}
                        data-lyrics-align-choice={choice.value}
                        aria-pressed={settings.visuals.lyricsAlign === choice.value}
                        title={choice.hint}
                        onClick={() => onUpdate({ visuals: { lyricsAlign: choice.value as LyricsAlign } })}
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
                      Shape and fit apply everywhere; ambience tints from the cover.
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
                  <h2>List columns</h2>
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
                  </h2>
                  <button type="button" onClick={onRefreshEngine} disabled={engineLoading}>
                    {engineLoading ? <SpinnerIcon /> : <RefreshIcon />}
                    <span>Check</span>
                  </button>
                </header>
                <p className="card-hint">
                  Checks the binaries playback and saving need. Suura downloads them on first use rather than
                  bundling them, and verifies each pinned SHA-256 before a file is installed.
                </p>

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

                <div className="field-row engine-download">
                  <button
                    type="button"
                    onClick={() => void onInstallSidecars()}
                    disabled={sidecarInstalling}
                  >
                    {sidecarInstalling ? <SpinnerIcon /> : <DownloadIcon />}
                    <span>
                      {sidecarInstalling
                        ? 'Downloading engine'
                        : requiredUnavailable.length > 0
                          ? `Download engine (${formatBytes(requiredUnavailableBytes)})`
                          : requiredMissing.length > 0
                            ? `Download pinned engine (${formatBytes(requiredMissingBytes)})`
                            : 'Re-download engine'}
                    </span>
                  </button>
                  {sidecarInstalling ? (
                    <button type="button" onClick={() => void onCancelSidecarInstall()}>
                      Cancel
                    </button>
                  ) : null}
                </div>

                {sidecarProgress ? (
                  <div className="engine-progress" role="status">
                    <progress
                      value={sidecarProgress.receivedBytes}
                      max={Math.max(1, sidecarProgress.totalBytes)}
                    />
                    <span>
                      {sidecarProgress.id}: {formatBytes(sidecarProgress.receivedBytes)} of{' '}
                      {formatBytes(sidecarProgress.totalBytes)}
                    </span>
                  </div>
                ) : null}

                {sidecars.length > 0 ? (
                  <p className="card-hint">
                    {playbackReady
                      ? requiredMissing.length === 0
                        ? `Playback is ready. ${formatCount(
                            sidecars.length - missingSidecars.length
                          )} of ${formatCount(sidecars.length)} pinned engine files are current in ${
                            paths?.engine ?? 'the engine folder'
                          }.`
                        : `Playback is ready using copies found outside the engine folder. ${formatCount(
                            requiredMissing.length
                          )} pinned engine ${requiredMissing.length === 1 ? 'file is' : 'files are'} not downloaded.`
                      : `${formatCount(requiredUnavailable.length)} of ${formatCount(
                          requiredSidecars.length
                        )} required engine files ${requiredUnavailable.length === 1 ? 'is' : 'are'} missing.`}
                    {optionalMissing > 0
                      ? ' Fingerprinting (fpcalc) is not installed.'
                      : ''}
                  </p>
                ) : null}
                {sidecarNote ? <p className="card-hint">{sidecarNote}</p> : null}
                {sidecarError ? <p className="card-hint status-error">{sidecarError}</p> : null}

                <div className="field-grid">
                  <label className="field wide">
                    <span>
                      Engine folder (optional)
                      <InfoHint label="About the engine folder">
                        Folder holding yt-dlp and ffmpeg. Empty searches PATH.
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
                        Checks daily and keeps the previous binary, in case the new one breaks.
                      </InfoHint>
                    </span>
                  </label>
                </div>

                <div className="field-grid">
                  <div className="field wide">
                    <span>
                      Previous yt-dlp
                      <InfoHint label="About the last-known-good binary">
                        The yt-dlp that worked before the last update. Restoring it is safe.
                      </InfoHint>
                    </span>
                    <div className="field-row">
                      <span className="status-value">
                        {engineStatus?.rollback?.available
                          ? `Saved ${formatTimestamp(engineStatus.rollback.savedAt)}${
                              engineStatus.rollback.version ? ` · ${engineStatus.rollback.version}` : ''
                            }`
                          : engineStatus?.rollback?.lastRestoredAt
                            ? `Restored ${formatTimestamp(engineStatus.rollback.lastRestoredAt)}; no fallback is saved now.`
                            : 'No previous binary saved yet.'}
                      </span>
                      <button
                        type="button"
                        onClick={() => void onRestoreYtDlp()}
                        disabled={!engineStatus?.rollback?.available || sidecarInstalling}
                      >
                        Restore previous
                      </button>
                    </div>
                  </div>
                </div>
              </article>

              <article className="card">
                <header className="card-header">
                  <h2>PO Token provider</h2>
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
                        Short-lived proofs sent with a YouTube request.
                      </InfoHint>
                    </span>
                  </label>
                  <label className="field">
                    <span>
                      Provider URL
                      <InfoHint label="About the provider URL">
                        Where the bgutil plugin calls. Keep it on this PC.
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
                        Command the app can start and stop. Leave it blank to run the server yourself.
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
                          ? 'Add a provider command first.'
                          : undefined
                      }
                      onChange={(event) => onUpdate({ engine: { poTokenAutoStart: event.target.checked } })}
                    />
                    <span>
                      Start the provider automatically
                      <InfoHint label="About automatic provider start">
                        Starts the command above, stops only that process, and waits for a slow start.
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
                          ? 'Add a provider command, or run the server yourself.'
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
                    <li
                      className={
                        engineStatus.poToken.serverReachable
                          ? 'ok'
                          : engineStatus.poToken.managedRunning
                            ? ''
                            : 'bad'
                      }
                    >
                      <span className="status-name">Server</span>
                      <span className="status-value" title={engineStatus.poToken.providerUrl}>
                        {engineStatus.poToken.serverReachable
                          ? `reachable at ${engineStatus.poToken.providerUrl.replace(/^https?:\/\//, '')}${engineStatus.poToken.serverVersion ? `, v${engineStatus.poToken.serverVersion}` : ''}`
                          : engineStatus.poToken.managedRunning
                            ? `starting at ${engineStatus.poToken.providerUrl.replace(/^https?:\/\//, '')}`
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
                  <h2>Cookie fallback</h2>
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
                        Reads YouTube cookies from this browser. The app never signs in.
                      </InfoHint>
                    </span>
                    <select
                      value={settings.engine.cookiesFromBrowser ?? ''}
                      disabled={
                        settings.engine.cookieFallback === 'off' || Boolean(settings.engine.cookiesFile)
                      }
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
                        Profile name or path. Blank uses the default profile.
                      </InfoHint>
                    </span>
                    <input
                      type="text"
                      value={settings.engine.cookieBrowserProfile ?? ''}
                      disabled={
                        settings.engine.cookieFallback === 'off' || Boolean(settings.engine.cookiesFile)
                      }
                      placeholder="Default profile"
                      onChange={(event) =>
                        onUpdate({ engine: { cookieBrowserProfile: event.target.value || null } })
                      }
                    />
                  </label>
                  <label className="field wide">
                    <span>
                      Cookies file (optional)
                      <InfoHint label="About a cookies file">
                        An exported Netscape cookies.txt. Takes priority over the browser.
                      </InfoHint>
                    </span>
                    <div className="field-row">
                      <input
                        type="text"
                        readOnly
                        value={settings.engine.cookiesFile ?? '(none)'}
                      />
                      <button type="button" onClick={onPickCookiesFile}>
                        Choose
                      </button>
                      {settings.engine.cookiesFile ? (
                        <button
                          type="button"
                          onClick={() => onUpdate({ engine: { cookiesFile: null } })}
                        >
                          Clear
                        </button>
                      ) : null}
                    </div>
                  </label>
                </div>
                {settings.engine.cookieFallback !== 'off' &&
                !settings.engine.cookiesFromBrowser &&
                !settings.engine.cookiesFile ? (
                  <p className="card-hint status-error">
                    Choose a browser or a cookies file, or the fallback will be skipped.
                  </p>
                ) : null}
                {settings.engine.cookieFallback !== 'off' &&
                !settings.engine.cookiesFile &&
                usesAppBoundEncryption(settings.engine.cookiesFromBrowser) ? (
                  <p className="card-hint">
                    Chrome and Edge cookies cannot be decrypted on Windows. Choose Firefox, or leave the
                    fallback off and use a PO Token provider.
                  </p>
                ) : null}
                <p className="card-hint">The app never signs in; account playlists are unsupported.</p>
              </article>

              <article className="card">
                <header className="card-header">
                  <h2>Playback &amp; imports</h2>
                </header>
                <p className="card-hint">Caps keep a large playlist from becoming a large queue.</p>
                <div className="field-grid">
                  <label className="field">
                    <span>
                      Concurrent downloads
                      <InfoHint label="About concurrent downloads">
                        How many saves may download at once.
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
                        Tracks kept per imported playlist or album.
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
                        Tracks kept from a mix.
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
                        Resolves the next track early, at one extra request.
                      </InfoHint>
                    </span>
                  </label>
                </div>
              </article>

              <article className="card">
                <header className="card-header">
                  <h2>How streams are kept</h2>
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
                            Least recently used copies are deleted past this size. Pinned copies stay.
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
                            Unplayed copies older than this are deleted. Pinned copies stay.
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
                  <h2>Saving to your library</h2>
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
                        value={settings.retention.downloadFolder ?? '(default: Music\\Suura)'}
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
                  <h2>Storage &amp; diagnostics</h2>
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
                        ['Backups', paths.backups],
                        ['Crash reports', paths.crashes]
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

                <article className="card">
                  <header className="card-header">
                    <h2>Crash reports</h2>
                  </header>
                  <p className="card-hint">
                    Off by default. When on, Suura saves a small report if the app or its renderer crashes, so you
                    can review it or share it yourself.
                  </p>
                  <label className="field checkbox">
                    <input
                      type="checkbox"
                      checked={settings.diagnostics.crashReports}
                      onChange={(event) =>
                        onUpdate({ diagnostics: { crashReports: event.target.checked } })
                      }
                    />
                    <span>
                      Keep crash reports on this PC
                      <InfoHint label="About the crash-report switch">
                        Off stops new reports. Existing files stay until you clear them.
                      </InfoHint>
                    </span>
                  </label>
                  {crashReports ? (
                    <ul className="status-list">
                      <li>
                        <span className="status-name">Saved reports</span>
                        <span className="status-value">
                          {crashReports.count === 0
                            ? 'None'
                            : `${formatCount(crashReports.count)} · ${formatBytes(crashReports.bytes)}`}
                        </span>
                      </li>
                      <li>
                        <span className="status-name">Latest</span>
                        <span className="status-value">
                          {crashReports.latestAt ? formatTimestamp(crashReports.latestAt) : 'Never'}
                        </span>
                      </li>
                      <li>
                        <span className="status-name">Folder</span>
                        <span className="status-value" title={crashReports.folder}>
                          {crashReports.folder}
                        </span>
                      </li>
                    </ul>
                  ) : (
                    <p className="card-hint">Checking this PC…</p>
                  )}
                  <div className="field-row">
                    <button
                      type="button"
                      onClick={() => void runExportCrashReports()}
                      disabled={crashBusy !== null || (crashReports?.count ?? 0) === 0}
                    >
                      {crashBusy === 'export' ? <SpinnerIcon /> : null}
                      <span>Save reports...</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmClearCrashes(true)}
                      disabled={crashBusy !== null || (crashReports?.count ?? 0) === 0}
                    >
                      {crashBusy === 'clear' ? <SpinnerIcon /> : null}
                      <span>Clear reports...</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenPath(crashReports?.folder ?? paths?.crashes ?? '')}
                      disabled={!crashReports && !paths}
                    >
                      Open folder
                    </button>
                  </div>
                  {confirmClearCrashes ? (
                    <div className="reset-confirm" role="alert">
                      <p>Delete every saved crash report? This cannot be undone.</p>
                      <div className="field-row">
                        <button
                          type="button"
                          className="primary"
                          autoFocus
                          onClick={() => void runClearCrashReports()}
                          disabled={crashBusy !== null}
                        >
                          Delete reports
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmClearCrashes(false)}
                          disabled={crashBusy !== null}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}
                  {crashError ? (
                    <div className="banner error" role="alert">
                      {crashError}
                    </div>
                  ) : null}
                  {crashNote ? (
                    <p className="card-hint" role="status">
                      {crashNote}
                    </p>
                  ) : null}
              </article>
            </div>

            <div className="cards-col">
              <article className="card">
                <header className="card-header">
                  <h2>Backup &amp; restore</h2>
                </header>
                <p className="card-hint">Automatic copies at startup and before upgrades; export a CSV for spreadsheets.</p>
                <div className="field-grid">
                  <label className="field">
                    <span>
                      Automatic backups to keep
                      <InfoHint label="About backup retention">
                        Keeps the newest copies; manual backups are never touched. Lowering prunes now.
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
                  <h2>Library health</h2>
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

              <article className="card">
                <header className="card-header">
                  <h2>Fingerprint lookup</h2>
                </header>
                <p className="card-hint">
                  AcoustID matches a Chromaprint fingerprint to a MusicBrainz recording. It needs
                  fpcalc and your own AcoustID application key; the text search works without either.
                </p>
                <div className="field-grid">
                  <label className="field wide">
                    <span>
                      AcoustID key
                      <InfoHint label="About the AcoustID key">
                        Create a free application key at acoustid.org and paste it here.
                      </InfoHint>
                    </span>
                    <input
                      type="text"
                      value={acoustidKeyDraft}
                      placeholder="Your AcoustID application key"
                      aria-invalid={!acoustidKeyValid}
                      onChange={(event) => setAcoustidKeyDraft(event.target.value)}
                      onBlur={commitAcoustidKey}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return
                        event.preventDefault()
                        commitAcoustidKey()
                      }}
                    />
                  </label>
                </div>
                {!acoustidKeyValid ? (
                  <p className="card-hint status-error">
                    A key is 8 to 64 letters and digits. Clear the field to turn fingerprint matching
                    off.
                  </p>
                ) : null}

                <ul className="status-list">
                  <li className={fpcalcState?.available ? 'ok' : ''}>
                    <span className="status-name">fpcalc</span>
                    <span className="status-value">
                      {fpcalcState
                        ? fpcalcState.installed
                          ? `${fpcalcState.version} installed`
                          : fpcalcState.available
                            ? `found via ${sourceLabel(fpcalcState.source)}`
                            : 'not installed'
                        : 'not checked'}
                    </span>
                  </li>
                </ul>
                {fpcalcState && !fpcalcState.installed ? (
                  <div className="field-row">
                    <button type="button" onClick={() => void onInstallSidecars()} disabled={sidecarInstalling}>
                      {sidecarInstalling ? <SpinnerIcon /> : <DownloadIcon />}
                      <span>Download pinned engine</span>
                    </button>
                    <span className="card-hint">
                      {fpcalcState.available
                        ? 'The copy above works; this also puts a pinned copy in the engine folder.'
                        : 'fpcalc is optional: streaming works without it.'}
                    </span>
                  </div>
                ) : null}
              </article>

            </div>
          </div>

          <footer className="settings-footer">
            <div className="settings-footer-head">
              <h2>Reset preferences</h2>
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
                <h2>About</h2>
                <span className="badge">M8 · release</span>
              </header>
              <p className="card-hint">
                Local library, playlists, queue and YouTube playback. Streams can be saved with tags and cover.
              </p>
              <ul className="status-list">
                <li>
                  <span className="status-name">Suura</span>
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

              <div className="about-updates">
                <h3>Updates</h3>
                <ul className="status-list">
                  <li
                    className={
                      updateStatus?.state === 'error'
                        ? 'bad'
                        : updateStatus?.canInstall || updateStatus?.state === 'up-to-date'
                          ? 'ok'
                          : ''
                    }
                  >
                    <span className="status-name">Channel</span>
                    <span className="status-value">{describeUpdateStatus(updateStatus)}</span>
                  </li>
                  <li>
                    <span className="status-name">Last checked</span>
                    <span className="status-value">
                      {formatTimestamp(updateStatus?.lastCheckAt ?? settings.update.lastCheckAt)}
                    </span>
                  </li>
                </ul>
                {updateStatus?.message ? (
                  <p className="card-hint" role="status">
                    {updateStatus.message}
                  </p>
                ) : null}
                {updateStatus?.state === 'downloading' && updateStatus.percent !== null ? (
                  <div className="engine-progress" role="status">
                    <progress value={updateStatus.percent} max={100} />
                    <span>{updateStatus.percent}%</span>
                  </div>
                ) : null}

                <div className="field-grid">
                  <label className="field">
                    <span>
                      Channel
                      <InfoHint label="About update channels">
                        Stable reads the latest channel file. Beta may receive a release before it is promoted.
                      </InfoHint>
                    </span>
                    <select
                      value={settings.update.channel}
                      onChange={(event) =>
                        onUpdate({
                          update: { channel: event.target.value === 'beta' ? 'beta' : 'stable' }
                        })
                      }
                    >
                      <option value="stable">Stable</option>
                      <option value="beta">Beta (may be ahead)</option>
                    </select>
                  </label>
                  <label className="field wide">
                    <span>
                      Feed folder
                      <InfoHint label="About the update feed">
                        A static HTTPS folder holding the channel file and the build it names.
                      </InfoHint>
                    </span>
                    <input
                      type="url"
                      value={updateFeedDraft}
                      placeholder="https://updates.example.com/suura"
                      aria-invalid={!updateFeedDraftValid}
                      onChange={(event) => setUpdateFeedDraft(event.target.value)}
                      onBlur={commitUpdateFeed}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return
                        event.preventDefault()
                        commitUpdateFeed()
                      }}
                    />
                  </label>
                </div>
                {!updateFeedDraftValid ? (
                  <p className="card-hint status-error">
                    Enter an https:// folder URL. HTTP is accepted only for localhost.
                  </p>
                ) : null}

                <label className="field checkbox">
                  <input
                    type="checkbox"
                    checked={settings.update.autoCheck}
                    onChange={(event) => onUpdate({ update: { autoCheck: event.target.checked } })}
                  />
                  <span>
                    Check once a day in the background
                    <InfoHint label="About automatic update checks">
                      Installed builds only. A found update still waits for your go-ahead.
                    </InfoHint>
                  </span>
                </label>

                <p className="card-hint">
                  Nothing is downloaded until you press Check now. The feed is a static folder serving{' '}
                  {settings.update.channel === 'beta' ? 'beta.yml' : 'latest.yml'} on Windows (add <code>-linux</code> on
                  Linux) and the release it names.
                </p>

                <div className="field-row">
                  <button
                    type="button"
                    onClick={() => void onCheckForUpdates()}
                    disabled={
                      !updateStatus?.supported ||
                      !updateStatus?.feedUrl ||
                      updateStatus?.state === 'checking' ||
                      updateStatus?.state === 'downloading' ||
                      updateStatus?.state === 'ready'
                    }
                  >
                    {updateStatus?.state === 'checking' ? <SpinnerIcon /> : <RefreshIcon />}
                    <span>Check now</span>
                  </button>
                  {updateStatus?.state === 'available' ? (
                    <button type="button" onClick={() => void onDownloadUpdate()}>
                      <DownloadIcon />
                      <span>Download update</span>
                    </button>
                  ) : null}
                  {updateStatus?.canInstall ? (
                    <button type="button" onClick={() => void onInstallUpdate()}>
                      <DownloadIcon />
                      <span>Restart and install</span>
                    </button>
                  ) : null}
                </div>
              </div>

              <p className="card-hint">
                Save diagnostics writes this snapshot and the recent log to a text file you choose. Review it before
                sharing: log lines can contain local file paths.
              </p>
              <div className="field-row">
                <button
                  type="button"
                  onClick={() => void copyDiagnostics()}
                  disabled={diagnosticsBusy !== null}
                >
                  {diagnosticsBusy === 'copy' ? <SpinnerIcon /> : null}
                  <span>Copy diagnostics</span>
                </button>
                <button
                  type="button"
                  onClick={() => void saveDiagnostics()}
                  disabled={diagnosticsBusy !== null}
                >
                  {diagnosticsBusy === 'save' ? <SpinnerIcon /> : null}
                  <span>Save diagnostics...</span>
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

              <p className="card-hint">
                Suura collects nothing: no account, no analytics and no telemetry. Crash reports stay on this PC and
                are off until you turn them on. The{' '}
                <a
                  href="https://suura-player.pages.dev/privacy"
                  target="_blank"
                  rel="noreferrer"
                >
                  privacy statement
                </a>{' '}
                lists every request the app can make, and the only one it sends on its own is the update check above.
              </p>
              <p className="card-hint">
                YouTube links play through yt-dlp and are subject to YouTube's Terms of Service. Suura is not
                affiliated with YouTube: a link plays in the app, and nothing is downloaded unless you save it.
              </p>

              <details className="about-licences">
                <summary>Open-source licences</summary>
                <p className="card-hint">
                  Suura is MIT-licensed. It runs on Electron and Chromium (MIT and BSD-3-Clause), React, React DOM,
                  music-metadata and node-id3 (MIT), and the Inter typeface (SIL OFL 1.1). yt-dlp (Unlicense), ffmpeg
                  (GPL-3.0) and fpcalc (LGPL-2.1) are downloaded separately, only when you ask for them, and run as
                  their own programs. The full notices ship with the source as <code>THIRD-PARTY.md</code>.
                </p>
              </details>
            </article>
          </div>
        </section>
      </div>
    </main>
  )
}
