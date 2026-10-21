import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import {
  ACCENT_CHOICES,
  DEFAULT_APPEARANCE,
  DENSITY_CHOICES,
  MOTION_CHOICES,
  SURFACE_CHOICES,
  THEME_CHOICES
} from '@shared/appearance'
import { DEFAULT_PREFERENCE_PATCH } from '@shared/settings-defaults'
import type {
  AccentName,
  AppPaths,
  AppSettings,
  ArtworkFit,
  ArtworkShape,
  ArtworkSize,
  DeepPartial,
  Density,
  DownloadFormat,
  DuplicateMergeOutcome,
  DuplicateReport,
  EngineStatus,
  ExecutableStatus,
  LibraryClickAction,
  MotionPreference,
  QualityTier,
  RelocateReport,
  SurfaceStyle,
  ThemeMode
} from '@shared/types'
import { COOKIE_BROWSERS } from '@shared/youtube'
import { FolderIcon, InfoIcon, RefreshIcon, SpinnerIcon, TrashIcon } from './Icons'

export interface SettingsViewProps {
  settings: AppSettings
  paths: AppPaths | null
  engineStatus: EngineStatus | null
  engineLoading: boolean
  scanning: boolean
  error: string | null
  onUpdate: (patch: DeepPartial<AppSettings>) => void
  onAddFolder: () => void
  onRemoveFolder: (folder: string) => void
  onPickEngineDir: () => void
  onPickDownloadFolder: () => void
  onRefreshEngine: () => void
  onOpenPath: (target: string) => void
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

const FORMAT_CHOICES: Array<{ value: DownloadFormat; label: string }> = [
  { value: 'opus', label: 'Opus (no re-encode)' },
  { value: 'mp3', label: 'MP3 320 (compatibility)' },
  { value: 'm4a', label: 'M4A / AAC (Apple devices)' }
]

const COOKIE_CHOICES: Array<{ value: string; label: string }> = [
  { value: '', label: 'Off (recommended)' },
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

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'behaviour', label: 'Behaviour' },
  { id: 'streaming', label: 'Streaming' },
  { id: 'misc', label: 'Misc' },
  { id: 'about', label: 'About' }
] as const

type TabId = (typeof TABS)[number]['id']

/**
 * A compact explanation that stays out of the way until it is needed.
 *
 * The trigger is focusable as well as hoverable, so the text is reachable
 * without a mouse. `aria-describedby` ties the visible bubble to the icon
 * instead of leaving it as decoration.
 */
function InfoHint(props: { label: string; children: ReactNode }) {
  const id = useId()
  return (
    <span className="info-hint">
      <span
        className="info-hint-trigger"
        tabIndex={0}
        role="img"
        aria-label={props.label}
        aria-describedby={id}
      >
        <InfoIcon size={13} />
      </span>
      <span id={id} className="info-hint-bubble" role="tooltip">
        {props.children}
      </span>
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
    engineStatus,
    engineLoading,
    scanning,
    error,
    onUpdate,
    onAddFolder,
    onRemoveFolder,
    onPickEngineDir,
    onPickDownloadFolder,
    onRefreshEngine,
    onOpenPath,
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
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const resetButtonRef = useRef<HTMLButtonElement | null>(null)

  // A tab strip is one tab stop, not six. Arrow keys move between tabs, Home and
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
                  <span>Watch the folders and rescan when files change</span>
                </label>
              </div>
              <p className="card-hint">
                Watching is what makes an album you copy in show up without pressing Rescan: a change starts a scan, and
                a scan only opens files whose size or timestamp moved, so it stays cheap in a large library. Turn it off
                for a library on a network or removable drive, where watching can cost more than the occasional manual
                scan.
              </p>
            </article>
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
                      slow spinner. Full always animates. The bars below preview the difference.
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
                <div className="motion-preview" aria-hidden="true">
                  <span className="motion-preview-label">Preview</span>
                  <span className="motion-preview-bars">
                    <span />
                    <span />
                    <span />
                  </span>
                </div>
              </article>
            </div>

            <div className="cards-col">
              <article className="card">
                <header className="card-header">
                  <h2>
                    Cover art
                    <InfoHint label="About cover art">
                      Shape and fit apply to library rows, the player bar and the full-window player. A circle is always
                      cropped. Size applies only to the full-window player; ambience takes its colour from the current
                      cover.
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
            </div>
          </div>

          <div className="appearance-reset">
            <div>
              <strong>Reset appearance</strong>
              <p>Puts the theme, accent, density, surface, motion and cover-art choices back to their defaults.</p>
            </div>
            <button type="button" onClick={() => onUpdate(DEFAULT_APPEARANCE)}>
              Reset appearance
            </button>
          </div>
        </section>

        <section
          className="settings-panel"
          role="tabpanel"
          id="settings-panel-behaviour"
          aria-labelledby="settings-tab-behaviour"
          tabIndex={0}
          hidden={tab !== 'behaviour'}
        >
          <div className="cards">
            <article className="card">
              <header className="card-header">
                <h2>Click behaviour</h2>
              </header>
              <p className="card-hint">
                What a click on a track in the library does. Two conventions are in wide use — select on click, or play
                on click — and whichever one you are used to, the other feels broken. A double click always arrives as
                two single clicks first, so choosing &quot;play&quot; for both starts the track on the first click and
                does not restart it on the second.
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
                    YouTube engine <span className="badge">used from M3</span>
                  </h2>
                  <button type="button" onClick={onRefreshEngine} disabled={engineLoading}>
                    {engineLoading ? <SpinnerIcon /> : <RefreshIcon />}
                    <span>Check</span>
                  </button>
                </header>
                <p className="card-hint">
                  The app shells out to yt-dlp for YouTube audio and ffmpeg for transcoding, tagging and covers.
                  Playback, importing lists and saving tracks all need these two binaries; this reports whether they are
                  ready.
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

                <div className="field-grid">
                  <label className="field wide">
                    <span>Engine folder (optional)</span>
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
                  <label className="field">
                    <span>Concurrent downloads</span>
                    <input
                      type="number"
                      min={1}
                      max={8}
                      value={settings.engine.downloadConcurrency}
                      onChange={(event) => onUpdate({ engine: { downloadConcurrency: Number(event.target.value) } })}
                    />
                  </label>
                  <label className="field">
                    <span>Playlist / album import limit</span>
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      value={settings.engine.importLimit}
                      onChange={(event) => onUpdate({ engine: { importLimit: Number(event.target.value) } })}
                    />
                  </label>
                  <label className="field">
                    <span>Mix length</span>
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
                      checked={settings.engine.autoUpdate}
                      onChange={(event) => onUpdate({ engine: { autoUpdate: event.target.checked } })}
                    />
                    <span>Keep yt-dlp up to date automatically</span>
                  </label>
                  <label className="field checkbox">
                    <input
                      type="checkbox"
                      checked={settings.engine.prefetchNext}
                      onChange={(event) => onUpdate({ engine: { prefetchNext: event.target.checked } })}
                    />
                    <span>Prefetch the next track</span>
                  </label>
                  <label className="field">
                    <span>Browser cookies (last resort)</span>
                    <select
                      value={settings.engine.cookiesFromBrowser ?? ''}
                      onChange={(event) =>
                        onUpdate({ engine: { cookiesFromBrowser: event.target.value || null } })
                      }
                    >
                      {COOKIE_CHOICES.map((choice) => (
                        <option key={choice.value} value={choice.value}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="card-hint">
                  The automatic update checks at most once a day and never runs during a test. Prefetch resolves the
                  next queued YouTube track while the current one plays; turn it off to send one fewer request per
                  track. Browser cookies stay off unless you choose one: when enabled, yt-dlp reads that browser&apos;s
                  YouTube cookies on this PC, which can help a sign-in challenge but also grants access to that
                  account. The app itself never signs in, and account playlists remain unsupported.
                </p>
                <p className="card-hint">
                  A playlist or album import keeps the first N tracks; a mix never ends, so N is its whole definition.
                  Both caps are applied while listing, so the rest of the list is never fetched or queued.
                </p>
              </article>
            </div>

            <div className="cards-col">
              <article className="card">
                <header className="card-header">
                  <h2>
                    Saving to your library <span className="badge">stream only</span>
                  </h2>
                </header>
                <p className="card-hint">
                  Streams are played straight from YouTube and nothing is written to disk while you listen. Press{' '}
                  <strong>Save to library</strong> on a link or an imported entry when you want to keep a copy: it
                  downloads once, writes its tags and cover, and moves into your music folder as an ordinary local
                  track.
                </p>
                <p className="card-hint">
                  Offline caching — replaying a streamed track without a connection — is deliberately switched off for
                  now. It is planned as a separate phase, once the everyday library and discovery work is settled.
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
            <article className="card">
              <header className="card-header">
                <h2>Storage &amp; diagnostics</h2>
              </header>
              <p className="card-hint">
                Everything the app writes lives here. The log file is the first place to look when something goes wrong.
              </p>
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

            <article className="card">
              <header className="card-header">
                <h2>Backup &amp; restore</h2>
              </header>
              <p className="card-hint">
                Player keeps a consistent copy of the database when it starts, and a separate copy before any library
                upgrade. The ten newest automatic copies live in the backups folder. Back up now adds a folder the user
                chooses, with the database, settings and a manifest; restoring validates that folder, copies the current
                data aside, then restarts. Export writes a spreadsheet-friendly CSV of every track, including paths and
                play counts.
              </p>
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
                Duplicate detection compares whole files, not tags, so only byte-identical copies are
                grouped. Merging keeps the oldest entry, combines its playlists and play counts, and
                deletes the redundant file. Missing tracks keep their history while the file is away,
                and can be matched again after a folder move.
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
                <h2>Reset preferences</h2>
              </header>
              <p className="card-hint">
                Puts playback, appearance, click behaviour, import limits, saving quality and the request-budget choices
                back to their defaults. It keeps your library folders and the engine and download folders you chose:
                forgetting a folder is not a preference change.
              </p>
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
              <p className="card-hint">
                A preference reset is not a data reset: the library, playlists and backups stay where they are.
              </p>
            </article>
          </div>
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
                <span className="badge">M6 · settings</span>
              </header>
              <p className="card-hint">
                The local library, playlists, the queue and YouTube playback all work, and a stream can be saved into
                the library with its tags and cover. Unified search, channel pages, metadata cleanup and the six-tab
                Settings page are in, including the bounded Appearance choices and a preference reset. Offline caching
                and the full Downloads screen are deferred to M12. The roadmap in ROADMAP.md is the source of truth for
                what comes next.
              </p>
            </article>
          </div>
        </section>
      </div>
    </section>
  )
}
