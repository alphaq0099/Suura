import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import type { ExecutableStatus } from '@shared/types'

const execFileAsync = promisify(execFile)

export interface LocatedExecutable {
  path: string
  source: 'configured' | 'path' | 'well-known'
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

export function locateExecutable(name: string, extraDirs: readonly string[] = []): LocatedExecutable | null {
  const extensions = candidateExtensions()

  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension}`)
      if (existsSync(candidate)) return { path: candidate, source: 'path' }
    }
  }

  for (const dir of extraDirs) {
    const base = isAbsolute(dir) ? dir : join(process.cwd(), dir)
    for (const extension of extensions) {
      const candidate = join(base, `${name}${extension}`)
      if (existsSync(candidate)) return { path: candidate, source: 'well-known' }
    }
  }

  return null
}

export interface ProbeOptions {
  versionArgs?: string[]
  /** Explicit folder from settings; wins over PATH. */
  configuredDir?: string | null
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

  let located: LocatedExecutable | null = null

  if (options.configuredDir) {
    for (const extension of candidateExtensions()) {
      const candidate = join(options.configuredDir, `${name}${extension}`)
      if (existsSync(candidate)) {
        located = { path: candidate, source: 'configured' }
        break
      }
    }
  }
  located ??= locateExecutable(name, wellKnownDirectories())

  if (!located) {
    return { ...base, error: 'Not found on PATH or in any known location.' }
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
