import type { ChatAttachment } from '../../../../stores/useAgent'

export const IMAGE_ATTACHMENT_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tiff'])
export const VIDEO_ATTACHMENT_EXTS = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi'])
export const TEXT_ATTACHMENT_EXTS = new Set([
  'txt',
  'md',
  'csv',
  'pdf',
  'json',
  'html',
  'docx',
  'doc',
  'rtf',
  'odt'
])
export const SPREADSHEET_ATTACHMENT_EXTS = new Set(['xlsx', 'xls', 'tsv'])

export function getAttachmentTypeFromExt(ext?: string, isDirectory = false): ChatAttachment['type'] {
  if (isDirectory) return 'other'
  const normalizedExt = String(ext || '')
    .toLowerCase()
    .replace(/^\./, '')
  if (IMAGE_ATTACHMENT_EXTS.has(normalizedExt)) return 'image'
  if (VIDEO_ATTACHMENT_EXTS.has(normalizedExt)) return 'video'
  if (TEXT_ATTACHMENT_EXTS.has(normalizedExt)) return 'text'
  if (SPREADSHEET_ATTACHMENT_EXTS.has(normalizedExt)) return 'spreadsheet'
  return 'other'
}

export function getPathBasename(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

export function createLocalPathAttachment(params: {
  name?: string
  path: string
  ext?: string
  size?: number
  isDirectory?: boolean
}): ChatAttachment {
  const isDirectory = Boolean(params.isDirectory)
  const normalizedExt = isDirectory
    ? ''
    : String(params.ext || getPathBasename(params.path).split('.').pop() || '')
        .toLowerCase()
        .replace(/^\./, '')

  return {
    id: `attach-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: params.name || getPathBasename(params.path),
    path: params.path,
    type: getAttachmentTypeFromExt(normalizedExt, isDirectory),
    isDirectory,
    size: params.size || 0,
    ext: normalizedExt ? `.${normalizedExt}` : '',
    source: 'file'
  }
}
