import { ipcMain, dialog, shell, BrowserWindow, type WebContents } from 'electron'
import {
  writeFileSync, statSync, existsSync,
  copyFileSync, watch, accessSync, constants as fsConstants, type FSWatcher
} from 'fs'
import { readFile, readdir, stat, writeFile, rename, cp, mkdir, unlink, rm, copyFile } from 'fs/promises'
import { join, basename, dirname, extname } from 'path'
import { homedir } from 'os'
import { buildDocumentHtmlSnapshotExport } from '../../../shared/document-widget-html-export'
import { documentCommitRegistry, type DocumentWidgetCommitEvent } from './document-commit-registry'
import { validateWorkspaceRoot } from '../../../shared/workspace-validation'
import { BINARY_EXTENSIONS } from './binary-extensions'
import {
  ATTACHMENT_HARD_CAP_BYTES,
  IMAGE_INLINE_CAP_BYTES,
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
  return `local-file:///${encoded}` // Three slashes for absolute paths
}

/** Detect content type category from extension */
function getFileCategory(filePath: string): 'image' | 'video' | 'audio' | 'pdf' | 'binary' {
  const ext = extname(filePath).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.svg', '.tiff', '.tif', '.avif'].includes(ext)) return 'image'
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.m4v'].includes(ext)) return 'video'
  if (['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma'].includes(ext)) return 'audio'
  if (ext === '.pdf') return 'pdf'
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

async function saveDocumentWithDialog(payload: {
  content?: string
  contentBase64?: string
  suggestedName?: string
  defaultPath?: string | null
}): Promise<{
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
    const win = BrowserWindow.getFocusedWindow()
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

  type DirectoryWatchSession = {
    sender: WebContents
    watchers: Map<string, FSWatcher>
    debounceTimer: NodeJS.Timeout | null
    pendingPaths: Set<string>
  }

  const directoryWatchSessions = new Map<number, DirectoryWatchSession>()

  const closeDirectoryWatchSession = (senderId: number) => {
    const session = directoryWatchSessions.get(senderId)
    if (!session) return
    if (session.debounceTimer) {
      clearTimeout(session.debounceTimer)
    }
    session.watchers.forEach((watcher) => watcher.close())
    directoryWatchSessions.delete(senderId)
  }

  const ensureDirectoryWatchSession = (sender: WebContents): DirectoryWatchSession => {
    const existing = directoryWatchSessions.get(sender.id)
    if (existing) return existing

    const session: DirectoryWatchSession = {
      sender,
      watchers: new Map<string, FSWatcher>(),
      debounceTimer: null,
      pendingPaths: new Set<string>(),
    }

    sender.once('destroyed', () => {
      closeDirectoryWatchSession(sender.id)
    })

    directoryWatchSessions.set(sender.id, session)
    return session
  }

  const queueDirectoryWatchEvent = (session: DirectoryWatchSession, watchedPath: string) => {
    session.pendingPaths.add(watchedPath)
    if (session.debounceTimer) return

    session.debounceTimer = setTimeout(() => {
      session.debounceTimer = null
      if (session.sender.isDestroyed()) return
      const paths = Array.from(session.pendingPaths)
      session.pendingPaths.clear()
      session.sender.send('document:directoryChanged', {
        paths,
        timestamp: Date.now(),
      })
    }, 140)
  }

  const syncWatchedDirectories = (sender: WebContents, rawPaths: string[]): string[] => {
    const session = ensureDirectoryWatchSession(sender)
    const normalizedPaths = Array.from(
      new Set(
        rawPaths
          .map((value) => String(value || '').trim())
          .filter(Boolean)
          .filter((value) => {
            if (!existsSync(value)) return false
            try {
              return statSync(value).isDirectory()
            } catch {
              return false
            }
          }),
      ),
    )

    session.watchers.forEach((watcher, watchedPath) => {
      if (normalizedPaths.includes(watchedPath)) return
      watcher.close()
      session.watchers.delete(watchedPath)
    })

    normalizedPaths.forEach((dirPath) => {
      if (session.watchers.has(dirPath)) return
      try {
        const watcher = watch(dirPath, { persistent: false }, () => {
          queueDirectoryWatchEvent(session, dirPath)
        })
        watcher.on('error', () => {
          watcher.close()
          session.watchers.delete(dirPath)
        })
        session.watchers.set(dirPath, watcher)
      } catch {
        // Ignore unwatchable paths; other directories should continue to work.
      }
    })

    return Array.from(session.watchers.keys())
  }

  ipcMain.handle('document:watchDirectories', async (event, payload: { paths?: string[] }) => {
    try {
      if (useMock) {
        return { success: true, data: { watchedPaths: [] }, mock: true }
      }
      const watchedPaths = syncWatchedDirectories(event.sender, Array.isArray(payload?.paths) ? payload.paths : [])
      return { success: true, data: { watchedPaths } }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Read file — enhanced with binary file handling via local-file:// URLs
  ipcMain.handle('document:read', async (_, path: string) => {
    try {
      if (useMock) {
        return {
          success: true,
          data: { type: 'text' as const, content: `[Mock] Content of ${path}` },
          mock: true
        }
      }

      if (!existsSync(path)) {
        return { success: false, error: 'File not found', errorCode: 'FILE_NOT_FOUND' }
      }

      // For binary files, return a local-file:// URL instead of content
      if (isBinaryFile(path)) {
        const category = getFileCategory(path)
        const extension = extname(path).toLowerCase()
        // Pre-stat to size-guard inline byte loads and flag oversized media
        // so the renderer can fall back to a streaming/<video src=local-file://>
        // path instead of rehydrating tens of MB through structured clone.
        const stats = await stat(path)
        const decision = decideReadAttachmentSize(stats.size, category)
        if (decision.kind === 'attachment_too_large') {
          return {
            success: false,
            error: 'attachment_too_large',
            errorCode: 'ATTACHMENT_TOO_LARGE',
            max: decision.max,
            actual: decision.actual,
          }
        }
        if (decision.kind === 'pdf_too_large_for_inline_bytes') {
          return {
            success: false,
            error: 'pdf_too_large_for_inline_bytes',
            errorCode: 'PDF_TOO_LARGE_FOR_INLINE_BYTES',
            max: decision.max,
            actual: decision.actual,
          }
        }
        const data: {
          type: 'binary'
          category: 'image' | 'video' | 'audio' | 'pdf' | 'binary'
          localUrl: string
          extension: string
          bytes?: Uint8Array
          size: number
          /** Set when the file is too large to inline — renderer should stream from `localUrl`. */
          kind?: 'large_video_ref' | 'large_image_ref'
        } = {
          type: 'binary',
          category,
          localUrl: toLocalFileUrl(path),
          extension,
          size: stats.size,
        }

        if (decision.kind === 'large_video_ref') {
          data.kind = 'large_video_ref'
        } else if (decision.kind === 'large_image_ref') {
          data.kind = 'large_image_ref'
        } else if (decision.kind === 'ok' && decision.loadInlineBytes) {
          // react-pdf reads raw bytes more reliably than fetching a custom protocol URL.
          data.bytes = new Uint8Array(await readFile(path))
        }

        return {
          success: true,
          data,
        }
      }

      // Text file — read as UTF-8
      const content = await readFile(path, 'utf-8')
      return {
        success: true,
        data: { type: 'text' as const, content },
        // Keep backward-compatible `content` at top level
        content
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage, errorCode: 'PARSE_ERROR' }
    }
  })

  // Write file
  ipcMain.handle('document:write', async (_, { path, content }: { path: string; content: string }) => {
    try {
      if (useMock) {
        return { success: true, mock: true }
      }
      const result = await writeDocumentEditableText(path, content)
      if (!result.success) {
        const ext = extname(path).toLowerCase()
        return {
          success: false,
          error: result.error || '文档写入失败',
          errorCode: ext === '.docx' ? 'DOCX_WRITE_FAILED' : 'UNSUPPORTED_TEXT_WRITE',
        }
      }
      if (documentWriteIndexHook) {
        try {
          documentWriteIndexHook(path, content)
        } catch (hookError) {
          console.warn('[document-engine] write index hook failed', hookError)
        }
      }
      return result
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage }
    }
  })

  ipcMain.handle('document:saveAs', async (_, payload: { content?: string; contentBase64?: string; suggestedName?: string; defaultPath?: string | null }) => {
    if (useMock) {
      return {
        success: true,
        path: payload.defaultPath || payload.suggestedName || '新文档.md',
        mock: true,
      }
    }
    return saveDocumentWithDialog(payload)
  })

  // List directory
  ipcMain.handle('document:list', async (_, dir: string) => {
    try {
      if (useMock) {
        return {
          success: true,
          items: [
            { name: 'documents', path: `${dir}/documents`, isDirectory: true, size: 0, modified: new Date() },
            { name: 'images', path: `${dir}/images`, isDirectory: true, size: 0, modified: new Date() },
            { name: 'readme.md', path: `${dir}/readme.md`, isDirectory: false, size: 1024, modified: new Date() }
          ],
          mock: true
        }
      }

      if (!existsSync(dir)) {
        return { success: false, error: 'Directory not found', errorCode: 'FILE_NOT_FOUND' }
      }

      const items = (await readdir(dir))
        .filter((name) => !shouldHideInternalBackup(name))
      const entries = await Promise.all(items.map(async (name) => {
        const filePath = join(dir, name)
        try {
          const stats = await stat(filePath)
          return {
            name,
            path: filePath,
            isDirectory: stats.isDirectory(),
            size: stats.size,
            modified: stats.mtime
          }
        } catch {
          // Handle permission errors or broken symlinks gracefully
          return {
            name,
            path: filePath,
            isDirectory: false,
            size: 0,
            modified: new Date(0)
          }
        }
      }))

      return { success: true, items: entries }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { success: false, error: errorMessage, errorCode: 'PARSE_ERROR' }
    }
  })

  // Parse docx — real parsing with mammoth, returns { html, rawText }
  ipcMain.handle('document:parseDocx', async (_, path: string) => {
    try {
      if (useMock) {
        return {
          success: true,
          data: {
            html: '<p>[Mock] DOCX parsing requires mammoth.js</p>',
            rawText: '[Mock] DOCX parsing requires mammoth.js'
          },
          // backward compat
          content: '<p>[Mock] DOCX parsing requires mammoth.js</p>',
          html: '<p>[Mock] DOCX parsing requires mammoth.js</p>',
          mock: true
        }
      }

      if (!existsSync(path)) {
        return { success: false, error: 'File not found', errorCode: 'FILE_NOT_FOUND', file: path }
      }

      const mammoth = await getMammoth()
      if (!mammoth) {
        return {
          success: false,
          error: 'DOCX parsing library (mammoth) is not installed. Run: npm install mammoth',
          errorCode: 'LIBRARY_NOT_INSTALLED'
        }
      }

      const buffer = await readFile(path)

      // Use the mammoth module — handle both default and named exports
      const mammothMod = (mammoth as unknown as { default?: typeof import('mammoth') }).default || mammoth
      const htmlResult = await mammothMod.convertToHtml({ buffer })
      const textResult = await mammothMod.extractRawText({ buffer })

      return {
        success: true,
        data: {
          html: htmlResult.value,
          rawText: textResult.value,
          messages: htmlResult.messages
        },
        // backward compat
        content: htmlResult.value,
        html: htmlResult.value,
        file: path
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      if (/end of central directory|zip file/i.test(errorMessage)) {
        try {
          const rawText = await readFile(path, 'utf-8')
          if (looksLikeReadableText(rawText)) {
            const html = `<pre>${escapeHtml(rawText)}</pre>`
            return {
              success: true,
              data: {
                html,
                rawText,
                messages: [
                  {
                    type: 'warning',
                    message: 'DOCX 文件结构损坏，已回退为原始文本视图（文件可能曾被当作纯文本覆盖保存）。',
                  },
                ],
              },
              content: html,
              html,
              file: path,
            }
          }
        } catch {
          // Keep original parse error below.
        }
      }
      return {
        success: false,
        error: `Failed to parse DOCX: ${errorMessage}`,
        errorCode: 'PARSE_ERROR',
        file: path
      }
    }
  })

  // Parse xlsx — real parsing with SheetJS, multi-sheet support
  ipcMain.handle('document:parseXlsx', async (_, path: string) => {
    try {
      if (useMock) {
        return {
          success: true,
          data: {
            sheets: [
              { name: 'Sheet1', data: [['A1', 'B1'], ['A2', 'B2']] }
            ]
          },
          // backward compat
          sheets: ['Sheet1'],
          file: path,
          mock: true
        }
      }

      if (!existsSync(path)) {
        return { success: false, error: 'File not found', errorCode: 'FILE_NOT_FOUND', file: path }
      }

      const xlsx = await getXlsx()
      if (!xlsx) {
        return {
          success: false,
          error: 'XLSX parsing library (xlsx) is not installed. Run: npm install xlsx',
          errorCode: 'LIBRARY_NOT_INSTALLED'
        }
      }

      const buffer = await readFile(path)
      const xlsxMod = (xlsx as unknown as { default?: typeof import('xlsx') }).default || xlsx
      const workbook = xlsxMod.read(buffer, { type: 'buffer' })

      // Build structured multi-sheet output: { name, data: string[][] }
      const sheets: Array<{ name: string; data: unknown[][] }> = []
      const legacyData: Record<string, unknown[][]> = {}

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName]
        const rows = xlsxMod.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][]
        sheets.push({ name: sheetName, data: rows })
        legacyData[sheetName] = rows
      }

      return {
        success: true,
        data: { sheets },
        // backward compat
        sheets: workbook.SheetNames,
        // Legacy flat data map
        sheetData: legacyData,
        file: path
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        error: `Failed to parse XLSX: ${errorMessage}`,
        errorCode: 'PARSE_ERROR',
        file: path
      }
    }
  })

  // --- File Management IPC Handlers ---

  // Create directory
  ipcMain.handle('document:mkdir', async (_, path: string) => {
    try {
      if (useMock) return { success: true, mock: true }
      await mkdir(path, { recursive: true })
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Rename file/directory
  ipcMain.handle('document:rename', async (_, { oldPath, newPath }: { oldPath: string; newPath: string }) => {
    try {
      if (useMock) return { success: true, mock: true }
      if (!existsSync(oldPath)) return { success: false, error: 'Source not found' }
      if (existsSync(newPath)) return { success: false, error: 'Target already exists' }
      await rename(oldPath, newPath)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Delete file/directory
  ipcMain.handle('document:delete', async (_, path: string) => {
    try {
      if (useMock) return { success: true, mock: true }
      if (!existsSync(path)) return { success: false, error: 'Not found' }
      const stats = await stat(path)
      if (stats.isDirectory()) {
        await rm(path, { recursive: true, force: true })
      } else {
        await unlink(path)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Copy file/directory
  ipcMain.handle('document:copy', async (_, { src, dest }: { src: string; dest: string }) => {
    try {
      if (useMock) return { success: true, mock: true }
      if (!existsSync(src)) return { success: false, error: 'Source not found' }
      const stats = await stat(src)
      if (stats.isDirectory()) {
        await cp(src, dest, { recursive: true })
      } else {
        await copyFile(src, dest)
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Move file/directory
  ipcMain.handle('document:move', async (_, { src, dest }: { src: string; dest: string }) => {
    try {
      if (useMock) return { success: true, mock: true }
      if (!existsSync(src)) return { success: false, error: 'Source not found' }
      await rename(src, dest)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Get file stats — enhanced with extension and modifiedTime/createdTime
  ipcMain.handle('document:stat', async (_, path: string) => {
    try {
      if (useMock) {
        return {
          success: true,
          mock: true,
          data: { size: 1024, isDirectory: false, modifiedTime: Date.now(), createdTime: Date.now(), extension: '.md' },
          stat: { size: 1024, isDirectory: false, modified: new Date() }
        }
      }
      if (!existsSync(path)) return { success: false, error: 'Not found' }
      const stats = statSync(path)
      const ext = extname(path).toLowerCase()
      return {
        success: true,
        data: {
          size: stats.size,
          modifiedTime: stats.mtime.getTime(),
          createdTime: stats.birthtime.getTime(),
          isDirectory: stats.isDirectory(),
          extension: ext || null
        },
        // backward compat
        stat: {
          size: stats.size,
          isDirectory: stats.isDirectory(),
          modified: stats.mtime,
          created: stats.birthtime
        }
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Open folder dialog — let user choose a workspace directory.
  //
  // Optional payload `{ validateAsWorkspace: true }` runs the shared
  // `validateWorkspaceRoot` check (with an fs.accessSync read probe) before
  // returning the path. Callers that pick a folder for *non*-workspace
  // purposes (e.g. RSS download dir, skill import) pass no payload and get
  // the legacy unconditional behavior.
  ipcMain.handle('document:openFolder', async (_event, payload?: { validateAsWorkspace?: boolean }) => {
    try {
      const win = BrowserWindow.getFocusedWindow()
      if (!win) return { success: false, error: 'No window' }
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: '选择工作区目录'
      })
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: 'cancelled' }
      }
      const picked = result.filePaths[0]
      if (payload?.validateAsWorkspace) {
        const validation = validateWorkspaceRoot(picked, {
          homeDir: homedir(),
          accessCheck: (p) => {
            try {
              accessSync(p, fsConstants.R_OK)
              return true
            } catch {
              return false
            }
          },
        })
        if (!validation.ok) {
          return {
            success: false,
            error: validation.message || `不能将 ${picked} 设为工作区。`,
            validationReason: validation.reason,
            attemptedPath: picked,
          }
        }
      }
      return { success: true, path: picked }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Get home directory
  ipcMain.handle('document:getHome', async () => {
    return { success: true, path: homedir() }
  })

  // Reveal in system file manager
  ipcMain.handle('document:showInFolder', async (_, path: string) => {
    try {
      if (!existsSync(path)) return { success: false, error: 'Not found' }
      shell.showItemInFolder(path)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('document:openPath', async (_, path: string) => {
    try {
      if (!existsSync(path)) return { success: false, error: 'Not found' }
      await shell.openPath(path)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Create a new empty file
  ipcMain.handle('document:createFile', async (_, path: string) => {
    try {
      if (useMock) return { success: true, mock: true }
      if (existsSync(path)) return { success: false, error: 'File already exists' }
      await writeFile(path, '', 'utf-8')
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
}
