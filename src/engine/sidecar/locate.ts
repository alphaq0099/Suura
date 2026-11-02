import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type { ExecutableStatus } from '@shared/types'

const execFileAsync = promisify(execFile)

export interface LocatedExecutable {
  path: string
  source: 'configured' | 'managed' | 'path' | 'well-known'
}

function candidateExtensions(): string[] {
  // .cmd/.bat can only be launched through cmd.exe, so they are not probed here;
  // yt-dlp and ffmpeg both ship as real executables.
  return process.platform === 'win32' ? ['.exe', ''] : ['']
}

/**
 * Directories worth checking when a binary is not on PATH. The first entry is the
 * folder many Windows users end up with after following the yt-dlp install docs.
 */
export function wellKnownDirectories(): string[] {
  const home = homedir()
  const dirs = [join(home, 'yt-dlp'), join(home, 'bin'), join(home, '.local', 'bin')]
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) {
      dirs.push(join(localAppData, 'Programs', 'yt-dlp'))
      dirs.push(join(localAppData, 'Microsoft', 'WinGet', 'Links'))
      dirs.push(join(localAppData, 'Programs', 'Python', 'Scripts'))
    }
    const appData = process.env.APPDATA
    if (appData) dirs.push(join(appData, 'Python', 'Scripts'))
  }
  return dirs
}

function findInDirectory(
  dir: string,
  name: string,
  source: LocatedExecutable['source']
): LocatedExecutable | null {
  const base = isAbsolute(dir) ? dir : join(process.cwd(), dir)
  for (const extension of candidateExtensions()) {
    const candidate = join(base, `${name}${extension}`)
    if (existsSync(candidate)) return { path: candidate, source }
  }
  return null
}

export interface LocateOptions {
  /** Explicit folder from settings; wins over everything. */
  configuredDir?: string | null
  /** The app-managed engine folder, checked after the configured one. */
  managedDir?: string | null
  /** Folders checked after PATH. */
  extraDirs?: readonly string[]
}

/**
 * Finds a binary without running it.
 *
 * Order: the folder the user picked, then the folder the app manages, then
 * PATH, then the usual install locations. A user override stays first so an
 * existing setup keeps working, and the managed copy stays ahead of PATH so a
 * stale sidecar on PATH cannot shadow the version the app pinned.
 */
export function locateExecutable(name: string, options: LocateOptions = {}): LocatedExecutable | null {
  if (options.configuredDir) {
    const found = findInDirectory(options.configuredDir, name, 'configured')
    if (found) return found
  }
  if (options.managedDir) {
    const found = findInDirectory(options.managedDir, name, 'managed')
    if (found) return found
  }

  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const found = findInDirectory(dir, name, 'path')
    if (found) return found
  }

  for (const dir of options.extraDirs ?? []) {
    const found = findInDirectory(dir, name, 'well-known')
    if (found) return found
  }

  return null
}

export interface ProbeOptions {
  versionArgs?: string[]
  /** Explicit folder from settings; wins over PATH. */
  configuredDir?: string | null
  /** The app-managed engine folder. */
  managedDir?: string | null
  timeoutMs?: number
}

/**
 * Locates a binary and asks it for its version.
 *
 * This is intentionally cheap and does not run at startup: the settings screen
 * calls it on demand. It is the M0 smoke test for the sidecar layer without any
 * of M3's resolution logic.
 */
export async function probeExecutable(name: string, options: ProbeOptions = {}): Promise<ExecutableStatus> {
  const base: ExecutableStatus = {
    name,
    found: false,
    path: null,
    version: null,
    source: null,
    error: null
  }

  const located = locateExecutable(name, {
    configuredDir: options.configuredDir,
    managedDir: options.managedDir,
    extraDirs: wellKnownDirectories()
  })

  if (!located) {
    return {
      ...base,
      error: 'Not found in the engine folder, on PATH, or in any known location.'
    }
  }

  try {
    const { stdout } = await execFileAsync(located.path, options.versionArgs ?? ['--version'], {
      timeout: options.timeoutMs ?? 8000,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    })
    const version =
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? null
    return { name, found: true, path: located.path, version, source: located.source, error: null }
  } catch (error) {
    return {
      name,
      found: true,
      path: located.path,
      version: null,
      source: located.source,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
