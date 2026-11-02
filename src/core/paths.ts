import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppPaths } from '@shared/types'

/**
 * All application-owned locations, derived from one root. The core takes this as
 * an argument instead of calling Electron's `app.getPath`, which keeps the core
 * runnable from a plain Node process (see tools/smoke.ts).
 */
export function resolveAppPaths(userDataDir: string): AppPaths {
  return {
    userData: userDataDir,
    config: join(userDataDir, 'config.json'),
    database: join(userDataDir, 'library.db'),
    logs: join(userDataDir, 'logs', 'suura.log'),
    cache: join(userDataDir, 'cache'),
    downloads: join(userDataDir, 'downloads'),
    backups: join(userDataDir, 'backups'),
    engine: join(userDataDir, 'engine')
  }
}

export function ensureAppDirectories(paths: AppPaths): void {
  const dirs = [
    paths.userData,
    dirname(paths.logs),
    paths.cache,
    paths.downloads,
    paths.backups,
    paths.engine
  ]
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true })
  }
}
