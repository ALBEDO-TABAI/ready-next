// Stage V V2.3b — document-engine FileIoGroup channel cluster.
//
// Bundles the 8 channels that drive file I/O between the renderer and the
// host filesystem (read/write/saveAs/list + the openFolder/openPath/
// showInFolder/createFile companions):
//
//   document:read          (read a path; binary files return a local-file://
//                           URL + optional inline bytes per the size guard)
//   document:write         (write editable text to a path; fires the
//                           document write-index hook on success)
//   document:saveAs        (host-owned save dialog flow with size guards)
//   document:list          (enumerate a directory; hides internal
//                           autosave/empty-backup files)
//   document:openFolder    (open-directory dialog; optional workspace
//                           validation against the shared schema)
//   document:openPath      (shell.openPath on an existing file/folder)
//   document:showInFolder  (shell.showItemInFolder on an existing path)
//   document:createFile    (create an empty file; refuse if it exists)
//
// Handler bodies are lifted VERBATIM from `ipc-handler.ts` (V2.3b follows
// the V2.3a move + thin-wrapper shape). The handlers do NOT import electron
// at runtime: dialog, shell, and BrowserWindow are wrapped behind small
// facades on `FileIoGroupDeps` so the group is testable with a stub host
// and so a future move out of document-engine stays mechanical.
//
// The 8 channels live in one group despite ranging across reads
// (`read`/`list`), mutations (`write`/`saveAs`/`createFile`), and shell
// integrations (`openFolder`/`openPath`/`showInFolder`) because they share:
//   • the same domain concept (renderer-driven file I/O for documents)
//   • the same dispose lifecycle (renderer wires them as one feature
//     toggle in the document workbench)
//   • the same dep surface (mock flag + host file helpers + dialog/shell
//     facades + workspace validation)
// Splitting reads from writes or peeling the shell helpers into a sibling
// would create groups whose deps overlap entirely — against the
// per-group-deps-as-contract intent.
import { readFile, readdir, stat, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname, extname, join } from 'path'
import type { IpcMain } from 'electron'
import { EBOOK_BINARY_EXTENSIONS } from '../../../../shared/ebook'
import { BINARY_EXTENSIONS } from '../binary-extensions'
import {
  type AttachmentCategory,
  DOCUMENT_TEXT_READ_CAP_BYTES,
  decideReadAttachmentSize,
  isDocumentTextReadTooLarge,
} from '../attachment-size-guards'
import type { EngineDeps, SaveAsPayload } from './engine-deps'
import { broadcastDirectoryChanged } from './directory-change-broadcast'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

/**
 * Per-group deps — subset of `EngineDeps`. Tests pass a fake that
 * implements exactly these members; nothing more is required to exercise
 * the 8 handler bodies.
 */
export type FileIoGroupDeps = Pick<
  EngineDeps,
  | 'useMock'
  | 'getDocumentWriteIndexHook'
  | 'writeDocumentEditableText'
  | 'saveDocumentWithDialog'
  | 'resolveDialogWindow'
  | 'getBrowserWindowFromWebContents'
  | 'showOpenDialog'
  | 'showItemInFolder'
  | 'openShellPath'
  | 'validateWorkspaceRoot'
>

const CHANNELS = [
  'document:read',
  'document:write',
  'document:saveAs',
  'document:list',
  'document:openFolder',
  'document:openPath',
  'document:showInFolder',
  'document:createFile',
] as const

// --- Pure helpers (kept inside the group so the contract is self-contained) ---
// These mirror the host's local helpers verbatim; moving them keeps the host
// from re-exporting transient internals just to feed this group. Anything
// stateful (write-index hook, dialog flow, validation) stays on deps.

function isBinaryFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

function getFileCategory(filePath: string): AttachmentCategory {
  const ext = extname(filePath).toLowerCase()
  if (['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.svg', '.tiff', '.tif', '.avif'].includes(ext)) return 'image'
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.wmv', '.m4v'].includes(ext)) return 'video'
  if (['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma'].includes(ext)) return 'audio'
  if (ext === '.pdf') return 'pdf'
  if (EBOOK_BINARY_EXTENSIONS.has(ext)) return 'ebook'
  return 'binary'
}

function toLocalFileUrl(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/')
  const encoded = normalized
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return normalized.startsWith('/')
    ? `local-file://${encoded}`
    : `local-file:///${encoded}`
}

function shouldHideInternalBackup(name: string): boolean {
  return (
    /\.autosave-\d{8}-\d{6}\.bak\.docx$/i.test(name) ||
    /\.empty-backup-\d{8}-\d{6}$/i.test(name)
  )
}

export const fileIoGroup: IpcChannelGroup<FileIoGroupDeps> = {
  namespace: 'document:fileIo',

  register(ipcMain: IpcMain, deps: FileIoGroupDeps): IpcDisposeHandle {
    // setupDocumentIPC may be re-entered on dev reload; strip any prior
    // handler so `ipcMain.handle` does not throw on the second
    // registration. Mirrors the pre-extraction defensive pattern used by
    // the V2.3a MarkGroup and the rss-engine groups (V2.2a).
    for (const channel of CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    // Read file — enhanced with binary file handling via local-file:// URLs
    ipcMain.handle('document:read', async (_, path: string) => {
      try {
        if (deps.useMock) {
          return {
            success: true,
            data: { type: 'text' as const, content: `[Mock] Content of ${path}` },
            mock: true,
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
            category: AttachmentCategory
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
            // PDF and ebook previews read raw bytes more reliably than fetching a custom protocol URL.
            data.bytes = new Uint8Array(await readFile(path))
          }

          return {
            success: true,
            data,
          }
        }

        // Text file — reject oversized files before allocating the UTF-8 string.
        const textStats = await stat(path)
        if (isDocumentTextReadTooLarge(textStats.size)) {
          return {
            success: false,
            error: '文本文件超过 20 MiB，为避免卡死已停止读取。',
            errorCode: 'TEXT_FILE_TOO_LARGE',
            max: DOCUMENT_TEXT_READ_CAP_BYTES,
            actual: textStats.size,
            limitBytes: DOCUMENT_TEXT_READ_CAP_BYTES,
            bytes: textStats.size,
          }
        }
        const content = await readFile(path, 'utf-8')
        return {
          success: true,
          data: { type: 'text' as const, content },
          // Keep backward-compatible `content` at top level
          content,
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return { success: false, error: errorMessage, errorCode: 'PARSE_ERROR' }
      }
    })

    // Write file
    ipcMain.handle('document:write', async (_, { path, content }: { path: string; content: string }) => {
      try {
        if (deps.useMock) {
          return { success: true, mock: true }
        }
        const result = await deps.writeDocumentEditableText(path, content)
        if (!result.success) {
          const ext = extname(path).toLowerCase()
          return {
            success: false,
            error: result.error || '文档写入失败',
            errorCode: ext === '.docx' ? 'DOCX_WRITE_FAILED' : 'UNSUPPORTED_TEXT_WRITE',
          }
        }
        const hook = deps.getDocumentWriteIndexHook()
        if (hook) {
          try {
            hook(path, content)
          } catch (hookError) {
            console.warn('[document-engine] write index hook failed', hookError)
          }
        }
        broadcastDirectoryChanged([dirname(path)])
        return result
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return { success: false, error: errorMessage }
      }
    })

    ipcMain.handle('document:saveAs', async (event, payload: SaveAsPayload) => {
      if (deps.useMock) {
        return {
          success: true,
          path: payload.defaultPath || payload.suggestedName || '新文档.md',
          mock: true,
        }
      }
      const result = await deps.saveDocumentWithDialog(payload, deps.getBrowserWindowFromWebContents(event.sender))
      if (result.success && result.path) broadcastDirectoryChanged([dirname(result.path)])
      return result
    })

    // List directory
    ipcMain.handle('document:list', async (_, dir: string) => {
      try {
        if (deps.useMock) {
          return {
            success: true,
            items: [
              { name: 'documents', path: `${dir}/documents`, isDirectory: true, size: 0, modified: new Date() },
              { name: 'images', path: `${dir}/images`, isDirectory: true, size: 0, modified: new Date() },
              { name: 'readme.md', path: `${dir}/readme.md`, isDirectory: false, size: 1024, modified: new Date() },
            ],
            mock: true,
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
              modified: stats.mtime,
            }
          } catch {
            // Handle permission errors or broken symlinks gracefully
            return {
              name,
              path: filePath,
              isDirectory: false,
              size: 0,
              modified: new Date(0),
            }
          }
        }))

        return { success: true, items: entries }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        return { success: false, error: errorMessage, errorCode: 'PARSE_ERROR' }
      }
    })

    // Open folder dialog — let user choose a workspace directory.
    //
    // Optional payload `{ validateAsWorkspace: true }` runs the shared
    // `validateWorkspaceRoot` check (with an fs.accessSync read probe) before
    // returning the path. Callers that pick a folder for *non*-workspace
    // purposes (e.g. RSS download dir, skill import) pass no payload and get
    // the legacy unconditional behavior.
    ipcMain.handle('document:openFolder', async (event, payload?: { validateAsWorkspace?: boolean; title?: string }) => {
      try {
        const win = deps.resolveDialogWindow(deps.getBrowserWindowFromWebContents(event.sender))
        if (!win) return { success: false, error: 'No window' }
        const result = await deps.showOpenDialog(win, {
          properties: ['openDirectory'],
          title: payload?.title || '选择工作区目录',
        })
        if (result.canceled || result.filePaths.length === 0) {
          return { success: false, error: 'cancelled' }
        }
        const picked = result.filePaths[0]
        if (payload?.validateAsWorkspace) {
          const validation = deps.validateWorkspaceRoot(picked)
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

    // Reveal in system file manager
    ipcMain.handle('document:showInFolder', async (_, path: string) => {
      try {
        if (!existsSync(path)) return { success: false, error: 'Not found' }
        deps.showItemInFolder(path)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    ipcMain.handle('document:openPath', async (_, path: string) => {
      try {
        if (!existsSync(path)) return { success: false, error: 'Not found' }
        await deps.openShellPath(path)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    // Create a new empty file
    ipcMain.handle('document:createFile', async (_, path: string) => {
      try {
        if (deps.useMock) return { success: true, mock: true }
        if (existsSync(path)) return { success: false, error: 'File already exists' }
        await writeFile(path, '', 'utf-8')
        broadcastDirectoryChanged([dirname(path)])
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    })

    return {
      dispose(): void {
        for (const channel of CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* ignore — already removed */ }
        }
      },
    }
  },
}

/** Exposed for the registration-behavior test (channels list assertion). */
export const _fileIoGroupChannelsForTest: ReadonlyArray<string> = CHANNELS
