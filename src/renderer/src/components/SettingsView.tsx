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
  QualityTier,
  RetentionMode
} from '@shared/types'
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

const RETENTION_CHOICES: Array<{ value: RetentionMode; label: string; detail: string }> = [
  {
    value: 'stream',
    label: 'Stream only',
    detail: 'Nothing is written to disk. The default, and the only mode available until M4.'
  },
  {
    value: 'cache',
    label: 'Cache while playing',
    detail: 'Keeps bytes on disk temporarily so a track can replay offline, then evicts them under the budgets below.'
  },
  {
    value: 'keep',
    label: 'Keep / download',
    detail: 'Downloads permanently into your library with tags and artwork, until you remove it.'
  }
]

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

function describeExecutable(status: ExecutableStatus): string {
  if (!status.found) return status.error ?? 'Not found.'
  const origin = status.source === 'configured' ? 'configured folder' : status.source === 'path' ? 'PATH' : 'known location'
  return `${status.version ?? 'version unknown'} · via ${origin}`
}

/**
 * Two independent columns of cards, with About spanning the bottom.
 *
 * The columns are explicit children rather than one grid with two tracks: a grid
 * ties the height of every card sharing a row together, which left a large void
 * under the short card. See `.cards` in styles.css.
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

  return (
    <section className="main-view">
      <header className="view-header">
        <div className="view-heading">
          <h1>Settings</h1>
          <p className="subtitle">Saved to config.json in the app data folder. Changes apply immediately.</p>
        </div>
      </header>

      {error ? <div className="banner error">{error}</div> : null}

      <div className="cards">
        <div className="cards-col">
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
              Watching is what makes an album you copy in show up without pressing Rescan: a change starts a scan, and a
              scan only opens files whose size or timestamp moved, so it stays cheap in a large library. Turn it off for a
              library on a network or removable drive, where watching can cost more than the occasional manual scan.
            </p>
          </article>

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
              thumbnail size. Fitting is for the player window&apos;s large artwork, where the box takes the cover&apos;s
              own proportions: nothing is cut off and nothing is left blank around it. A circle only exists on a square,
              so round artwork is always cropped. Size applies to the player window&apos;s artwork; it is a proportion of
              the space the window leaves over, so the cover never overflows it.
            </p>
          </article>

          <article className="card">
            <header className="card-header">
              <h2>Click behaviour</h2>
            </header>
            <p className="card-hint">
              What a click on a track in the library does. Two conventions are in wide use — select on click, or play on
              click — and whichever one you are used to, the other feels broken. A double click always arrives as two
              single clicks first, so choosing &quot;play&quot; for both starts the track on the first click and does not
              restart it on the second.
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
                Retention <span className="badge">saving now · cache next</span>
              </h2>
            </header>
            <p className="card-hint">
              Saving to the library always writes a file to the download folder. The modes below decide whether streams
              are also cached while you listen.
            </p>
            <div className="choice-list">
              {RETENTION_CHOICES.map((choice) => (
                <label key={choice.value} className={settings.retention.mode === choice.value ? 'choice selected' : 'choice'}>
                  <input
                    type="radio"
                    name="retention-mode"
                    value={choice.value}
                    checked={settings.retention.mode === choice.value}
                    onChange={() => onUpdate({ retention: { mode: choice.value } })}
                  />
                  <span>
                    <strong>{choice.label}</strong>
                    <em>{choice.detail}</em>
                  </span>
                </label>
              ))}
            </div>

            <div className="field-grid">
              <label className="field">
                <span>Cache budget (MB)</span>
                <input
                  type="number"
                  min={128}
                  max={1000000}
                  step={128}
                  value={settings.retention.cacheBudgetMb}
                  onChange={(event) => onUpdate({ retention: { cacheBudgetMb: Number(event.target.value) } })}
                />
              </label>
              <label className="field">
                <span>Cache max age (days)</span>
                <input
                  type="number"
                  min={1}
                  max={3650}
                  value={settings.retention.cacheMaxAgeDays}
                  onChange={(event) => onUpdate({ retention: { cacheMaxAgeDays: Number(event.target.value) } })}
                />
              </label>
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
                  <input type="text" readOnly value={settings.retention.downloadFolder ?? '(default: Music\\Player)'} />
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

        <div className="cards-col">
          <article className="card">
            <header className="card-header">
              <h2>
                Streaming engine <span className="badge">used from M3</span>
              </h2>
              <button type="button" onClick={onRefreshEngine} disabled={engineLoading}>
                {engineLoading ? <SpinnerIcon /> : <RefreshIcon />}
                <span>Check</span>
              </button>
            </header>
            <p className="card-hint">
              The app shells out to yt-dlp for YouTube audio and ffmpeg for transcoding, tagging and covers. Streaming,
              importing lists and saving tracks all need these two binaries; this reports whether they are ready.
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
            </div>
            <p className="card-hint">
              A playlist or album import keeps the first N tracks; a mix never ends, so N is its whole definition. Both
              caps are applied while listing, so the rest of the list is never fetched or queued.
            </p>
          </article>

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
                    ['Cache', paths.cache],
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

        <article className="card about-card">
          <header className="card-header">
            <h2>About</h2>
            <span className="badge">M0.5 · local library slice</span>
          </header>
          <p className="card-hint">
            Local library playback is the working slice. Scanning, tag reading, artwork, the queue, repeat and shuffle,
            folder watching, the keyboard shortcuts and the media keys are in. Playlists, resuming the last session,
            gapless playback, the yt-dlp resolver and packaging are still ahead — see ROADMAP.md for the sequence.
          </p>
        </article>
      </div>
    </section>
  )
}
