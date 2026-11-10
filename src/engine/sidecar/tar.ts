import { gunzipSync } from 'node:zlib'
import { MAX_ENTRY_BYTES, isSafeEntryName } from './archive-entry'

/**
 * The smallest tar.gz reader that can install one known binary.
 *
 * AcoustID publishes `fpcalc` for Linux only as a `.tar.gz`, and this is the
 * second archive shape the engine has to read. Like the ZIP reader it accepts
 * exactly one already-known member and returns its bytes; nothing is joined to
 * a path or written to disk, and the member name is checked before any byte is
 * returned.
 *
 * Only plain ustar headers are understood. PAX and GNU long-name headers are
 * refused with a sentence rather than half-read, because a release archive that
 * needs them is a different archive and should be looked at, not guessed at.
 */

/** A decompressed tar bomb is not a desktop binary; the cap makes that cheap. */
const MAX_TAR_BYTES = 256 * 1024 * 1024
const BLOCK = 512

function readString(block: Buffer, offset: number, length: number): string {
  const field = block.subarray(offset, offset + length)
  const end = field.indexOf(0)
  return field.subarray(0, end === -1 ? field.length : end).toString('utf8')
}

/** Octal ASCII, the only size encoding a ustar header may use. */
function readSize(block: Buffer, offset: number, length: number): number {
  const raw = block.subarray(offset, offset + length)
  if (raw[0] !== undefined && (raw[0] & 0x80) !== 0) {
    throw new Error('The archive uses a binary size field, which is not supported.')
  }
  const text = raw.toString('ascii').replace(/\0.*$/s, '').trim()
  if (text.length === 0) return 0
  if (!/^[0-7]+$/.test(text)) throw new Error('The archive header is damaged.')
  return Number.parseInt(text, 8)
}

function readMember(tar: Buffer, name: string): Buffer {
  let offset = 0
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every((byte) => byte === 0)) break

    const type = String.fromCharCode(header.readUInt8(156))
    const size = readSize(header, 124, 12)
    const dataStart = offset + BLOCK
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) throw new Error('The archive member is truncated.')

    if (type === '0' || type === '\0') {
      const prefix = readString(header, 345, 155)
      const shortName = readString(header, 0, 100)
      const memberName = prefix.length > 0 ? `${prefix}/${shortName}` : shortName
      if (memberName === name) {
        if (size > MAX_ENTRY_BYTES) throw new Error(`The archive member ${name} is too large to extract.`)
        return Buffer.from(tar.subarray(dataStart, dataEnd))
      }
    } else if (type === 'L' || type === 'K' || type === 'x' || type === 'g') {
      throw new Error('The archive uses extended tar headers, which are not supported.')
    }

    // Every member starts on a 512-byte boundary.
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
  }

  throw new Error(`The archive does not contain ${name}.`)
}

/** Returns one member's bytes from a `.tar.gz`, or throws with a sentence that can be shown. */
export function readTarGzEntry(archive: Buffer, name: string): Buffer {
  if (!isSafeEntryName(name)) throw new Error(`Refusing an unsafe archive path: ${name}`)
  const tar = gunzipSync(archive, { maxOutputLength: MAX_TAR_BYTES })
  return readMember(tar, name)
}
