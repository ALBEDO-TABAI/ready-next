/**
 * Which document tabs the top-bar 导出 button can export, and how the
 * suggested file name is derived. Kept outside the button component so
 * react-refresh stays happy and tests can drive the predicate directly.
 */
import { getFileExtension } from '../../utils/path'
import { isEbookExtension } from '../../../shared/ebook'
import { isReadyBoardFile } from '../../../shared/ready-board'

const NON_MARKDOWN_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico',
  'mp4', 'webm', 'mov', 'avi', 'mkv', 'ogg',
  'pdf',
  'xlsx', 'csv', 'xls',
])

/**
 * Export targets the markdown/text reading surface. Sheets, media, PDFs,
 * boards and binary ebooks have their own native formats — the button stays
 * visible but disabled there so the top bar keeps a stable layout.
 */
export function isMarkdownExportableTab(tab: { path: string | null | undefined } | null | undefined): boolean {
  if (!tab) return false
  if (!tab.path) return true // untitled draft — markdown by construction
  if (isReadyBoardFile(tab.path)) return false
  const ext = getFileExtension(tab.path)
  if (!ext) return true
  if (NON_MARKDOWN_EXTENSIONS.has(ext)) return false
  if (isEbookExtension(ext)) return false
  return true
}

export function stripTitleExtension(title: string): string {
  const trimmed = title.trim()
  const stripped = trimmed.replace(/\.[A-Za-z0-9]{1,8}$/, '')
  return stripped || trimmed || '导出文档'
}
