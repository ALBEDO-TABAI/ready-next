import { inflateRawSync } from 'node:zlib'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
const MAX_BOOK = 128 * 1024 * 1024
export interface RangeReader { size: number; read(start: number, end: number): Promise<Buffer> }

/** Fetch the central directory and only the selected EPUB's header and compressed bytes. */
export async function epubFromZip(reader: RangeReader): Promise<{ name: string; bytes: Buffer }> {
  const tailStart = Math.max(0, reader.size - 65_557)
  const tail = await reader.read(tailStart, reader.size - 1)
  let end = -1
  for (let p = tail.length - 22; p >= 0; p--) {
    if (tail.readUInt32LE(p) === 0x06054b50 && p + 22 + tail.readUInt16LE(p + 20) === tail.length) { end = p; break }
  }
  if (end < 0) throw new Error('ZIP 目录损坏')
  const count = tail.readUInt16LE(end + 10), length = tail.readUInt32LE(end + 12), offset = tail.readUInt32LE(end + 16)
  if (count === 65535 || offset === 0xffffffff || length > 16 * 1024 * 1024 || offset + length > reader.size) throw new Error('不支持此 ZIP 目录，请手动下载')
  const directory = offset >= tailStart ? tail.subarray(offset - tailStart, offset - tailStart + length) : await reader.read(offset, offset + length - 1)
  const entries: { name: string; flags: number; method: number; packed: number; size: number; offset: number }[] = []
  for (let p = 0, n = 0; n < count; n++) {
    if (p + 46 > directory.length || directory.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 目录不完整')
    const flags = directory.readUInt16LE(p + 8), names = directory.readUInt16LE(p + 28)
    const next = p + 46 + names + directory.readUInt16LE(p + 30) + directory.readUInt16LE(p + 32)
    if (next > directory.length) throw new Error('ZIP 文件名损坏')
    const name = new TextDecoder(flags & 0x800 ? 'utf-8' : 'gb18030').decode(directory.subarray(p + 46, p + 46 + names))
    if (/\.epub$/i.test(name) && !/(^|\/)\.|__MACOSX/.test(name)) entries.push({ name, flags, method: directory.readUInt16LE(p + 10), packed: directory.readUInt32LE(p + 20), size: directory.readUInt32LE(p + 24), offset: directory.readUInt32LE(p + 42) })
    p = next
  }
  if (entries.length !== 1) throw new Error(entries.length ? '压缩包中有多本 EPUB，请去网盘选择后手动导入' : '压缩包中没有 EPUB')
  const entry = entries[0]
  if (entry.flags & 1 || ![0, 8].includes(entry.method) || entry.size > MAX_BOOK || entry.packed > MAX_BOOK) throw new Error('EPUB 加密、过大或压缩方式不受支持')
  const header = await reader.read(entry.offset, entry.offset + 29)
  if (header.readUInt32LE(0) !== 0x04034b50) throw new Error('ZIP 文件头损坏')
  const start = entry.offset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28)
  const packed = await reader.read(start, start + entry.packed - 1)
  const bytes = entry.method === 8 ? inflateRawSync(packed, { maxOutputLength: MAX_BOOK }) : packed
  if (bytes.length !== entry.size) throw new Error('EPUB 解压长度不符')
  return { name: basename(entry.name), bytes }
}

export async function epubFromArchive(archive: Buffer, directory: string, signal: AbortSignal): Promise<{ name: string; bytes: Buffer }> {
  const file = join(directory, 'download.archive'); await writeFile(file, archive)
  const bin = process.platform === 'darwin' ? '/usr/bin/tar' : process.platform === 'win32' ? 'tar.exe' : 'bsdtar'
  const run = (args: string[]): Promise<Buffer> => new Promise((resolve, reject) => {
    execFile(bin, args, { signal, encoding: 'buffer', maxBuffer: MAX_BOOK, timeout: 120_000, killSignal: 'SIGKILL' }, (error, stdout) => {
      if (error) reject(new Error(`系统 bsdtar 解压失败：${error.message}，请去网盘手动下载`))
      else resolve(stdout)
    })
  })
  const names = (await run(['-tf', file])).toString('utf8').split(/\r?\n/).filter(name => /\.epub$/i.test(name) && !/(^|\/)\.|__MACOSX/.test(name))
  if (names.length !== 1) throw new Error('压缩包须包含一本 EPUB，多卷本请手动选择后导入')
  // Stream one member to stdout; never let archive paths or symlinks write into the filesystem.
  return { name: basename(names[0]), bytes: await run(['-xOf', file, '--', names[0]]) }
}
