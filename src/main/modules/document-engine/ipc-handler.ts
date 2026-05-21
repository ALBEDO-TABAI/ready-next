import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import {
  writeFileSync, statSync, existsSync,
  copyFileSync, accessSync, constants as fsConstants,
} from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { join, basename, dirname, extname } from 'path'
import { homedir } from 'os'
import { buildDocumentHtmlSnapshotExport } from '../../../shared/document-widget-html-export'
import { documentCommitRegistry, type DocumentWidgetCommitEvent } from './document-commit-registry'
import { validateWorkspaceRoot } from '../../../shared/workspace-validation'
import { EBOOK_BINARY_EXTENSIONS } from '../../../shared/ebook'
import { BINARY_EXTENSIONS } from './binary-extensions'
import { importEpubAsMarkdown } from './ebook-importer'
import { getDatabase } from '../database'
import { DocumentMarksRepository } from './document-marks-repository'
import { markGroup } from './ipc/mark-group'
import { fileIoGroup } from './ipc/file-io-group'
import { fileMutationGroup } from './ipc/file-mutation-group'
import { workspaceGroup } from './ipc/workspace-group'
import { parserGroup } from './ipc/parser-group'
import { watchGroup } from './ipc/watch-group'
import type { IpcDisposeHandle } from './ipc/types'
import {
  ATTACHMENT_HARD_CAP_BYTES,
  IMAGE_INLINE_CAP_BYTES,
  type AttachmentCategory,
  VIDEO_INLINE_CAP_BYTES,
  base64DecodedLength,
  categoryFromSuggestedName,
  decideAttachmentSize,
  decideReadAttachmentSize,
} from './attachment-size-guards'

// Re-export the perf size-guard surface so existing import paths keep working.
export {
  ATTACHMENT_HARD_CAP_BYTES,
  IMAGE_INLINE_CAP_BYTES,
  VIDEO_INLINE_CAP_BYTES,
  base64DecodedLength,
  categoryFromSuggestedName,
  decideAttachmentSize,
  decideReadAttachmentSize,
}
export type {
  AttachmentSizeDecision,
  ReadAttachmentDecision,
} from './attachment-size-guards'

// Lazy-loaded libraries
let mammothLib: typeof import('mammoth') | null = null
let xlsxLib: typeof import('xlsx') | null = null
let docxLib: typeof import('docx') | null = null

async function getMammoth(): Promise<typeof import('mammoth') | null> {
  if (mammothLib) return mammothLib
  try {
    mammothLib = await import('mammoth')
    return mammothLib
  } catch {
    return null
  }
}

async function getXlsx(): Promise<typeof import('xlsx') | null> {
  if (xlsxLib) return xlsxLib
  try {
    xlsxLib = await import('xlsx')
    return xlsxLib
  } catch {
    return null
  }
}

async function getDocx(): Promise<typeof import('docx') | null> {
  if (docxLib) return docxLib
  try {
    docxLib = await import('docx')
    return docxLib
  } catch {
    return null
  }
}

// --- Binary file detection ---

// BINARY_EXTENSIONS lives in `./binary-extensions` so test files (and the
// search-engine adapter) can import it without pulling `electron` through
// this module. Re-export here to preserve the existing public surface.
export { BINARY_EXTENSIONS }

const TEXT_WRITE_BLOCKED_EXTENSIONS = new Set([
  '.docx', '.doc', '.xlsx', '.xls', '.pptx', '.ppt', '.pdf',
  ...EBOOK_BINARY_EXTENSIONS,
])

function isBinaryFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

function isTextWriteBlocked(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  return TEXT_WRITE_BLOCKED_EXTENSIONS.has(ext)
}

function looksLikeReadableText(value: string): boolean {
  if (!value || value.trim().length === 0) return false
  const sample = value.slice(0, 4000)
  let printable = 0
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i)
    const isControl = code < 32 && code !== 9 && code !== 10 && code !== 13
    if (!isControl) printable += 1
  }
  return printable / sample.length > 0.88
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '\'')
    .replace(/&amp;/g, '&')
}

function normalizeDocContentForDocx(content: string): string {
  if (!content) return ''
  const hasHtml = /<[^>]+>/.test(content)
  if (!hasHtml) return content

  const withBreaks = content
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|blockquote|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/li>/gi, '\n')

  const noTags = withBreaks.replace(/<[^>]+>/g, '')
  return decodeHtmlEntities(noTags)
}

function normalizeInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
}

function makeTimestampLabel(date = new Date()): string {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  const hh = String(date.getHours()).padStart(2, '0')
  const mi = String(date.getMinutes()).padStart(2, '0')
  const ss = String(date.getSeconds()).padStart(2, '0')
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`
}

async function readDocxRawText(path: string): Promise<string> {
  const mammoth = await getMammoth()
  if (!mammoth) return ''
  try {
    const buffer = await readFile(path)
    const mammothMod = (mammoth as unknown as { default?: typeof import('mammoth') }).default || mammoth
    const textResult = await mammothMod.extractRawText({ buffer })
    return (textResult.value || '').trim()
  } catch {
    return ''
  }
}

async function writeDocxFromContent(path: string, content: string): Promise<{ success: boolean; error?: string }> {
  const docx = await getDocx()
  if (!docx) {
    return { success: false, error: 'DOCX 写入库(docx)不可用' }
  }

  try {
    const normalized = normalizeDocContentForDocx(content).replace(/\r\n/g, '\n')
    const trimmed = normalized.trim()

    if (trimmed.length === 0 && existsSync(path)) {
      const previousText = await readDocxRawText(path)
      if (previousText.length > 0) {
        return {
          success: false,
          error: '检测到空内容将覆盖已有 DOCX 正文，已阻止保存。请先确认文档已正确加载。',
        }
      }
    }

    if (existsSync(path)) {
      const previousText = await readDocxRawText(path)
      const prevLen = previousText.trim().length
      const nextLen = trimmed.length
      const suspiciousShrink =
        prevLen >= 600 &&
        nextLen > 0 &&
        nextLen <= 120 &&
        nextLen / prevLen < 0.08
      if (suspiciousShrink) {
        return {
          success: false,
          error:
            '检测到将长文档覆盖为极短内容，已阻止保存以避免误写。请确认文档已正确加载后再保存。',
        }
      }
    }

    if (existsSync(path)) {
      try {
        const backupPath = `${path}.autosave-${makeTimestampLabel()}.bak.docx`
        copyFileSync(path, backupPath)
      } catch {
        // Backup failure should not block user save.
      }
    }

    const lines = normalized.split('\n')
    const paragraphs: InstanceType<typeof docx.Paragraph>[] = []

    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/g, '')
      const trimmed = line.trim()
      if (!trimmed) {
        paragraphs.push(new docx.Paragraph({ text: '' }))
        continue
      }

      const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/)
      if (headingMatch) {
        const level = headingMatch[1].length
        const text = normalizeInlineMarkdown(headingMatch[2].trim())
        const heading =
          level <= 1 ? docx.HeadingLevel.HEADING_1
            : level === 2 ? docx.HeadingLevel.HEADING_2
              : level === 3 ? docx.HeadingLevel.HEADING_3
                : level === 4 ? docx.HeadingLevel.HEADING_4
                  : level === 5 ? docx.HeadingLevel.HEADING_5
                    : docx.HeadingLevel.HEADING_6
        paragraphs.push(
          new docx.Paragraph({
            text,
            heading,
          }),
        )
        continue
      }

      const bulletMatch = trimmed.match(/^[-*]\s+(.+)$/)
      if (bulletMatch) {
        paragraphs.push(
          new docx.Paragraph({
            text: normalizeInlineMarkdown(bulletMatch[1].trim()),
            bullet: { level: 0 },
          }),
        )
        continue
      }

      const orderedMatch = trimmed.match(/^\d+\.\s+(.+)$/)
      if (orderedMatch) {
        paragraphs.push(new docx.Paragraph({ text: normalizeInlineMarkdown(orderedMatch[1].trim()) }))
        continue
      }

      const quoteMatch = trimmed.match(/^>\s*(.+)$/)
      if (quoteMatch) {
        paragraphs.push(
          new docx.Paragraph({
            text: normalizeInlineMarkdown(quoteMatch[1].trim()),
            indent: { left: 480 },
          }),
        )
        continue
      }

      paragraphs.push(new docx.Paragraph({ text: normalizeInlineMarkdown(trimmed) }))
    }

    const document = new docx.Document({
      sections: [
        {
          children: paragraphs.length > 0 ? paragraphs : [new docx.Paragraph({ text: '' })],
        },
      ],
    })

    const output = await docx.Packer.toBuffer(document)
    writeFileSync(path, output)
    return { success: true }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return { success: false, error: `DOCX 写入失败: ${errorMessage}` }
  }
}

/** Convert an absolute file path to a local-file:// URL with proper encoding */
function toLocalFileUrl(filePath: string): string {
  // Normalize Windows backslashes to forward slashes
  const normalized = filePath.replace(/\\/g, '/')
  // Encode each path component separately to handle Chinese chars, spaces, etc.
  const encoded = normalized
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return normalized.startsWith('/')
    ? `local-file://${encoded}`
    : `local-file:///${encoded}`
}

/** Detect content type category from extension */
function getFileCategory(filePath: string): AttachmentCategory {
  const ext = extname(filePath).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.svg', '.tiff', '.tif', '.avif'].includes(ext)) return 'image'
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.m4v'].includes(ext)) return 'video'
  if (['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma'].includes(ext)) return 'audio'
  if (ext === '.pdf') return 'pdf'
  if (EBOOK_BINARY_EXTENSIONS.has(ext)) return 'ebook'
  return 'binary'
}

function shouldHideInternalBackup(name: string): boolean {
  return (
    /\.autosave-\d{8}-\d{6}\.bak\.docx$/i.test(name) ||
    /\.empty-backup-\d{8}-\d{6}$/i.test(name)
  )
}


export type DocumentWriteIndexHook = (path: string, content: string) => void

let documentWriteIndexHook: DocumentWriteIndexHook | null = null

export function setDocumentWriteIndexHook(hook: DocumentWriteIndexHook | null): void {
  documentWriteIndexHook = hook
}

export async function readDocumentEditableText(
  filePath: string,
): Promise<{ success: boolean; content: string; error?: string }> {
  try {
    if (!existsSync(filePath)) {
      return { success: false, content: '', error: 'File not found' }
    }
    const ext = extname(filePath).toLowerCase()
    if (ext === '.docx') {
      const text = await readDocxRawText(filePath)
      if (!text && existsSync(filePath)) {
        return { success: false, content: '', error: 'DOCX 读取失败或正文为空' }
      }
      return { success: true, content: text }
    }
    if (isBinaryFile(filePath)) {
      return { success: false, content: '', error: `不支持直接编辑二进制文件: ${ext || 'unknown'}` }
    }
    const content = await readFile(filePath, 'utf-8')
    return { success: true, content }
  } catch (error) {
    return {
      success: false,
      content: '',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export async function writeDocumentEditableText(
  filePath: string,
  content: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const ext = extname(filePath).toLowerCase()
    if (ext === '.docx') {
      return writeDocxFromContent(filePath, content)
    }
    if (isTextWriteBlocked(filePath)) {
      return {
        success: false,
        error: `无法直接以纯文本保存到 ${ext || 'binary'} 文件。请另存为 .md/.txt，避免损坏原文件。`,
      }
    }
    await writeFile(filePath, content, 'utf-8')
    return { success: true }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function resolveDialogWindow(parentWindow?: BrowserWindow | null): BrowserWindow | null {
  if (parentWindow && !parentWindow.isDestroyed()) return parentWindow
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && !focused.isDestroyed()) return focused
  return BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed()) || null
}

async function saveDocumentWithDialog(payload: {
  content?: string
  contentBase64?: string
  suggestedName?: string
  defaultPath?: string | null
}, parentWindow?: BrowserWindow | null): Promise<{
  success: boolean
  path?: string
  canceled?: boolean
  error?: string
  errorCode?: string
  /** When refused due to a size guard, the configured max byte cap. */
  max?: number
  /** When refused due to a size guard, the actual decoded byte length. */
  actual?: number
}> {
  try {
    const win = resolveDialogWindow(parentWindow)
    if (!win) return { success: false, error: 'No window' }

    const suggestedName = (payload.suggestedName || '新文档.md').trim() || '新文档.md'
    const safeSuggestedName = extname(suggestedName) ? suggestedName : `${suggestedName}.md`
    const defaultDir = payload.defaultPath ? dirname(payload.defaultPath) : homedir()
    const suggestedExt = extname(safeSuggestedName).toLowerCase()
    const saveResult = await dialog.showSaveDialog(win, {
      title: '保存文档',
      defaultPath: join(defaultDir, safeSuggestedName),
      filters: suggestedExt === '.png'
        ? [
            { name: 'PNG 图片', extensions: ['png'] },
            { name: '所有文件', extensions: ['*'] },
          ]
        : [
            { name: 'Markdown 文档', extensions: ['md'] },
            { name: '文本文件', extensions: ['txt'] },
            { name: 'HTML 快照', extensions: ['html'] },
            { name: 'Word 文档', extensions: ['docx'] },
            { name: '所有文件', extensions: ['*'] },
          ],
    })

    if (saveResult.canceled || !saveResult.filePath) {
      return { success: false, canceled: true, error: 'cancelled' }
    }

    if (payload.contentBase64) {
      // D2 perf guard: refuse oversized base64 payloads instead of blocking the
      // main thread inside Buffer.from for tens of MB. Renderer should switch
      // to a streamed path for these.
      const approxBytes = base64DecodedLength(payload.contentBase64)
      const category = categoryFromSuggestedName(payload.suggestedName || saveResult.filePath)
      const decision = decideAttachmentSize(approxBytes, category)
      if (decision.kind === 'attachment_too_large') {
        return {
          success: false,
          error: 'attachment_too_large',
          errorCode: 'ATTACHMENT_TOO_LARGE',
          max: decision.max,
          actual: decision.actual,
        }
      }
      if (decision.kind === 'video_too_large_for_base64') {
        return {
          success: false,
          error: 'video_too_large_for_base64',
          errorCode: 'VIDEO_TOO_LARGE_FOR_BASE64',
          max: decision.max,
          actual: decision.actual,
        }
      }
      if (decision.kind === 'image_too_large_for_base64') {
        return {
          success: false,
          error: 'image_too_large_for_base64',
          errorCode: 'IMAGE_TOO_LARGE_FOR_BASE64',
          max: decision.max,
          actual: decision.actual,
        }
      }
      await writeFile(saveResult.filePath, Buffer.from(payload.contentBase64, 'base64'))
      return { success: true, path: saveResult.filePath }
    }

    if (extname(saveResult.filePath).toLowerCase() === '.html') {
      const title = basename(saveResult.filePath, '.html') || 'Document Snapshot'
      const html = buildDocumentHtmlSnapshotExport(payload.content || '', title)
      await writeFile(saveResult.filePath, html, 'utf-8')
      return { success: true, path: saveResult.filePath }
    }

    const writeResult = await writeDocumentEditableText(saveResult.filePath, payload.content || '')
    if (!writeResult.success) {
      return { success: false, error: writeResult.error || '文档写入失败' }
    }

    return { success: true, path: saveResult.filePath }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Stage V V2.3a — dispose handle returned by `markGroup.register`. The 4
 * document mark channels live in `ipc/mark-group.ts`; the host keeps the
 * dispose handle so a re-entrant `setupDocumentIPC` (dev-reload) can drop
 * the prior registration before the next one binds. A future
 * `cleanupDocumentEngine` hook will drain this on shutdown.
 */
let markGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.3b — dispose handle returned by `fileIoGroup.register`. The 8
 * file-I/O channels (read/write/saveAs/list + openFolder/openPath/
 * showInFolder/createFile) live in `ipc/file-io-group.ts`; same dev-reload
 * lifecycle as MarkGroup.
 */
let fileIoGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.3c — dispose handle returned by `fileMutationGroup.register`.
 * The 6 file-management channels (mkdir/rename/delete/copy/move/stat) live
 * in `ipc/file-mutation-group.ts`; same dev-reload lifecycle as MarkGroup
 * and FileIoGroup.
 */
let fileMutationGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.3d — dispose handle returned by `workspaceGroup.register`.
 * The 3 workspace-portability channels (exportWorkspace/importWorkspace/
 * getHome) live in `ipc/workspace-group.ts`; same dev-reload lifecycle as
 * the other extracted groups.
 */
let workspaceGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.3e — dispose handle returned by `parserGroup.register`.
 * The 3 parser channels (parseDocx/parseXlsx/importEbookAsMarkdown) live
 * in `ipc/parser-group.ts`; same dev-reload lifecycle as the other
 * extracted groups.
 */
let parserGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.3f — dispose handle returned by `watchGroup.register`. The
 * single `document:watchDirectories` channel + the per-sender
 * `document:directoryChanged` push live in `ipc/watch-group.ts`; same
 * dev-reload lifecycle as the other extracted groups. Disposing the
 * handle closes every live `FSWatcher` before unhooking the request
 * channel so renderer reloads cannot leak file descriptors.
 */
let watchGroupDispose: IpcDisposeHandle | null = null

export function setupDocumentIPC(useMock = false): void {
  // Renderer notifies main whenever a widget update has been committed into the tab content store.
  //   Pipeline executor waits on this via documentCommitRegistry.waitForCommitAfter so the write
  //   step is acked by the actual editor state, not just the tool-call IPC round-trip.
  ipcMain.removeAllListeners('document:widgetCommitted')
  ipcMain.on('document:widgetCommitted', (_event, payload: DocumentWidgetCommitEvent) => {
    if (!payload || typeof payload !== 'object') return
    const tabId = typeof payload.tabId === 'string' ? payload.tabId : ''
    const widgetId = typeof payload.widgetId === 'string' ? payload.widgetId : ''
    const committedAt = typeof payload.committedAt === 'number' ? payload.committedAt : Date.now()
    if (!tabId || !widgetId) return
    documentCommitRegistry.record({
      tabId,
      widgetId,
      requestId: typeof payload.requestId === 'string' ? payload.requestId : undefined,
      committedAt,
    })
  })

  // Stage V V2.3f — `document:watchDirectories` (request) and the paired
  // `document:directoryChanged` push moved into `watchGroup`. The group
  // owns the per-sender `FSWatcher` session lifecycle, debounced fan-out,
  // and the `sender.once('destroyed')` cleanup hook; dispose closes every
  // live watcher before unhooking the channel. The push literal stays
  // visible to the V5 IPC contract gate via the inline
  // `session.sender.send('document:directoryChanged', …)` in the group.
  if (watchGroupDispose) {
    try { watchGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    watchGroupDispose = null
  }
  watchGroupDispose = watchGroup.register(ipcMain, { useMock })

  // Stage V V2.3a — 4 document mark channels (`document:listMarks`,
  // `document:createMark`, `document:updateMark`, `document:deleteMark`)
  // moved into `markGroup`. The group handles dev-reload removeHandler
  // pre-clear internally; we hold the dispose handle so a future cleanup
  // hook (or the next setupDocumentIPC entry) can drop them on shutdown.
  // Re-binding on dev reload first calls `dispose()` on the prior handle
  // so listener slots stay clean.
  if (markGroupDispose) {
    try { markGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    markGroupDispose = null
  }
  markGroupDispose = markGroup.register(ipcMain, {
    useMock,
    getDocumentMarksRepository: () => {
      const rawDb = getDatabase().getRawDb()
      if (!rawDb) throw new Error('database_unavailable')
      return new DocumentMarksRepository(rawDb)
    },
  })

  // Stage V V2.3b — 8 file-I/O channels (`document:read`, `document:write`,
  // `document:saveAs`, `document:list`, `document:openFolder`,
  // `document:openPath`, `document:showInFolder`, `document:createFile`)
  // moved into `fileIoGroup`. The host injects the mutable write-index hook
  // getter, the editable-text writer, the save-dialog flow, the dialog/
  // shell facades, and the workspace-validation context — everything the
  // 8 handler bodies touch is captured in the per-group deps contract.
  if (fileIoGroupDispose) {
    try { fileIoGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    fileIoGroupDispose = null
  }
  fileIoGroupDispose = fileIoGroup.register(ipcMain, {
    useMock,
    getDocumentWriteIndexHook: () => documentWriteIndexHook,
    writeDocumentEditableText,
    saveDocumentWithDialog,
    resolveDialogWindow,
    getBrowserWindowFromWebContents: (sender) => BrowserWindow.fromWebContents(sender),
    showOpenDialog: (window, options) => dialog.showOpenDialog(window, options),
    showItemInFolder: (target) => shell.showItemInFolder(target),
    openShellPath: (target) => shell.openPath(target),
    validateWorkspaceRoot: (picked) => validateWorkspaceRoot(picked, {
      homeDir: homedir(),
      accessCheck: (p) => {
        try {
          accessSync(p, fsConstants.R_OK)
          return true
        } catch {
          return false
        }
      },
    }),
  })

  // Stage V V2.3c — 6 file-management channels (`document:mkdir`,
  // `document:rename`, `document:delete`, `document:copy`, `document:move`,
  // `document:stat`) moved into `fileMutationGroup`. The group only needs
  // the mock flag — no dialog, no shell, no marks repo — because the inline
  // handlers were already self-contained fs/promises calls.
  if (fileMutationGroupDispose) {
    try { fileMutationGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    fileMutationGroupDispose = null
  }
  fileMutationGroupDispose = fileMutationGroup.register(ipcMain, {
    useMock,
  })

  // Stage V V2.3d — 3 workspace-portability channels
  // (`document:exportWorkspace`, `document:importWorkspace`,
  // `document:getHome`) moved into `workspaceGroup`. The group needs the
  // dialog facades (save + open-file, distinct from the FileIoGroup's
  // open-folder facade), the window-resolution helpers it shares with
  // FileIoGroup, and the home-directory probe used by both the export
  // default-path hint and the dedicated getHome read.
  if (workspaceGroupDispose) {
    try { workspaceGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    workspaceGroupDispose = null
  }
  workspaceGroupDispose = workspaceGroup.register(ipcMain, {
    resolveDialogWindow,
    getBrowserWindowFromWebContents: (sender) => BrowserWindow.fromWebContents(sender),
    showSaveWorkspaceDialog: (window, options) => dialog.showSaveDialog(window, options),
    showOpenWorkspaceFileDialog: (window, options) => dialog.showOpenDialog(window, options),
    getHomeDirectory: () => homedir(),
  })

  // Stage V V2.3e — 3 parser channels (`document:parseDocx`,
  // `document:parseXlsx`, `document:importEbookAsMarkdown`) moved into
  // `parserGroup`. The group needs the mock flag, the lazy mammoth/xlsx
  // module getters (host owns the singleton cache), the ebook importer
  // facade, and the write-index hook (shared with FileIoGroup so the
  // ebook importer can fan its `index.md` back into the search engine).
  if (parserGroupDispose) {
    try { parserGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    parserGroupDispose = null
  }
  parserGroupDispose = parserGroup.register(ipcMain, {
    useMock,
    getDocumentWriteIndexHook: () => documentWriteIndexHook,
    getMammothModule: () => getMammoth(),
    getXlsxModule: () => getXlsx(),
    importEbookAsMarkdown: (sourcePath) => importEpubAsMarkdown(sourcePath),
  })

  // --- File Management IPC Handlers ---
  // Stage V V2.3c — `document:mkdir`, `document:rename`, `document:delete`,
  // `document:copy`, `document:move`, `document:stat` moved into
  // `fileMutationGroup`. See breadcrumb + registration block above.

  // Stage V V2.3b — `document:openFolder` moved into `fileIoGroup`. The
  // group injects the workspace-validation context (homeDir + accessSync
  // probe) so the handler stays pure.

  // Stage V V2.3d — `document:exportWorkspace`, `document:importWorkspace`,
  // and `document:getHome` moved into `workspaceGroup`. See the breadcrumb
  // + registration block alongside the other extracted groups above.

  // Stage V V2.3b — `document:showInFolder`, `document:openPath`, and
  // `document:createFile` moved into `fileIoGroup` alongside the rest of
  // the file-I/O cluster. The group's single registration site sits with
  // the MarkGroup wiring above so dev-reload disposes both groups together.
}
