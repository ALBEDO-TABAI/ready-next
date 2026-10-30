export type BlockErrorCode = 'invalid_range' | 'split_surrogate' | 'invalid_unicode' | 'invalid_byte_offset'
  | 'stale_range' | 'overlapping_ranges' | 'version_conflict' | 'source_required' | 'invalid_command'

export class DocumentBlockError extends Error {
  constructor(public readonly code: BlockErrorCode, message: string) { super(message); this.name = 'DocumentBlockError' }
}

export function assertBoundary(source: string, offset: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset > source.length) {
    throw new DocumentBlockError('invalid_range', 'Offset is outside the source')
  }
  const left = source.charCodeAt(offset - 1), right = source.charCodeAt(offset)
  if (left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff) {
    throw new DocumentBlockError('split_surrogate', 'Offset splits a surrogate pair')
  }
}

export function assertUnicode(source: string): void {
  for (const char of source) {
    const cp = char.codePointAt(0)!
    if (cp >= 0xd800 && cp <= 0xdfff) throw new DocumentBlockError('invalid_unicode', 'Unpaired surrogate cannot be preserved as UTF-8')
  }
}

export function isValidUtf8(bytes: Uint8Array): boolean {
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true }
  catch { return false }
}

/** Build once per source. Interior surrogate/code-unit byte positions have no mapping. */
export function createPositionMap(source: string) {
  assertUnicode(source)
  const utf16 = new Int32Array(source.length + 1).fill(-1)
  const bytes = new Map<number, number>()
  let offset = 0, byte = 0
  utf16[0] = 0; bytes.set(0, 0)
  for (const char of source) {
    const cp = char.codePointAt(0)!
    byte += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    offset += char.length
    utf16[offset] = byte; bytes.set(byte, offset)
  }
  return {
    byteLength: byte,
    toByte(position: number): number {
      assertBoundary(source, position)
      return utf16[position]
    },
    toUtf16(position: number): number {
      const result = bytes.get(position)
      if (result === undefined) throw new DocumentBlockError('invalid_byte_offset', 'Offset is not a UTF-8 character boundary')
      return result
    },
  }
}

/** Non-security fingerprint for transient block identity; edits also verify exact expectedText. */
export function fragmentHash(source: string): string {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(source)) hash = Math.imul(hash ^ byte, 0x01000193)
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}
