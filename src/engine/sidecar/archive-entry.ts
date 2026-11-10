/**
 * Rules shared by the archive readers.
 *
 * Both readers extract exactly one already-known member, so the only thing a
 * hostile archive could try is a name that escapes the target file. The name is
 * checked before any byte is returned, and no path is ever joined or created.
 */

/** A member larger than this is not a desktop binary and is not extracted. */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024

export function isSafeEntryName(name: string): boolean {
  if (!name || name.length > 1024) return false
  if (name.includes('\0') || name.includes('\\')) return false
  if (name.startsWith('/') || name.startsWith('.')) return false
  if (/^[A-Za-z]:/.test(name)) return false
  return name.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..')
}
