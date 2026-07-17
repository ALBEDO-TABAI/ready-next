import { app, ipcMain, dialog, shell, BrowserWindow } from 'electron'
import {
  statSync, existsSync,
  accessSync, constants as fsConstants,
} from 'fs'
import { join, basename, dirname, extname } from 'path'
import { homedir } from 'os'
import { buildDocumentHtmlSnapshotExport } from '../../../shared/document-widget-html-export'
import { documentCommitRegistry } from './document-commit-registry'
import { validateWorkspaceRoot } from '../../../shared/workspace-validation'
import { EBOOK_BINARY_EXTENSIONS } from '../../../shared/ebook'
import { readDocumentEditableText, writeDocumentEditableText } from './document-editable-text'
import { getDocumentWorker } from './document-worker-bridge'
import { publishFileAtomically } from './atomic-file-publish'
import { getDatabase } from '../database'
import { DocumentMarksRepository } from './document-marks-repository'
import { markGroup } from './ipc/mark-group'
import { fileIoGroup } from './ipc/file-io-group'
import { fileMutationGroup } from './ipc/file-mutation-group'
import { workspaceGroup } from './ipc/workspace-group'
import { parserGroup } from './ipc/parser-group'
import { watchGroup } from './ipc/watch-group'
import { widgetGroup } from './ipc/widget-group'
import { exportGroup } from './ipc/export-group'
import { renderHtmlToPdfBuffer } from './export/pdf-renderer'
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

// BINARY_EXTENSIONS lives in `./binary-extensions` so test files (and the
// search-engine adapter) can import it without pulling `electron` through
// this module. Re-export here to preserve the existing public surface.
export { BINARY_EXTENSIONS } from './binary-extensions'
export { readDocumentEditableText, writeDocumentEditableText } from './document-editable-text'

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
export type DocumentMoveIdentityHook = (input: { oldPath: string; newPath: string; isDirectory: boolean }) => void

const documentWriteListeners = new Set<DocumentWriteIndexHook>()
const documentMoveIdentityListeners = new Set<DocumentMoveIdentityHook>()

const documentWriteIndexHook: DocumentWriteIndexHook = (path, content) => {
  for (const listener of Array.from(documentWriteListeners)) {
    listener(path, content)
  }
}

export function addDocumentWriteListener(listener: DocumentWriteIndexHook): () => void {
  documentWriteListeners.add(listener)
  return () => {
    documentWriteListeners.delete(listener)
  }
}

export function setDocumentWriteIndexHook(hook: DocumentWriteIndexHook | null): void {
  documentWriteListeners.clear()
  if (hook) documentWriteListeners.add(hook)
}

export function addDocumentMoveIdentityListener(listener: DocumentMoveIdentityHook): () => void {
  documentMoveIdentityListeners.add(listener)
  return () => {
    documentMoveIdentityListeners.delete(listener)
  }
}

function notifyDocumentPathMoved(input: { oldPath: string; newPath: string; isDirectory: boolean }): void {
  for (const listener of Array.from(documentMoveIdentityListeners)) listener(input)
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
      await publishFileAtomically(saveResult.filePath, Buffer.from(payload.contentBase64, 'base64'))
      return { success: true, path: saveResult.filePath }
    }

    if (extname(saveResult.filePath).toLowerCase() === '.html') {
      const title = basename(saveResult.filePath, '.html') || 'Document Snapshot'
      const html = buildDocumentHtmlSnapshotExport(payload.content || '', title)
      await publishFileAtomically(saveResult.filePath, html)
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
 * single `document:watchDirectories` channel lives in `ipc/watch-group.ts`;
 * the shared directory broadcaster owns the per-sender push. Disposing the
 * handle closes every live `FSWatcher` before unhooking the request
 * channel so renderer reloads cannot leak file descriptors.
 */
let watchGroupDispose: IpcDisposeHandle | null = null

/**
 * Stage V V2.3g — dispose handle returned by `widgetGroup.register`. The
 * single `document:widgetCommitted` listener (renderer → main push) lives
 * in `ipc/widget-group.ts`; same dev-reload lifecycle as the other
 * extracted groups. This is the FINAL document-engine group move — the
 * ipc-handler.ts split is now complete (7 groups: mark / fileIo /
 * fileMutation / workspace / parser / watch / widget).
 */
let widgetGroupDispose: IpcDisposeHandle | null = null

/**
 * Dispose handle returned by `exportGroup.register`. The 2 document export
 * channels (`document:exportPdf`, `document:exportMarkdownBundle`) live in
 * `ipc/export-group.ts`; same dev-reload lifecycle as the other groups.
 */
let exportGroupDispose: IpcDisposeHandle | null = null

export function setupDocumentIPC(useMock = false): void {
  // Stage V V2.3g — `document:widgetCommitted` (renderer → main push)
  // moved into `widgetGroup`. The group owns the listener registration
  // + dev-reload pre-clear; the handler body (payload validation +
  // `documentCommitRegistry.record(…)` sink) is lifted verbatim. The
  // V5 IPC contract gate continues to pair the literal in this file's
  // `ipcMain.on(…)` (now inside the group) with the preload-side
  // `ipcRenderer.send('document:widgetCommitted', …)`.
  if (widgetGroupDispose) {
    try { widgetGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    widgetGroupDispose = null
  }
  widgetGroupDispose = widgetGroup.register(ipcMain, {
    recordCommit: (event) => documentCommitRegistry.record(event),
  })

  // Stage V V2.3f — `document:watchDirectories` moved into `watchGroup`.
  // The group owns each sender's watcher lifecycle and contributes changes
  // to the shared broadcaster, which is the only directoryChanged push
  // authority. Dispose closes every live watcher before unhooking the channel.
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

  // Stage V V2.3c — file-management channels (`document:mkdir`,
  // `document:rename`, `document:deletePermanent`, `document:copy`,
  // `document:move`, `document:stat`) moved into `fileMutationGroup`.
  if (fileMutationGroupDispose) {
    try { fileMutationGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    fileMutationGroupDispose = null
  }
  fileMutationGroupDispose = fileMutationGroup.register(ipcMain, {
    useMock,
    onPathMoved: notifyDocumentPathMoved,
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

  // Document export channels (`document:exportPdf`,
  // `document:exportMarkdownBundle`) — top-bar 导出 button. The group gets
  // the save-dialog facade (shared window-resolution helper) and the hidden
  // -window PDF renderer; zip assembly lives inside the group.
  if (exportGroupDispose) {
    try { exportGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    exportGroupDispose = null
  }
  exportGroupDispose = exportGroup.register(ipcMain, {
    showExportSaveDialog: async (request) => {
      const window = resolveDialogWindow()
      if (!window) return { canceled: true }
      const result = await dialog.showSaveDialog(window, {
        title: request.title,
        defaultPath: request.defaultPath,
        filters: request.filters,
      })
      return { canceled: result.canceled, filePath: result.filePath || undefined }
    },
    renderHtmlToPdf: (html) => renderHtmlToPdfBuffer({ html, tempDir: app.getPath('temp') }),
    getFallbackExportDir: () => homedir(),
  })

  // Stage V V2.3e — 3 parser channels (`document:parseDocx`,
  // `document:parseXlsx`, `document:importEbookAsMarkdown`) moved into
  // `parserGroup`. The group receives lazy document-worker facades and the
  // write-index hook (shared with FileIoGroup so the
  // ebook importer can fan its `index.md` back into the search engine).
  if (parserGroupDispose) {
    try { parserGroupDispose.dispose() } catch { /* ignore — handlers may already be gone */ }
    parserGroupDispose = null
  }
  parserGroupDispose = parserGroup.register(ipcMain, {
    useMock,
    getDocumentWriteIndexHook: () => documentWriteIndexHook,
    parseDocxInWorker: (path) => getDocumentWorker().parseDocx(path),
    parseXlsxInWorker: (path) => getDocumentWorker().parseXlsx(path),
    importEbookInWorker: (sourcePath) => getDocumentWorker().importEpub(sourcePath),
  })

  // --- File Management IPC Handlers ---
  // Stage V V2.3c — `document:mkdir`, `document:rename`,
  // `document:deletePermanent`, `document:copy`, `document:move`,
  // `document:stat` moved into `fileMutationGroup`.
  // See breadcrumb + registration block above.

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
