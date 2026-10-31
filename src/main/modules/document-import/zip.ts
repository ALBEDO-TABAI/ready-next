import { inflateRawSync } from 'node:zlib'
export const LIMITS = { source: 64 * 1024 * 1024, entry: 16 * 1024 * 1024, total: 128 * 1024 * 1024, entries: 5000 }
export function safeArchivePath(name: string): string {
  if (!name || name.includes('\\') || name.startsWith('/') || (name.includes(':') || [...name].some(char => char.charCodeAt(0) < 32))) throw new Error(`Unsafe archive path: ${name}`)
  const parts = name.replace(/\/$/, '').split('/')
  if (parts.length > 32 || parts.some(part => !part || part === '.' || part === '..')) throw new Error(`Unsafe archive path: ${name}`)
  return parts.join('/').normalize('NFC')
}
function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
/** Validate the entire central directory before allocating any decompressed data. Never extract to disk. */
export function readZip(data: Buffer): Map<string, Buffer> {
  if (data.length > LIMITS.source) throw new Error('ZIP exceeds source size limit')
  let end = data.length - 22
  while (end >= Math.max(0, data.length - 65557) && data.readUInt32LE(end) !== 0x06054b50) end--
  if (end < Math.max(0, data.length - 65557)) throw new Error('ZIP directory missing')
  const count = data.readUInt16LE(end + 10), start = data.readUInt32LE(end + 16), size = data.readUInt32LE(end + 12)
  if (end + 22 + data.readUInt16LE(end + 20) !== data.length || data.readUInt32LE(end + 4) !== 0 || count !== data.readUInt16LE(end + 8) || count > LIMITS.entries || start + size !== end) throw new Error('Unsupported ZIP directory / ZIP64 / entry limit')
  const entries: { name: string; offset: number; compressed: number; length: number; method: number; crc: number; directory: boolean }[] = []
  const names = new Set<string>(); let cursor = start, total = 0
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || data.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP entry')
    const flags = data.readUInt16LE(cursor + 8), method = data.readUInt16LE(cursor + 10)
    const compressed = data.readUInt32LE(cursor + 20), length = data.readUInt32LE(cursor + 24)
    const nameSize = data.readUInt16LE(cursor + 28), extra = data.readUInt16LE(cursor + 30), comment = data.readUInt16LE(cursor + 32)
    const next = cursor + 46 + nameSize + extra + comment
    if (next > end) throw new Error('Truncated ZIP entry')
    const rawName = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(cursor + 46, cursor + 46 + nameSize))
    const name = safeArchivePath(rawName), key = name.toLowerCase(), mode = data.readUInt32LE(cursor + 38) >>> 16
    total += length
    if ((flags & 1) || ![0, 8].includes(method) || (mode & 0xf000) === 0xa000 || data.readUInt16LE(cursor + 34) !== 0 || length > LIMITS.entry || total > LIMITS.total || length > Math.max(1, compressed) * 200 || names.has(key)) throw new Error(`Unsafe ZIP entry or size limit: ${name}`)
    names.add(key)
    entries.push({ name, offset: data.readUInt32LE(cursor + 42), compressed, length, method, crc: data.readUInt32LE(cursor + 16), directory: rawName.endsWith('/') })
    cursor = next
  }
  if (cursor !== end) throw new Error('ZIP directory size mismatch')
  const output = new Map<string, Buffer>()
  for (const entry of entries) {
    const offset = entry.offset
    if (offset + 30 > start || data.readUInt32LE(offset) !== 0x04034b50) throw new Error('Invalid ZIP local header')
    const nameLength = data.readUInt16LE(offset + 26), from = offset + 30 + nameLength + data.readUInt16LE(offset + 28)
    const localName = new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(offset + 30, offset + 30 + nameLength))
    if (safeArchivePath(localName) !== entry.name || data.readUInt16LE(offset + 8) !== entry.method || (data.readUInt16LE(offset + 6) & 1) || from + entry.compressed > start) throw new Error('ZIP local header mismatch')
    const compressed = data.subarray(from, from + entry.compressed)
    const bytes = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: LIMITS.entry })
    if (bytes.length !== entry.length || crc32(bytes) !== entry.crc) throw new Error(`ZIP checksum mismatch: ${entry.name}`)
    if (!entry.directory) output.set(entry.name, bytes)
  }
  return output
}
