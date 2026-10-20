import { useState } from 'react'
import type {
  AppPaths,
  AppSettings,
  ArtworkFit,
  ArtworkShape,
  ArtworkSize,
  DeepPartial,
  DownloadFormat,
  EngineStatus,
  ExecutableStatus,
  LibraryClickAction,
  QualityTier
} from '@shared/types'
import { COOKIE_BROWSERS } from '@shared/youtube'
import { FolderIcon, RefreshIcon, SpinnerIcon, TrashIcon } from './Icons'

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
    onOpenPath
  } = props
  const [tab, setTab] = useState<TabId>('general')

  return (
    <section className="main-view settings-view">
      <header className="view-header">
        <div className="view-heading">
          <h1>Settings</h1>
          <p className="subtitle">Saved to config.json in the app data folder. Changes apply immediately.</p>
        </div>
      </header>

      {error ? <div className="banner error">{error}</div> : null}

      <nav className="settings-tabs" role="tablist" aria-label="Settings sections">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`settings-tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`settings-panel-${entry.id}`}
            className={tab === entry.id ? 'settings-tab active' : 'settings-tab'}
            onClick={() => setTab(entry.id)}
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
          hidden={tab !== 'appearance'}
        >
          <div className="cards">
            <article className="card">
              <header className="card-header">
                <h2>Visuals</h2>
              </header>
              <p className="card-hint">
                How cover art is drawn. The shape applies everywhere it appears: the library rows, the player bar and the
                player window.
              </p>
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
              <p className="card-hint">
                Cropping keeps every tile the same shape, which is what most players do, and is all that reads at
                thumbnail size. Fitting is for the player window&apos;s large artwork, where the box takes the
                cover&apos;s own proportions: nothing is cut off and nothing is left blank around it. A circle only
                exists on a square, so round artwork is always cropped. Size applies to the player window&apos;s
                artwork; it is a proportion of the space the window leaves over, so the cover never overflows it.
              </p>
            </article>
          </div>
        </section>

        <section
          className="settings-panel"
          role="tabpanel"
          id="settings-panel-behaviour"
          aria-labelledby="settings-tab-behaviour"
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
                      ['Downloads', paths.downloads]
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
        </section>

        <section
          className="settings-panel"
          role="tabpanel"
          id="settings-panel-about"
          aria-labelledby="settings-tab-about"
          hidden={tab !== 'about'}
        >
          <div className="cards">
            <article className="card about-card">
              <header className="card-header">
                <h2>About</h2>
                <span className="badge">M5 · search and settings</span>
              </header>
              <p className="card-hint">
                The local library, playlists, the queue and YouTube playback all work, and a stream can be saved into
                the library with its tags and cover. Unified search, channel pages and metadata cleanup are in.
                Offline caching and the full Downloads screen are deferred to M12. The roadmap in ROADMAP.md is the
                source of truth for what comes next.
              </p>
            </article>
          </div>
        </section>
      </div>
    </section>
  )
}
