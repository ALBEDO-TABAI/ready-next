import { z } from 'zod'
import { hashBytes } from '../document-drafts/files'

// Bytes the person dropped, pasted, picked or recorded on a board (M4 2026-11-14 contract). The renderer hands
// over bytes, never a path: Main reads nothing outside what the person gave it. The type is decided here from
// the bytes themselves; the declared MIME only settles containers that carry either sound or picture.

export type StagedKind = 'image' | 'audio' | 'video'
const MB = 1024 * 1024
export const ATTACHMENT_LIMITS: Record<StagedKind, number> = { image: 20 * MB, audio: 50 * MB, video: 50 * MB }
/** Staged bytes wait in memory for their board write: ten minutes, and never more than this in total. */
export const STAGING_TTL_MS = 10 * 60 * 1000
export const STAGING_TOTAL_BYTES = 256 * MB

export const StageAttachmentSchema = z.strictObject({
  name: z.string().min(1).max(255), mime: z.string().max(127),
  bytes: z.instanceof(Uint8Array).refine(bytes => bytes.byteLength > 0 && bytes.byteLength <= Math.max(...Object.values(ATTACHMENT_LIMITS)), '文件为空或超过大小上限'),
})
export interface StagedAttachment { bytes: Buffer; name: string; kind: StagedKind; mime: string; sha256: string }

const ascii = (bytes: Buffer, start: number, end: number) => bytes.toString('latin1', start, end)
/** What the bytes are, or null when they are not a picture, sound or video Ready shows. */
export function sniffMedia(bytes: Buffer, declaredMime: string): { kind: StagedKind; mime: string; extension: string } | null {
  const declared = declaredMime.split(';')[0].trim().toLowerCase()
  if (bytes.length < 12) return null
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { kind: 'image', mime: 'image/png', extension: 'png' }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { kind: 'image', mime: 'image/jpeg', extension: 'jpg' }
  if (/^GIF8[79]a$/.test(ascii(bytes, 0, 6))) return { kind: 'image', mime: 'image/gif', extension: 'gif' }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') return { kind: 'image', mime: 'image/webp', extension: 'webp' }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WAVE') return { kind: 'audio', mime: 'audio/wav', extension: 'wav' }
  if (ascii(bytes, 0, 4) === 'fLaC') return { kind: 'audio', mime: 'audio/flac', extension: 'flac' }
  if (ascii(bytes, 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe6) === 0xe2)) return { kind: 'audio', mime: 'audio/mpeg', extension: 'mp3' }
  if (ascii(bytes, 0, 4) === 'OggS') return declared.startsWith('video/') ? { kind: 'video', mime: 'video/ogg', extension: 'ogv' } : { kind: 'audio', mime: 'audio/ogg', extension: 'ogg' }
  // WebM (EBML) and MP4 (ftyp) hold sound alone or sound with picture: the declared type says which card it becomes.
  if (bytes.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))) return declared.startsWith('audio/') ? { kind: 'audio', mime: 'audio/webm', extension: 'webm' } : { kind: 'video', mime: 'video/webm', extension: 'webm' }
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12)
    if (/^M4[AB] $/.test(brand) || declared.startsWith('audio/')) return { kind: 'audio', mime: 'audio/mp4', extension: 'm4a' }
    return brand === 'qt  ' ? { kind: 'video', mime: 'video/quicktime', extension: 'mov' } : { kind: 'video', mime: 'video/mp4', extension: 'mp4' }
  }
  return null
}

/** A file name safe inside `X.assets/`: no folders, no characters a canvas path refuses, the extension of the real type. */
export function attachmentName(name: string, extension: string): string {
  const base = name.split(/[\\/]/).pop()!.replace(/\.[^.]*$/, '').replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 80)
  return `${base || 'file'}.${extension}`
}

export function stagedAttachment(input: unknown): StagedAttachment {
  const request = StageAttachmentSchema.parse(input), bytes = Buffer.from(request.bytes)
  const media = sniffMedia(bytes, request.mime)
  if (!media) throw new Error('不支持的文件类型：画板接收图片（PNG、JPEG、GIF、WebP）、音频（WebM、Ogg、WAV、MP3、M4A、FLAC）和视频（MP4、MOV、WebM）')
  if (bytes.length > ATTACHMENT_LIMITS[media.kind]) throw new Error(`文件超过大小上限（${({ image: '图片', audio: '音频', video: '视频' })[media.kind]} ${ATTACHMENT_LIMITS[media.kind] / MB} MB）`)
  return { bytes, name: attachmentName(request.name, media.extension), kind: media.kind, mime: media.mime, sha256: hashBytes(bytes) }
}
