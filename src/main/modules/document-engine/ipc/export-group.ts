// Document export channel cluster (top-bar 导出 button):
//
//   document:exportPdf             (capture-HTML → hidden-window printToPDF → save)
//   document:exportMarkdownBundle  (markdown + local media assets → zip → save)
//
// Both flows are dialog-first: the user picks the destination before any
// heavy work (offscreen print / asset packing) happens. Cancel returns
// `{ success: false, canceled: true }` and must stay side-effect free.
//
// Deps are facades so the group is testable without electron: the save
// dialog and the PDF renderer (which owns the hidden BrowserWindow) are
// injected; zip assembly + fs stay in the handler bodies because tests can
// drive them against real temp files.
import { existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { basename, dirname, extname, join } from 'path'
import type { IpcMain } from 'electron'
import JSZip from 'jszip'
import {
  DOCUMENT_EXPORT_HTML_MAX_BYTES,
  type DocumentExportMarkdownBundlePayload,
  type DocumentExportPdfPayload,
  type DocumentExportResult,
} from '../../../../shared/document-export'
import {
  planMarkdownBundle,
  sanitizeExportFolderName,
} from '../export/markdown-bundle'
import type { IpcChannelGroup, IpcDisposeHandle } from './types'

export interface ExportSaveDialogRequest {
  title: string
  defaultPath: string
  filters: Array<{ name: string; extensions: string[] }>
}

export interface ExportGroupDeps {
  /** Wrap `dialog.showSaveDialog` against the current document window. */
  showExportSaveDialog(request: ExportSaveDialogRequest): Promise<{ canceled: boolean; filePath?: string }>
  /** Wrap `renderHtmlToPdfBuffer` (hidden BrowserWindow + printToPDF). */
  renderHtmlToPdf(html: string): Promise<Buffer>
  /** Fallback directory when the document has no path (untitled drafts). */
  getFallbackExportDir(): string
}

const HANDLED_CHANNELS = [
  'document:exportPdf',
  'document:exportMarkdownBundle',
] as const

function resolveExportBaseName(suggestedName: string | undefined, sourcePath: string | null | undefined): string {
  const fromSuggestion = (suggestedName || '').trim()
  if (fromSuggestion) return sanitizeExportFolderName(fromSuggestion)
  if (sourcePath) {
    const stem = basename(sourcePath, extname(sourcePath)).trim()
    if (stem) return sanitizeExportFolderName(stem)
  }
  return '导出文档'
}

function resolveExportDir(sourcePath: string | null | undefined, deps: ExportGroupDeps): string {
  if (typeof sourcePath === 'string' && sourcePath.trim()) return dirname(sourcePath)
  return deps.getFallbackExportDir()
}

async function handleExportPdf(payload: DocumentExportPdfPayload, deps: ExportGroupDeps): Promise<DocumentExportResult> {
  try {
    const html = typeof payload?.html === 'string' ? payload.html : ''
    if (!html.trim()) return { success: false, error: 'empty_export_html' }
    if (Buffer.byteLength(html, 'utf-8') > DOCUMENT_EXPORT_HTML_MAX_BYTES) {
      return { success: false, error: 'export_html_too_large' }
    }

    const baseName = resolveExportBaseName(payload.suggestedName, payload.sourcePath)
    const dialogResult = await deps.showExportSaveDialog({
      title: '导出为 PDF',
      defaultPath: join(resolveExportDir(payload.sourcePath, deps), `${baseName}.pdf`),
      filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
    })
    if (dialogResult.canceled || !dialogResult.filePath) {
      return { success: false, canceled: true }
    }

    const pdf = await deps.renderHtmlToPdf(html)
    await writeFile(dialogResult.filePath, pdf)
    return { success: true, path: dialogResult.filePath }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function handleExportMarkdownBundle(
  payload: DocumentExportMarkdownBundlePayload,
  deps: ExportGroupDeps,
): Promise<DocumentExportResult> {
  try {
    const content = typeof payload?.content === 'string' ? payload.content : ''
    if (!content.trim()) return { success: false, error: 'empty_document' }

    const sourcePath = typeof payload.sourcePath === 'string' && payload.sourcePath.trim()
      ? payload.sourcePath
      : null
    const baseName = resolveExportBaseName(payload.suggestedName, sourcePath)
    const dialogResult = await deps.showExportSaveDialog({
      title: '导出 Markdown 压缩包',
      defaultPath: join(resolveExportDir(sourcePath, deps), `${baseName}.zip`),
      filters: [{ name: 'Zip 压缩包', extensions: ['zip'] }],
    })
    if (dialogResult.canceled || !dialogResult.filePath) {
      return { success: false, canceled: true }
    }

    const plan = planMarkdownBundle({
      content,
      documentDir: sourcePath ? dirname(sourcePath) : null,
      fileExists: (candidate) => existsSync(candidate),
    })

    const zip = new JSZip()
    const folder = zip.folder(baseName)
    if (!folder) return { success: false, error: 'zip_folder_failed' }
    folder.file(`${baseName}.md`, plan.markdown)

    let packedCount = 0
    let unreadableCount = 0
    for (const asset of plan.assets) {
      try {
        folder.file(asset.zipPath, await readFile(asset.sourcePath))
        packedCount += 1
      } catch {
        // Planned via existsSync but unreadable at pack time (permissions,
        // TOCTOU delete). Keep the bundle going; surface it in the count.
        unreadableCount += 1
      }
    }

    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    })
    await writeFile(dialogResult.filePath, buffer)
    return {
      success: true,
      path: dialogResult.filePath,
      assetCount: packedCount,
      missingAssetCount: plan.missing.length + unreadableCount,
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export const exportGroup: IpcChannelGroup<ExportGroupDeps> = {
  namespace: 'document:export',

  register(ipcMain: IpcMain, deps: ExportGroupDeps): IpcDisposeHandle {
    // Dev-reload defensive strip, mirroring the other document-engine groups.
    for (const channel of HANDLED_CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore — handler may not exist */ }
    }

    ipcMain.handle('document:exportPdf', (_event, payload: DocumentExportPdfPayload) =>
      handleExportPdf(payload, deps))

    ipcMain.handle('document:exportMarkdownBundle', (_event, payload: DocumentExportMarkdownBundlePayload) =>
      handleExportMarkdownBundle(payload, deps))

    return {
      dispose(): void {
        for (const channel of HANDLED_CHANNELS) {
          try { ipcMain.removeHandler(channel) } catch { /* ignore — already cleared */ }
        }
      },
    }
  },
}

/** Exposed for registration-behavior tests (channel list assertion). */
export const _exportGroupHandledChannelsForTest: ReadonlyArray<string> = HANDLED_CHANNELS
