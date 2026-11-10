import { createHash } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Logger } from '@core/logging/logger'
import type { SidecarId, SidecarProgress, SidecarState } from '@shared/types'
import { SIDECAR_ASSETS, type SidecarAsset } from './manifest'
import { locateExecutable } from './locate'
import { readZipEntry } from './zip'
import { readTarGzEntry } from './tar'

/**
 * Downloads the pinned sidecars into the app-managed engine folder.
 *
 * The rules that matter:
 *
 * - A checksum is checked against the bytes on disk before anything is
 *   renamed into place, so an interrupted or altered download can never leave
 *   a half-written executable behind.
 * - The old file is replaced only after the new one is complete. A failed
 *   update keeps the binary that was already working.
 * - The install record is written after the binary, so "current" in Settings
 *   always means the file is there too. It is a convenience, not a security
 *   boundary: the digest is verified at install time, not on every start.
 * - Downloads go to a temporary file in the same folder, which makes the final
 *   rename atomic and keeps partial files out of the lookup path.
 */

const RECORD_FILE = 'install-record.json'
const RECORD_VERSION = 1
const PROGRESS_INTERVAL_MS = 200
const USER_AGENT = 'Suura/0.1 (sidecar installer)'

export class SidecarInstallError extends Error {
  constructor(
    message: string,
    readonly id: SidecarId
  ) {
    super(message)
    this.name = 'SidecarInstallError'
  }
}

interface InstallRecordEntry {
  version: string
  sha256: string
  bytes: number
  /**
   * Size of the file that was actually installed. For a zip this differs from
   * `bytes`, which is the size of the archive that was downloaded.
   */
  fileBytes?: number
  installedAt: number
}

interface InstallRecord {
  version: number
  files: Partial<Record<SidecarId, InstallRecordEntry>>
}

export interface InstallAssetOptions {
  /** The app-managed engine folder. */
  dir: string
  log: Logger
  onProgress?: (progress: SidecarProgress) => void
  signal?: AbortSignal
  /** Injectable so the smoke test can serve bytes without the network. */
  fetchImpl?: typeof fetch
  now?: () => number
  /** Download again even when the record says the pinned file is present. */
  force?: boolean
}

function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} MB`
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readRecord(dir: string): Promise<InstallRecord> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, RECORD_FILE), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return { version: RECORD_VERSION, files: {} }
    const candidate = parsed as Partial<InstallRecord>
    if (candidate.version !== RECORD_VERSION || !candidate.files || typeof candidate.files !== 'object') {
      return { version: RECORD_VERSION, files: {} }
    }
    return { version: RECORD_VERSION, files: candidate.files }
  } catch {
    return { version: RECORD_VERSION, files: {} }
  }
}

async function writeRecord(dir: string, record: InstallRecord): Promise<void> {
  const target = join(dir, RECORD_FILE)
  const temporary = `${target}.tmp`
  await writeFile(temporary, JSON.stringify(record, null, 2), 'utf8')
  await replaceFile(temporary, target)
}

async function replaceFile(temporary: string, target: string): Promise<void> {
  try {
    await rename(temporary, target)
  } catch (error) {
    // Windows refuses to rename over an existing file, and may briefly lock it
    // after an antivirus scan. A second attempt after removing the old file is
    // enough; the caller still has the verified bytes in `temporary`.
    if (!(error instanceof Error)) throw error
    await rm(target, { force: true })
    await rename(temporary, target)
  }
}

/** True when the recorded pinned version is actually on disk at its size. */
export async function sidecarIsCurrent(dir: string, asset: SidecarAsset): Promise<boolean> {
  const record = await readRecord(dir)
  const entry = record.files[asset.id]
  if (!entry || entry.version !== asset.version || entry.sha256 !== asset.sha256) return false
  try {
    const info = await stat(join(dir, asset.file))
    if (!info.isFile() || info.size <= 0) return false
    // Older records only knew the download size. That is the installed size for
    // a plain file, but not for a zip member, which is why records written by
    // this build also store `fileBytes`. An old zip record still proves the
    // archive was verified, so an existing non-empty member is accepted rather
    // than making the user download it again.
    const expected = entry.fileBytes ?? (asset.kind === 'file' ? asset.bytes : null)
    return expected === null || info.size === expected
  } catch {
    return false
  }
}

export interface SidecarLocateOptions {
  /** The folder the user chose in Settings, checked before the managed one. */
  configuredDir?: string | null
  /** Extra folders worth checking, such as yt-dlp's usual install locations. */
  extraDirs?: readonly string[]
}

/** What Settings shows. Cheap: one read of the record and one stat per asset. */
export async function sidecarStates(
  dir: string,
  assets: readonly SidecarAsset[] = SIDECAR_ASSETS,
  locate: SidecarLocateOptions = {}
): Promise<SidecarState[]> {
  return Promise.all(
    assets.map(async (asset) => {
      const installed = await sidecarIsCurrent(dir, asset)
      // `installed` is about the pinned copy the app owns. A binary on PATH is
      // still usable, and saying "not installed" for it would be wrong.
      const found = installed
        ? { source: 'managed' as const }
        : locateExecutable(asset.id, {
            configuredDir: locate.configuredDir ?? null,
            managedDir: dir,
            extraDirs: locate.extraDirs
          })
      return {
        id: asset.id,
        version: asset.version,
        bytes: asset.bytes,
        installed,
        available: found !== null,
        source: found?.source ?? null,
        optional: asset.optional === true
      }
    })
  )
}

interface DownloadResult {
  bytes: number
}

async function download(
  asset: SidecarAsset,
  target: string,
  options: InstallAssetOptions
): Promise<DownloadResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  let response: Response
  try {
    response = await fetchImpl(asset.url, {
      redirect: 'follow',
      signal: options.signal,
      headers: { 'user-agent': USER_AGENT, accept: 'application/octet-stream' }
    })
  } catch (error) {
    if (options.signal?.aborted) throw error
    throw new SidecarInstallError(
      `Could not reach the ${asset.id} download. Check the connection and try again.`,
      asset.id
    )
  }

  if (!response.ok) {
    throw new SidecarInstallError(
      `Could not download ${asset.id} (HTTP ${response.status}). The pinned release may have moved; update the app to get a new link.`,
      asset.id
    )
  }
  if (!response.body) {
    throw new SidecarInstallError(`The ${asset.id} download returned no data.`, asset.id)
  }

  const hash = createHash('sha256')
  const handle = await open(target, 'w')
  let received = 0
  let lastEmit = 0
  try {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      received += value.byteLength
      if (received > asset.bytes) {
        throw new SidecarInstallError(
          `The ${asset.id} download is larger than its pinned ${formatMegabytes(asset.bytes)}. It was rejected without being installed.`,
          asset.id
        )
      }
      hash.update(value)
      await handle.write(value)

      const at = now()
      if (at - lastEmit >= PROGRESS_INTERVAL_MS) {
        lastEmit = at
        options.onProgress?.({ id: asset.id, receivedBytes: received, totalBytes: asset.bytes })
      }
    }
  } finally {
    await handle.close()
  }

  const digest = hash.digest('hex')
  if (received !== asset.bytes || digest !== asset.sha256) {
    throw new SidecarInstallError(
      `The ${asset.id} download did not match its pinned checksum. It was discarded; update the app if the pinned release has changed.`,
      asset.id
    )
  }
  options.onProgress?.({ id: asset.id, receivedBytes: received, totalBytes: asset.bytes })
  return { bytes: received }
}

function temporaryName(dir: string, asset: SidecarAsset, suffix: string): string {
  return join(dir, `.${asset.file}.${process.pid}-${Date.now()}${suffix}`)
}

/**
 * Installs one asset. Resolves `installed: false` when the pinned file is
 * already present, so pressing the button twice is harmless.
 */
export async function installAsset(
  asset: SidecarAsset,
  options: InstallAssetOptions
): Promise<{ installed: boolean }> {
  await mkdir(options.dir, { recursive: true })

  if (!options.force && (await sidecarIsCurrent(options.dir, asset))) {
    options.log.debug('sidecar is already current', { id: asset.id, version: asset.version })
    return { installed: false }
  }

  const target = join(options.dir, asset.file)
  const archiveSuffix = asset.kind === 'zip' ? '.zip' : asset.kind === 'tar.gz' ? '.tar.gz' : null
  const downloadPath = temporaryName(options.dir, asset, archiveSuffix ?? '.download')
  const extractPath = archiveSuffix ? temporaryName(options.dir, asset, '.extract') : downloadPath
  const startedAt = (options.now ?? Date.now)()

  try {
    options.log.info('downloading sidecar', { id: asset.id, version: asset.version, bytes: asset.bytes })
    await download(asset, downloadPath, options)

    if (archiveSuffix) {
      if (!asset.entry) throw new SidecarInstallError(`No archive member is pinned for ${asset.id}.`, asset.id)
      const archive = await readFile(downloadPath)
      const member =
        asset.kind === 'zip' ? readZipEntry(archive, asset.entry) : readTarGzEntry(archive, asset.entry)
      await writeFile(extractPath, member, { mode: 0o755 })
    }

    await replaceFile(extractPath, target)

    // A rename keeps the downloaded file's mode, and a download arrives 0644
    // under the usual umask — enough to read, not enough to run. Windows has no
    // executable bit, so this is the one place the two platforms differ.
    if (process.platform !== 'win32') await chmod(target, 0o755)

    const installedInfo = await stat(target)
    const record = await readRecord(options.dir)
    record.files[asset.id] = {
      version: asset.version,
      sha256: asset.sha256,
      bytes: asset.bytes,
      fileBytes: installedInfo.size,
      installedAt: (options.now ?? Date.now)()
    }
    await writeRecord(options.dir, record)
    options.log.info('sidecar installed', {
      id: asset.id,
      version: asset.version,
      ms: (options.now ?? Date.now)() - startedAt
    })
    return { installed: true }
  } catch (error) {
    if (error instanceof SidecarInstallError) throw error
    throw new SidecarInstallError(`Could not install ${asset.id}: ${messageOf(error)}`, asset.id)
  } finally {
    // The rename consumes the extract; removing it again is a no-op.
    await rm(downloadPath, { force: true }).catch(() => undefined)
    if (archiveSuffix) await rm(extractPath, { force: true }).catch(() => undefined)
  }
}
