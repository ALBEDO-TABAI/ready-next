import { createHash, randomUUID } from 'node:crypto'
import { constants, openSync, closeSync, writeFileSync, fsyncSync, renameSync, readFileSync, mkdirSync, realpathSync, lstatSync, existsSync, unlinkSync } from 'node:fs'
import { join, resolve, relative, dirname } from 'node:path'
import type { FastCardMedia } from '../../../shared/fastcard'
import { fetchPublic, type PublicResponse } from '../link-preview/fetch-public'

export const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
export function mediaExtension(bytes: Buffer, mime: string): string {
  if (mime === 'image/png' && bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && bytes.toString('ascii', 12, 16) === 'IHDR' && bytes.includes(Buffer.from('IEND'))) return 'png'
  if (mime === 'image/jpeg' && bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return 'jpg'
  if (mime === 'image/gif' && bytes.length >= 14 && /GIF8[79]a/.test(bytes.toString('ascii', 0, 6)) && bytes.at(-1) === 59) return 'gif'
  if (mime === 'image/webp' && bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length) return 'webp'
  if (mime === 'audio/webm' && bytes.length > 16 && bytes.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))) return 'webm'
  if (mime === 'audio/ogg' && bytes.length > 27 && bytes.toString('ascii', 0, 4) === 'OggS') return 'ogg'
  if (mime === 'audio/wav' && bytes.length > 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE') return 'wav'
  throw new Error('Invalid or unsupported media bytes')
}
export function safeDirectory(root: string, relativeDirectory: string): string {
  const canonical = realpathSync(root)
  let current = canonical
  for (const part of relativeDirectory.split('/')) {
    if (!part || part === '.' || part === '..' || /[\\:]/.test(part) || part.includes(String.fromCharCode(0))) throw new Error('Unsafe media directory')
    current = join(current, part)
    if (!existsSync(current)) mkdirSync(current)
    if (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory()) throw new Error('Unsafe media directory')
  }
  if (relative(canonical, realpathSync(current)).startsWith('..')) throw new Error('Media outside root')
  return current
}
export function verifiedRead(path: string, sha256: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { const bytes = readFileSync(fd); if (digest(bytes) !== sha256) throw new Error('Media hash mismatch'); return bytes }
  finally { closeSync(fd) }
}
export function publishBytes(path: string, bytes: Buffer): void {
  if (existsSync(path)) { verifiedRead(path, digest(bytes)); return }
  const temp = `${path}.${randomUUID()}.tmp`
  const fd = openSync(temp, 'wx', 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  try { renameSync(temp, path); const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory) } finally { closeSync(directory) } }
  finally { if (existsSync(temp)) unlinkSync(temp) }
  verifiedRead(path, digest(bytes))
}
export class FastCardMediaCache {
  private readonly directory: string
  constructor(private readonly userData: string, private readonly downloadBytes: (url: string) => Promise<PublicResponse> = url => fetchPublic(url, { maxBytes: 20 * 1024 * 1024 })) {
    // F supplies the already isolated Ready Next userData. Reject the known daily application identity too.
    let ancestor = resolve(userData)
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor)
    for (const candidate of [resolve(userData), realpathSync(ancestor)]) {
      if (/(?:^|\/)Library\/Application Support\/Ready(?:\/|$)/.test(candidate)) throw new Error('Daily Ready data is forbidden')
    }
    mkdirSync(userData, { recursive: true })
    this.directory = safeDirectory(userData, 'fastcard-media')
  }
  save(bytes: Buffer, mime: string): Extract<FastCardMedia, { status: 'cached' }> {
    if (!bytes.length || bytes.length > 50 * 1024 * 1024) throw new Error('Invalid media size')
    safeDirectory(this.userData, 'fastcard-media')
    const normalized = mime.split(';')[0].toLowerCase(), extension = mediaExtension(bytes, normalized)
    const sha256 = digest(bytes), key = `${sha256}.${extension}`
    publishBytes(join(this.directory, key), bytes)
    return { status: 'cached', key, sha256, mime: normalized, bytes: bytes.length }
  }
  async download(url: string): Promise<FastCardMedia> {
    try {
      const result = await this.downloadBytes(url)
      if (!result.type.toLowerCase().startsWith('image/')) throw new Error('Expected image media')
      return this.save(result.body, result.type)
    } catch (error) { return { status: 'missing', error: error instanceof Error ? error.message : String(error) } }
  }
  read(media: Extract<FastCardMedia, { status: 'cached' }>): Buffer {
    if (!/^[a-f0-9]{64}\.(png|jpg|gif|webp|webm|ogg|wav)$/.test(media.key) || !media.key.startsWith(`${media.sha256}.`)) throw new Error('Invalid media key')
    const bytes = verifiedRead(join(this.directory, media.key), media.sha256)
    if (bytes.length !== media.bytes || !media.key.endsWith(`.${mediaExtension(bytes, media.mime)}`)) throw new Error('Invalid media record')
    return bytes
  }
}
