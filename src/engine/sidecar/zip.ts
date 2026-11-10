import { inflateRawSync } from 'node:zlib'
import { MAX_ENTRY_BYTES, isSafeEntryName } from './archive-entry'

/**
 * The smallest ZIP reader that can install one known binary.
 *
 * It reads the central directory instead of scanning for local headers, and it
 * accepts exactly one member name. That is deliberate: there is no path
 * joining, no recursion and no directory creation, so a malicious archive has
 * no way to write outside the file the caller asked for. `isSafeEntryName` is a
 * second guard for the same reason.
 *
 * Only stored (0) and deflated (8) members are supported, which is what release
 * archives use.
 */

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const MAX_COMMENT_BYTES = 0xffff

function findEndOfCentralDirectory(zip: Buffer): number {
  const earliest = Math.max(0, zip.length - 22 - MAX_COMMENT_BYTES)
  for (let offset = zip.length - 22; offset >= earliest; offset -= 1) {
    if (zip.readUInt32LE(offset) !== EOCD_SIGNATURE) continue
    // A signature inside the archive comment would not describe this file.
    const commentLength = zip.readUInt16LE(offset + 20)
    if (offset + 22 + commentLength === zip.length) return offset
  }
  throw new Error('The archive is not a readable ZIP file.')
}

interface CentralEntry {
  method: number
  flags: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

function findCentralEntry(zip: Buffer, name: string): CentralEntry {
  const end = findEndOfCentralDirectory(zip)
  const disk = zip.readUInt16LE(end + 4)
  const centralDisk = zip.readUInt16LE(end + 6)
  if (disk !== 0 || centralDisk !== 0) throw new Error('Multi-part ZIP archives are not supported.')

  const count = zip.readUInt16LE(end + 10)
  const directorySize = zip.readUInt32LE(end + 12)
  const directoryOffset = zip.readUInt32LE(end + 16)
  if (directoryOffset + directorySize > zip.length) throw new Error('The archive directory is truncated.')

  let cursor = directoryOffset
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > zip.length || zip.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error('The archive directory is damaged.')
    }
    const flags = zip.readUInt16LE(cursor + 8)
    const method = zip.readUInt16LE(cursor + 10)
    const compressedSize = zip.readUInt32LE(cursor + 20)
    const uncompressedSize = zip.readUInt32LE(cursor + 24)
    const nameLength = zip.readUInt16LE(cursor + 28)
    const extraLength = zip.readUInt16LE(cursor + 30)
    const commentLength = zip.readUInt16LE(cursor + 32)
    const localOffset = zip.readUInt32LE(cursor + 42)
    const memberName = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')

    if (memberName === name) {
      if (flags & 0x1) throw new Error('The archive member is encrypted.')
      return { method, flags, compressedSize, uncompressedSize, localOffset }
    }
    cursor += 46 + nameLength + extraLength + commentLength
  }

  throw new Error(`The archive does not contain ${name}.`)
}

/** Returns one member's bytes, or throws with a sentence that can be shown. */
export function readZipEntry(zip: Buffer, name: string): Buffer {
  if (!isSafeEntryName(name)) throw new Error(`Refusing an unsafe archive path: ${name}`)

  const entry = findCentralEntry(zip, name)
  if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
    throw new Error(`The archive member ${name} is too large to extract.`)
  }
  if (entry.localOffset + 30 > zip.length || zip.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) {
    throw new Error('The archive member is damaged.')
  }

  const nameLength = zip.readUInt16LE(entry.localOffset + 26)
  const extraLength = zip.readUInt16LE(entry.localOffset + 28)
  const dataStart = entry.localOffset + 30 + nameLength + extraLength
  const dataEnd = dataStart + entry.compressedSize
  if (dataEnd > zip.length) throw new Error('The archive member is truncated.')
  const compressed = zip.subarray(dataStart, dataEnd)

  if (entry.method === 0) {
    if (compressed.length !== entry.uncompressedSize) throw new Error('The archive member is truncated.')
    return Buffer.from(compressed)
  }
  if (entry.method !== 8) throw new Error('The archive uses an unsupported compression method.')

  const inflated = inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES })
  if (entry.uncompressedSize > 0 && inflated.length !== entry.uncompressedSize) {
    throw new Error('The archive member did not decompress to its stated size.')
  }
  return inflated
}
