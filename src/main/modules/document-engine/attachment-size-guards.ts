/**
 * Pure helpers for document attachment size guards (D2 perf rescue).
 *
 * Lives in a standalone module so the Node test runner can import it
 * without pulling Electron through the IPC handler. The IPC handler
 * (`./ipc-handler.ts`) re-exports the public surface for backward compat.
 */
import { extname } from 'path'
import { EBOOK_BINARY_EXTENSIONS } from '../../../shared/ebook'

// --- Cap constants ---
// Block main thread on huge base64 / readFile calls is the primary cause of
// document-mode video flickering during a saveAs / read. We bail out early
// with a structured ref instead of decoding multi-MB blobs synchronously.
export const ATTACHMENT_HARD_CAP_BYTES = 100 * 1024 * 1024 // 100 MB any type
export const VIDEO_INLINE_CAP_BYTES = 40 * 1024 * 1024 // 40 MB video → ref
export const IMAGE_INLINE_CAP_BYTES = 20 * 1024 * 1024 // 20 MB image → refuse base64
export const EBOOK_INLINE_CAP_BYTES = 40 * 1024 * 1024 // 40 MB ebook → inline bytes for reader

export type AttachmentCategory = 'image' | 'video' | 'audio' | 'pdf' | 'ebook' | 'binary'

/** Detect content type category from extension. Mirrors getFileCategory() in ipc-handler. */
export function getAttachmentCategory(filePath: string): AttachmentCategory {
  const ext = extname(filePath).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.svg', '.tiff', '.tif', '.avif'].includes(ext)) return 'image'
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.m4v'].includes(ext)) return 'video'
  if (['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma'].includes(ext)) return 'audio'
  if (ext === '.pdf') return 'pdf'
  if (EBOOK_BINARY_EXTENSIONS.has(ext)) return 'ebook'
  return 'binary'
}

/** Approximate decoded byte length of a base64 string without allocating the buffer. */
export function base64DecodedLength(value: string): number {
  if (!value) return 0
  // Strip data URL prefix if present (`data:image/png;base64,...`)
  const commaIdx = value.indexOf(',')
  const body = commaIdx >= 0 && value.startsWith('data:') ? value.slice(commaIdx + 1) : value
  // base64 length math: every 4 chars → 3 bytes, minus 1 per `=` pad
  let padding = 0
  if (body.endsWith('==')) padding = 2
  else if (body.endsWith('=')) padding = 1
  return Math.floor((body.length * 3) / 4) - padding
}

/** Best-effort category guess for a base64 payload using the suggested filename's extension. */
export function categoryFromSuggestedName(
  name: string | undefined | null,
): AttachmentCategory {
  if (!name) return 'binary'
  return getAttachmentCategory(name)
}

export type AttachmentSizeDecision =
  | { kind: 'ok' }
  | {
      kind: 'attachment_too_large'
      max: number
      actual: number
    }
  | {
      kind: 'video_too_large_for_base64'
      max: number
      actual: number
    }
  | {
      kind: 'image_too_large_for_base64'
      max: number
      actual: number
    }

/**
 * Pure decision function for the saveAs base64 size guard.
 * Returns the structured result the IPC handler should bail with;
 * `kind: 'ok'` means the handler can proceed with `Buffer.from + writeFile`.
 */
export function decideAttachmentSize(
  approxBytes: number,
  category: AttachmentCategory,
): AttachmentSizeDecision {
  if (approxBytes > ATTACHMENT_HARD_CAP_BYTES) {
    return { kind: 'attachment_too_large', max: ATTACHMENT_HARD_CAP_BYTES, actual: approxBytes }
  }
  if (category === 'video' && approxBytes > VIDEO_INLINE_CAP_BYTES) {
    return { kind: 'video_too_large_for_base64', max: VIDEO_INLINE_CAP_BYTES, actual: approxBytes }
  }
  if (category === 'image' && approxBytes > IMAGE_INLINE_CAP_BYTES) {
    return { kind: 'image_too_large_for_base64', max: IMAGE_INLINE_CAP_BYTES, actual: approxBytes }
  }
  return { kind: 'ok' }
}

export type ReadAttachmentDecision =
  | { kind: 'ok'; loadInlineBytes: boolean }
  | { kind: 'large_video_ref'; size: number }
  | { kind: 'large_image_ref'; size: number }
  | { kind: 'attachment_too_large'; max: number; actual: number }
  | { kind: 'pdf_too_large_for_inline_bytes'; max: number; actual: number }
  | { kind: 'ebook_too_large_for_inline_bytes'; max: number; actual: number }

/**
 * Pure decision function for the binary read size guard.
 * Mirrors the branching inside `document:read` but is callable from tests
 * with a synthetic stat size.
 */
export function decideReadAttachmentSize(
  size: number,
  category: AttachmentCategory,
): ReadAttachmentDecision {
  if (size > ATTACHMENT_HARD_CAP_BYTES) {
    return { kind: 'attachment_too_large', max: ATTACHMENT_HARD_CAP_BYTES, actual: size }
  }
  if (category === 'video' && size > VIDEO_INLINE_CAP_BYTES) {
    return { kind: 'large_video_ref', size }
  }
  if (category === 'image' && size > IMAGE_INLINE_CAP_BYTES) {
    return { kind: 'large_image_ref', size }
  }
  if (category === 'pdf') {
    if (size > VIDEO_INLINE_CAP_BYTES) {
      return { kind: 'pdf_too_large_for_inline_bytes', max: VIDEO_INLINE_CAP_BYTES, actual: size }
    }
    return { kind: 'ok', loadInlineBytes: true }
  }
  if (category === 'ebook') {
    if (size > EBOOK_INLINE_CAP_BYTES) {
      return { kind: 'ebook_too_large_for_inline_bytes', max: EBOOK_INLINE_CAP_BYTES, actual: size }
    }
    return { kind: 'ok', loadInlineBytes: true }
  }
  return { kind: 'ok', loadInlineBytes: false }
}
