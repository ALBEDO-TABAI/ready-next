import { getFileExtension } from '../../utils/path'

export type DocumentViewMode = 'source' | 'rich' | 'preview'

export interface DocumentViewModeOption {
  mode: DocumentViewMode
  label: string
  description: string
}

const MARKDOWN_LIKE_EXTENSIONS = new Set([
  '',
  'md',
  'markdown',
  'txt',
  'docx',
])

const SOURCE_ONLY_EXTENSIONS = new Set([
  'json',
  'ts',
  'tsx',
  'js',
  'jsx',
  'css',
  'scss',
  'less',
  'html',
  'htm',
  'xml',
  'yaml',
  'yml',
  'cjs',
  'mjs',
  'cts',
  'mts',
])

const PREVIEW_ONLY_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'svg',
  'bmp',
  'ico',
  'mp4',
  'webm',
  'mov',
  'avi',
  'mkv',
  'ogg',
  'pdf',
  'xlsx',
  'xls',
  'csv',
])

const MODE_OPTIONS: Record<DocumentViewMode, DocumentViewModeOption> = {
  source: {
    mode: 'source',
    label: '源码',
    description: '直接编辑原始 Markdown 或文本内容',
  },
  rich: {
    mode: 'rich',
    label: '排版',
    description: '查看最终排版效果',
  },
  preview: {
    mode: 'preview',
    label: '预览',
    description: '查看最终呈现效果',
  },
}

function getNormalizedExtension(path: string | null | undefined): string {
  if (!path) return ''
  return getFileExtension(path)
}

export function getDocumentViewModeOptions(path: string | null | undefined): DocumentViewModeOption[] {
  const ext = getNormalizedExtension(path)

  if (MARKDOWN_LIKE_EXTENSIONS.has(ext)) {
    return [MODE_OPTIONS.source, MODE_OPTIONS.rich]
  }

  if (SOURCE_ONLY_EXTENSIONS.has(ext)) {
    return [MODE_OPTIONS.source]
  }

  if (PREVIEW_ONLY_EXTENSIONS.has(ext)) {
    return []
  }

  return [MODE_OPTIONS.source, MODE_OPTIONS.rich]
}

export function getDefaultDocumentViewMode(path: string | null | undefined): DocumentViewMode {
  const ext = getNormalizedExtension(path)

  if (MARKDOWN_LIKE_EXTENSIONS.has(ext)) return 'rich'
  if (SOURCE_ONLY_EXTENSIONS.has(ext)) return 'source'
  return getDocumentViewModeOptions(path)[0]?.mode || 'rich'
}

export function normalizeDocumentViewMode(
  path: string | null | undefined,
  requestedMode: DocumentViewMode,
): DocumentViewMode {
  const availableModes = new Set(getDocumentViewModeOptions(path).map((option) => option.mode))
  return availableModes.has(requestedMode) ? requestedMode : getDefaultDocumentViewMode(path)
}
