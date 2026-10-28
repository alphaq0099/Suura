import { existsSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Free bytes on the volume that holds `path`.
 *
 * A path that does not exist yet is walked upwards: the target folder of a save
 * may not have been created, but its parent volume is the one that has to have
 * room. A platform without `statfs` support returns null, which makes callers
 * skip the check rather than refuse to save.
 */
export async function freeBytesFor(path: string): Promise<number | null> {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }

  try {
    const stats = await statfs(current)
    const available = Number(stats.bavail)
    const blockSize = Number(stats.bsize)
    if (!Number.isFinite(available) || !Number.isFinite(blockSize)) return null
    return Math.max(0, available * blockSize)
  } catch {
    // ENOSYS on a platform without statfs, EACCES on an inaccessible volume:
    // neither is proof that the disk is full.
    return null
  }
}
