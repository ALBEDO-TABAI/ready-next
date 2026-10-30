import { inflateRawSync } from 'node:zlib'
import { CanvasPathSchema } from '../../../shared/ready-canvas'

/** Bounded classic ZIP reader. No extraction touches the source directory. */
export function readSpaceZip(bytes: Buffer, maxBytes = 256 * 1024 * 1024): Map<string, Buffer> {
  if (bytes.length > maxBytes) throw new Error('ZIP archive exceeds size limit')
  let end = bytes.length - 22
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--
  if (end < 0 || bytes.readUInt32LE(end) !== 0x06054b50) throw new Error('Invalid ZIP directory')
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16), size = bytes.readUInt32LE(end + 12)
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || count !== bytes.readUInt16LE(end + 8) || count > 10000 || start + size !== end) throw new Error('Unsupported ZIP directory or entry limit')
  const result = new Map<string, Buffer>(), names = new Set<string>()
  let cursor = start, total = 0
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP entry')
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16)
    const compressed = bytes.readUInt32LE(cursor + 20), expanded = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32)
    const offset = bytes.readUInt32LE(cursor + 42), mode = bytes.readUInt32LE(cursor + 38) >>> 16
    const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    const path = name.endsWith('/') ? name.slice(0, -1) : name
    CanvasPathSchema.parse(path)
    if (names.has(name.toLowerCase()) || flags & 1 || (mode & 0xf000) === 0xa000 || ![0, 8].includes(method)) throw new Error('Unsafe or unsupported ZIP entry')
    names.add(name.toLowerCase()); total += expanded
    if (total > maxBytes || expanded > maxBytes || compressed > maxBytes) throw new Error('ZIP decompression limit exceeded')
    if (offset + 30 > start || bytes.readUInt32LE(offset) !== 0x04034b50) throw new Error('Invalid local ZIP entry')
    const localNameLength = bytes.readUInt16LE(offset + 26), localExtraLength = bytes.readUInt16LE(offset + 28)
    const localName = bytes.subarray(offset + 30, offset + 30 + localNameLength).toString('utf8')
    const dataStart = offset + 30 + localNameLength + localExtraLength
    if (localName !== name || bytes.readUInt16LE(offset + 8) !== method || dataStart + compressed > start) throw new Error('ZIP local entry mismatch')
    const data = bytes.subarray(dataStart, dataStart + compressed)
    const content = method === 0 ? Buffer.from(data) : inflateRawSync(data, { maxOutputLength: Math.max(1, Math.min(expanded, maxBytes)) })
    if (content.length !== expanded || crc32(content) !== crc) throw new Error('ZIP content checksum mismatch')
    if (!name.endsWith('/')) result.set(name, content)
    cursor += 46 + nameLength + extra + comment
  }
  if (cursor !== end || !result.has('space.json')) throw new Error('A complete Stillroom ZIP requires space.json')
  return result
}
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
