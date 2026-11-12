import { READY_REF_MIME } from '../../../shared/ready-ref'
import { knownDraggedPath } from '../workbench/file-drag-ref'
import { EBOOK_EXTENSIONS } from '../../../shared/ebook'
import { isReadyBoardFile } from '../../../shared/ready-board'

const OPENABLE_DOCUMENT_PANE_EXTS = new Set([
  'md',
  'txt',
  'json',
  'ts',
  'tsx',
  'js',
  'css',
  'docx',
  'xlsx',
  'xls',
  'csv',
  'png',
  'jpg',
  'jpeg',
  'webp',
  'svg',
  'gif',
  'bmp',
  'ico',
  'pdf',
  ...EBOOK_EXTENSIONS,
  'tldr',
])

type DropDataTransfer = Pick<DataTransfer, 'getData' | 'types' | 'files'>

function normalizeExt(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase().replace(/^\./, '')
}

function getPathExt(path: string): string {
  const name = path.split(/[\\/]/).pop() || path
  const idx = name.lastIndexOf('.')
  return idx > 0 ? normalizeExt(name.slice(idx + 1)) : ''
}

function isLikelyAbsolutePath(value: string): boolean {
  if (!value) return false
  if (value.startsWith('/')) return true
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true
  if (value.startsWith('\\\\')) return true
  return false
}

export function isDocumentPaneOpenablePath(path: string | null | undefined): path is string {
  if (!path || !isLikelyAbsolutePath(path)) return false
  if ((isReadyBoardFile(path) || /\.canvas$/i.test(path))) return true
  return OPENABLE_DOCUMENT_PANE_EXTS.has(getPathExt(path))
}

function getNativeFilePath(file: File): string | null {
  const fromElectron = typeof window !== 'undefined' && window.electronAPI?.getFilePathFromDrop
    ? window.electronAPI.getFilePathFromDrop(file)
    : ''
  return fromElectron || file.name || null
}

export function getDocumentPaneDropPath(dataTransfer: DropDataTransfer): string | null {
  if (dataTransfer.getData(READY_REF_MIME)) { const path = knownDraggedPath(dataTransfer); return isDocumentPaneOpenablePath(path) ? path : null }

  const textPath = dataTransfer.getData('text/plain')?.trim()
  if (textPath && isDocumentPaneOpenablePath(textPath)) {
    return textPath
  }

  const files = dataTransfer.files ? Array.from(dataTransfer.files) : []
  for (const file of files) {
    const path = getNativeFilePath(file)
    if (isDocumentPaneOpenablePath(path)) return path
  }

  return null
}

export function canAcceptDocumentPaneDrop(dataTransfer: DropDataTransfer): boolean {
  const types = new Set(Array.from(dataTransfer.types || []))
  if (
    types.has(READY_REF_MIME)
  ) {
    return dataTransfer.getData(READY_REF_MIME) ? Boolean(getDocumentPaneDropPath(dataTransfer)) : true
  }
  if (types.has('text/plain')) {
    return Boolean(getDocumentPaneDropPath(dataTransfer))
  }
  return types.has('Files')
}
