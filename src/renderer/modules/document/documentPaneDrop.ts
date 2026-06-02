import { EBOOK_EXTENSIONS } from '../../../shared/ebook'

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

type ReadyPayloadResult =
  | { accepted: true; path: string }
  | { accepted: false }
  | null

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
  return OPENABLE_DOCUMENT_PANE_EXTS.has(getPathExt(path))
}

function parseReadyPayload(raw: string): ReadyPayloadResult {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as {
      type?: string
      path?: string
      isDirectory?: boolean
      ext?: string
    }
    if (parsed.type === 'folder' || parsed.isDirectory) return { accepted: false }
    if (parsed.type === 'browser-tab') return { accepted: false }
    if (!parsed.path || !isLikelyAbsolutePath(parsed.path)) return { accepted: false }
    const ext = normalizeExt(parsed.ext) || getPathExt(parsed.path)
    if (!OPENABLE_DOCUMENT_PANE_EXTS.has(ext)) return { accepted: false }
    return { accepted: true, path: parsed.path }
  } catch {
    // silent-catch: malformed drag payload is simply not accepted as a document drop.
    return { accepted: false }
  }
}

function getNativeFilePath(file: File): string | null {
  const fromElectron = typeof window !== 'undefined' && window.electronAPI?.getFilePathFromDrop
    ? window.electronAPI.getFilePathFromDrop(file)
    : ''
  return fromElectron || file.name || null
}

export function getDocumentPaneDropPath(dataTransfer: DropDataTransfer): string | null {
  const documentTabRaw = dataTransfer.getData('application/x-ready-document-tab')
  if (documentTabRaw) {
    const parsed = parseReadyPayload(documentTabRaw)
    return parsed?.accepted ? parsed.path : null
  }

  const readyRaw = dataTransfer.getData('application/x-ready-drag')
  if (readyRaw) {
    const parsed = parseReadyPayload(readyRaw)
    return parsed?.accepted ? parsed.path : null
  }

  const readyFileRaw = dataTransfer.getData('application/x-ready-file')
  if (readyFileRaw) {
    const parsed = parseReadyPayload(readyFileRaw)
    return parsed?.accepted ? parsed.path : null
  }

  const workspaceRaw = dataTransfer.getData('application/x-ready-workspace-item')
  if (workspaceRaw) {
    const parsed = parseReadyPayload(workspaceRaw)
    return parsed?.accepted ? parsed.path : null
  }

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
    types.has('application/x-ready-document-tab') ||
    types.has('application/x-ready-file') ||
    types.has('application/x-ready-workspace-item')
  ) {
    return true
  }
  if (types.has('text/plain')) {
    return Boolean(getDocumentPaneDropPath(dataTransfer))
  }
  return types.has('Files')
}
