import { resolve, sep } from 'node:path'

/**
 * Path handling for library identity.
 *
 * Windows paths are compared case-insensitively, because `C:\Music` and
 * `c:\music` are the same folder. `resolve` also collapses `..`, which matters
 * for the media allowlist check.
 */
export function normalizePath(input: string): string {
  const absolute = resolve(input)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

/**
 * The dedupe identity of a local file: its normalised absolute path.
 *
 * Size and mtime deliberately live in their own columns instead of in the key,
 * so that touching a file updates a row rather than orphaning it.
 */
export function localContentKey(filePath: string): string {
  return `local:${normalizePath(filePath)}`
}

export function youtubeContentKey(videoId: string): string {
  return `youtube:${videoId}`
}

/** True when `child` is the same as, or nested inside, `parent`. */
export function isPathInside(parent: string, child: string): boolean {
  const parentPath = normalizePath(parent)
  const childPath = normalizePath(child)
  if (parentPath === childPath) return true
  const prefix = parentPath.endsWith(sep) ? parentPath : parentPath + sep
  return childPath.startsWith(prefix)
}
