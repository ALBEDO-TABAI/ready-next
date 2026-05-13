import { EBOOK_EXTENSIONS } from '../../shared/ebook'

export interface DroppedFile {
  path: string
  name: string
  ext: string
  size: number
}

export type DroppedFileKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'document'
  | 'spreadsheet'
  | 'design'
  | 'other'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'ico', 'tiff'])
const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v'])
const AUDIO_EXTS = new Set(['mp3', 'wav', 'aac', 'ogg', 'flac', 'm4a', 'wma', 'opus'])
const DOCUMENT_EXTS = new Set(['md', 'txt', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'html', 'htm', ...EBOOK_EXTENSIONS])
const SPREADSHEET_EXTS = new Set(['xlsx', 'xls', 'csv', 'tsv'])

function normalizeExt(input: string | undefined | null): string {
  if (!input) return ''
  const ext = input.trim().toLowerCase().replace(/^\./, '')
  return ext
}

function toDroppedFile(path: string, name?: string, ext?: string, size = 0): DroppedFile {
  const normalizedName = name || path.split(/[\\/]/).pop() || path
  const normalizedExt = normalizeExt(ext || normalizedName.split('.').pop())
  return {
    path,
    name: normalizedName,
    ext: normalizedExt,
    size: Number.isFinite(size) ? size : 0,
  }
}

function isLikelyAbsolutePath(value: string): boolean {
  if (!value) return false
  if (value.startsWith('/')) return true
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true
  if (value.startsWith('\\\\')) return true
  return false
}

function parseReadyDrag(data: string): DroppedFile[] {
  try {
    const parsed = JSON.parse(data) as {
      type?: string
      path?: string
      name?: string
      ext?: string
      size?: number
    }
    if (!parsed.path || !isLikelyAbsolutePath(parsed.path)) return []
    if (parsed.type === 'browser-tab') return []
    return [toDroppedFile(parsed.path, parsed.name, parsed.ext, parsed.size ?? 0)]
  } catch {
    return []
  }
}

export function getDroppedFilesFromDataTransfer(dataTransfer: DataTransfer): DroppedFile[] {
  const files: DroppedFile[] = []

  const readyDragRaw = dataTransfer.getData('application/x-ready-drag')
  if (readyDragRaw) {
    files.push(...parseReadyDrag(readyDragRaw))
  }

  const readyFileRaw = dataTransfer.getData('application/x-ready-file')
  if (readyFileRaw) {
    files.push(...parseReadyDrag(readyFileRaw))
  }

  const textPath = dataTransfer.getData('text/plain')?.trim()
  if (textPath && isLikelyAbsolutePath(textPath)) {
    files.push(toDroppedFile(textPath))
  }

  if (dataTransfer.files && dataTransfer.files.length > 0) {
    const nativeFiles = Array.from(dataTransfer.files)
    for (const file of nativeFiles) {
      const nativePath = window.electronAPI?.getFilePathFromDrop
        ? window.electronAPI.getFilePathFromDrop(file)
        : file.name
      files.push(
        toDroppedFile(
          nativePath,
          file.name,
          file.name.split('.').pop(),
          file.size,
        ),
      )
    }
  }

  const deduped = new Map<string, DroppedFile>()
  files.forEach((file) => {
    if (!file.path) return
    deduped.set(file.path, file)
  })
  return Array.from(deduped.values())
}

export function getDroppedFileKind(file: Pick<DroppedFile, 'ext'>): DroppedFileKind {
  const ext = normalizeExt(file.ext)
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (VIDEO_EXTS.has(ext)) return 'video'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  if (DOCUMENT_EXTS.has(ext)) return 'document'
  if (SPREADSHEET_EXTS.has(ext)) return 'spreadsheet'
  if (ext === 'tldr') return 'design'
  return 'other'
}

export function toLocalFileUrl(filePath: string): string {
  // Normalize Windows backslashes to forward slashes
  const normalized = filePath.replace(/\\/g, '/')
  const encoded = encodeURI(normalized).replace(/#/g, '%23')
  return normalized.startsWith('/')
    ? `local-file://${encoded}`
    : `local-file:///${encoded}`
}

export function toFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  if (normalized.startsWith('/')) {
    return `file://${encodeURI(normalized).replace(/#/g, '%23')}`
  }
  return `file:///${encodeURI(normalized).replace(/#/g, '%23')}`
}
